import { execFile } from 'child_process';

// GPU first: lower latency and far less CPU than x264 at the same quality. Constant-quality rate control
// with a ceiling, a keyframe every 2 s at 15 fps, no B-frames (they add a frame of delay).
const NVENC = '-c:v h264_nvenc -preset p4 -tune ll -rc vbr -cq 21 -b:v 8M -maxrate 12M -bufsize 6M -g 30 -bf 0 -profile:v high -pix_fmt yuv420p';
const X264 = '-c:v libx264 -preset veryfast -tune zerolatency -crf 20 -maxrate 10M -bufsize 5M -g 30 -bf 0 -profile:v high -pix_fmt yuv420p';

let detected: Promise<string[]> | undefined;

/**
 * H.264 encoder arguments for re-encoding (H.265 sources and dual-lens composition): `override` if the user
 * set one, else NVENC when this host can actually encode with it, else libx264.
 */
export function h264EncoderArgs(ffmpegPath: string, override: string | undefined, console: Console): Promise<string[]> {
    if (override?.trim())
        return Promise.resolve(override.trim().split(/\s+/));
    detected ??= new Promise<string[]>(resolve => {
        execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=15', '-frames:v', '5', '-c:v', 'h264_nvenc', '-f', 'null', '-'],
            { timeout: 15_000 },
            error => {
                const args = error ? X264 : NVENC;
                console.log(`H.264 encoder: ${error ? 'libx264 (NVENC unavailable)' : 'NVENC (GPU)'}`);
                resolve(args.split(' '));
            });
    });
    return detected;
}
