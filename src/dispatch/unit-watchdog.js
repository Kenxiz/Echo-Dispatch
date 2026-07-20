import { speakCallsign } from "../utils/radio.js";

export class UnitWatchdog {
  timer = null;
  running = false;
  constructor(config, calls, units, voice, text) {
    this.config = config;
    this.calls = calls;
    this.units = units;
    this.voice = voice;
    this.text = text;
  }
  start() {
    if (this.running) return;
    this.running = true;
    const interval = Math.max(15_000, Math.min(60_000, Math.floor(this.config.UNIT_WATCHDOG_SECOND_MS / 2)));
    this.timer = setInterval(
      () => void this.check().catch((error) => this.text.warning(`Unit watchdog: ${error.message}`)),
      interval,
    );
    this.timer.unref?.();
  }
  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  async check(now = Date.now()) {
    for (const call of this.calls.list()) {
      if (!call.assignedUnits.length || !["ACTIVE", "CODE_4"].includes(call.status)) continue;
      const idleMs = now - new Date(call.lastActivityAt ?? call.createdAt).getTime();
      const locationContext = call.assignedUnits
        .map((callsign) => {
          const unit = this.units.getByCallsign?.(callsign);
          return unit?.location ? `${speakCallsign(callsign)} last shown ${unit.location}` : speakCallsign(callsign);
        })
        .join(", ");
      if (call.watchdogLevel === 0 && idleMs >= this.config.UNIT_WATCHDOG_FIRST_MS) {
        const traffic = `${locationContext}, dispatch requesting status on ${call.id}.`;
        await this.calls.setWatchdogLevel(call.id, 1, "First automated status check.");
        await this.voice.announce(traffic, false, "ROUTINE_REPLY");
      } else if (call.watchdogLevel === 1 && idleMs >= this.config.UNIT_WATCHDOG_SECOND_MS) {
        const traffic = `${locationContext}, second request for status. Advise when able.`;
        await this.calls.setWatchdogLevel(call.id, 2, "Second automated status check.");
        await this.voice.announce(traffic, true, "UNIT_EMERGENCY");
      } else if (call.watchdogLevel === 2 && idleMs >= this.config.UNIT_WATCHDOG_SECOND_MS) {
        const supervisor = this.units
          .list()
          .find((unit) =>
            /\b(?:sergeant|lieutenant|captain|chief|supervisor)\b/i.test(`${unit.rank} ${unit.division}`),
          );
        await this.calls.setWatchdogLevel(call.id, 3, "No response to two status checks; supervisor notified.");
        await (this.text.situation?.(
          `Supervisor notification: no response from ${call.assignedUnits.join(", ")} on ${call.id} after two automated status checks.${supervisor ? ` Recommended supervisor: ${supervisor.callsign}.` : " No registered supervisor is available."}`,
        ) ??
          this.text.system(
            `Supervisor notification: no response from ${call.assignedUnits.join(", ")} on ${call.id} after two automated status checks.${supervisor ? ` Recommended supervisor: ${supervisor.callsign}.` : " No registered supervisor is available."}`,
          ));
        await this.voice.announce(
          `All units, hold one. No status response from ${call.assignedUnits.map(speakCallsign).join(", ")} on ${call.id}. Supervisor requested.`,
          true,
          "DISPATCHER_EMERGENCY",
        );
      }
    }
  }
}
