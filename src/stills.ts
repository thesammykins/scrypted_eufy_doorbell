import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { LensView } from './lenses';

export type StillKind = 'event' | 'live';

/**
 * Latest picture per camera, kept on disk so tiles survive a plugin restart instead of falling back to a
 * blank frame until the next event. Eufy's event thumbnail and frames taken from the live pull are kept
 * apart (the event thumbnail is re-offered unchanged on every read, so it must not overwrite a newer frame);
 * whichever was written last is the snapshot.
 */
export class ThumbnailStore {
    private readonly dir: string;

    constructor(volume: string) {
        this.dir = path.join(volume, 'thumbnails');
        fs.mkdirSync(this.dir, { recursive: true });
    }

    save(sn: string, jpeg: Buffer, kind: StillKind) {
        const file = this.file(sn, kind);
        if (fs.existsSync(file) && fs.statSync(file).size === jpeg.length && fs.readFileSync(file).equals(jpeg))
            return false;
        fs.writeFileSync(file, jpeg);
        return true;
    }

    /** The newer of the event thumbnail and the live frame. */
    latest(sn: string): { kind: StillKind; jpeg: Buffer; ageMs: number } | undefined {
        const found = (['event', 'live'] as StillKind[])
            .map(kind => ({ kind, file: this.file(sn, kind) }))
            .filter(f => fs.existsSync(f.file))
            .map(f => ({ ...f, mtime: fs.statSync(f.file).mtimeMs }))
            .sort((a, b) => b.mtime - a.mtime)[0];
        return found && { kind: found.kind, jpeg: fs.readFileSync(found.file), ageMs: Date.now() - found.mtime };
    }

    private file(sn: string, kind: StillKind) {
        return path.join(this.dir, `${sn.replace(/[^A-Za-z0-9]/g, '')}${kind === 'live' ? '.live' : ''}.jpg`);
    }
}

/** Width/height from a JPEG's start-of-frame marker. */
function jpegSize(jpeg: Buffer): { width: number; height: number } | undefined {
    let i = 2;
    while (i + 9 < jpeg.length) {
        if (jpeg[i] !== 0xff) {
            i++;
            continue;
        }
        const marker = jpeg[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
            return { height: jpeg.readUInt16BE(i + 5), width: jpeg.readUInt16BE(i + 7) };
        i += 2 + jpeg.readUInt16BE(i + 2);
    }
    return undefined;
}

/** Composes a still into the doorbell's view when it is the stacked dual-lens frame; otherwise returns it as-is. */
export function cropStill(ffmpegPath: string, jpeg: Buffer, view: LensView | undefined): Promise<Buffer> {
    const size = jpegSize(jpeg);
    if (!view || !size || size.height < size.width * 1.2)
        return Promise.resolve(jpeg);
    return new Promise((resolve, reject) => {
        const cp = execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'image2pipe', '-i', 'pipe:0', '-vf', view.filter, '-frames:v', '1', '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'],
            { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 },
            (error, stdout) => error ? reject(error) : resolve(stdout));
        cp.stdin!.end(jpeg);
    });
}

let placeholder: Promise<Buffer> | undefined;

/** A plain dark frame, served when no Eufy image exists yet so nothing falls back to waking the camera. */
export function placeholderJpeg(ffmpegPath: string) {
    placeholder ??= new Promise<Buffer>((resolve, reject) => {
        execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x202020:s=640x360', '-frames:v', '1', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'],
            { encoding: 'buffer', maxBuffer: 1024 * 1024 },
            (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    placeholder.catch(() => placeholder = undefined);
    return placeholder;
}
