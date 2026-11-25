import sdk, {
    Device, DeviceProvider, ScryptedDeviceBase, ScryptedDeviceType, ScryptedInterface, Setting, Settings, SettingValue,
} from '@scrypted/sdk';
import { StorageSettings } from '@scrypted/sdk/storage-settings';
import { randomBytes } from 'crypto';
import { RecordingArchive } from './archive';
import { BatteryAlerts } from './battery-alert';
import { h264EncoderArgs } from './encoder';
import type { H264Transcode } from './media';
import { viewFor } from './lenses';
import { EufyDoorbell } from './doorbell';
import { ThumbnailStore } from './stills';
import workerBundle from './generated/worker.json';
import type { AuthState, DoorbellInfo } from './protocol';
import { WorkerHost } from './worker-host';

const { deviceManager, mediaManager } = sdk;

const NOTIFICATION_STYLES: Record<number, string> = {
    1: 'Text Only',
    2: 'Included Thumbnail',
    3: 'Text First, Then Thumbnail',
};

class EufyPlugin extends ScryptedDeviceBase implements DeviceProvider, Settings {
    private readonly cameras = new Map<string, EufyDoorbell>();
    private readonly worker: WorkerHost;
    private readonly archive: RecordingArchive;
    private readonly thumbnails: ThumbnailStore;
    private readonly batteryAlerts: BatteryAlerts;
    private readonly doorbells = new Map<string, DoorbellInfo>();
    private auth: AuthState = { kind: 'signedOut' };

    readonly storageSettings = new StorageSettings(this, {
        status: {
            title: 'Status',
            readonly: true,
            noStore: true,
            onGet: async () => ({ defaultValue: describe(this.auth) }),
        },
        email: {
            title: 'Email',
            onPut: () => this.start(),
        },
        password: {
            title: 'Password',
            type: 'password',
            onPut: () => this.start(),
        },
        country: {
            title: 'Country',
            description: 'Two-letter code of the country the Eufy account is registered in.',
            defaultValue: 'AU',
            onPut: () => this.start(),
        },
        verificationCode: {
            title: 'Verification Code',
            noStore: true,
            onGet: async () => ({ hide: this.auth.kind !== 'needsCode' }),
            onPut: (_: unknown, code: unknown) => this.run('verification', () => this.worker.call('submitCode', { code: String(code).trim() })),
        },
        captchaImage: {
            title: 'Captcha',
            type: 'html',
            readonly: true,
            noStore: true,
            onGet: async () => this.auth.kind === 'needsCaptcha'
                ? { hide: false, defaultValue: `<img src="${this.auth.image}" style="background:white">` }
                : { hide: true },
        },
        captchaAnswer: {
            title: 'Captcha Answer',
            noStore: true,
            onGet: async () => ({ hide: this.auth.kind !== 'needsCaptcha' }),
            onPut: (_: unknown, answer: unknown) => this.run('captcha', () => this.worker.call('solveCaptcha', { answer: String(answer).trim() })),
        },
        maxLiveSeconds: {
            title: 'Max Live View (seconds)',
            description: 'A battery camera goes back to sleep after this long even if someone is still watching.',
            type: 'number',
            defaultValue: 300,
            group: 'Advanced',
        },
        archiveMotion: {
            title: 'Archive Motion Clips',
            description: 'Ring clips are always copied off the HomeBase. Turn on to keep motion clips too.',
            type: 'boolean',
            group: 'Recordings',
        },
        retentionDays: {
            title: 'Keep Clips (days)',
            type: 'number',
            defaultValue: 30,
            group: 'Recordings',
        },
        downloadDelaySeconds: {
            title: 'Download Delay (seconds)',
            description: 'Wait this long after an event so Eufy has finished writing the clip.',
            type: 'number',
            defaultValue: 45,
            group: 'Recordings',
        },
        notificationStyle: {
            title: 'Eufy Notification Style',
            choices: Object.values(NOTIFICATION_STYLES),
            noStore: true,
            onGet: async () => {
                const doorbell = this.doorbells.values().next().value;
                const style = doorbell?.notificationStyle;
                return {
                    hide: style === undefined,
                    defaultValue: style !== undefined ? NOTIFICATION_STYLES[style] : undefined,
                    readonly: !doorbell?.notificationStyleWritable,
                    description: doorbell?.notificationStyleWritable
                        ? 'Text Only pushes carry no thumbnail or clip. Also changes the Eufy app\'s notifications.'
                        : 'Change this in the Eufy app (doorbell > Notifications). Text Only pushes carry no thumbnail or clip, so snapshots and ring clips need a thumbnail style.',
                };
            },
            onPut: (_: unknown, value: unknown) => {
                const style = Number(Object.entries(NOTIFICATION_STYLES).find(([, name]) => name === value)?.[0]);
                if (!style)
                    return;
                for (const info of [...this.doorbells.values()].filter(d => d.notificationStyleWritable)) {
                    this.worker.call('setNotificationStyle', { sn: info.sn, style })
                        .then(() => info.notificationStyle = style)
                        .catch(e => this.console.error(`setting ${info.name} notification style failed`, e));
                }
            },
        },
        lowBatteryThreshold: {
            title: 'Low Battery Alert (%)',
            type: 'number',
            defaultValue: 20,
            group: 'Battery',
        },
        batteryNotifiers: {
            title: 'Send Low Battery Alerts To',
            type: 'device',
            multiple: true,
            deviceFilter: `interfaces.includes('${ScryptedInterface.Notifier}')`,
            group: 'Battery',
        },
        h264EncoderArguments: {
            title: 'H.264 Encoder Override',
            description: 'ffmpeg encoder arguments. Leave empty to use the GPU (NVENC) when available, else libx264.',
            group: 'Advanced',
        },
        debugLogging: {
            title: 'Debug Logging',
            type: 'boolean',
            group: 'Advanced',
            onPut: () => this.start(),
        },
        // Internal state, never shown: this install's identity and the persisted eufy session/push credentials.
        openudid: { hide: true },
        session: { hide: true, json: true },
        batteryAlerted: { hide: true, json: true },
        push: { hide: true, json: true },
    });

