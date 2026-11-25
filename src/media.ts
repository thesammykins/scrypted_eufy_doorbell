import { ChildProcess, spawn } from 'child_process';
import net from 'net';
import { FFmpegInput, ResponseMediaStreamOptions } from '@scrypted/sdk';
import type { LensView } from './lenses';
import type { LiveStreamInfo } from './protocol';

// Raw elementary streams carry no container timing: stamp packets on arrival and skip probing so frames are
// forwarded as soon as they land instead of after ffmpeg's default multi-second analysis.
const LOW_LATENCY_INPUT = ['-fflags', '+nobuffer+genpts', '-flags', 'low_delay', '-probesize', '65536', '-analyzeduration', '0'];
const RAW_INPUT = [...LOW_LATENCY_INPUT, '-thread_queue_size', '1024', '-use_wallclock_as_timestamps', '1'];

const DEFAULT_STREAM_ID = 'p2p';

export interface H264Transcode {
    ffmpegPath: string;
    encoderArgs: string[];
}

/** Always H.264 + AAC out; a dual-lens doorbell advertises its composed view's fixed size. */
export function streamOptions(view?: LensView, info?: LiveStreamInfo): ResponseMediaStreamOptions {
    return {
        id: view?.id ?? DEFAULT_STREAM_ID,
        name: view?.name ?? 'P2P Livestream',
        tool: 'ffmpeg',
        // Advertised up front: without a size Scrypted's Adaptive Streaming assumes 16:9 and may squash it.
        video: { codec: 'h264', width: view?.width ?? info?.video.width, height: view?.height ?? info?.video.height },
        audio: info && !info.audio ? null : { codec: 'aac' },
        // Battery doorbell: nothing may keep this stream open in the background.
        allowBatteryPrebuffer: false,
    } as ResponseMediaStreamOptions;
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
export async function createFFmpegInput(info: LiveStreamInfo, console: Console, transcode: H264Transcode, view?: LensView): Promise<FFmpegInput> {
    const video = info.video.codec === 'h264' && !view
        ? ['-c:v', 'copy']
        : [...(view ? ['-vf', view.filter] : []), ...transcode.encoderArgs];
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
    return { inputArguments: ['-f', 'nut', ...LOW_LATENCY_INPUT, '-i', served.url], mediaStreamOptions: streamOptions(view, info) };
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
