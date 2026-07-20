import { ErlcApiError } from "./client.js";
export class EmergencyCallAdapter {
    client;
    store;
    intervalMs;
    onEmergency;
    onJoinLog;
    onError;
    timer = null;
    polling = false;
    running = false;
    constructor(client, store, intervalMs, onEmergency, onJoinLog, onError) {
        this.client = client;
        this.store = store;
        this.intervalMs = intervalMs;
        this.onEmergency = onEmergency;
        this.onJoinLog = onJoinLog;
        this.onError = onError;
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        void this.poll();
    }
    stop() {
        this.running = false;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
    }
    async ingest(call) {
        const key = this.key(call);
        const seen = this.store.settings.get().seenErlcEmergencyIds;
        if (seen.includes(key))
            return false;
        await this.onEmergency(call);
        await this.store.settings.update((settings) => {
            if (!settings.seenErlcEmergencyIds.includes(key))
                settings.seenErlcEmergencyIds.push(key);
            if (settings.seenErlcEmergencyIds.length > 500)
                settings.seenErlcEmergencyIds.splice(0, settings.seenErlcEmergencyIds.length - 500);
        });
        return true;
    }
    async poll() {
        if (this.polling || !this.running)
            return;
        this.polling = true;
        let nextDelay = this.intervalMs;
        try {
            const info = await this.client.fetchServerInfo({ players: true, joinLogs: true, emergencyCalls: true });
            if (this.store.settings.get().lastErlcAuthWarningAt) {
                await this.store.settings.update((settings) => { settings.lastErlcAuthWarningAt = null; });
            }
            for (const call of info.EmergencyCalls ?? [])
                await this.ingest(call);
            const previousTimestamp = this.store.settings.get().lastJoinLogTimestamp;
            const joinLogs = (info.JoinLogs ?? []).filter((log) => log.Timestamp > previousTimestamp).sort((a, b) => a.Timestamp - b.Timestamp);
            for (const log of joinLogs)
                await this.onJoinLog(log);
            const newest = Math.max(previousTimestamp, ...joinLogs.map((log) => log.Timestamp));
            if (newest > previousTimestamp)
                await this.store.settings.update((settings) => { settings.lastJoinLogTimestamp = newest; });
        }
        catch (error) {
            if (error instanceof ErlcApiError && error.status === 403) {
                this.running = false;
                const lastWarning = this.store.settings.get().lastErlcAuthWarningAt;
                if (!lastWarning || Date.now() - Date.parse(lastWarning) >= 3_600_000) {
                    await this.store.settings.update((settings) => { settings.lastErlcAuthWarningAt = new Date().toISOString(); });
                    await this.onError(error);
                }
                return;
            }
            if (error instanceof ErlcApiError && error.status === 429)
                nextDelay = error.retryAfterMs ?? this.intervalMs;
            await this.onError(error instanceof Error ? error : new Error("Unknown ER:LC polling error."));
        }
        finally {
            this.polling = false;
            if (this.running) {
                this.timer = setTimeout(() => { void this.poll(); }, nextDelay);
                this.timer.unref();
            }
        }
    }
    key(call) {
        return `erlc:${call.CallNumber}:${call.StartedAt}`;
    }
}
