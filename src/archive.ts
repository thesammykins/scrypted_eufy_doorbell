import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import type { VideoClip, VideoClipOptions } from '@scrypted/sdk';
import type { RecordingEntry } from './protocol';
import type { WorkerHost } from './worker-host';

const execFileAsync = promisify(execFile);

export type ClipKind = 'ring' | 'motion';

export interface ArchivePolicy {
    archiveMotion(): boolean;
    retentionDays(): number;
    /** Seconds to wait after a ring before syncing: Eufy must have finished writing the clip. */
    downloadDelaySeconds(): number;
    ffmpegPath(): Promise<string>;
}

// A second pass after a ring catches a clip that was still being written on the first.
const SECOND_PASS_S = 120;
const PERIODIC_SYNC_MS = 30 * 60 * 1000;
const LOOKBACK_DAYS = 2;

/**
 * Keeps a copy of the clip Eufy records on the HomeBase for each ring (and optionally motion): full
 * resolution, both lenses, exactly what the Eufy app shows. It syncs against the HomeBase's own clip index
 * rather than trusting push payloads, so a restart, a missed push or an earlier ring is caught up on the next
 * pass. Nothing here wakes the doorbell: the index and the clips live on the wired HomeBase.
 *
 * Stored as `<volume>/recordings/<sn>/<startMs>-<kind>.mp4` + `.jpg` + `.json`.
 */
export class RecordingArchive {
    private readonly root: string;
    private readonly syncing = new Map<string, Promise<void>>();
    private readonly started = new Set<string>();

    constructor(volume: string, private readonly worker: WorkerHost, private readonly policy: ArchivePolicy, private readonly console: Console) {
        this.root = path.join(volume, 'recordings');
        fs.mkdirSync(this.root, { recursive: true });
    }

    /** Sync now and every 30 minutes from here on (once per doorbell, however often it is rediscovered). */
    start(sn: string) {
        if (this.started.has(sn))
            return;
        this.started.add(sn);
        this.sync(sn, 'startup');
        setInterval(() => this.sync(sn, 'periodic'), PERIODIC_SYNC_MS);
    }

    onRing(sn: string) {
        const delay = this.policy.downloadDelaySeconds();
        setTimeout(() => this.sync(sn, 'ring'), delay * 1000);
        setTimeout(() => this.sync(sn, 'ring (second pass)'), (delay + SECOND_PASS_S) * 1000);
    }

    /** One sync per doorbell at a time; a request during a running sync waits for it then runs again. */
    sync(sn: string, reason: string): Promise<void> {
        const previous = this.syncing.get(sn) ?? Promise.resolve();
        const next = previous.then(() => this.syncOnce(sn, reason)).catch(e => this.console.warn(`clip sync (${reason}) failed: ${(e as Error).message}`));
        this.syncing.set(sn, next);
        return next;
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

    private async syncOnce(sn: string, reason: string) {
        const cutoff = Date.now() - this.policy.retentionDays() * 24 * 60 * 60 * 1000;
        const entries = await this.worker.call('listRecordings', { sn, days: LOOKBACK_DAYS });
        const wanted = entries.filter(e => (e.isRing || this.policy.archiveMotion()) && e.startMs >= cutoff);
        const missing = wanted.filter(e => !fs.existsSync(this.pathFor(sn, e)));
        this.console.log(`clip sync (${reason}): HomeBase has ${entries.length} clips, ${wanted.filter(e => e.isRing).length} rings; ${missing.length} to fetch`);
        for (const entry of missing)
            await this.download(sn, entry);
        this.prune(sn, cutoff);
    }

    private pathFor(sn: string, e: RecordingEntry) {
        return path.join(this.root, sn, `${e.startMs}-${e.isRing ? 'ring' : 'motion'}.mp4`);
    }

    private async download(sn: string, entry: RecordingEntry) {
        const outPath = this.pathFor(sn, entry);
        const partial = `${outPath}.part.mp4`;
        const started = Date.now();
        try {
            const result = await this.worker.call('downloadRecording', { sn, recording: entry.recording, codec: entry.codec, cipherId: entry.cipherId, outPath: partial });
            fs.renameSync(partial, outPath);
            fs.writeFileSync(outPath.replace(/\.mp4$/, '.json'), JSON.stringify({ recording: entry.recording, codec: entry.codec, ...result }));
            await this.writeThumbnail(outPath);
            this.console.log(`archived ${entry.isRing ? 'ring' : 'motion'} clip ${entry.recording} (${Math.round(result.durationMs / 1000)}s, ${result.fps}fps, audio ${result.hasAudio}) in ${Date.now() - started}ms`);
        }
        catch (err) {
            fs.rmSync(partial, { force: true });
            // Left missing on purpose: the next sync retries it.
            this.console.warn(`clip ${entry.recording} not archived yet: ${(err as Error).message}`);
        }
    }

    private prune(sn: string, cutoff: number) {
        const old = this.list(sn).filter(c => c.startTime < cutoff).map(c => c.id);
        if (old.length) {
            this.console.log(`pruning ${old.length} archived clips older than ${this.policy.retentionDays()} days for ${sn}`);
            this.remove(old);
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
