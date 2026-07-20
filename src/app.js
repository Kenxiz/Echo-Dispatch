import { EmbedBuilder } from "discord.js";
import { detectRadioCode } from "./utils/radio.js";
import { fallbackCallPriority } from "./ai/call-triage.js";
import { buildHeatmap, buildShiftStatistics, findMergeCandidate } from "./dispatch/cad-intelligence.js";
import { isFilteredErlcLocation } from "./erlc/client.js";
export class EchoDispatchApp {
  config;
  store;
  calls;
  text;
  voice;
  gemini;
  erlc;
  emergencyAdapter;
  watchdog;
  codebook;
  reannounceTimers = new Map();
  constructor(config, store, calls, text, voice, gemini, erlc, emergencyAdapter, watchdog = null, codebook = null) {
    this.config = config;
    this.store = store;
    this.calls = calls;
    this.text = text;
    this.voice = voice;
    this.gemini = gemini;
    this.erlc = erlc;
    this.emergencyAdapter = emergencyAdapter;
    this.watchdog = watchdog;
    this.codebook = codebook;
  }
  async restore() {
    for (const call of this.calls.list()) {
      await this.text.publishCall(call);
      this.scheduleReannouncement(call);
    }
    await this.text.publishActiveUnits?.(this.calls.units.list());
    if (this.store.settings.get().dispatchRunning) await this.start(false);
  }
  async start(postMessage = true) {
    await this.voice.start();
    this.emergencyAdapter.start();
    this.watchdog?.start();
    await this.store.settings.update((settings) => {
      settings.dispatchRunning = true;
    });
    await this.store.settings.update((settings) => {
      settings.shiftStartedAt ??= new Date().toISOString();
    });
    if (postMessage) await this.text.system("Dispatch started and joined the configured radio channel.");
  }
  async stop(postMessage = true) {
    this.emergencyAdapter.stop();
    this.watchdog?.stop();
    await this.voice.stop();
    await this.store.settings.update((settings) => {
      settings.dispatchRunning = false;
    });
    if (postMessage) await this.text.system("Dispatch stopped and left the radio channel.");
  }
  async createCall(input) {
    let triage;
    let prioritySource = "AI";
    try {
      triage = await this.gemini.triageCall(input);
    } catch (error) {
      triage = fallbackCallPriority(input);
      prioritySource = "FALLBACK";
      const reason = error instanceof Error ? error.message : "Unknown triage error";
      void this.text
        .warning(
          `AI call triage was unavailable; ${input.source === "ERLC_EMERGENCY" ? "ER:LC" : "911"} call assigned Priority ${triage.priority} by safety fallback. ${reason}`,
        )
        .catch(() => undefined);
    }
    const activeCalls = typeof this.calls.list === "function" ? this.calls.list() : [];
    const mergeTarget = findMergeCandidate(activeCalls, input, this.config.CALL_MERGE_WINDOW_MS);
    if (mergeTarget) {
      const previousPriority = mergeTarget.priority;
      const merged = await this.calls.mergeReport(mergeTarget.id, input, { ...triage, source: prioritySource });
      await this.text.publishCall(merged);
      if (merged.priority < previousPriority) {
        void this.voice
          .announce(
            `Attention units. ${merged.id} at ${merged.location} has been upgraded to Priority ${merged.priority}. Units respond ${merged.responseMode.replace("_", " ")}.`,
            true,
            `PRIORITY_${merged.priority}`,
          )
          .catch((error) =>
            this.text.warning(error instanceof Error ? error.message : "Call upgrade announcement failed."),
          );
      }
      return merged;
    }
    const call = await this.calls.create({
      ...input,
      priority: triage.priority,
      prioritySource,
      priorityReason: triage.reason,
    });
    await this.text.publishCall(call);
    await this.store.settings?.update?.((settings) => {
      settings.mostRecentAnnouncedCallId = call.id;
      settings.mostRecentActiveCallId = call.id;
    });
    void this.voice
      .announceCall(call, call.priority === 1)
      .catch((error) => this.text.warning(error instanceof Error ? error.message : "Call announcement failed."));
    this.scheduleReannouncement(call);
    return call;
  }
  heatmap() {
    return buildHeatmap(this.calls.list(false));
  }
  shiftStatistics() {
    return buildShiftStatistics(
      this.calls.list(false),
      this.store.transmissions.get(),
      this.store.units.get(),
      this.store.settings.get().shiftStartedAt,
    );
  }
  async resetShift() {
    const startedAt = new Date().toISOString();
    await this.store.settings.update((settings) => {
      settings.shiftStartedAt = startedAt;
    });
    return startedAt;
  }
  async createErlcCall(source) {
    const description = source.Description.trim() || "In-game emergency call received.";
    const reportedLocation = source.PositionDescriptor.trim();
    let location = reportedLocation || `Coordinates ${source.Position.join(", ")}`;
    if (isFilteredErlcLocation(reportedLocation)) {
      location = `Coordinates ${source.Position.join(", ")}`;
      try {
        const caller = await this.erlc.locateEmergencyCaller(source);
        if (caller.found) location = caller.location;
      } catch (error) {
        void this.text
          .warning(
            `ER:LC caller location fallback failed for call ${source.CallNumber}; using the reported coordinates. ${error instanceof Error ? error.message : "Unknown error"}`,
          )
          .catch(() => undefined);
        location = `Coordinates ${source.Position.join(", ")}`;
      }
    }
    return this.createCall({
      source: "ERLC_EMERGENCY",
      sourceExternalId: `erlc:${source.CallNumber}:${source.StartedAt}`,
      incident: detectRadioCode(description) === "10-50" ? "Motor Vehicle Accident" : "Emergency Call",
      radioCode: detectRadioCode(description),
      location,
      description,
    });
  }
  async closeCall(id) {
    const call = await this.calls.close(id);
    const timer = this.reannounceTimers.get(call.id);
    if (timer) clearTimeout(timer);
    this.reannounceTimers.delete(call.id);
    await this.text.publishCall(call);
    return call;
  }
  async statusEmbed() {
    let erlcStatus = "Unavailable";
    try {
      const server = await this.erlc.fetchServerInfo();
      erlcStatus = `${server.Name} • ${server.CurrentPlayers}/${server.MaxPlayers} players`;
    } catch (error) {
      erlcStatus = error instanceof Error ? error.message : "Unavailable";
    }
    return new EmbedBuilder()
      .setTitle(`${this.config.AGENCY_NAME ?? "Echo Dispatch"} status`)
      .setColor(this.voice.isConnected() ? 0x16a34a : 0xdc2626)
      .addFields(
        { name: "Dispatch", value: this.store.settings.get().dispatchRunning ? "Running" : "Stopped", inline: true },
        { name: "Voice", value: this.voice.isConnected() ? "Connected" : "Disconnected", inline: true },
        { name: "Active calls", value: String(this.calls.list().length), inline: true },
        { name: "ER:LC", value: erlcStatus.slice(0, 1024) },
      )
      .setTimestamp();
  }
  scheduleReannouncement(call) {
    if (call.status !== "AWAITING_UNIT" || call.reannounced || this.reannounceTimers.has(call.id)) return;
    const age = Date.now() - new Date(call.createdAt).getTime();
    const delay = Math.max(1_000, this.config.CALL_REANNOUNCE_DELAY_MS - age);
    const timer = setTimeout(() => {
      this.reannounceTimers.delete(call.id);
      void (async () => {
        const current = this.calls.get(call.id);
        if (!current || current.status !== "AWAITING_UNIT" || current.reannounced) return;
        await this.text.system(
          `Unassigned call reminder: ${current.id}, ${current.radioCode ?? current.incident} at ${current.location}.`,
        );
        void this.voice
          .announceCall(current, current.priority === 1, true)
          .catch((error) => this.text.warning(error instanceof Error ? error.message : "Call reannouncement failed."));
        await this.calls.markReannounced(current.id);
        await this.text.publishCall(this.calls.get(current.id));
      })().catch((error) => this.text.warning(error instanceof Error ? error.message : "Call reannouncement failed."));
    }, delay);
    timer.unref();
    this.reannounceTimers.set(call.id, timer);
  }
}
