import { spawn } from 'child_process';
import { FFmpegInput } from '@scrypted/sdk';
import { killQuietly } from './media';

export interface TalkbackEncoder {
    stop(): void;
    exited: Promise<void>;
}

/**
 * Encodes whatever the viewer's microphone sends (Opus from WebRTC, AAC-ELD from HomeKit, …) to the
 * 16 kHz mono AAC-LC ADTS the doorbell speaker plays, with every ffmpeg buffer turned off, and writes it
 * straight into the worker's talkback socket. eufy-sdk paces and frames it onto the P2P audio channel.
 */
export function startTalkbackEncoder(ffmpegPath: string, input: FFmpegInput, url: string, console: Console): TalkbackEncoder {
    const args = [
        '-hide_banner', '-loglevel', 'warning',
        '-fflags', '+nobuffer', '-flags', 'low_delay', '-probesize', '32768', '-analyzeduration', '0',
        ...(input.inputArguments || []),
        '-vn', '-sn', '-dn',
        // ≤ 32 kbps: above that the encoder occasionally emits a frame longer than the doorbell accepts.
        '-acodec', 'aac', '-profile:a', 'aac_low', '-ac', '1', '-ar', '16000', '-b:a', '24k',
        '-flush_packets', '1',
        '-f', 'adts', url,
    ];
    const cp = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...input.env } });
    cp.stderr!.on('data', d => console.warn('[talkback]', d.toString().trim()));
    const exited = new Promise<void>(resolve => cp.once('exit', code => {
        console.log(`talkback encoder exited (${code})`);
        resolve();
    }));
    return { stop: () => killQuietly(cp), exited };
}
