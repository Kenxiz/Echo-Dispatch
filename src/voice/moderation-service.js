import { speakCallsign } from "../utils/radio.js";

export class RadioModerationService {
  constructor(host) {
    this.host = host;
  }

  async evaluateHotMicDecision(userId, unit, epoch, classification) {
    const host = this.host;
    const now = Date.now();
    const windowMs = host.config.HOT_MIC_WINDOW_MS ?? 900_000;
    const existing = host.hotMicHistory.get(userId) ?? [];
    const incidents = existing.filter((timestamp) => now - timestamp <= windowMs);
    let action = incidents.length < existing.length ? "EXPIRED" : "NONE";
    const previousWarningCount = incidents.length;
    let updatedWarningCount = incidents.length;
    let reply = "";
    if (
      classification.classification === "CONFIRMED_HOT_MIC" &&
      classification.confidence >= (host.config.HOT_MIC_CONFIDENCE_THRESHOLD ?? 0.92) &&
      !classification.containsDispatchInformation
    ) {
      incidents.push(now);
      updatedWarningCount = incidents.length;
      host.validRadioSinceHotMic.set(userId, 0);
      if (incidents.length === 1) {
        reply = `${speakCallsign(unit.callsign)}, hot mic. Secure your radio.`;
        action = "WARNING";
      } else if (incidents.length === 2) {
        reply = `${speakCallsign(unit.callsign)}, second hot mic warning. Secure your radio.`;
        action = "WARNING";
      } else {
        const muted = await this.applyHotMicMute(userId, host.config.HOT_MIC_MUTE_MS ?? 120_000);
        reply = muted
          ? `${speakCallsign(unit.callsign)}, repeated hot mic. Radio muted for two minutes.`
          : `${speakCallsign(unit.callsign)}, third hot mic warning. Secure your radio.`;
        action = muted ? "MUTE" : "WARNING";
        if (muted) incidents.splice(0);
      }
    } else if (
      classification.classification === "VALID_RADIO_TRAFFIC" ||
      (classification.classification === "CROSS_TRANSMISSION" && classification.containsDispatchInformation)
    ) {
      const validCount = (host.validRadioSinceHotMic.get(userId) ?? 0) + 1;
      if (incidents.length && validCount >= (host.config.HOT_MIC_WARNING_RESET_TRANSMISSIONS ?? 2)) {
        incidents.shift();
        updatedWarningCount = incidents.length;
        action = "REDUCED";
        host.validRadioSinceHotMic.set(userId, 0);
      } else host.validRadioSinceHotMic.set(userId, validCount);
    }
    if (incidents.length) host.hotMicHistory.set(userId, incidents);
    else host.hotMicHistory.delete(userId);
    if (action !== "NONE") await this.persistHotMicWarnings();
    if (reply) await this.transmitHotMicWarning(userId, unit, epoch, reply);
    return { reply, previousWarningCount, updatedWarningCount, action };
  }

  async transmitHotMicWarning(userId, unit, epoch, reply) {
    const host = this.host;
    let audio = Buffer.alloc(0);
    try {
      audio = await host.gemini.synthesize(reply);
    } catch (error) {
      void host.text
        .warning(
          `Could not synthesize hot mic warning for ${unit.callsign}: ${error instanceof Error ? error.message : "Unknown error"}`,
        )
        .catch(() => undefined);
    }
    if (audio.length && host.channelOwner === userId && host.channelEpoch === epoch) await host.playback.play(audio);
  }

  async persistHotMicWarnings() {
    const settings = this.host.dispatch?.store?.settings;
    if (!settings) return;
    const warnings = Object.fromEntries(
      [...this.host.hotMicHistory].map(([userId, timestamps]) => [
        userId,
        timestamps.map((timestamp) => new Date(timestamp).toISOString()),
      ]),
    );
    await settings.update((current) => {
      current.hotMicWarnings = warnings;
    });
  }

  async recoverHotMicWarnings() {
    const host = this.host;
    const warnings = host.dispatch?.store?.settings?.get().hotMicWarnings ?? {};
    const cutoff = Date.now() - (host.config.HOT_MIC_WINDOW_MS ?? 900_000);
    for (const [userId, timestamps] of Object.entries(warnings)) {
      const active = timestamps
        .map(Date.parse)
        .filter((timestamp) => Number.isFinite(timestamp) && timestamp >= cutoff);
      if (active.length) host.hotMicHistory.set(userId, active);
    }
    await this.persistHotMicWarnings();
  }

