import { ChildProcess, spawn } from 'child_process';
import net from 'net';
import { FFmpegInput, ResponseMediaStreamOptions } from '@scrypted/sdk';
import type { LensView } from './lenses';
import type { LiveStreamInfo } from './protocol';

// Raw elementary streams carry no container timing: stamp packets on arrival and skip probing so frames are
// forwarded as soon as they land instead of after ffmpeg's default multi-second analysis.
const LOW_LATENCY_INPUT = ['-fflags', '+nobuffer+genpts', '-flags', 'low_delay', '-probesize', '65536', '-analyzeduration', '0'];
const RAW_INPUT = [...LOW_LATENCY_INPUT, '-thread_queue_size', '1024', '-use_wallclock_as_timestamps', '1'];

export interface H264Transcode {
    ffmpegPath: string;
    encoderArgs: string[];
}

/**
 * Two renditions of the same P2P pull, each encoded only when someone asks for it.
 *
 * - `full`: the doorbell's native resolution, High profile. Local viewing, HomeKit and recordings.
 * - `compat`: fitted to 1920x1080, Constrained Baseline at level 4.1. Google's cast receivers and WebRTC
 *   player take nothing else as-is, so without it Scrypted re-encodes every Google session on the CPU before
 *   the first frame (`transcodeBaseline: true`), on top of the doorbell's wake-up. Remote and low-resolution
 *   viewers get it too, which is the bucket Google draws from.
 */
export interface StreamVariant {
    id: string;
    name: string;
    destinations: Array<'local' | 'remote' | 'medium-resolution' | 'low-resolution' | 'local-recorder' | 'remote-recorder'>;
    fit?: { width: number; height: number };
    baseline: boolean;
}

export const STREAM_VARIANTS: StreamVariant[] = [
    { id: 'full', name: 'Doorbell', destinations: ['local', 'local-recorder', 'remote-recorder'], baseline: false },
    { id: 'compat', name: 'Doorbell (1080p)', destinations: ['remote', 'medium-resolution', 'low-resolution'], fit: { width: 1920, height: 1080 }, baseline: true },
];

export function variantFor(id: string | undefined) {
    return STREAM_VARIANTS.find(v => v.id === id) ?? STREAM_VARIANTS[0];
}

/** Always H.264 + AAC out, with the size the stream will actually have. */
export function streamOptions(variant: StreamVariant, view?: LensView, info?: LiveStreamInfo): ResponseMediaStreamOptions {
    const native = { width: view?.width ?? info?.video.width, height: view?.height ?? info?.video.height };
    const size = variant.fit ? fitWithin(native, variant.fit) : native;
    return {
        id: variant.id,
        name: variant.name,
        tool: 'ffmpeg',
        destinations: variant.destinations,
        // Advertised up front: without a size Scrypted's Adaptive Streaming assumes 16:9 and may squash it.
        video: { codec: 'h264', profile: variant.baseline ? 'baseline' : 'high', ...size },
        audio: info && !info.audio ? null : { codec: 'aac' },
        // Battery doorbell: nothing may keep this stream open in the background.
        allowBatteryPrebuffer: false,
    } as ResponseMediaStreamOptions;
}

/** The dual-lens doorbell stacks its two lenses into a frame much taller than it is wide. */
export function isStacked(width: number, height: number) {
    return height > width * 1.2;
}

function fitWithin(size: { width?: number; height?: number }, box: { width: number; height: number }) {
    if (!size.width || !size.height)
        return { ...box };
    const scale = Math.min(1, box.width / size.width, box.height / size.height);
    return { width: Math.round(size.width * scale / 2) * 2, height: Math.round(size.height * scale / 2) * 2 };
}

/** Encoder arguments for a variant: the configured encoder with its profile swapped for Baseline where needed. */
function encoderFor(variant: StreamVariant, encoderArgs: string[]) {
    if (!variant.baseline)
        return encoderArgs;
    const args: string[] = [];
    for (let i = 0; i < encoderArgs.length; i++) {
        if (encoderArgs[i] === '-profile:v' || encoderArgs[i] === '-level') {
            i++;
            continue;
        }
        args.push(encoderArgs[i]);
    }
    return [...args, '-profile:v', 'baseline', '-level', '4.1'];
}

