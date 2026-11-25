import { ChildProcess, fork } from 'child_process';
import { EventEmitter } from 'events';
import type { Method, Methods, Response, WorkerEvent, WorkerMessage } from './protocol';
import { ensureNodeRuntime, installWorker, WorkerBundle } from './node-runtime';

type EventMap = { [E in WorkerEvent as E['event']]: [E] };

const CALL_TIMEOUT_MS = 60_000;
const RESTART_DELAY_MS = 5_000;

/**
 * Supervises the Node 24 eufy worker: provisions it, restarts it if it dies, and gives the plugin a typed
 * request/response API plus typed events. `onRestart` re-sends the start config so a crash recovers on its own.
 */
export class WorkerHost extends EventEmitter<EventMap> {
    private child?: ChildProcess;
    private nextId = 1;
    private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    private ready?: Promise<void>;
    private disposed = false;

    constructor(
        private readonly volume: string,
        private readonly bundle: WorkerBundle,
        private readonly console: Console,
        private readonly onRestart: () => void,
    ) {
        super();
    }

    call<M extends Method>(method: M, params: Methods[M][0]): Promise<Methods[M][1]> {
        return this.ensureRunning().then(() => new Promise<Methods[M][1]>((resolve, reject) => {
            const id = this.nextId++;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`worker call ${method} timed out`));
            }, CALL_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            this.child!.send({ id, method, params });
        }));
    }

    /** Provision and launch eagerly so runtime problems surface in the console before anyone signs in. */
    warm() {
        this.ensureRunning().catch(e => this.console.error('eufy worker failed to start', e));
    }

    dispose() {
        this.disposed = true;
        this.child?.kill();
    }

    private ensureRunning(): Promise<void> {
        if (!this.ready) {
            this.ready = this.spawn().catch(e => {
                this.ready = undefined;
                throw e;
            });
        }
        return this.ready;
    }

    private async spawn() {
        const runtime = await ensureNodeRuntime(this.volume, this.console);
        const entry = await installWorker(this.volume, runtime, this.bundle, this.console);
        const child = fork(entry, [], {
            execPath: runtime.node,
            execArgv: [],
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            serialization: 'json',
        });
        this.child = child;
        child.stdout!.on('data', d => this.console.log('[worker]', d.toString().trimEnd()));
        child.stderr!.on('data', d => this.console.warn('[worker]', d.toString().trimEnd()));
        child.on('message', (message: WorkerMessage) => this.onMessage(message));
        child.once('exit', (code, signal) => {
            this.console.warn(`eufy worker exited (code ${code}, signal ${signal})`);
            if (this.child === child)
                this.child = undefined;
            this.ready = undefined;
            for (const [, call] of this.pending) {
                clearTimeout(call.timer);
                call.reject(new Error('eufy worker exited'));
            }
            this.pending.clear();
            if (!this.disposed)
                setTimeout(() => !this.disposed && this.onRestart(), RESTART_DELAY_MS);
        });
        await new Promise<void>((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', reject);
        });
    }

    private onMessage(message: WorkerMessage) {
        if ('id' in message) {
            const call = this.pending.get(message.id);
            if (!call)
                return;
            this.pending.delete(message.id);
            clearTimeout(call.timer);
            const response = message as Response;
            if (response.ok)
                call.resolve(response.result);
            else
                call.reject(new Error(response.error));
            return;
        }
        (this.emit as (event: string, payload: WorkerEvent) => boolean)(message.event, message);
    }
}
