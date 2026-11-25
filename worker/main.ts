/**
 * eufy worker. Runs on Node ≥ 24.5 (eufy-sdk's floor: it needs OpenSSL 3.5 to decrypt E2E camera video),
 * spawned by the Scrypted plugin over an IPC channel. It owns the eufy session and hands raw media to the
 * plugin's ffmpeg through one-shot localhost sockets.
 */
import net from 'node:net';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { EufyMega, LoginStatus, type LiveStreamConsumer, type TalkbackHandle } from '@mega-yfue/eufy-sdk';
import type {
    AudioFormat, AuthState, DetectionClass, DoorbellInfo, LiveStreamInfo, Methods, Request, Response, TalkbackInfo, VideoCodec, WorkerConfig, WorkerEvent,
} from '../src/protocol.js';

type Device = Awaited<ReturnType<EufyMega['getDevice']>>;

const CONNECT_TIMEOUT_MS = 15_000;
const FIRST_KEYFRAME_TIMEOUT_MS = 20_000;
const AUDIO_SNIFF_MS = 1_500;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;

let client: EufyMega | undefined;
let debug = false;
let ffmpegPath = 'ffmpeg';
/** Strong references: eufy-sdk holds devices weakly and stops announcing for ones nobody keeps. */
const devices = new Map<string, Device>();
const streams = new Map<string, () => void>();
const talkbacks = new Map<string, () => Promise<void>>();

function send(message: WorkerEvent | Response) {
    process.send?.(message);
}

const log = {
    debug: (m: unknown, ...a: unknown[]) => debug && send({ event: 'log', level: 'debug', message: format(m, a) }),
    info: (m: unknown, ...a: unknown[]) => send({ event: 'log', level: 'info', message: format(m, a) }),
    warn: (m: unknown, ...a: unknown[]) => send({ event: 'log', level: 'warn', message: format(m, a) }),
    error: (m: unknown, ...a: unknown[]) => send({ event: 'log', level: 'error', message: format(m, a) }),
};

function format(m: unknown, args: unknown[]) {
    return [m, ...args].map(v => typeof v === 'string' ? v : v instanceof Error ? v.stack || v.message : safeJson(v)).join(' ');
}

function safeJson(v: unknown) {
    try {
        return JSON.stringify(v);
    }
    catch {
        return String(v);
    }
}

function setAuth(state: AuthState) {
    send({ event: 'auth', state });
}

// --- methods ---