function rawInputs(info: LiveStreamInfo) {
    const args = ['-f', info.video.codec === 'h265' ? 'hevc' : 'h264', ...RAW_INPUT, '-i', info.video.url];
    if (info.audio?.format === 'aac-lc')
        args.push('-f', 'aac', ...RAW_INPUT, '-i', info.audio.url);
    else if (info.audio?.format === 'g711a')
        args.push('-f', 'alaw', '-ar', '16000', '-ac', '1', ...RAW_INPUT, '-i', info.audio.url);
    return args;
}

function maps(info: LiveStreamInfo) {
    return ['-map', '0:v:0', ...(info.audio ? ['-map', '1:a:0'] : [])];
}

/**
 * Muxes the worker's raw video/audio sockets into one NUT stream on a one-shot local socket for the
 * consumer (Rebroadcast). NUT carries codec headers, which RTSP needs and raw ADTS/Annex-B lack.
 * H.264 video is copied; H.265 is re-encoded because HomeKit and Google Home only take H.264, and a stacked
 * dual-lens frame is composed into its landscape view (which needs the encode anyway). Audio is
 * re-encoded (cheap at 16 kHz mono) so it can be re-timed onto a steady clock.
 * Closing the socket kills the muxer, which closes the worker's sockets, which ends the P2P pull.
 */
export async function createFFmpegInput(info: LiveStreamInfo, console: Console, transcode: H264Transcode, variant: StreamVariant, view?: LensView): Promise<FFmpegInput> {
    // The doorbell does not always send the stacked dual-lens frame (it has been seen switching to a plain
    // 1920x1080 H.264 picture). Compose only a frame that really is stacked; anything else passes through.
    const stacked = !!info.video.width && !!info.video.height && isStacked(info.video.width, info.video.height);
    if (view && !stacked)
        console.log(`camera sent a ${info.video.width}x${info.video.height} frame, not the stacked dual-lens layout; passing it through`);
    const filters = [
        ...(view && stacked ? [view.filter] : []),
        ...(variant.fit ? [`scale=w=${variant.fit.width}:h=${variant.fit.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`] : []),
    ];
    const video = info.video.codec === 'h264' && !filters.length && !variant.baseline
        ? ['-c:v', 'copy']
        : [...(filters.length ? ['-vf', filters.join(',')] : []), ...encoderFor(variant, transcode.encoderArgs)];
    // P2P delivers audio in bursts, so arrival stamps jitter. Re-stamp from the sample count (a steady clock),
    // anchored at the first frame's arrival time so it stays in step with the arrival-stamped video.
    // Never resample to fit the jitter: stretching to it is what made the audio warble.
    const audio = info.audio ? ['-af', 'asetpts=N/SR/TB+STARTPTS', '-c:a', 'aac', '-b:a', '48k'] : [];
    const args = [
        '-hide_banner', '-loglevel', 'error',
        ...rawInputs(info), ...maps(info),
        ...video, ...audio,
        // NUT stores SPS/PPS in its header, so an encoder writing into it omits them in-band; put them back
        // on every keyframe or anyone joining the rebroadcast mid-stream never finds a decodable frame.
        '-bsf:v', 'dump_extra=freq=keyframe',
        '-f', 'nut', '-flush_packets', '1', 'pipe:1',
    ];
    const muxer = spawn(transcode.ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    muxer.stderr!.on('data', d => console.warn('[muxer]', d.toString().trim()));
    muxer.once('exit', code => console.log(`muxer exited (${code})`));
    const served = await serveOnce(muxer, console);
    served.done.finally(() => killQuietly(muxer));
    return { inputArguments: ['-f', 'nut', ...LOW_LATENCY_INPUT, '-i', served.url], mediaStreamOptions: streamOptions(variant, view, info) };
}

function serveOnce(encoder: ChildProcess, console: Console): Promise<{ url: string; done: Promise<void> }> {
    return new Promise((resolveListen, rejectListen) => {
        let finish!: () => void;
        const done = new Promise<void>(resolve => finish = resolve);
        const server = net.createServer();
        const timeout = setTimeout(() => {
            console.warn('muxed stream: nobody connected within 15s');
            server.close();
            finish();
        }, 15_000);
        server.once('connection', socket => {
            clearTimeout(timeout);
            server.close();
            socket.setNoDelay(true);
            socket.on('error', () => { });
            encoder.stdout!.pipe(socket);
            socket.once('close', finish);
            encoder.once('exit', () => socket.end());
        });
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', () => resolveListen({ url: `tcp://127.0.0.1:${(server.address() as net.AddressInfo).port}`, done }));
    });
}

export function killQuietly(cp: ChildProcess) {
    if (cp.exitCode === null && !cp.killed)
        cp.kill('SIGKILL');
}
