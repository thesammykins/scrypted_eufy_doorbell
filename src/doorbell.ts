import fs from 'fs';
import sdk, {
    Battery, BinarySensor, Camera, FFmpegInput, Intercom, MediaObject, MotionSensor, ObjectDetectionTypes, ObjectDetector,
    ObjectsDetected, Online, RequestMediaStreamOptions, ResponseMediaStreamOptions, ResponsePictureOptions, ScryptedDeviceBase, ScryptedInterface,
    ScryptedMimeTypes, VideoCamera, VideoClip, VideoClipOptions, VideoClips,
} from '@scrypted/sdk';
import type { RecordingArchive } from './archive';
import { LensView, viewFor } from './lenses';
import { createFFmpegInput, H264Transcode, STREAM_VARIANTS, streamOptions, variantFor } from './media';
import type { DoorbellInfo, DetectionClass } from './protocol';
import { cropStill, placeholderJpeg, ThumbnailStore } from './stills';
import { startTalkbackEncoder, TalkbackEncoder } from './talkback';
import type { WorkerHost } from './worker-host';

const { mediaManager } = sdk;

// HomeKit and Google treat the rising edge as the press/detection; drop back so the next one is a new edge.
const RING_RESET_MS = 10_000;
// HomeKit Secure Video records for as long as motion reads true, streaming live from the doorbell the whole
// time. Eufy's own clips run 7-15 s, so hold motion about that long rather than keeping the doorbell awake.
const MOTION_RESET_MS = 10_000;
// Eufy fetches the event thumbnail a few seconds after the push; pick it up and keep it on disk.
const THUMBNAIL_CAPTURE_DELAYS_MS = [4_000, 12_000];

export interface CameraContext {
    worker: WorkerHost;
    archive: RecordingArchive;
    thumbnails: ThumbnailStore;
    transcode(): Promise<H264Transcode>;
    maxLiveSeconds(): number;
    /** Authenticated URL prefix the plugin serves archived clip files under. */
    clipUrlBase(): Promise<string>;
}

type IntercomState =
    | { kind: 'idle' }
    | { kind: 'starting' }
    | { kind: 'active'; talkId: string; encoder: TalkbackEncoder };

const DETECTION_CLASSES: DetectionClass[] = ['person', 'package', 'vehicle', 'animal'];

/** One Scrypted doorbell per Eufy doorbell; the native id is the Eufy serial. */
export class EufyDoorbell extends ScryptedDeviceBase implements VideoCamera, Camera, Intercom, MotionSensor, BinarySensor, Battery, Online, VideoClips, ObjectDetector {
    private ringReset?: NodeJS.Timeout;
    private motionReset?: NodeJS.Timeout;
    private intercom: IntercomState = { kind: 'idle' };
    private lastSnapshotSource?: string;

    private readonly sn: string;
    private readonly view?: LensView;

    constructor(sn: string, private readonly context: CameraContext) {
        super(sn);
        this.sn = sn;
        this.view = viewFor(sn);
    }

    // --- state pushed from the worker ---

    update(info: DoorbellInfo) {
        if (info.batteryLevel !== undefined)
            this.batteryLevel = info.batteryLevel;
        this.online = true;
    }

    onRing() {
        this.console.log('doorbell pressed');
        clearTimeout(this.ringReset);
        this.binaryState = true;
        this.ringReset = setTimeout(() => this.binaryState = false, RING_RESET_MS);
        this.captureThumbnail();
    }

    onMotion() {
        this.console.log('motion detected');
        clearTimeout(this.motionReset);
        this.motionDetected = true;
        this.motionReset = setTimeout(() => this.motionDetected = false, MOTION_RESET_MS);
        this.captureThumbnail();
    }

    /** Eufy's on-camera classification, surfaced as a Scrypted detection so the NVR and automations see it. */
    onDetection(className: DetectionClass, label: string) {
        this.console.log(`eufy detected ${label}`);
        this.onMotion();
        const detected: ObjectsDetected = {
            timestamp: Date.now(),
            detectionId: `eufy-${Date.now()}`,
            detections: [{ className, label, score: 1 }],
        };
        this.onDeviceEvent(ScryptedInterface.ObjectDetector, detected);
    }

    async getObjectTypes(): Promise<ObjectDetectionTypes> {
        return { classes: DETECTION_CLASSES };
    }

    /** The detection's picture is Eufy's event thumbnail, the same one the Eufy app shows. */
    async getDetectionInput(): Promise<MediaObject> {
        return this.takePicture();
    }

    onBattery(level: number) {
        this.batteryLevel = level;
    }

    onTalkbackEnded(talkId: string, reason: string) {
        if (this.intercom.kind === 'active' && this.intercom.talkId === talkId) {
            this.console.log(`doorbell ended talkback: ${reason}`);
            this.intercom.encoder.stop();
            this.intercom = { kind: 'idle' };
        }
    }

    // --- VideoCamera: one P2P pull shared by every viewer, gone when the last viewer leaves ---

