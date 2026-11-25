import sdk, { Notifier, ScryptedInterface } from '@scrypted/sdk';

const { systemManager } = sdk;

// Re-arm only after a real recharge, so a reading that wobbles around the threshold alerts once, not daily.
const REARM_MARGIN = 10;

export interface BatteryAlertPolicy {
    threshold(): number;
    notifierIds(): string[];
    /** Persisted per doorbell so a plugin restart doesn't re-send an alert already sent. */
    alerted(sn: string): boolean;
    setAlerted(sn: string, alerted: boolean): void;
}

/** Notifies the chosen Scrypted notifiers once when a doorbell's battery drops to the threshold. */
export class BatteryAlerts {
    constructor(private readonly policy: BatteryAlertPolicy, private readonly console: Console) {
    }

    onLevel(sn: string, name: string, level: number) {
        const threshold = this.policy.threshold();
        if (level > threshold + REARM_MARGIN && this.policy.alerted(sn)) {
            this.policy.setAlerted(sn, false);
            this.console.log(`${name} battery back to ${level}%, low-battery alert re-armed`);
        }
        else if (level <= threshold && !this.policy.alerted(sn)) {
            this.policy.setAlerted(sn, true);
            this.send(`${name} battery low`, `${level}% left. Charge the doorbell soon.`);
        }
    }

    /** Eufy's own battery push (low / overheating). Sent every time: Eufy already rate-limits these. */
    onEufyAlert(name: string, state: 'low' | 'hot' | 'full' | undefined) {
        if (state === 'hot')
            this.send(`${name} battery too hot`, 'Eufy reports the doorbell battery is overheating.');
        else if (state === 'low')
            this.send(`${name} battery low`, 'Eufy reports the doorbell battery is low.');
    }

    private send(title: string, body: string) {
        const ids = this.policy.notifierIds();
        this.console.log(`battery alert: ${title}: ${body} (${ids.length} notifier${ids.length === 1 ? '' : 's'})`);
        for (const id of ids) {
            const notifier = systemManager.getDeviceById<Notifier>(id);
            if (!notifier?.interfaces?.includes(ScryptedInterface.Notifier)) {
                this.console.warn(`battery alert: notifier ${id} is gone`);
                continue;
            }
            notifier.sendNotification(title, { body }).catch(e => this.console.error(`battery alert via ${notifier.name} failed`, e));
        }
    }
}