    constructor(nativeId?: string) {
        super(nativeId);
        const volume = process.env.SCRYPTED_PLUGIN_VOLUME;
        if (!volume)
            throw new Error('SCRYPTED_PLUGIN_VOLUME is not set');
        this.worker = new WorkerHost(volume, workerBundle, this.console, () => this.start());
        this.thumbnails = new ThumbnailStore(volume);
        this.batteryAlerts = new BatteryAlerts({
            threshold: () => Number(this.storageSettings.values.lowBatteryThreshold) || 20,
            notifierIds: () => [this.storageSettings.values.batteryNotifiers ?? []].flat().filter(Boolean),
            alerted: sn => !!(this.storageSettings.values.batteryAlerted || {})[sn],
            setAlerted: (sn, alerted) => this.storageSettings.values.batteryAlerted = { ...(this.storageSettings.values.batteryAlerted || {}), [sn]: alerted },
        }, this.console);
        this.archive = new RecordingArchive(volume, this.worker, {
            archiveMotion: () => !!this.storageSettings.values.archiveMotion,
            retentionDays: () => Number(this.storageSettings.values.retentionDays) || 30,
            downloadDelaySeconds: () => Number(this.storageSettings.values.downloadDelaySeconds) || 45,
            transcode: () => this.transcode(),
        }, this.console);
        this.wireWorker();
        this.worker.warm();
        if (!this.storageSettings.values.openudid)
            this.storageSettings.values.openudid = randomBytes(16).toString('hex');
        this.start();
    }

    async getSettings(): Promise<Setting[]> {
        return this.storageSettings.getSettings();
    }

    async putSetting(key: string, value: SettingValue): Promise<void> {
        await this.storageSettings.putSetting(key, value);
    }

    async getDevice(nativeId: string) {
        return this.getCamera(nativeId);
    }

    async releaseDevice(_id: string, nativeId: string) {
        await this.cameras.get(nativeId)?.stopIntercom();
        this.cameras.delete(nativeId);
    }

    private getCamera(nativeId: string) {
        let camera = this.cameras.get(nativeId);
        if (!camera) {
            camera = new EufyDoorbell(nativeId, {
                worker: this.worker,
                archive: this.archive,
                thumbnails: this.thumbnails,
                maxLiveSeconds: () => Number(this.storageSettings.values.maxLiveSeconds) || 300,
                transcode: () => this.transcode(),
            });
            this.cameras.set(nativeId, camera);
        }
        return camera;
    }

    private async transcode(): Promise<H264Transcode> {
        const ffmpegPath = await mediaManager.getFFmpegPath();
        return { ffmpegPath, encoderArgs: await h264EncoderArgs(ffmpegPath, this.storageSettings.values.h264EncoderArguments, this.console) };
    }

    /** Events only reach doorbells Scrypted already knows about. */
    private knownDoorbell(sn: string) {
        return deviceManager.getNativeIds().includes(sn) ? this.getCamera(sn) : undefined;
    }

