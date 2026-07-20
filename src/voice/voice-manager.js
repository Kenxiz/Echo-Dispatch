import { EndBehaviorType, VoiceConnectionStatus, entersState, joinVoiceChannel } from "@discordjs/voice";
import { setTimeout as delay } from "node:timers/promises";
import prism from "prism-media";
import { RadioPlayback } from "./playback.js";
import { describeOfficerPanic, isDirectedRadioTraffic, isLikelySpeech, isOfficerPanicTraffic } from "./audio-gate.js";
import { speakCallsign } from "../utils/radio.js";

const ANNOUNCEMENT_OWNER = "__echo_dispatch_announcement__";

export class VoiceManager {
  connection = null;
  guild = null;
  playback = new RadioPlayback();
  active = new Map();
  controlledMutes = new Set();
  channelOwner = null;
  channelEpoch = 0;
  radioQueue = Promise.resolve();
  emergencyQueue = [];
  emergencyActive = 0;
  announcementQueue = [];
  announcementRunning = false;
  muteWarningSent = false;
  unregisteredWarnings = new Set();
  panicCooldowns = new Map();
  startPromise = null;
  voiceApi;

  constructor(client, config, gemini, dispatch, text, erlc = null, voiceApi = null) {
    this.client = client;
    this.config = config;
    this.gemini = gemini;
    this.dispatch = dispatch;
    this.text = text;
    this.erlc = erlc;
    this.voiceApi = voiceApi ?? { joinVoiceChannel, entersState, delay };
  }

  isConnected() {
    return this.connection?.state.status === VoiceConnectionStatus.Ready;
  }