    async getVideoStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        return STREAM_VARIANTS.map(variant => streamOptions(variant, this.view));
    }

    async getVideoStream(options?: RequestMediaStreamOptions): Promise<MediaObject> {
        const variant = variantFor(options?.id);
        const view = this.view;
        const started = Date.now();
        const info = await this.context.worker.call('live', { sn: this.sn, maxSeconds: this.context.maxLiveSeconds() });
        this.console.log(`live stream ready in ${Date.now() - started}ms: ${info.video.codec} ${info.video.width}x${info.video.height}, audio ${info.audio?.format ?? 'none'}, serving ${variant.id}`);
        try {
            const input = await createFFmpegInput(info, this.console, await this.context.transcode(), variant, view);
            return await mediaManager.createFFmpegMediaObject(input);
        }
        catch (e) {
            await this.context.worker.call('stopLive', { streamId: info.streamId }).catch(() => { });
            throw e;
        }
    }

    // --- Camera: Eufy's own event thumbnail; never wakes the doorbell ---

    /**
     * Throwing here would make the Snapshot plugin fall back to opening a live stream, i.e. waking the
     * camera for every tile refresh. So: the thumbnail Eufy pushed with the last event, else the copy kept
     * on disk, else a frame of the last archived ring clip, else a blank frame.
     */
    async takePicture(): Promise<MediaObject> {
        const ffmpeg = await mediaManager.getFFmpegPath();
        const { source, jpeg } = await this.latestStill(ffmpeg);
        if (source !== this.lastSnapshotSource)
            this.console.log(`snapshot source: ${source}`);
        this.lastSnapshotSource = source;
        return mediaManager.createMediaObject(await cropStill(ffmpeg, jpeg, this.view), 'image/jpeg');
    }

    async getPictureOptions(): Promise<ResponsePictureOptions[]> {
        return [];
    }

    private async latestStill(ffmpeg: string): Promise<{ source: string; jpeg: Buffer }> {
        try {
            const { jpegBase64 } = await this.context.worker.call('snapshot', { sn: this.sn });
            const jpeg = Buffer.from(jpegBase64, 'base64');
            this.context.thumbnails.save(this.sn, jpeg);
            return { source: 'eufy event thumbnail', jpeg };
        }
        catch {
            const saved = this.context.thumbnails.load(this.sn);
            if (saved)
                return { source: 'saved eufy event thumbnail', jpeg: saved };
            const clipThumb = this.context.archive.latestThumbnail(this.sn);
            if (clipThumb)
                return { source: 'last archived ring clip', jpeg: fs.readFileSync(clipThumb) };
            return { source: 'placeholder (no eufy event yet)', jpeg: await placeholderJpeg(ffmpeg) };
        }
    }

    private captureThumbnail() {
        for (const delay of THUMBNAIL_CAPTURE_DELAYS_MS) {
            setTimeout(() => {
                this.context.worker.call('snapshot', { sn: this.sn })
                    .then(({ jpegBase64 }) => {
                        if (this.context.thumbnails.save(this.sn, Buffer.from(jpegBase64, 'base64')))
                            this.console.log('saved new eufy event thumbnail');
                    })
                    .catch(() => { });
            }, delay);
        }
    }

    // --- VideoClips: Eufy's own ring recordings, copied off the HomeBase ---

    /** NVR plays a clip straight from `resources.video.href` in a <video> element; the plugin serves that file. */
    async getVideoClips(options?: VideoClipOptions): Promise<VideoClip[]> {
        const base = await this.context.clipUrlBase();
        return this.context.archive.list(this.sn, options).map(clip => ({
            ...clip,
            resources: {
                video: { href: `${base}${clip.id}.mp4` },
                thumbnail: { href: `${base}${clip.id}.jpg` },
            },
        }));
    }

    /** An in-memory MP4 (a few MB): Scrypted's players can turn that into a URL, which a bare file path is not. */
    async getVideoClip(videoId: string): Promise<MediaObject> {
        return mediaManager.createMediaObject(await fs.promises.readFile(this.context.archive.videoPath(videoId)), 'video/mp4');
    }

    async getVideoClipThumbnail(thumbnailId: string): Promise<MediaObject> {
        return mediaManager.createMediaObject(fs.readFileSync(this.context.archive.thumbnailPath(thumbnailId)), 'image/jpeg');
    }

    async removeVideoClips(...videoClipIds: string[]): Promise<void> {
        this.context.archive.remove(videoClipIds);
    }

    // --- Intercom: viewer mic → ffmpeg (AAC-LC 16 kHz) → worker → P2P talkback ---

    async startIntercom(media: MediaObject): Promise<void> {
        await this.stopIntercom();
        this.intercom = { kind: 'starting' };
        const started = Date.now();
        try {
            const input = await mediaManager.convertMediaObjectToJSON<FFmpegInput>(media, ScryptedMimeTypes.FFmpegInput);
            const { talkId, url } = await this.context.worker.call('talkback', { sn: this.sn });
            if (this.intercom.kind !== 'starting') {
                await this.context.worker.call('stopTalkback', { talkId });
                return;
            }
            const encoder = startTalkbackEncoder(await mediaManager.getFFmpegPath(), input, url, this.console);
            this.intercom = { kind: 'active', talkId, encoder };
            encoder.exited.then(() => {
                if (this.intercom.kind === 'active' && this.intercom.encoder === encoder)
                    this.stopIntercom().catch(() => { });
            });
            this.console.log(`intercom open in ${Date.now() - started}ms`);
        }
        catch (e) {
            this.intercom = { kind: 'idle' };
            this.console.error('intercom failed to start', e);
            throw e;
        }
    }

    async stopIntercom(): Promise<void> {
        const state = this.intercom;
        this.intercom = { kind: 'idle' };
        if (state.kind !== 'active')
            return;
        state.encoder.stop();
        await this.context.worker.call('stopTalkback', { talkId: state.talkId }).catch(e => this.console.warn('stop talkback failed', e));
        this.console.log('intercom closed');
    }
}
