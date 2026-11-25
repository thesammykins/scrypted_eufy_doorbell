import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type { VideoClip, VideoClipOptions } from '@scrypted/sdk';
import type { WorkerEvent } from './protocol';
import type { WorkerHost } from './worker-host';

const execFileAsync = promisify(execFile);

type RecordingAvailable = Extract<WorkerEvent, { event: 'recordingAvailable' }>;
export type ClipKind = 'ring' | 'motion';

export interface ArchivePolicy {
    archiveMotion(): boolean;
    retentionDays(): number;
    /** Seconds to wait after the push before downloading: Eufy must have finished writing the clip. */
    downloadDelaySeconds(): number;
    ffmpegPath(): Promise<string>;
}

// A ring push and the recording push for the same press arrive within seconds of each other.
const RING_CORRELATION_MS = 60_000;
const RETRY_DELAYS_S = [30, 90];
const SEEN_LIMIT = 500;

/**
 * Keeps a copy of the clip Eufy records on the HomeBase for each ring (and optionally motion): full
 * resolution, both lenses, exactly what the Eufy app would show, fetched from the HomeBase's storage so the
 * doorbell is never woken for it. Stored as `<volume>/recordings/<sn>/<startMs>-<kind>.mp4` + `.jpg`.
 */
export class RecordingArchive {
    private readonly root: string;
    private readonly lastRing = new Map<string, number>();
    private readonly seen = new Set<string>();

    constructor(volume: string, private readonly worker: WorkerHost, private readonly policy: ArchivePolicy, private readonly console: Console) {
        this.root = path.join(volume, 'recordings');
        fs.mkdirSync(this.root, { recursive: true });
    }

    noteRing(sn: string) {
        this.lastRing.set(sn, Date.now());
    }

    onRecordingAvailable(e: RecordingAvailable) {
        if (this.seen.has(e.recording))
            return; // one event usually arrives as several pushes
        const kind = this.classify(e);
        if (kind === 'motion' && !this.policy.archiveMotion())
            return;
        this.seen.add(e.recording);
        if (this.seen.size > SEEN_LIMIT)
            this.seen.delete(this.seen.values().next().value!);

        const outPath = path.join(this.root, e.sn, `${e.at}-${kind}.mp4`);
        const delay = this.policy.downloadDelaySeconds();
        this.console.log(`${kind} recording ${e.recording} on ${e.sn}: downloading from the HomeBase in ${delay}s`);
        setTimeout(() => this.download(e, outPath, 0), delay * 1000);
    }

    list(sn: string, options?: VideoClipOptions): VideoClip[] {
        const dir = path.join(this.root, sn);
        if (!fs.existsSync(dir))
            return [];
        const clips: VideoClip[] = [];
        for (const file of fs.readdirSync(dir)) {
            const match = /^(\d+)-(ring|motion)\.mp4$/.exec(file);
            if (!match)
                continue;
            const startTime = Number(match[1]);
            if (options?.startTime && startTime < options.startTime)
                continue;
            if (options?.endTime && startTime > options.endTime)
                continue;
            const id = `${sn}/${file.replace(/\.mp4$/, '')}`;
            const meta = readMeta(path.join(dir, file.replace(/\.mp4$/, '.json')));
            clips.push({
                id,
                videoId: id,
                thumbnailId: id,
                startTime,
                duration: meta?.durationMs,
                event: match[2],
                description: match[2] === 'ring' ? 'Doorbell ring' : 'Motion',
            });
        }
        clips.sort((a, b) => b.startTime - a.startTime);
        return options?.count ? clips.slice(0, options.count) : clips;
    }

    videoPath(id: string) {
        return this.resolve(id, '.mp4');
    }

    thumbnailPath(id: string) {
        return this.resolve(id, '.jpg');
    }

    latestThumbnail(sn: string): string | undefined {
        const latest = this.list(sn, { count: 1 })[0];
        const file = latest && this.thumbnailPath(latest.id);
        return file && fs.existsSync(file) ? file : undefined;
    }

    remove(ids: string[]) {
        for (const id of ids)
            for (const ext of ['.mp4', '.jpg', '.json'])
                fs.rmSync(this.resolve(id, ext), { force: true });
    }

    prune() {
        const cutoff = Date.now() - this.policy.retentionDays() * 24 * 60 * 60 * 1000;
        for (const sn of fs.readdirSync(this.root)) {
            const old = this.list(sn).filter(c => c.startTime < cutoff).map(c => c.id);
            if (old.length) {
                this.console.log(`pruning ${old.length} archived clips older than ${this.policy.retentionDays()} days for ${sn}`);
                this.remove(old);
            }
        }
    }

    private classify(e: RecordingAvailable): ClipKind {
        if (e.isRing)
            return 'ring';
        const rang = this.lastRing.get(e.sn);
        return rang && Math.abs(e.at - rang) < RING_CORRELATION_MS ? 'ring' : 'motion';
    }

    private async download(e: RecordingAvailable, outPath: string, attempt: number) {
        const started = Date.now();
        try {
            const result = await this.worker.call('downloadRecording', { sn: e.sn, recording: e.recording, codec: e.codec, cipherId: e.cipherId, outPath });
            fs.writeFileSync(outPath.replace(/\.mp4$/, '.json'), JSON.stringify({ recording: e.recording, ...result }));
            await this.writeThumbnail(outPath);
            this.console.log(`archived ${path.basename(outPath)} (${Math.round(result.durationMs / 1000)}s, ${result.fps}fps, audio ${result.hasAudio}) in ${Date.now() - started}ms`);
            this.prune();
        }
        catch (err) {
            const retryIn = RETRY_DELAYS_S[attempt];
            this.console.warn(`recording ${e.recording} download failed (attempt ${attempt + 1}): ${(err as Error).message}${retryIn ? `; retrying in ${retryIn}s` : '; giving up'}`);
            if (retryIn)
                setTimeout(() => this.download(e, outPath, attempt + 1), retryIn * 1000);
        }
    }

    private async writeThumbnail(videoPath: string) {
        const ffmpeg = await this.policy.ffmpegPath();
        await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', videoPath, '-frames:v', '1', '-q:v', '3', videoPath.replace(/\.mp4$/, '.jpg')]);
    }

    private resolve(id: string, ext: string) {
        const resolved = path.resolve(this.root, `${id}${ext}`);
        if (!resolved.startsWith(this.root + path.sep))
            throw new Error(`invalid clip id ${id}`);
        return resolved;
    }
}

function readMeta(file: string): { durationMs?: number } | undefined {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return undefined;
    }
}