    private start() {
        const v = this.storageSettings.values;
        if (!v.email || !v.password) {
            this.setAuth({ kind: 'signedOut' });
            return;
        }
        this.run('sign-in', async () => this.worker.call('start', {
            email: v.email,
            password: v.password,
            countryCode: String(v.country || 'AU').toUpperCase(),
            openudid: v.openudid,
            session: v.session || undefined,
            push: v.push || undefined,
            ffmpegPath: await mediaManager.getFFmpegPath(),
            debug: !!v.debugLogging,
        }));
    }

    private run(label: string, task: () => Promise<unknown>) {
        task().catch(e => {
            this.console.error(`${label} failed`, e);
            this.setAuth({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
        });
    }

    private setAuth(state: AuthState) {
        this.auth = state;
        this.console.log(`account: ${describe(state)}`);
        this.onDeviceEvent(ScryptedInterface.Settings, undefined);
    }

    private wireWorker() {
        const w = this.worker;
        w.on('auth', e => this.setAuth(e.state));
        w.on('session', e => this.storageSettings.values.session = e.data ?? '');
        w.on('push', e => this.storageSettings.values.push = e.data ?? '');
        w.on('doorbells', e => this.discover(e.doorbells));
        w.on('ring', e => {
            this.archive.onRing(e.sn);
            this.knownDoorbell(e.sn)?.onRing();
        });
        w.on('motion', e => this.knownDoorbell(e.sn)?.onMotion());
        w.on('detection', e => this.knownDoorbell(e.sn)?.onDetection(e.className, e.label));
        w.on('battery', e => {
            this.knownDoorbell(e.sn)?.onBattery(e.level);
            this.batteryAlerts.onLevel(e.sn, this.doorbells.get(e.sn)?.name ?? e.sn, e.level);
        });
        w.on('batteryAlert', e => this.batteryAlerts.onEufyAlert(this.doorbells.get(e.sn)?.name ?? e.sn, e.state));
        w.on('talkbackEnded', e => {
            for (const camera of this.cameras.values())
                camera.onTalkbackEnded(e.talkId, e.reason);
        });
        w.on('streamEnded', e => this.console.log(`stream ${e.streamId.slice(0, 8)} ended: ${e.reason}`));
        w.on('log', e => {
            const line = `[eufy] ${e.message}`;
            if (e.level === 'error')
                this.console.error(line);
            else if (e.level === 'warn')
                this.console.warn(line);
            else
                this.console.log(line);
        });
    }

    private async discover(doorbells: DoorbellInfo[]) {
        const devices: Device[] = [];
        for (const info of doorbells) {
            devices.push({
                nativeId: info.sn,
                name: info.name,
                type: ScryptedDeviceType.Doorbell,
                interfaces: [
                    ScryptedInterface.VideoCamera,
                    ScryptedInterface.Camera,
                    ScryptedInterface.BinarySensor,
                    ScryptedInterface.MotionSensor,
                    ScryptedInterface.Online,
                    ScryptedInterface.VideoClips,
                    // What Scrypted NVR needs to list and play events (it seeks the recording to the event's time).
                    ScryptedInterface.VideoRecorder,
                    ScryptedInterface.EventRecorder,
                    ScryptedInterface.ObjectDetector,
                    ...(info.hasTalkback ? [ScryptedInterface.Intercom] : []),
                    // Battery is also what tells Rebroadcast not to prebuffer (keep the doorbell awake) by default.
                    ...(info.hasBattery ? [ScryptedInterface.Battery] : []),
                ],
                info: { manufacturer: 'Eufy', model: info.model, serialNumber: info.sn },
            });
        }
        // onDevicesChanged also removes devices no longer listed (non-doorbell cameras, per-lens devices).
        await deviceManager.onDevicesChanged({ devices });
        for (const info of doorbells) {
            this.console.log(`doorbell ${info.name} (${info.model}, ${info.sn}) battery=${info.hasBattery} talkback=${info.hasTalkback} view=${viewFor(info.sn)?.name ?? 'single lens'}`);
            this.getCamera(info.sn).update(info);
            this.doorbells.set(info.sn, info);
            if (info.batteryLevel !== undefined)
                this.batteryAlerts.onLevel(info.sn, info.name, info.batteryLevel);
        }
        for (const info of doorbells)
            this.archive.start(info.sn);
    }
}

function describe(state: AuthState) {
    switch (state.kind) {
        case 'signedOut': return 'Enter your Eufy email and password';
        case 'connecting': return 'Connecting…';
        case 'needsCode': return `Enter the verification code Eufy sent (${state.method})`;
        case 'needsCaptcha': return state.retry ? 'Wrong captcha, try the new one' : 'Solve the captcha';
        case 'connected': return 'Connected';
        case 'failed': return `Failed: ${state.message}`;
    }
}

export default EufyPlugin;
