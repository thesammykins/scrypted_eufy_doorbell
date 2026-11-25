/**
 * IPC contract between the Scrypted plugin (server's Node 22) and the eufy worker (Node 24, eufy-sdk).
 * Types only: both sides compile against this file, so a change here breaks both builds together.
 */

export type VideoCodec = 'h264' | 'h265';
/** Audio formats the worker forwards as-is; anything else (aac-eld) is dropped and reported as no audio. */
export type AudioFormat = 'aac-lc' | 'g711a';

export interface WorkerConfig {
    email: string;
    password: string;
    countryCode: string;
    /** Stable per-install identity, so this client never evicts the phone app's session (or vice versa). */
    openudid: string;
    session?: unknown;
    push?: unknown;
    ffmpegPath: string;
    debug: boolean;
}

export type AuthState =
    | { kind: 'signedOut' }
    | { kind: 'connecting' }
    | { kind: 'needsCode'; method: string }
    | { kind: 'needsCaptcha'; image: string; retry: boolean }
    | { kind: 'connected' }
    | { kind: 'failed'; message: string };

export type DetectionClass = 'person' | 'package' | 'vehicle' | 'animal';

export interface DoorbellInfo {
    sn: string;
    stationSn: string;
    name: string;
    model: string;
    hasBattery: boolean;
    hasTalkback: boolean;
    batteryLevel?: number;
}

export interface LiveStreamInfo {
    streamId: string;
    video: { url: string; codec: VideoCodec; width?: number; height?: number };
    audio?: { url: string; format: AudioFormat };
}

export interface TalkbackInfo {
    talkId: string;
    /** The worker listens here; the plugin's encoder connects and writes 16 kHz mono AAC-LC ADTS. */
    url: string;
}

export interface Methods {
    start: [WorkerConfig, void];
    submitCode: [{ code: string }, void];
    solveCaptcha: [{ answer: string }, void];
    live: [{ sn: string; maxSeconds: number }, LiveStreamInfo];
    stopLive: [{ streamId: string }, void];
    talkback: [{ sn: string }, TalkbackInfo];
    stopTalkback: [{ talkId: string }, void];
    snapshot: [{ sn: string }, { jpegBase64: string }];
    /** Fetch the clip Eufy itself recorded on the HomeBase and mux it to MP4 at `outPath`. Never wakes the camera. */
    downloadRecording: [{ sn: string; recording: string; cipherId: number; outPath: string }, RecordingResult];
}

export interface RecordingResult {
    durationMs: number;
    fps: number;
    missingFrames: number;
    hasAudio: boolean;
}

export type Method = keyof Methods;

export type Request = { [M in Method]: { id: number; method: M; params: Methods[M][0] } }[Method];

export type Response =
    | { id: number; ok: true; result: unknown }
    | { id: number; ok: false; error: string };

export type WorkerEvent =
    | { event: 'auth'; state: AuthState }
    | { event: 'session'; data: unknown | null }
    | { event: 'push'; data: unknown | null }
    | { event: 'doorbells'; doorbells: DoorbellInfo[] }
    | { event: 'ring'; sn: string }
    | { event: 'motion'; sn: string }
    /** Eufy's own on-camera classification for an event. */
    | { event: 'detection'; sn: string; className: DetectionClass; label: string }
    | { event: 'battery'; sn: string; level: number }
    /** An event push named a recording the HomeBase is storing; `eventName` is the SDK's semantic name. */
    | { event: 'recordingAvailable'; sn: string; recording: string; cipherId: number; eventName?: string; at: number }
    | { event: 'streamEnded'; streamId: string; reason: string }
    | { event: 'talkbackEnded'; talkId: string; reason: string }
    | { event: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };

export type WorkerMessage = Response | WorkerEvent;