const handlers: { [M in keyof Methods]: (params: Methods[M][0]) => Promise<Methods[M][1]> } = {
    async start(config: WorkerConfig) {
        debug = config.debug;
        ffmpegPath = config.ffmpegPath || 'ffmpeg';
        await shutdownClient();
        setAuth({ kind: 'connecting' });
        const eufy = new EufyMega({
            email: config.email,
            password: config.password,
            countryCode: config.countryCode,
            openudid: config.openudid,
            ffmpegPath: config.ffmpegPath,
            logger: log,
            store: jsonStore('session', config.session),
            pushStore: jsonStore('push', config.push),
            // A ring is nearly always followed by someone opening the stream; start the P2P handshake
            // as the push lands so the live view opens warm.
            prewarmEvents: ['doorbellPress'],
            // Battery stations sleep 30 s after the last viewer instead of the SDK's 5 min default.
            p2pIdleMs: 30_000,
        });
        client = eufy;
        wireEvents(eufy);
        await handleLogin(eufy, () => eufy.login());
    },

    async submitCode({ code }) {
        const eufy = requireClient();
        setAuth({ kind: 'connecting' });
        await handleLogin(eufy, () => eufy.submitVerifyCode(code));
    },

    async solveCaptcha({ answer }) {
        const eufy = requireClient();
        setAuth({ kind: 'connecting' });
        await handleLogin(eufy, () => eufy.solveCaptcha(answer));
    },

    async live({ sn, maxSeconds }) {
        return startLive(sn, maxSeconds);
    },

    async stopLive({ streamId }) {
        streams.get(streamId)?.();
    },

    async talkback({ sn }) {
        return startTalkback(sn);
    },

    async stopTalkback({ talkId }) {
        await talkbacks.get(talkId)?.();
    },

    async snapshot({ sn }) {
        const cam = await cameraOf(sn);
        if (!cam.snapshotStored)
            throw new Error('this camera has no stored snapshot support');
        const jpeg = await cam.snapshotStored();
        return { jpegBase64: jpeg.toString('base64') };
    },

    async setNotificationStyle({ sn, style }) {
        await cameraOf(sn);
        await requireClient().setProperty(sn, 'notificationStyle', style);
        log.info(`doorbell ${sn} notification style set to ${style}`);
    },

    async downloadRecording({ sn, recording, codec, cipherId, outPath }) {
        const cam = await cameraOf(sn);
        if (!cam.downloadRecording)
            throw new Error('this camera\'s station does not support recording download (HomeBase 2 only)');
        const started = Date.now();
        const resolved = await resolveRecording(sn, recording).catch(e => {
            log.warn(`recording index lookup failed for ${sn}: ${e instanceof Error ? e.message : e}; using the push's name`);
            return undefined;
        });
        if (resolved && (resolved.recording !== recording || resolved.cipherId !== cipherId))
            log.info(`recording ${recording} is stored on the HomeBase as ${resolved.recording} (cipher ${resolved.cipherId})`);
        const clip = await cam.downloadRecording({ recording: resolved?.recording ?? recording, cipherId: resolved?.cipherId ?? cipherId, timeoutMs: 120_000 });
        log.info(`recording ${recording} downloaded in ${Date.now() - started}ms: ${clip.durationMs}ms @ ${clip.fps}fps, ${clip.video.length} bytes video, missing ${clip.missingFrames} frames`);
        await muxRecording(clip.video, codec, clip.audio, clip.fps, outPath);
        return { durationMs: clip.durationMs, fps: clip.fps, missingFrames: clip.missingFrames, hasAudio: !!clip.audio?.length };
    },
};

const execFileAsync = promisify(execFile);

const RECORDING_MATCH_WINDOW_S = 120;

/**
 * The push names a clip by the ring time, which need not be the file the HomeBase wrote (it can start a
 * few seconds earlier or later). Ask the HomeBase's own recording index (`history_record_info`) for this
 * doorbell's clips that day and take the one starting nearest the push's time.
 */
async function resolveRecording(sn: string, pushName: string): Promise<{ recording: string; cipherId: number } | undefined> {
    const eufy = requireClient();
    const dev = devices.get(sn);
    if (!dev)
        return undefined;
    const station = dev.stationSn;
    // Private on EufyMega, but it is the only source of the account id the station's database requires.
    const accountId = (eufy as unknown as { adminUserIdOf(sn: string): string | undefined }).adminUserIdOf(station);
    const session = eufy.getP2pSessions().get(station);
    if (!accountId || !session)
        throw new Error(`no ${!accountId ? 'admin account id' : 'P2P session'} for station ${station}`);
    const day = pushName.slice(0, 8);
    const rows = await session.queryRecordPage({ accountId, startDate: day, endDate: day, startTime: '0', count: 20 });
    log.debug(`HomeBase index raw reply (${rows.length} groups): ${safeJson(rows).slice(0, 3000)}`);
    const records = collectRecords(rows).filter(r => !r.device_sn || r.device_sn === sn);
    log.debug(`HomeBase index for ${sn} on ${day}: ${safeJson(records.slice(0, 5))}`);
    const target = toEpochSeconds(pushName);
    let best: { recording: string; cipherId: number; distance: number } | undefined;
    for (const r of records) {
        const name = /(\d{14})\.dat$/.exec(String(r.storage_path ?? ''))?.[1];
        if (!name || typeof r.cipher_id !== 'number')
            continue;
        const distance = Math.abs(toEpochSeconds(name) - target);
        if (distance <= RECORDING_MATCH_WINDOW_S && (!best || distance < best.distance))
            best = { recording: name, cipherId: r.cipher_id, distance };
    }
    log.info(`HomeBase index for ${sn} on ${day}: ${records.length} clips; nearest to ${pushName}: ${best ? `${best.recording} (${best.distance}s away)` : 'none'}`);
    return best && { recording: best.recording, cipherId: best.cipherId };
}