  async applyHotMicMute(userId, durationMs) {
    const host = this.host;
    if (!host.guild || host.hotMicMutes.has(userId)) return false;
    try {
      const member = host.guild.members.cache.get(userId) ?? (await host.guild.members.fetch(userId));
      if (!member.voice.channelId || member.voice.serverMute) return false;
      const expiresAt = new Date(Date.now() + durationMs).toISOString();
      await member.voice.setMute(true, "Echo Dispatch repeated hot mic enforcement");
      const timer = setTimeout(() => {
        void this.releaseHotMicMute(userId);
      }, durationMs);
      timer.unref?.();
      host.hotMicMutes.set(userId, { expiresAt, timer });
      await this.persistHotMicMutes();
      return true;
    } catch (error) {
      void host.text
        .warning(
          `Unable to apply hot mic enforcement. Confirm Mute Members permission and role order. ${error instanceof Error ? error.message : ""}`.trim(),
        )
        .catch(() => undefined);
      return false;
    }
  }

  async releaseHotMicMute(userId) {
    const host = this.host;
    const record = host.hotMicMutes.get(userId);
    if (!record || !host.guild) return;
    clearTimeout(record.timer);
    try {
      const member = host.guild.members.cache.get(userId) ?? (await host.guild.members.fetch(userId));
      if (member.voice.channelId && !host.controlledMutes.has(userId))
        await member.voice.setMute(false, "Echo Dispatch hot mic timeout expired");
    } catch {
      /* member may have left */
    }
    host.hotMicMutes.delete(userId);
    await this.persistHotMicMutes();
  }

  async releaseHotMicMutes() {
    await Promise.all([...this.host.hotMicMutes.keys()].map((userId) => this.releaseHotMicMute(userId)));
  }
  async persistHotMicMutes() {
    const settings = this.host.dispatch?.store?.settings;
    if (!settings) return;
    const records = [...this.host.hotMicMutes].map(([userId, record]) => ({ userId, expiresAt: record.expiresAt }));
    await settings.update((current) => {
      current.hotMicMutes = records;
    });
  }
  async recoverHotMicMutes() {
    const host = this.host;
    const records = host.dispatch?.store?.settings?.get().hotMicMutes ?? [];
    for (const record of records) {
      const remaining = Date.parse(record.expiresAt) - Date.now();
      if (remaining <= 0) {
        host.hotMicMutes.set(record.userId, { expiresAt: record.expiresAt, timer: null });
        await this.releaseHotMicMute(record.userId);
      } else {
        const timer = setTimeout(() => {
          void this.releaseHotMicMute(record.userId);
        }, remaining);
        timer.unref?.();
        host.hotMicMutes.set(record.userId, { expiresAt: record.expiresAt, timer });
      }
    }
    await this.persistHotMicMutes();
  }

  async setControlledMute(userId, muted, expectedEpoch = null) {
    const host = this.host;
    if (!host.guild) return;
    try {
      const member = host.guild.members.cache.get(userId) ?? (await host.guild.members.fetch(userId));
      if (muted) {
        if (expectedEpoch !== null && (host.channelOwner === null || host.channelEpoch !== expectedEpoch)) return;
        if (!member.voice.channelId || member.voice.serverMute) return;
        await member.voice.setMute(true, "Echo Dispatch radio channel control");
        if (expectedEpoch !== null && (host.channelOwner === null || host.channelEpoch !== expectedEpoch)) {
          if (member.voice.channelId) await member.voice.setMute(false, "Echo Dispatch radio channel already released");
          return;
        }
        host.controlledMutes.add(userId);
        await this.persistControlledMutes();
      } else if (host.controlledMutes.has(userId)) {
        if (member.voice.channelId && !host.hotMicMutes.has(userId))
          await member.voice.setMute(false, "Echo Dispatch radio channel released");
        host.controlledMutes.delete(userId);
        await this.persistControlledMutes();
      }
    } catch (error) {
      if (!host.muteWarningSent) {
        host.muteWarningSent = true;
        await host.text
          .warning(
            `Unable to control radio interruptions. Give the bot Mute Members permission and place its role above unit roles. ${error instanceof Error ? error.message : ""}`.trim(),
          )
          .catch(() => undefined);
      }
    }
  }

  async releaseControlledMutes() {
    await Promise.all([...this.host.controlledMutes].map((userId) => this.setControlledMute(userId, false)));
  }
  async persistControlledMutes() {
    const settings = this.host.dispatch?.store?.settings;
    if (!settings) return;
    await settings.update((current) => {
      current.controlledMuteUserIds = [...this.host.controlledMutes];
    });
  }
  async recoverControlledMutes() {
    const userIds = this.host.dispatch?.store?.settings?.get().controlledMuteUserIds ?? [];
    for (const userId of userIds) this.host.controlledMutes.add(userId);
    await this.releaseControlledMutes();
  }
}