  async start() {
    if (this.isConnected()) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.connectWithRetry();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async connectWithRetry() {
    const channel = await this.client.channels.fetch(this.config.DISCORD_VOICE_CHANNEL_ID);
    if (!channel?.isVoiceBased()) throw new Error("Configured voice channel is unavailable or is not voice based.");
    this.guild = channel.guild;
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let ready = false;
      let handshakeError = null;
      const connection = this.voiceApi.joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });
      this.connection = connection;
      // This listener must exist before entersState: UDP/IP-discovery errors can
      // otherwise be emitted during the handshake and terminate the process.
      connection.on("error", (error) => {
        handshakeError = error;
        if (ready) void this.text.warning(`Voice connection error: ${error.message}`).catch(() => undefined);
      });
      try {
        await this.voiceApi.entersState(connection, VoiceConnectionStatus.Ready, 20_000);
        ready = true;
        this.playback.setConnection(connection);
        await this.recoverControlledMutes();
        connection.receiver.speaking.on("start", (userId) => this.receive(userId));
        this.pumpAnnouncements();
        return;
      } catch (error) {
        lastError = handshakeError ?? error;
        try { connection.destroy(); } catch { /* already destroyed */ }
        if (this.connection === connection) this.connection = null;
        if (attempt < 3) await this.voiceApi.delay(attempt * 750);
      }
    }
    this.guild = null;
    const detail = lastError instanceof Error ? lastError.message : "Unknown voice handshake error";
    throw new Error(`Discord voice connection failed after 3 attempts: ${detail}. Check for another running bot process and confirm UDP traffic is allowed.`);
  }

  async stop() {
    this.playback.stop();
    for (const item of this.announcementQueue.splice(0)) item.resolve();
    for (const item of this.emergencyQueue.splice(0)) item.resolve({ transcript: "", emergency: false });
    for (const state of this.active.values()) this.cancelPrepared(state);
    await this.releaseControlledMutes();
    this.connection?.destroy();
    this.connection = null;
    this.guild = null;
    this.active.clear();
    this.channelOwner = null;
    this.channelEpoch += 1;
  }

  async speak(text, priority = false) {
    if (!this.isConnected()) return;
    const audio = await this.gemini.synthesize(text);
    await this.playback.play(audio, priority);
  }

  announce(text, priority = false) {
    return this.queueAnnouncement({ text, priority });
  }

  announceCall(call, priority = call.priority === 1, reannouncement = false) {
    return this.queueAnnouncement({ call, priority, reannouncement });
  }

  queueAnnouncement(input) {
    if (!this.isConnected()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const item = { ...input, resolve, reject };
      if (item.priority) {
        const firstRoutine = this.announcementQueue.findIndex((queued) => !queued.priority);
        if (firstRoutine === -1) this.announcementQueue.push(item);
        else this.announcementQueue.splice(firstRoutine, 0, item);
      } else this.announcementQueue.push(item);
      this.pumpAnnouncements();
    });
  }

  pumpAnnouncements() {
    if (this.announcementRunning || this.channelOwner !== null || !this.isConnected()) return;
    const item = this.announcementQueue.shift();
    if (!item) return;
    this.announcementRunning = true;
    const epoch = ++this.channelEpoch;
    this.channelOwner = ANNOUNCEMENT_OWNER;
    void (async () => {
      try {
        const audio = item.call
          ? await this.gemini.synthesizeCall(item.call, item.reannouncement)
          : await this.gemini.synthesize(item.text);
        await this.playback.play(audio, item.priority);
        if (this.channelOwner === ANNOUNCEMENT_OWNER && this.channelEpoch === epoch) item.resolve();
        else this.announcementQueue.unshift(item);
      } catch (error) {
        item.reject(error);
      } finally {
        this.announcementRunning = false;
        await this.releaseChannel(ANNOUNCEMENT_OWNER, epoch);
        this.pumpAnnouncements();
      }
    })();
  }

  receive(userId) {
    if (!this.connection || this.active.has(userId)) return;
    const user = this.client.users.cache.get(userId);
    if (user?.bot) return;

    const isOwner = this.channelOwner === null;
    const state = {
      role: isOwner ? "owner" : "interrupter",
      epoch: isOwner ? ++this.channelEpoch : this.channelEpoch,
      chunks: [],
      muteTimer: null,
      prepared: null,
    };
    if (isOwner) this.channelOwner = userId;
    this.active.set(userId, state);

    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: this.config.VOICE_END_SILENCE_MS },
    });
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 1, frameSize: 960 });
    const captureLimitMs = isOwner ? 30_000 : this.config.RADIO_INTERRUPT_GRACE_MS + 600;
    const maximum = setTimeout(() => opus.destroy(), captureLimitMs);

    if (!isOwner) {
      state.muteTimer = setTimeout(() => {
        const pcm = Buffer.concat(state.chunks);
        if (this.passesSpeechGate(pcm)) void this.setControlledMute(userId, true, state.epoch);
      }, this.config.RADIO_INTERRUPT_GRACE_MS);
    }

    opus.pipe(decoder);
    decoder.on("data", (chunk) => {
      state.chunks.push(Buffer.from(chunk));
      if (state.role === "owner") this.maybePrepareTransmission(userId, state);
    });
    decoder.once("error", () => opus.destroy());
    decoder.once("end", () => {
      clearTimeout(maximum);
      if (state.muteTimer) clearTimeout(state.muteTimer);
      this.active.delete(userId);
      const pcm = Buffer.concat(state.chunks);

      if (!this.passesSpeechGate(pcm)) {
        if (state.role === "owner") {
          this.cancelPrepared(state);
          void this.releaseChannel(userId, state.epoch);
        }
        else void this.setControlledMute(userId, false);
        return;
      }

      if (state.role === "interrupter") {
        void this.handleInterruption(userId, pcm, state.epoch);
        return;
      }

      this.enqueue(async () => {
        try {
          if (this.channelOwner !== userId || this.channelEpoch !== state.epoch) return;
          await this.process(userId, pcm, state.epoch, state.prepared);
        } finally {
          await this.releaseChannel(userId, state.epoch);
        }
      });
    });
  }

  passesSpeechGate(pcm) {
    return isLikelySpeech(pcm, {
      minimumDurationMs: this.config.VOICE_MIN_TRANSMISSION_MS,
      rmsThreshold: this.config.VOICE_RMS_THRESHOLD,
    });
  }

  maybePrepareTransmission(userId, state) {
    if (state.prepared || this.active.get(userId) !== state || typeof this.gemini.prepareTransmission !== "function") return;
    const pcm = Buffer.concat(state.chunks);
    if (!isLikelySpeech(pcm, { minimumDurationMs: 120, rmsThreshold: this.config.VOICE_RMS_THRESHOLD })) return;
    const unit = this.dispatch.units.getByUserId(userId);
    if (!unit) return;
    state.prepared = this.gemini.prepareTransmission(unit, this.dispatch);
    // The promise is consumed when the transmission ends; this prevents a
    // connection error during a long transmission from becoming unhandled.
    void state.prepared.catch(() => undefined);
  }

  cancelPrepared(state) {
    const prepared = state.prepared;
    state.prepared = null;
    if (prepared) void prepared.then((session) => session.cancel()).catch(() => undefined);
  }

  enqueue(task) {
    this.radioQueue = this.radioQueue.then(task).catch(async (error) => {
      await this.text.warning(error instanceof Error ? error.message : "Radio processing failed.").catch(() => undefined);
    });
  }

  async process(userId, pcm, epoch, preparedPromise = null) {
    const unit = this.dispatch.units.getByUserId(userId);
    if (!unit) {
      if (!this.unregisteredWarnings.has(userId)) {
        this.unregisteredWarnings.add(userId);
        await this.text.warning(`Ignoring radio audio from <@${userId}> because that user has not registered a unit.`).catch(() => undefined);
      }
      await this.dispatch.logTransmission({
        discordUserId: userId,
        callsign: null,
        transcript: "",
        dispatcherTranscript: "",
        overlap: false,
        actions: [],
      });
      return;
    }

    let result;
    try {
      result = preparedPromise
        ? await (await preparedPromise).complete(pcm)
        : await this.gemini.handleTransmission(pcm, unit, this.dispatch);
    } catch (error) {
      await this.replyTenNine(unit, userId, epoch);
      return;
    }
    const transcript = result.inputTranscript.trim();
    const directed = isDirectedRadioTraffic(transcript, unit.callsign) || transcript.length === 0;
    if (isOfficerPanicTraffic(transcript)) {
      const dispatcherTranscript = await this.escalateOfficerPanic(userId, transcript);
      await this.dispatch.logTransmission({
        discordUserId: userId,
        callsign: unit.callsign,
        transcript,
        dispatcherTranscript,
        overlap: false,
        actions: result.actions,
      });
      void this.text.transcript(unit.callsign, transcript, dispatcherTranscript).catch(() => undefined);
      return;
    }
    let dispatcherTranscript = directed ? result.outputTranscript.trim() : "";
    let responseAudio = result.audio;
    if (directed && (transcript.length === 0 || responseAudio.length === 0)) {
      if (transcript.length === 0) dispatcherTranscript = `${speakCallsign(unit.callsign)}, 10-9 your traffic.`;
      else dispatcherTranscript ||= `${speakCallsign(unit.callsign)}, 10-9 your traffic.`;
      responseAudio = Buffer.alloc(0);
      try {
        responseAudio = await this.gemini.synthesize(dispatcherTranscript);
      } catch (error) {
        await this.text.warning(`Could not synthesize a radio reply for ${unit.callsign}: ${error instanceof Error ? error.message : "Unknown error"}`).catch(() => undefined);
      }
    }
    await this.dispatch.logTransmission({
      discordUserId: userId,
      callsign: unit.callsign,
      transcript,
      dispatcherTranscript,
      overlap: false,
      actions: result.actions,
    });
    if (!directed) return;
    void this.text.transcript(unit.callsign, transcript, dispatcherTranscript || "Radio acknowledgement transmitted.").catch(() => undefined);
    if (this.channelOwner !== userId || this.channelEpoch !== epoch) return;
    if (responseAudio.length > 0) await this.playback.play(responseAudio);
  }

  async replyTenNine(unit, userId, epoch, transcript = "", actions = []) {
    const reply = `${speakCallsign(unit.callsign)}, 10-9 your traffic.`;
    let audio = Buffer.alloc(0);
    try {
      audio = await this.gemini.synthesize(reply);
    } catch (error) {
      await this.text.warning(`Radio processing and 10-9 fallback failed for ${unit.callsign}: ${error instanceof Error ? error.message : "Unknown error"}`).catch(() => undefined);
    }
    await this.dispatch.logTransmission({
      discordUserId: userId,
      callsign: unit.callsign,
      transcript,
      dispatcherTranscript: reply,
      overlap: false,
      actions,
    });
    void this.text.transcript(unit.callsign, transcript, reply).catch(() => undefined);
    if (audio.length > 0 && this.channelOwner === userId && this.channelEpoch === epoch) await this.playback.play(audio);
  }

  async escalateOfficerPanic(userId, transcript) {
    const unit = this.dispatch.units.getByUserId(userId);
    if (!unit) return "Unidentified unit, 10-9 your emergency traffic.";
    const now = Date.now();
    const cooldown = this.config.PANIC_COOLDOWN_MS ?? 15_000;
    if (now - (this.panicCooldowns.get(userId) ?? 0) < cooldown) {
      const repeat = `${speakCallsign(unit.callsign)}, emergency traffic acknowledged. All units continue Code 3.`;
      await this.speak(repeat, true);
      return repeat;
    }
    this.panicCooldowns.set(userId, now);

    await Promise.allSettled([
      this.dispatch.setUnitStatus(userId, "EMERGENCY"),
      this.dispatch.setUnitResponseMode(userId, "CODE_3"),
    ]);

    let location = unit.location;
    let locationSource = location ? "last known" : "unavailable";
    try {
      const located = await this.erlc?.locateUnit(unit);
      if (located?.found && located.location) {
        location = located.location;
        locationSource = located.stale ? "recent ER:LC" : "live ER:LC";
        await this.dispatch.setUnitLocation(userId, location);
      }
    } catch (error) {
      void this.text.warning(`Officer panic location lookup failed for ${unit.callsign}; broadcasting with ${location ? "the unit's last known location" : "location unavailable"}. ${error instanceof Error ? error.message : "Unknown ER:LC error"}`).catch(() => undefined);
    }

    const panicDescription = describeOfficerPanic(transcript);
    const locationTraffic = location ? `Location ${location}.` : "Location unavailable; unit advise when able.";
    const announcement = `All units, mass panic. ${speakCallsign(unit.callsign)} ${panicDescription}. ${locationTraffic} All available units respond Code 3.`;
    const current = this.dispatch.units.getByUserId(userId);
    if (current?.assignedCallId) {
      await this.dispatch.addCallNoteForUnit(userId, `Officer panic: ${panicDescription}. ${location ? `${locationSource} location ${location}.` : "Location unavailable."}`).catch(() => undefined);
    }
    if (this.text.panic) void this.text.panic(unit, location, locationSource, transcript).catch(() => undefined);
    await this.speak(announcement, true);
    return announcement;
  }

  async handleInterruption(userId, pcm, interruptedEpoch) {
    if (this.channelOwner === null || this.channelEpoch !== interruptedEpoch) {
      await this.setControlledMute(userId, false);
      return;
    }
    await this.setControlledMute(userId, true, interruptedEpoch);
    let detection;
    try {
      detection = await this.detectEmergencyQueued(pcm);
    } catch (error) {
      await this.text.warning(`Could not classify interrupted traffic: ${error instanceof Error ? error.message : "Unknown error"}`).catch(() => undefined);
      if (this.channelOwner === null || this.channelEpoch !== interruptedEpoch) await this.setControlledMute(userId, false);
      return;
    }

    await this.dispatch.logTransmission({
      discordUserId: userId,
      callsign: this.dispatch.units.getByUserId(userId)?.callsign ?? null,
      transcript: detection.transcript,
      dispatcherTranscript: "",
      overlap: true,
      actions: [],
    });
    if (!detection.emergency || !this.connection) {
      if (this.channelOwner === null || this.channelEpoch !== interruptedEpoch) await this.setControlledMute(userId, false);
      return;
    }

    this.channelEpoch += 1;
    const emergencyEpoch = this.channelEpoch;
    this.channelOwner = userId;
    this.playback.stop();
    await this.setControlledMute(userId, false);
    const unit = this.dispatch.units.getByUserId(userId);
    const address = unit ? `${speakCallsign(unit.callsign)}, ` : "emergency unit, ";
    try {
      if (unit && isOfficerPanicTraffic(detection.transcript))
        await this.escalateOfficerPanic(userId, detection.transcript);
      else
        await this.speak(`All units, hold the air. ${address}repeat emergency traffic.`, true);
    } finally {
      await this.releaseChannel(userId, emergencyEpoch);
    }
  }

  async releaseChannel(userId, epoch) {
    if (this.channelOwner !== userId || this.channelEpoch !== epoch) return;
    this.channelOwner = null;
    await this.releaseControlledMutes();
    this.pumpAnnouncements();
  }

  detectEmergencyQueued(pcm) {
    return new Promise((resolve, reject) => {
      this.emergencyQueue.push({ pcm, resolve, reject });
      this.pumpEmergencyQueue();
    });
  }

  pumpEmergencyQueue() {
    while (this.emergencyActive < 4 && this.emergencyQueue.length > 0) {
      const item = this.emergencyQueue.shift();
      this.emergencyActive += 1;
      void this.gemini.detectEmergency(item.pcm).then(item.resolve, item.reject).finally(() => {
        this.emergencyActive -= 1;
        this.pumpEmergencyQueue();
      });
    }
  }

  async setControlledMute(userId, muted, expectedEpoch = null) {
    if (!this.guild) return;
    try {
      const member = this.guild.members.cache.get(userId) ?? await this.guild.members.fetch(userId);
      if (muted) {
        if (expectedEpoch !== null && (this.channelOwner === null || this.channelEpoch !== expectedEpoch)) return;
        if (!member.voice.channelId || member.voice.serverMute) return;
        await member.voice.setMute(true, "Echo Dispatch radio channel control");
        // The active transmission may have cleared while Discord processed the
        // mute. Roll it back immediately instead of stranding the unit muted.
        if (expectedEpoch !== null && (this.channelOwner === null || this.channelEpoch !== expectedEpoch)) {
          if (member.voice.channelId) await member.voice.setMute(false, "Echo Dispatch radio channel already released");
          return;
        }
        this.controlledMutes.add(userId);
        await this.persistControlledMutes();
      } else if (this.controlledMutes.has(userId)) {
        if (member.voice.channelId) await member.voice.setMute(false, "Echo Dispatch radio channel released");
        this.controlledMutes.delete(userId);
        await this.persistControlledMutes();
      }
    } catch (error) {
      if (!this.muteWarningSent) {
        this.muteWarningSent = true;
        await this.text.warning(`Unable to control radio interruptions. Give the bot Mute Members permission and place its role above unit roles. ${error instanceof Error ? error.message : ""}`.trim()).catch(() => undefined);
      }
    }
  }

  async releaseControlledMutes() {
    const userIds = [...this.controlledMutes];
    await Promise.all(userIds.map((userId) => this.setControlledMute(userId, false)));
  }

  async persistControlledMutes() {
    const settings = this.dispatch?.store?.settings;
    if (!settings) return;
    const userIds = [...this.controlledMutes];
    await settings.update((current) => { current.controlledMuteUserIds = userIds; });
  }

  async recoverControlledMutes() {
    const userIds = this.dispatch?.store?.settings?.get().controlledMuteUserIds ?? [];
    for (const userId of userIds) this.controlledMutes.add(userId);
    await this.releaseControlledMutes();
  }
}