interface RecordRow {
    device_sn?: string;
    storage_path?: unknown;
    cipher_id?: unknown;
    start_time?: unknown;
}

/** The reply groups each recording row with companion tables; walk it and keep the rows that look like recordings. */
function collectRecords(value: unknown, out: RecordRow[] = []): RecordRow[] {
    if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
        try {
            collectRecords(JSON.parse(value), out);
        }
        catch {
            // not JSON; ignore
        }
    }
    else if (Array.isArray(value)) {
        for (const v of value)
            collectRecords(v, out);
    }
    else if (value && typeof value === 'object') {
        const row = value as Record<string, unknown>;
        if (typeof row.storage_path === 'string')
            out.push(row as RecordRow);
        for (const v of Object.values(row))
            if (v && (typeof v === 'object' || typeof v === 'string'))
                collectRecords(v, out);
    }
    return out;
}

/** yyyyMMddHHmmss (station-local) → seconds, only ever compared against another name in the same zone. */
function toEpochSeconds(name: string) {
    const [y, mo, d, h, mi, se] = [0, 4, 6, 8, 10, 12].map((i, k) => Number(name.slice(i, i + (k === 0 ? 4 : 2))));
    return Date.UTC(y, mo - 1, d, h, mi, se) / 1000;
}

/** Elementary video + ADTS AAC from the HomeBase → MP4, stream-copied (the archive keeps full resolution). */
async function muxRecording(video: Buffer, codec: VideoCodec, audio: Buffer | undefined, fps: number, outPath: string) {
    const dir = await mkdtemp(path.join(tmpdir(), 'eufy-rec-'));
    try {
        const videoPath = path.join(dir, 'video.es');
        await writeFile(videoPath, video);
        const args = ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps || 15), '-f', codec === 'h265' ? 'hevc' : 'h264', '-i', videoPath];
        if (audio?.length) {
            const audioPath = path.join(dir, 'audio.aac');
            await writeFile(audioPath, audio);
            args.push('-f', 'aac', '-i', audioPath, '-map', '0:v:0', '-map', '1:a:0');
        }
        await mkdir(path.dirname(outPath), { recursive: true });
        // hvc1 tag: what Apple players (and Chrome's HEVC path) need to play H.265 in MP4.
        args.push('-c', 'copy', ...(codec === 'h265' ? ['-tag:v', 'hvc1'] : []), '-movflags', '+faststart', outPath);
        await execFileAsync(ffmpegPath, args);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
}

type LoginResult = Awaited<ReturnType<EufyMega['login']>>;

