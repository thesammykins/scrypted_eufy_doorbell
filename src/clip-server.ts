import fs from 'fs';
import type { HttpRequest, HttpResponse } from '@scrypted/sdk';
import type { RecordingArchive } from './archive';

const CONTENT_TYPES: Record<string, string> = { mp4: 'video/mp4', jpg: 'image/jpeg' };

/**
 * Serves archived clips at `<authenticated plugin path>clips/<sn>/<startMs>-<kind>.(mp4|jpg)`. Scrypted NVR plays
 * a camera's events straight from `VideoClip.resources.video.href` in a <video> element, so this must answer
 * Range requests (seeking) and the right content type. The path is the plugin's authenticated endpoint, so only
 * a signed-in Scrypted user can fetch it.
 */
export function serveClip(request: HttpRequest, response: HttpResponse, archive: RecordingArchive) {
    const match = /\/clips\/([A-Za-z0-9]+\/\d+-(?:ring|motion))\.(mp4|jpg)(?:\?.*)?$/.exec(request.url || '');
    if (!match) {
        response.send('Not Found', { code: 404 });
        return;
    }
    const [, id, ext] = match;
    const file = ext === 'mp4' ? archive.videoPath(id) : archive.thumbnailPath(id);
    if (!fs.existsSync(file)) {
        response.send('Not Found', { code: 404 });
        return;
    }

    const size = fs.statSync(file).size;
    const headers = { 'Content-Type': CONTENT_TYPES[ext], 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers?.range || request.headers?.Range || '');
    if (!range || (!range[1] && !range[2])) {
        response.send(fs.readFileSync(file), { headers: { ...headers, 'Content-Length': String(size) } });
        return;
    }

    // bytes=a-b, bytes=a- , or bytes=-n (last n bytes)
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    end = Math.min(end, size - 1);
    if (start > end || start >= size) {
        response.send('', { code: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
        return;
    }
    const length = end - start + 1;
    const body = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
        fs.readSync(fd, body, 0, length, start);
    }
    finally {
        fs.closeSync(fd);
    }
    response.send(body, {
        code: 206,
        headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(length) },
    });
}
