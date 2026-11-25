import { execFile } from 'child_process';
import fs from 'fs';
import sdk, {
    Battery, BinarySensor, Camera, FFmpegInput, Intercom, MediaObject, MotionSensor, ObjectDetectionTypes, ObjectDetector,
    ObjectsDetected, Online, ResponseMediaStreamOptions, ResponsePictureOptions, ScryptedDeviceBase, ScryptedInterface,
    RequestRecordingStreamOptions, ScryptedMimeTypes, VideoCamera, VideoClip, VideoClipOptions, VideoClips, VideoRecorder,
} from '@scrypted/sdk';
import type { RecordingArchive } from './archive';
import { LensView, viewFor } from './lenses';
import { createFFmpegInput, H264Transcode, streamOptions } from './media';
import type { DoorbellInfo, DetectionClass } from './protocol';
import { cropStill, placeholderJpeg, ThumbnailStore } from './stills';
import { startTalkbackEncoder, TalkbackEncoder } from './talkback';
import type { WorkerHost } from './worker-host';

const { mediaManager } = sdk;

// HomeKit and Google treat the rising edge as the press/detection; drop back so the next one is a new edge.
const RING_RESET_MS = 10_000;
const MOTION_RESET_MS = 20_000;
// Eufy fetches the event thumbnail a few seconds after the push; pick it up and keep it on disk.
const THUMBNAIL_CAPTURE_DELAYS_MS = [4_000, 12_000];

export interface CameraContext {
    worker: WorkerHost;
    archive: RecordingArchive;
    thumbnails: ThumbnailStore;
    transcode(): Promise<H264Transcode>;
    maxLiveSeconds(): number;
}

type IntercomState =
    | { kind: 'idle' }
    | { kind: 'starting' }
    | { kind: 'active'; talkId: string; encoder: TalkbackEncoder };

const DETECTION_CLASSES: DetectionClass[] = ['person', 'package', 'vehicle', 'animal'];

/** One Scrypted doorbell per Eufy doorbell; the native id is the Eufy serial. */
export class EufyDoorbell extends ScryptedDeviceBase implements VideoCamera, Camera, Intercom, MotionSensor, BinarySensor, Battery, Online, VideoClips, VideoRecorder, ObjectDetector {
    private ringReset?: NodeJS.Timeout;
    private motionReset?: NodeJS.Timeout;
    private intercom: IntercomState = { kind: 'idle' };
    private lastSnapshotSource?: string;
    /** Where the most recent archive playback started, to answer "what time is playing now". */
    private playback?: { time: number; startedAt: number; rate: number };

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
        return [streamOptions(this.view)];
    }

    async getVideoStream(): Promise<MediaObject> {
        const view = this.view;
        const started = Date.now();
        const info = await this.context.worker.call('live', { sn: this.sn, maxSeconds: this.context.maxLiveSeconds() });
        this.console.log(`live stream ready in ${Date.now() - started}ms: ${info.video.codec} ${info.video.width}x${info.video.height}, audio ${info.audio?.format ?? 'none'}`);
        try {
            const input = await createFFmpegInput(info, this.console, await this.context.transcode(), view);
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

    async getVideoClips(options?: VideoClipOptions): Promise<VideoClip[]> {
        return this.context.archive.list(this.sn, options);
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

    // --- VideoRecorder: Scrypted NVR plays an event by asking for "the recording from time T". The archive is
    // that recording, sparse: one clip per Eufy event. Nothing here touches the doorbell. ---

    async getRecordingStreamOptions(): Promise<ResponseMediaStreamOptions[]> {
        return [{ ...streamOptions(this.view), id: 'archive', name: 'Eufy Event Clips' }];
    }

    async getRecordingStream(options: RequestRecordingStreamOptions): Promise<MediaObject> {
        const clip = this.context.archive.clipAt(this.sn, options.startTime);
        if (!clip)
            throw new Error(`no Eufy event clip at ${new Date(options.startTime).toLocaleString()}; only events are recorded`);
        const rate = options.playbackRate || 1;
        this.playback = { time: clip.startTime + clip.offsetMs, startedAt: Date.now(), rate };
        this.console.log(`playing archived clip from ${new Date(clip.startTime).toLocaleTimeString()} at +${Math.round(clip.offsetMs / 1000)}s`);
        return mediaManager.createFFmpegMediaObject({
            inputArguments: [
                // Real time (or the requested speed): the player treats this like a live stream.
                ...(rate === 1 ? ['-re'] : ['-readrate', String(rate)]),
                '-ss', (clip.offsetMs / 1000).toFixed(3),
                ...(options.loop ? ['-stream_loop', '-1'] : []),
                '-i', clip.path,
            ],
            mediaStreamOptions: { ...streamOptions(this.view), id: 'archive', container: 'mp4' },
        });
    }

    async getRecordingStreamCurrentTime(): Promise<number> {
        const p = this.playback;
        return p ? p.time + (Date.now() - p.startedAt) * p.rate : Date.now();
    }

    /** A frame from the archived clip at `time`, so scrubbing NVR's timeline shows the right moment. */
    async getRecordingStreamThumbnail(time: number): Promise<MediaObject> {
        const clip = this.context.archive.clipAt(this.sn, time, 0);
        if (!clip)
            return this.takePicture();
        const ffmpeg = await mediaManager.getFFmpegPath();
        const jpeg = await new Promise<Buffer>((resolve, reject) => execFile(ffmpeg,
            ['-hide_banner', '-loglevel', 'error', '-ss', (clip.offsetMs / 1000).toFixed(3), '-i', clip.path, '-frames:v', '1', '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'],
            { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
            (error, stdout) => error ? reject(error) : resolve(stdout)));
        return mediaManager.createMediaObject(jpeg, 'image/jpeg');
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