async function handleLogin(eufy: EufyMega, attempt: () => Promise<LoginResult>) {
    try {
        const result = await attempt();
        if (client !== eufy)
            return;
        if (result.status === LoginStatus.Captcha)
            return setAuth({ kind: 'needsCaptcha', image: result.image, retry: result.retry });
        if (result.status === LoginStatus.TwoFactor)
            return setAuth({ kind: 'needsCode', method: result.method });
        setAuth({ kind: 'connected' });
        await publishDoorbells(eufy);
    }
    catch (e) {
        if (client === eufy)
            setAuth({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
        throw e;
    }
}

async function publishDoorbells(eufy: EufyMega) {
    const doorbells: DoorbellInfo[] = [];
    for (const summary of await eufy.getDevices()) {
        const dev = await eufy.getDevice(summary.sn);
        // Doorbells only: other Eufy cameras on the account are left alone (never streamed or woken).
        if (!dev.has('doorbell'))
            continue;
        devices.set(dev.sn, dev);
        log.debug(`doorbell ${dev.sn} properties: ${safeJson(dev.getProperties())}`);
        const cam = dev.camera?.();
        doorbells.push({
            sn: dev.sn,
            stationSn: dev.stationSn,
            name: dev.name,
            model: dev.modelName || dev.model || 'Eufy Camera',
            hasBattery: dev.has('battery'),
            hasTalkback: !!cam?.talkback,
            batteryLevel: batteryOf(dev),
            ...notificationStyleOf(dev),
        });
        log.info(`doorbell ${dev.name} (${dev.sn}, ${dev.modelName}, station ${dev.stationSn}) capabilities: ${dev.capabilities.join(', ')}; live quality ${describeTier(dev.getProperty('streamingQuality'))}, recording quality ${describeTier(dev.getProperty('recordingQuality'))}`);
    }
    send({ event: 'doorbells', doorbells });
    markReady();
    if (debug) {
        const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        for (const sn of devices.keys())
            resolveRecording(sn, `${today}000000`).catch(e => log.debug(`index probe for ${sn} failed: ${e instanceof Error ? e.message : e}`));
    }
}

/**
 * Battery doorbells keep the style that actually governs their pushes inside the `notificationMode` (1710)
 * config, which has no verified write; others use `notificationStyle` (6020), which is writable.
 */
function notificationStyleOf(dev: Device): { notificationStyle?: number; notificationStyleWritable: boolean } {
    // getProperty() leaves config-shaped values out; the raw record in getProperties() carries them.
    const raw = dev.getProperties() as Record<string, { value?: unknown } | undefined>;
    const mode = raw.notificationMode?.value as { notification_style?: unknown } | undefined;
    if (mode && typeof mode === 'object' && typeof mode.notification_style === 'number')
        return { notificationStyle: mode.notification_style, notificationStyleWritable: false };
    const style = raw.notificationStyle?.value;
    return { notificationStyle: typeof style === 'number' ? style : undefined, notificationStyleWritable: typeof style === 'number' };
}

function describeTier(value: unknown) {
    return value === undefined ? 'unknown' : `${value}`;
}

function batteryOf(dev: Device): number | undefined {
    const level = dev.battery?.()?.level;
    return typeof level === 'number' ? level : undefined;
}

function wireEvents(eufy: EufyMega) {
    eufy.on('doorbellPress', e => e.deviceSn && send({ event: 'ring', sn: e.deviceSn }));
    eufy.on('motion', e => e.deviceSn && send({ event: 'motion', sn: e.deviceSn }));
    const detect = (className: DetectionClass, label: string) => (e: { deviceSn?: string }) =>
        e.deviceSn && send({ event: 'detection', sn: e.deviceSn, className, label });
    eufy.on('personDetected', detect('person', 'person'));
    eufy.on('strangerDetected', detect('person', 'stranger'));
    eufy.on('packageDelivered', detect('package', 'package delivered'));
    eufy.on('packageTaken', detect('package', 'package taken'));
    eufy.on('packageStranded', detect('package', 'package left unattended'));
    eufy.on('vehicleDetected', detect('vehicle', 'vehicle'));
    eufy.on('petDetection', detect('animal', 'pet'));
    eufy.on('dogDetected', detect('animal', 'dog'));
    eufy.on('batteryAlert', e => e.deviceSn && devices.has(e.deviceSn) && send({ event: 'batteryAlert', sn: e.deviceSn, state: e.state }));
    eufy.on('propertyChanged', e => {
        const dev = devices.get(e.deviceSn);
        const level = dev && batteryOf(dev);
        if (level !== undefined && /battery/i.test(e.property))
            send({ event: 'battery', sn: e.deviceSn, level });
    });
    eufy.on('push', ev => {
        log.debug(`push ${ev.eventName ?? '?'} type ${ev.eventType ?? '?'} device ${ev.deviceSn ?? '?'} cipher ${ev.cipher ?? '-'} payload ${safeJson(ev.payload)}`);
        const ref = recordingRef(ev.payload as { p?: unknown; file_path?: unknown } | undefined);
        if (ev.deviceSn && devices.has(ev.deviceSn) && ref && ev.cipher !== undefined) {
            const isRing = ev.eventType === RING_EVENT_TYPE || /doorbell|ring/i.test(ev.eventName ?? '');
            log.info(`push ${ev.eventName ?? ev.eventType} for ${ev.deviceSn} names recording ${ref.recording} (${ref.codec})`);
            send({ event: 'recordingAvailable', sn: ev.deviceSn, ...ref, cipherId: ev.cipher, isRing, at: Date.now() });
        }
    });
    eufy.on('sessionExpired', () => setAuth({ kind: 'failed', message: 'Eufy session expired or was replaced; sign in again' }));
    eufy.on('error', (e: unknown) => log.error('eufy error', e));
}

const RING_EVENT_TYPE = 3103;

/**
 * The HomeBase names a recording by its 14-digit start time. Pushes carry it as `p` on some families and as
 * `file_path` with a codec prefix (`h265_20261125200313`) on battery doorbells.
 */
function recordingRef(payload: { p?: unknown; file_path?: unknown } | undefined): { recording: string; codec: VideoCodec } | undefined {
    for (const value of [payload?.p, payload?.file_path]) {
        const match = typeof value === 'string' ? /^(?:(h26[45])_)?(\d{14})$/.exec(value) : null;
        if (match)
            return { recording: match[2], codec: match[1] === 'h265' ? 'h265' : 'h264' };
    }
    return undefined;
}

function requireClient() {
    if (!client)
        throw new Error('eufy client not started');
    return client;
}

let markReady!: () => void;
let ready = new Promise<void>(resolve => markReady = resolve);
const READY_WAIT_MS = 30_000;

/** Requests that arrive while the plugin is still signing in wait for the doorbells instead of failing. */
async function cameraOf(sn: string) {
    if (!devices.has(sn))
        await Promise.race([ready, new Promise(resolve => setTimeout(resolve, READY_WAIT_MS))]);
    const dev = devices.get(sn);
    const cam = dev?.camera?.();
    if (!cam)
        throw new Error(`no doorbell ${sn} on this account`);
    return cam;
}

/** Session/push persistence lives in Scrypted storage: the worker reports every save to the plugin. */
function jsonStore<T>(kind: 'session' | 'push', initial: unknown) {
    let value = (initial ?? null) as T | null;
    return {
        load: () => value,
        save: (v: T) => {
            value = v;
            send({ event: kind, data: v });
        },
        clear: () => {
            value = null;
            send({ event: kind, data: null });
        },
    };
}

// --- live media ---

async function startLive(sn: string, maxSeconds: number): Promise<LiveStreamInfo> {
    const cam = await cameraOf(sn);
    if (!cam.live)
        throw new Error('this camera has no live stream');
    const stream: LiveStreamConsumer = await cam.live();
    const streamId = randomUUID();
    const startedAt = Date.now();

    const videoOut = new SocketSink('video');
    const audioOut = new SocketSink('audio');
    let videoCodec: VideoCodec | undefined;
    let size: { width?: number; height?: number } = {};
    let audioFormat: AudioFormat | undefined;
    let gotKeyframe!: () => void;
    const firstKeyframe = new Promise<void>(resolve => gotKeyframe = resolve);
    let gotAudio!: () => void;
    const firstAudio = new Promise<void>(resolve => gotAudio = resolve);

    let ended = false;
    const end = (reason: string) => {
        if (ended)
            return;
        ended = true;
        streams.delete(streamId);
        stream.stop();
        videoOut.close();
        audioOut.close();
        log.info(`live ${sn} ended after ${Math.round((Date.now() - startedAt) / 1000)}s: ${reason}`);
        send({ event: 'streamEnded', streamId, reason });
    };
    streams.set(streamId, () => end('stopped by plugin'));

    stream.on('video', frame => {
        if (!videoCodec) {
            if (!frame.keyframe)
                return;
            if (frame.codec !== 'h264' && frame.codec !== 'h265') {
                end(`unsupported video codec ${frame.codec}`);
                return;
            }
            videoCodec = frame.codec;
            size = { width: frame.width, height: frame.height };
            gotKeyframe();
        }
        videoOut.write(frame.data);
    });
    stream.on('audio', frame => {
        if (!audioFormat) {
            if (frame.codec !== 'aac-lc' && frame.codec !== 'g711a')
                return; // aac-eld has no container ffmpeg can read from a raw socket; video still plays
            audioFormat = frame.codec;
            gotAudio();
        }
        if (frame.codec === audioFormat)
            audioOut.write(frame.data);
    });
    stream.on('video-config', config => log.debug(`live ${sn} video config ${config.codec} ${config.width}x${config.height}`));
    stream.on('error', err => end(`stream error: ${err.message}`));
    stream.on('stop', () => end('camera stopped streaming'));
    stream.on('budget', notice => {
        const elapsed = (Date.now() - startedAt) / 1000;
        // The budget belongs to the shared pull, which may predate this consumer. This consumer only exists
        // while its viewer is connecting or watching (a disconnect stops it), so keep extending up to maxSeconds.
        if (elapsed < maxSeconds) {
            log.debug(`live ${sn} battery budget reached at ${Math.round(elapsed)}s, extending`);
            notice.extend();
        }
        else {
            log.info(`live ${sn} reached the ${maxSeconds}s live view cap, letting the camera sleep`);
        }
    });

    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no keyframe within ${FIRST_KEYFRAME_TIMEOUT_MS / 1000}s`)), FIRST_KEYFRAME_TIMEOUT_MS));
    try {
        await Promise.race([firstKeyframe, timeout]);
        await Promise.race([firstAudio, new Promise(resolve => setTimeout(resolve, AUDIO_SNIFF_MS))]);
    }
    catch (e) {
        end((e as Error).message);
        throw e;
    }
    if (ended)
        throw new Error('stream ended before it could be served');

    const videoUrl = await videoOut.listen(() => end('viewer disconnected'));
    const audioUrl = audioFormat ? await audioOut.listen(() => { }) : undefined;
    if (!audioFormat)
        audioOut.close();

    log.info(`live ${sn} serving ${videoCodec} ${size.width}x${size.height}, audio ${audioFormat ?? 'none'} (first keyframe after ${Date.now() - startedAt}ms)`);
    return {
        streamId,
        video: { url: videoUrl, codec: videoCodec!, ...size },
        audio: audioUrl ? { url: audioUrl, format: audioFormat! } : undefined,
    };
}

/**
 * Buffers media from the first keyframe until the plugin's ffmpeg connects, then streams straight through.
 * One client only; the server closes as soon as it is accepted.
 */
class SocketSink {
    private socket?: net.Socket;
    private server?: net.Server;
    private buffered: Buffer[] = [];
    private bufferedBytes = 0;
    private closed = false;

    constructor(private readonly label: string) {
    }

    get connected() {
        return !!this.socket && !this.socket.destroyed;
    }

    write(data: Buffer) {
        if (this.closed)
            return;
        if (this.socket) {
            this.socket.write(data);
            return;
        }
        this.buffered.push(data);
        this.bufferedBytes += data.length;
        if (this.bufferedBytes > MAX_BUFFERED_BYTES) {
            this.buffered = [];
            this.bufferedBytes = 0;
        }
    }

    listen(onDisconnect: () => void): Promise<string> {
        return new Promise((resolve, reject) => {
            const server = net.createServer();
            this.server = server;
            const timeout = setTimeout(() => {
                log.warn(`${this.label}: nobody connected within ${CONNECT_TIMEOUT_MS / 1000}s`);
                this.close();
                onDisconnect();
            }, CONNECT_TIMEOUT_MS);
            server.once('connection', socket => {
                clearTimeout(timeout);
                server.close();
                socket.setNoDelay(true);
                socket.on('error', e => log.debug(`${this.label} socket: ${e.message}`));
                socket.once('close', () => {
                    if (!this.closed)
                        onDisconnect();
                });
                this.socket = socket;
                for (const chunk of this.buffered)
                    socket.write(chunk);
                this.buffered = [];
            });
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => resolve(`tcp://127.0.0.1:${(server.address() as net.AddressInfo).port}`));
        });
    }

    close() {
        this.closed = true;
        this.server?.close();
        this.socket?.end();
        this.buffered = [];
    }
}

// --- talkback ---

async function startTalkback(sn: string): Promise<TalkbackInfo> {
    const cam = await cameraOf(sn);
    if (!cam.talkback || !cam.live)
        throw new Error('this camera has no speaker');
    // The doorbell only plays host audio while it is actually streaming; behind a HomeBase the station
    // acknowledges talkback frames either way, so audio sent before the doorbell wakes is silently lost.
    // Hold a live pull and wait for its first keyframe (proof the doorbell is up) before talking.
    const started = Date.now();
    const keepAwake: LiveStreamConsumer = await cam.live();
    keepAwake.on('error', err => log.warn(`talkback ${sn} live hold: ${err.message}`));
    keepAwake.on('budget', notice => notice.extend());
    try {
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`doorbell did not wake within ${FIRST_KEYFRAME_TIMEOUT_MS / 1000}s`)), FIRST_KEYFRAME_TIMEOUT_MS);
            keepAwake.on('video', frame => {
                if (frame.keyframe) {
                    clearTimeout(timer);
                    resolve();
                }
            });
        });
    }
    catch (e) {
        keepAwake.stop();
        throw e;
    }
    log.info(`talkback ${sn}: doorbell awake after ${Date.now() - started}ms`);
    let talk: TalkbackHandle;
    try {
        talk = await cam.talkback();
    }
    catch (e) {
        keepAwake.stop();
        throw e;
    }
    if (talk.codec !== 'aac-lc') {
        await talk.stop();
        keepAwake.stop();
        throw new Error(`speaker codec ${talk.codec} is not supported (needs an AAC-ELD encoder)`);
    }
    const talkId = randomUUID();
    let socket: net.Socket | undefined;
    const server = net.createServer();
    let stopped = false;
    const stop = async (reason: string) => {
        if (stopped)
            return;
        stopped = true;
        talkbacks.delete(talkId);
        server.close();
        socket?.destroy();
        await talk.stop().catch(() => { });
        keepAwake.stop();
        log.info(`talkback ${sn} ended: ${reason}`);
        send({ event: 'talkbackEnded', talkId, reason });
    };
    talkbacks.set(talkId, () => stop('stopped by plugin'));
    talk.on('error', err => log.warn(`talkback ${sn}: ${err.message}`));
    talk.on('finished', () => stop('input finished'));

    const timeout = setTimeout(() => stop('encoder never connected'), CONNECT_TIMEOUT_MS);
    server.once('connection', s => {
        clearTimeout(timeout);
        server.close();
        socket = s;
        s.setNoDelay(true);
        s.on('error', e => log.debug(`talkback socket: ${e.message}`));
        s.pipe(talk.writable());
    });
    const url = await new Promise<string>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(`tcp://127.0.0.1:${(server.address() as net.AddressInfo).port}`));
    });
    log.info(`talkback ${sn} open (speaker codec ${talk.codec})`);
    return { talkId, url };
}

// --- lifecycle ---

async function shutdownClient() {
    for (const stop of streams.values())
        stop();
    for (const stop of talkbacks.values())
        await stop();
    devices.clear();
    ready = new Promise<void>(resolve => markReady = resolve);
    const old = client;
    client = undefined;
    if (old) {
        old.removeAllListeners?.();
        await old.disconnect().catch(() => { });
    }
}

process.on('message', async (raw: unknown) => {
    const request = raw as Request;
    const handler = handlers[request.method] as (params: unknown) => Promise<unknown>;
    if (!handler) {
        send({ id: request.id, ok: false, error: `unknown method ${String(request.method)}` });
        return;
    }
    try {
        const result = await handler(request.params);
        send({ id: request.id, ok: true, result });
    }
    catch (e) {
        send({ id: request.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
});

// The worker must never outlive the plugin: an orphan keeps the same eufy identity and push credentials,
// and two of those knock each other's push connection off (no ring events) and race for media.
let exiting = false;
function exitWithParent(reason: string) {
    if (exiting)
        return;
    exiting = true;
    log.info(`worker exiting: ${reason}`);
    setTimeout(() => process.exit(0), 3_000).unref();
    shutdownClient().finally(() => process.exit(0));
}
process.on('disconnect', () => exitWithParent('plugin disconnected'));
const parentPid = process.ppid;
setInterval(() => {
    if (!process.connected || process.ppid !== parentPid)
        exitWithParent('plugin process is gone');
}, 5_000).unref();
process.on('uncaughtException', e => log.error('worker uncaught exception', e));
process.on('unhandledRejection', e => log.error('worker unhandled rejection', e));

log.info(`eufy worker ready on node ${process.version}`);
