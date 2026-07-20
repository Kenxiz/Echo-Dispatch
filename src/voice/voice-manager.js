import { EndBehaviorType, VoiceConnectionStatus, entersState, joinVoiceChannel } from "@discordjs/voice";
import { setTimeout as delay } from "node:timers/promises";
import prism from "prism-media";
import { RadioPlayback } from "./playback.js";
import {
  analyzePcm16Mono,
  classifyEmergencyTraffic,
  classifyRadioTransmission,
  describeOfficerPanic,
  isDirectedRadioTraffic,
  isLikelySpeech,
} from "./audio-gate.js";
import { enforceFullCallsign, speakCallsign } from "../utils/radio.js";
import {
  assessTransmissionConfidence,
  callRadioPriority,
  compressRadioTraffic,
  confidenceReply,
  nextAcknowledgement,
  RADIO_PRIORITY,
} from "./radio-intelligence.js";
import { createBusyTone, downsample48kMono } from "./audio-utils.js";
import { RadioModerationService } from "./moderation-service.js";
import { HISTORY_LIMITS } from "../domain/limits.js";

const ANNOUNCEMENT_OWNER = "__echo_dispatch_announcement__";

export class VoiceManager {
  connection = null;
  guild = null;
  playback;
  active = new Map();
  controlledMutes = new Set();
  channelOwner = null;
  channelEpoch = 0;
  radioQueue = Promise.resolve();
  emergencyQueue = [];
  emergencyActive = 0;
  announcementQueue = [];
  announcementRunning = false;
  currentAnnouncement = null;
  muteWarningSent = false;
  unregisteredWarnings = new Set();
  panicCooldowns = new Map();
  panicStatusTimers = new Map();
  startPromise = null;
  recentAudio = [];
  pendingTraffic = [];
  classifyingTraffic = new Set();
  trafficSequence = 0;
  hotMicHistory = new Map();
  validRadioSinceHotMic = new Map();
  hotMicMutes = new Map();
  voiceApi;

  constructor(client, config, gemini, dispatch, text, erlc = null, voiceApi = null) {
    this.client = client;
    this.config = config;
    this.gemini = gemini;
    this.dispatch = dispatch;
    this.text = text;
    this.erlc = erlc;
    this.playback = new RadioPlayback(config.VOICE_PLAYBACK_PREROLL_MS ?? 180);
    this.voiceApi = voiceApi ?? { joinVoiceChannel, entersState, delay };
    this.moderation = new RadioModerationService(this);
  }

  isConnected() {
    return this.connection?.state.status === VoiceConnectionStatus.Ready;
  }
  debugState() {
    return {
      connected: this.isConnected(),
      channelOwner: this.channelOwner,
      channelEpoch: this.channelEpoch,
      activeStreams: [...this.active.entries()].map(([userId, state]) => ({
        userId,
        role: state.role,
        startedAt: state.startedAt,
        sequence: state.sequence,
      })),
      queuedTraffic: this.pendingTraffic.map((item) => ({
        userId: item.userId,
        startedAt: item.startedAt,
        sequence: item.sequence,
        overlap: item.overlap,
      })),
      currentAnnouncement: this.currentAnnouncement?.text ?? null,
      queuedAnnouncements: this.announcementQueue.length,
      emergencyActive: this.emergencyActive,
      hotMicUsers: [...this.hotMicHistory.keys()],
      controlledMutes: [...this.controlledMutes],
    };
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
        await this.recoverHotMicMutes();
        await this.recoverHotMicWarnings();
        connection.receiver.speaking.on("start", (userId) => this.receive(userId));
        this.pumpAnnouncements();
        return;
      } catch (error) {
        lastError = handshakeError ?? error;
        try {
          connection.destroy();
        } catch {
          /* already destroyed */
        }
        if (this.connection === connection) this.connection = null;
        if (attempt < 3) await this.voiceApi.delay(attempt * 750);
      }
    }
    this.guild = null;
    const detail = lastError instanceof Error ? lastError.message : "Unknown voice handshake error";
    throw new Error(
      `Discord voice connection failed after 3 attempts: ${detail}. Check for another running bot process and confirm UDP traffic is allowed.`,
    );
  }

  async stop() {
    this.playback.stop();
    for (const item of this.announcementQueue.splice(0)) item.resolve();
    for (const item of this.emergencyQueue.splice(0)) item.resolve({ transcript: "", emergency: false });
    for (const state of this.active.values()) this.cancelPrepared(state);
    await this.releaseControlledMutes();
    await this.releaseHotMicMutes();
    this.connection?.destroy();
    this.connection = null;
    this.guild = null;
    this.active.clear();
    this.pendingTraffic.splice(0);
    this.classifyingTraffic.clear();
    this.channelOwner = null;
    this.channelEpoch += 1;
  }

  async speak(text, priority = false) {
    if (!this.isConnected()) return;
    const audio = await this.gemini.synthesize(text);
    await this.playback.play(audio, priority);
  }

  announce(text, priority = false, level = null) {
    return this.queueAnnouncement({ text, priority, level: this.resolvePriorityLevel(level, priority) });
  }

  announceCall(call, priority = call.priority === 1, reannouncement = false) {
    return this.queueAnnouncement({ call, priority, reannouncement, level: callRadioPriority(call) });
  }

  resolvePriorityLevel(level, priority) {
    if (typeof level === "number") return level;
    if (typeof level === "string" && RADIO_PRIORITY[level] !== undefined) return RADIO_PRIORITY[level];
    return priority ? RADIO_PRIORITY.UNIT_EMERGENCY : RADIO_PRIORITY.ROUTINE_REPLY;
  }

  queueAnnouncement(input) {
    if (!this.isConnected()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const item = { ...input, resolve, reject };
      item.level ??= this.resolvePriorityLevel(null, item.priority);
      const index = this.announcementQueue.findIndex((queued) => queued.level < item.level);
      if (index === -1) this.announcementQueue.push(item);
      else this.announcementQueue.splice(index, 0, item);
      if (this.currentAnnouncement && item.level > this.currentAnnouncement.level) {
        this.currentAnnouncement.preempted = true;
        this.playback.interrupt();
      }
      this.pumpAnnouncements();
    });
  }

  pumpAnnouncements() {
    if (this.announcementRunning || this.channelOwner !== null || !this.isConnected()) return;
    const item = this.announcementQueue.shift();
    if (!item) return;
    item.preempted = false;
    this.announcementRunning = true;
    this.currentAnnouncement = item;
    const epoch = ++this.channelEpoch;
    this.channelOwner = ANNOUNCEMENT_OWNER;
    void (async () => {
      try {
        const audio = item.playbackAudio
          ? item.playbackAudio
          : item.call
            ? await this.gemini.synthesizeCall(item.call, item.reannouncement)
            : item.busyFor
              ? Buffer.concat([
                  createBusyTone(),
                  await this.gemini.synthesize(`${speakCallsign(item.busyFor)}, radio busy.`),
                ])
              : await this.gemini.synthesize(item.text);
        if (item.preempted) {
          this.announcementQueue.push(item);
          this.announcementQueue.sort((a, b) => b.level - a.level);
          return;
        }
        await this.playback.play(audio);
        if (item.preempted) {
          this.announcementQueue.push(item);
          this.announcementQueue.sort((a, b) => b.level - a.level);
        } else if (this.channelOwner === ANNOUNCEMENT_OWNER && this.channelEpoch === epoch) item.resolve();
        else this.announcementQueue.unshift(item);
      } catch (error) {
        item.reject(error);
      } finally {
        this.announcementRunning = false;
        if (this.currentAnnouncement === item) this.currentAnnouncement = null;
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
      startedAt: Date.now(),
      sequence: this.trafficSequence++,
      chunks: [],
      emergencyTimer: null,
      emergencyPromoted: false,
      emergencyProbeRunning: false,
      prepared: null,
    };
    if (isOwner) this.channelOwner = userId;
    this.active.set(userId, state);

    const opus = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: this.config.VOICE_END_SILENCE_MS },
    });
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 1, frameSize: 960 });
    const captureLimitMs = this.config.VOICE_CAPTURE_LIMIT_MS ?? 30_000;
    const maximum = setTimeout(() => opus.destroy(), captureLimitMs);

    if (!isOwner) {
      this.scheduleEmergencyProbe(userId, state, this.config.CROSS_TRANSMISSION_EMERGENCY_CHECK_MS ?? 650);
    }

    opus.pipe(decoder);
    decoder.on("data", (chunk) => {
      state.chunks.push(Buffer.from(chunk));
      if (state.role === "owner") this.maybePrepareTransmission(userId, state);
    });
    decoder.once("error", () => opus.destroy());
    decoder.once("end", () => {
      clearTimeout(maximum);
      if (state.emergencyTimer) clearTimeout(state.emergencyTimer);
      this.active.delete(userId);
      const pcm = Buffer.concat(state.chunks);
      const durationMs = analyzePcm16Mono(pcm).durationMs;

      if (
        !this.passesSpeechGate(pcm) &&
        !(state.role === "interrupter" && durationMs >= (this.config.RADIO_TAP_IGNORE_MS ?? 300))
      ) {
        if (state.role === "owner") {
          this.cancelPrepared(state);
          void this.releaseChannel(userId, state.epoch);
        } else this.pumpPendingTraffic();
        return;
      }

      if (state.role === "interrupter") {
        void this.queueCrossTransmission(userId, pcm, state, durationMs);
        return;
      }

      this.enqueue(async () => {
        try {
          if (this.channelOwner !== userId || this.channelEpoch !== state.epoch) {
            this.cancelPrepared(state);
            return;
          }
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
    if (state.prepared || this.active.get(userId) !== state || typeof this.gemini.prepareTransmission !== "function")
      return;
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
      await this.text
        .warning(error instanceof Error ? error.message : "Radio processing failed.")
        .catch(() => undefined);
    });
  }

  async process(userId, pcm, epoch, preparedPromise = null, metadata = {}) {
    this.rememberAudio(pcm);
    const audioDurationMs = analyzePcm16Mono(pcm).durationMs;
    const unit = this.dispatch.units.getByUserId(userId);
    if (!unit) {
      if (!this.unregisteredWarnings.has(userId)) {
        this.unregisteredWarnings.add(userId);
        await this.text
          .warning(`Ignoring radio audio from <@${userId}> because that user has not registered a unit.`)
          .catch(() => undefined);
      }
      await this.dispatch.logTransmission({
        discordUserId: userId,
        callsign: null,
        transcript: "",
        dispatcherTranscript: "",
        overlap: Boolean(metadata.overlap),
        actions: [],
        confidence: 0,
        confidenceDisposition: "IGNORED",
        rawAudioDurationMs: audioDurationMs,
      });
      return;
    }

    let result;
    try {
      result = preparedPromise
        ? await (await preparedPromise).complete(pcm)
        : await this.gemini.handleTransmission(pcm, unit, this.dispatch);
    } catch (error) {
      const partialTranscript = String(error?.inputTranscript ?? "").trim();
      if (partialTranscript && this.dispatch.processOfficerTransmission) {
        try {
          const workflow = await this.dispatch.processOfficerTransmission(userId, partialTranscript);
          if (workflow.handled) {
            const classification = classifyRadioTransmission({
              transcript: partialTranscript,
              pcm,
              callsign: unit.callsign,
              overlap: Boolean(metadata.overlap),
              hotMicMinimumMs: this.config.HOT_MIC_CONFIRM_MS ?? 5000,
              rmsThreshold: this.config.VOICE_RMS_THRESHOLD,
            });
            let audio = Buffer.alloc(0);
            try {
              audio = await this.gemini.synthesize(workflow.response);
            } catch {
              /* text CAD state is still preserved */
            }
            await this.dispatch.logTransmission({
              discordUserId: userId,
              callsign: unit.callsign,
              transcript: partialTranscript,
              dispatcherTranscript: workflow.response,
              overlap: Boolean(metadata.overlap),
              actions: workflow.context.orderedActions,
              facts: compressRadioTraffic(partialTranscript),
              confidence: workflow.interpretation.confidence,
              confidenceDisposition: "EXECUTE",
              rawAudioDurationMs: audioDurationMs,
              ...radioDecisionFields(classification),
              ...officerWorkflowLogFields(workflow, null, unit, partialTranscript),
            });
            void this.text.transcript(unit.callsign, partialTranscript, workflow.response).catch(() => undefined);
            if (audio.length && this.channelOwner === userId && this.channelEpoch === epoch)
              await this.playback.play(audio);
            return;
          }
        } catch {
          /* use the normal 10-9 failure path */
        }
      }
      await this.replyTenNine(unit, userId, epoch, "", [], {
        ...metadata,
        rawAudioDurationMs: audioDurationMs,
        classification: {
          classification: metadata.overlap ? "CROSS_TRANSMISSION" : "UNCLEAR_RADIO_TRAFFIC",
          confidence: 0,
          reason: "Radio processing failed before the transmission could be understood.",
          containsDispatchInformation: false,
          requiresRepeat: true,
        },
      });
      return;
    }
    const transcript = result.inputTranscript.trim();
    const normalization = this.dispatch.normalizeTransmission?.(userId, transcript);
    const classifiedTranscript = normalization?.normalizedTraffic ?? transcript;
    const classification = classifyRadioTransmission({
      transcript: classifiedTranscript,
      pcm,
      callsign: unit.callsign,
      overlap: Boolean(metadata.overlap),
      hotMicMinimumMs: this.config.HOT_MIC_CONFIRM_MS ?? 5000,
      rmsThreshold: this.config.VOICE_RMS_THRESHOLD,
    });
    const emergencyAssessment = classifyEmergencyTraffic(classifiedTranscript);
    if (emergencyAssessment.kind === "OFFICER_PANIC") {
      const dispatcherTranscript = await this.escalateOfficerPanic(userId, transcript);
      await this.dispatch.logTransmission({
        discordUserId: userId,
        callsign: unit.callsign,
        transcript,
        dispatcherTranscript,
        overlap: Boolean(metadata.overlap),
        actions: result.actions,
        confidence: 1,
        confidenceDisposition: "EXECUTE",
        rawAudioDurationMs: audioDurationMs,
        detectedLanguage: result.detectedLanguage ?? null,
        languageConfidence: result.languageConfidence ?? null,
        alternativeTranscripts: result.alternativeTranscripts ?? [],
        normalizedTranscript: normalization?.normalizedTranscript ?? transcript,
        correctionsApplied: normalization?.corrections ?? [],
        codesDetected: normalization?.codesDetected?.map((match) => match.code) ?? [],
        codeDefinitionsUsed:
          normalization?.codesDetected?.map((match) => ({
            code: match.code,
            meaning: match.definition.meaning,
            category: match.definition.category,
            action: match.definition.action,
          })) ?? [],
        emergencyPhrases: normalization?.emergencyPhrases ?? [],
        negationScopes: normalization?.negationScopes ?? [],
        interpretationDisposition: "ACTIONABLE",
        executionDisposition: "EXECUTED",
        replyDisposition: "REPLIED",
        ...radioDecisionFields(classification),
      });
      void this.text.transcript(unit.callsign, transcript, dispatcherTranscript).catch(() => undefined);
      return;
    }
    const language = assessTranscriptLanguage(result, transcript);
    const nonEnglishUncertain =
      language.detectedLanguage !== null &&
      language.detectedLanguage !== "en" &&
      language.languageConfidence >= (this.config.RADIO_LANGUAGE_CONFIDENCE_THRESHOLD ?? 0.75);
    if (nonEnglishUncertain) {
      const possiblyDirected =
        classification.containsDispatchInformation || isDirectedRadioTraffic(transcript, unit.callsign);
      const languageMetadata = {
        ...metadata,
        rawAudioDurationMs: audioDurationMs,
        classification,
        detectedLanguage: language.detectedLanguage,
        languageConfidence: language.languageConfidence,
        alternativeTranscripts: language.alternativeTranscripts,
        normalizedTranscript: normalization?.normalizedTranscript ?? transcript,
      };
      if (possiblyDirected) await this.replyTenNine(unit, userId, epoch, transcript, [], languageMetadata);
      else
        await this.dispatch.logTransmission({
          discordUserId: userId,
          callsign: unit.callsign,
          transcript,
          dispatcherTranscript: "",
          overlap: Boolean(metadata.overlap),
          actions: [],
          confidence: classification.confidence,
          confidenceDisposition: "IGNORED",
          rawAudioDurationMs: audioDurationMs,
          detectedLanguage: language.detectedLanguage,
          languageConfidence: language.languageConfidence,
          alternativeTranscripts: language.alternativeTranscripts,
          normalizedTranscript: normalization?.normalizedTranscript ?? transcript,
          interpretationDisposition: "UNRELATED",
          executionDisposition: "NO_ACTION",
          replyDisposition: "SUPPRESSED_POLICY",
          ...radioDecisionFields(classification),
        });
      return;
    }
    const hotMicDecision = await this.evaluateHotMicDecision(userId, unit, epoch, classification);
    let officerWorkflow = null;
    if (
      ["VALID_RADIO_TRAFFIC", "CROSS_TRANSMISSION", "EMERGENCY_INTERRUPTION"].includes(classification.classification) &&
      classification.containsDispatchInformation
    ) {
      try {
        officerWorkflow = await this.dispatch.processOfficerTransmission?.(
          userId,
          transcript,
          null,
          result.executionContext?.suggestedActions ?? [],
        );
        if (officerWorkflow?.context.createdCallId && this.gemini.triageCall) {
          const call = officerWorkflow.call;
          void this.gemini
            .triageCall({
              source: "OFFICER_INITIATED",
              incident: call.incident,
              location: call.location,
              description: transcript,
            })
            .then((triage) => this.dispatch.refineOfficerCallPriority(officerWorkflow.context.createdCallId, triage))
            .catch((error) =>
              this.text
                .warning(
                  `AI priority refinement was unavailable for ${officerWorkflow.context.createdCallId}; the conservative local priority remains active. ${error instanceof Error ? error.message : "Unknown triage error"}`,
                )
                .catch(() => undefined),
            );
        }
      } catch (error) {
        void this.text
          .warning(
            `Officer-initiated incident processing failed for ${unit.callsign}; successful Gemini actions were preserved. ${error instanceof Error ? error.message : "Unknown action error"}`,
          )
          .catch(() => undefined);
      }
    }
    if (classification.classification === "CONFIRMED_HOT_MIC" && hotMicDecision.reply) {
      await this.dispatch.logTransmission({
        discordUserId: userId,
        callsign: unit.callsign,
        transcript,
        dispatcherTranscript: hotMicDecision.reply,
        overlap: Boolean(metadata.overlap),
        actions: [],
        facts: [],
        rawAudioDurationMs: audioDurationMs,
        detectedLanguage: language.detectedLanguage,
        languageConfidence: language.languageConfidence,
        confidence: classification.confidence,
        confidenceDisposition: "IGNORED",
        ...radioDecisionFields(classification, hotMicDecision),
      });
      void this.text.transcript(unit.callsign, transcript, hotMicDecision.reply).catch(() => undefined);
      return;
    }
    if (classification.classification === "BRIEF_ACCIDENTAL_NOISE") {
      await this.dispatch.logTransmission({
        discordUserId: userId,
        callsign: unit.callsign,
        transcript,
        dispatcherTranscript: "",
        overlap: Boolean(metadata.overlap),
        actions: [],
        rawAudioDurationMs: audioDurationMs,
        detectedLanguage: language.detectedLanguage,
        languageConfidence: language.languageConfidence,
        confidence: classification.confidence,
        confidenceDisposition: "IGNORED",
        ...radioDecisionFields(classification, hotMicDecision),
      });
      return;
    }
    const directed = classification.containsDispatchInformation || isDirectedRadioTraffic(transcript, unit.callsign);
    if (!directed && (classification.requiresRepeat || classification.classification === "UNCLEAR_RADIO_TRAFFIC")) {
      if (classification.requiresRepeat)
        await this.replyTenNine(unit, userId, epoch, transcript, [], {
          ...metadata,
          rawAudioDurationMs: audioDurationMs,
          classification,
          hotMicDecision,
        });
      else
        await this.dispatch.logTransmission({
          discordUserId: userId,
          callsign: unit.callsign,
          transcript,
          dispatcherTranscript: "",
          overlap: Boolean(metadata.overlap),
          actions: [],
          confidence: classification.confidence,
          confidenceDisposition: "IGNORED",
          rawAudioDurationMs: audioDurationMs,
          ...radioDecisionFields(classification, hotMicDecision),
        });
      return;
    }
    const assessment = officerWorkflow?.handled
      ? { score: officerWorkflow.interpretation.confidence, disposition: "EXECUTE" }
      : directed
        ? assessTransmissionConfidence(transcript, result)
        : { score: 1, disposition: "IGNORED" };
    let dispatcherTranscript = officerWorkflow?.handled
      ? officerWorkflow.response
      : directed
        ? result.outputTranscript.trim()
        : "";
    let responseAudio = officerWorkflow?.handled ? Buffer.alloc(0) : result.audio;
    if (directed && assessment.disposition !== "EXECUTE") {
      dispatcherTranscript = confidenceReply(unit, assessment, transcript);
      responseAudio = Buffer.alloc(0);
    } else if (directed && responseAudio.length === 0) {
      dispatcherTranscript ||= `${speakCallsign(unit.callsign)}, ${nextAcknowledgement()}`;
    }
    if (directed && dispatcherTranscript) {
      const enforced = enforceFullCallsign(dispatcherTranscript, unit.callsign);
      if (enforced.changed) {
        dispatcherTranscript = enforced.text;
        responseAudio = Buffer.alloc(0);
      }
    }
    if (directed && responseAudio.length === 0) {
      responseAudio = Buffer.alloc(0);
      try {
        responseAudio = await this.gemini.synthesize(dispatcherTranscript);
      } catch (error) {
        await this.text
          .warning(
            `Could not synthesize a radio reply for ${unit.callsign}: ${error instanceof Error ? error.message : "Unknown error"}`,
          )
          .catch(() => undefined);
      }
    }
    await this.dispatch.logTransmission({
      discordUserId: userId,
      callsign: unit.callsign,
      transcript,
      dispatcherTranscript,
      overlap: Boolean(metadata.overlap),
      rawAudioDurationMs: audioDurationMs,
      detectedLanguage: language.detectedLanguage,
      languageConfidence: language.languageConfidence,
      alternativeTranscripts: language.alternativeTranscripts,
      normalizedTranscript: normalization?.normalizedTranscript ?? transcript,
      correctionsApplied: normalization?.corrections ?? [],
      codesDetected: normalization?.codesDetected?.map((match) => match.code) ?? [],
      codeDefinitionsUsed:
        normalization?.codesDetected?.map((match) => ({
          code: match.code,
          meaning: match.definition.meaning,
          category: match.definition.category,
          action: match.definition.action,
        })) ?? [],
      emergencyPhrases: normalization?.emergencyPhrases ?? [],
      negationScopes: normalization?.negationScopes ?? [],
      parsedIntent: officerWorkflow
        ? JSON.stringify({
            classification: officerWorkflow.interpretation.classification,
            resources: officerWorkflow.interpretation.resources,
            resourceCancellations: officerWorkflow.interpretation.resourceCancellations,
            sceneResolution: officerWorkflow.interpretation.sceneResolution,
            informationRequest: officerWorkflow.interpretation.informationRequest,
          })
        : "{}",
      actions: [...new Set([...(result.actions ?? []), ...(officerWorkflow?.context.orderedActions ?? [])])],
      facts: compressRadioTraffic(transcript),
      confidence: assessment.score,
      confidenceDisposition: assessment.disposition,
      ...radioDecisionFields(classification, hotMicDecision),
      ...officerWorkflowLogFields(officerWorkflow, result.executionContext, unit, transcript),
    });
    if (!directed) return;
    void this.text
      .transcript(unit.callsign, transcript, dispatcherTranscript || "Radio acknowledgement transmitted.")
      .catch(() => undefined);
    if (this.channelOwner !== userId || this.channelEpoch !== epoch) return;
    if (responseAudio.length > 0) await this.playback.play(responseAudio);
  }

  async replyTenNine(unit, userId, epoch, transcript = "", actions = [], metadata = {}) {
    const reply = `${speakCallsign(unit.callsign)}, 10-9 your traffic.`;
    let audio = Buffer.alloc(0);
    try {
      audio = await this.gemini.synthesize(reply);
    } catch (error) {
      await this.text
        .warning(
          `Radio processing and 10-9 fallback failed for ${unit.callsign}: ${error instanceof Error ? error.message : "Unknown error"}`,
        )
        .catch(() => undefined);
    }
    await this.dispatch.logTransmission({
      discordUserId: userId,
      callsign: unit.callsign,
      transcript,
      dispatcherTranscript: reply,
      overlap: Boolean(metadata.overlap),
      actions,
      confidence: 0,
      confidenceDisposition: "REPEAT",
      rawAudioDurationMs: metadata.rawAudioDurationMs ?? 0,
      detectedLanguage: metadata.detectedLanguage ?? null,
      languageConfidence: metadata.languageConfidence ?? null,
      alternativeTranscripts: metadata.alternativeTranscripts ?? [],
      normalizedTranscript: metadata.normalizedTranscript ?? transcript,
      ...radioDecisionFields(metadata.classification, metadata.hotMicDecision),
    });
    void this.text.transcript(unit.callsign, transcript, reply).catch(() => undefined);
    if (audio.length > 0 && this.channelOwner === userId && this.channelEpoch === epoch)
      await this.playback.play(audio);
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
        await this.dispatch.setUnitLocation(userId, location, "PANIC");
      }
    } catch (error) {
      void this.text
        .warning(
          `Officer panic location lookup failed for ${unit.callsign}; broadcasting with ${location ? "the unit's last known location" : "location unavailable"}. ${error instanceof Error ? error.message : "Unknown ER:LC error"}`,
        )
        .catch(() => undefined);
    }

    const panicDescription = describeOfficerPanic(transcript);
    const locationTraffic = location ? `Location ${location}.` : "Location unavailable; unit advise when able.";
    const announcement = `All units, mass panic. ${speakCallsign(unit.callsign)} ${panicDescription}. ${locationTraffic} All available units respond Code 3.`;
    await this.dispatch
      .activateOfficerEmergency?.(userId, {
        transcript,
        description: panicDescription,
        location,
        locationSource,
        stageMedical: /\b(?:officer down|taking fire|under fire|being shot at|shots? fired at)\b/i.test(transcript),
      })
      .catch((error) => {
        void this.text
          .warning(
            `Officer emergency CAD activation failed for ${unit.callsign}: ${error instanceof Error ? error.message : "Unknown error"}`,
          )
          .catch(() => undefined);
      });
    if (this.text.panic) void this.text.panic(unit, location, locationSource, transcript).catch(() => undefined);
    await this.speak(announcement, true);
    this.schedulePanicStatusCheck(userId, unit.callsign);
    return announcement;
  }

  schedulePanicStatusCheck(userId, callsign) {
    const existing = this.panicStatusTimers.get(userId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.panicStatusTimers.delete(userId);
      const unit = this.dispatch.units.getByUserId(userId);
      if (unit?.status !== "EMERGENCY") return;
      void this.announce(
        `${speakCallsign(callsign)}, emergency status check. Advise when able.`,
        true,
        "EMERGENCY",
      ).catch(() => undefined);
    }, this.config.PANIC_STATUS_CHECK_MS ?? 30_000);
    timer.unref?.();
    this.panicStatusTimers.set(userId, timer);
  }

  async probeEmergencyCutIn(userId, state) {
    if (
      state.emergencyProbeRunning ||
      this.active.get(userId) !== state ||
      state.role !== "interrupter" ||
      this.channelEpoch !== state.epoch
    )
      return;
    state.emergencyProbeRunning = true;
    const pcm = Buffer.concat(state.chunks);
    const minimumMs = this.config.CROSS_TRANSMISSION_EMERGENCY_CHECK_MS ?? 650;
    if (!isLikelySpeech(pcm, { minimumDurationMs: minimumMs, rmsThreshold: this.config.VOICE_RMS_THRESHOLD })) {
      state.emergencyProbeRunning = false;
      this.scheduleEmergencyProbe(userId, state, this.config.CROSS_TRANSMISSION_RECHECK_MS ?? 900);
      return;
    }
    try {
      const detection = await this.detectEmergencyQueued(pcm);
      if (detection.emergency) await this.promoteEmergencyCutIn(userId, state);
    } catch (error) {
      void this.text
        .warning(
          `Could not classify priority cut-in traffic: ${error instanceof Error ? error.message : "Unknown error"}`,
        )
        .catch(() => undefined);
    } finally {
      state.emergencyProbeRunning = false;
      this.scheduleEmergencyProbe(userId, state, this.config.CROSS_TRANSMISSION_RECHECK_MS ?? 900);
    }
  }

  scheduleEmergencyProbe(userId, state, delayMs) {
    if (this.active.get(userId) !== state || state.role !== "interrupter") return;
    if (state.emergencyTimer) clearTimeout(state.emergencyTimer);
    state.emergencyTimer = setTimeout(() => {
      void this.probeEmergencyCutIn(userId, state);
    }, delayMs);
  }

  async promoteEmergencyCutIn(userId, state) {
    if (state.role !== "interrupter" || this.active.get(userId) !== state) return false;
    const previousOwner = this.channelOwner;
    const emergencyEpoch = ++this.channelEpoch;
    state.role = "owner";
    state.epoch = emergencyEpoch;
    state.emergencyPromoted = true;
    this.channelOwner = userId;
    this.playback.stop();
    if (previousOwner && previousOwner !== ANNOUNCEMENT_OWNER && previousOwner !== userId)
      await this.setControlledMute(previousOwner, true, emergencyEpoch);
    return true;
  }

  async queueCrossTransmission(userId, pcm, state, durationMs = analyzePcm16Mono(pcm).durationMs) {
    this.rememberAudio(pcm);
    if (durationMs < (this.config.RADIO_TAP_IGNORE_MS ?? 300)) {
      this.pumpPendingTraffic();
      return;
    }
    this.classifyingTraffic.add(state);
    try {
      const detection = await this.detectEmergencyQueued(pcm);
      if (detection.emergency && this.active.get(userId) === state) {
        await this.promoteEmergencyCutIn(userId, state);
        return;
      }
      if (detection.emergency) {
        const previousOwner = this.channelOwner;
        const emergencyEpoch = ++this.channelEpoch;
        this.channelOwner = userId;
        this.playback.stop();
        if (previousOwner && previousOwner !== ANNOUNCEMENT_OWNER && previousOwner !== userId)
          await this.setControlledMute(previousOwner, true, emergencyEpoch);
        this.enqueue(async () => {
          try {
            await this.process(userId, pcm, emergencyEpoch, null, { overlap: true });
          } finally {
            await this.releaseChannel(userId, emergencyEpoch);
          }
        });
        return;
      }
    } catch (error) {
      void this.text
        .warning(
          `Could not classify overlapping traffic; it will be processed routinely. ${error instanceof Error ? error.message : "Unknown error"}`,
        )
        .catch(() => undefined);
    } finally {
      this.classifyingTraffic.delete(state);
    }
    this.pendingTraffic.push({ userId, pcm, startedAt: state.startedAt, sequence: state.sequence, overlap: true });
    this.pendingTraffic.sort((a, b) => a.startedAt - b.startedAt || a.sequence - b.sequence);
    this.pumpPendingTraffic();
  }

  pumpPendingTraffic() {
    if (this.channelOwner !== null || !this.isConnected() || this.pendingTraffic.length === 0) return false;
    const next = this.pendingTraffic[0];
    const earlierStillActive =
      [...this.active.values()].some(
        (state) =>
          state.role === "interrupter" &&
          (state.startedAt < next.startedAt || (state.startedAt === next.startedAt && state.sequence < next.sequence)),
      ) ||
      [...this.classifyingTraffic].some(
        (state) =>
          state.startedAt < next.startedAt || (state.startedAt === next.startedAt && state.sequence < next.sequence),
      );
    if (earlierStillActive) return false;
    this.pendingTraffic.shift();
    const epoch = ++this.channelEpoch;
    this.channelOwner = next.userId;
    this.enqueue(async () => {
      try {
        await this.process(next.userId, next.pcm, epoch, null, { overlap: true });
      } finally {
        await this.releaseChannel(next.userId, epoch);
      }
    });
    return true;
  }

  async evaluateHotMicDecision(userId, unit, epoch, classification) {
    return this.moderation.evaluateHotMicDecision(userId, unit, epoch, classification);
  }

  async transmitHotMicWarning(userId, unit, epoch, reply) {
    return this.moderation.transmitHotMicWarning(userId, unit, epoch, reply);
  }

  async persistHotMicWarnings() {
    return this.moderation.persistHotMicWarnings();
  }

  async recoverHotMicWarnings() {
    return this.moderation.recoverHotMicWarnings();
  }

  async applyHotMicMute(userId, durationMs) {
    return this.moderation.applyHotMicMute(userId, durationMs);
  }

  async releaseHotMicMute(userId) {
    return this.moderation.releaseHotMicMute(userId);
  }

  async releaseHotMicMutes() {
    return this.moderation.releaseHotMicMutes();
  }

  async persistHotMicMutes() {
    return this.moderation.persistHotMicMutes();
  }

  async recoverHotMicMutes() {
    return this.moderation.recoverHotMicMutes();
  }

  rememberAudio(pcm) {
    if (!pcm?.length) return;
    this.recentAudio.push({ timestamp: Date.now(), pcm: Buffer.from(pcm) });
    const cutoff = Date.now() - HISTORY_LIMITS.recentAudioMs;
    while (this.recentAudio.length && this.recentAudio[0].timestamp < cutoff) this.recentAudio.shift();
  }

  async playbackRecent(seconds = 15) {
    if (!this.isConnected()) throw new Error("Dispatch is not connected to voice.");
    const bounded = Math.max(1, Math.min(30, seconds));
    const cutoff = Date.now() - bounded * 1000;
    const selected = this.recentAudio
      .filter((item) => item.timestamp >= cutoff)
      .map((item) => downsample48kMono(item.pcm));
    if (!selected.length) throw new Error("No recent radio audio is available.");
    await this.queueAnnouncement({
      playbackAudio: Buffer.concat(selected),
      priority: false,
      level: RADIO_PRIORITY.ROUTINE_REPLY,
    });
    return bounded;
  }

  async releaseChannel(userId, epoch) {
    if (this.channelOwner !== userId || this.channelEpoch !== epoch) return;
    this.channelOwner = null;
    await this.releaseControlledMutes();
    if (!this.pumpPendingTraffic()) this.pumpAnnouncements();
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
      void this.gemini
        .detectEmergency(item.pcm)
        .then(item.resolve, item.reject)
        .finally(() => {
          this.emergencyActive -= 1;
          this.pumpEmergencyQueue();
        });
    }
  }

  async setControlledMute(userId, muted, expectedEpoch = null) {
    return this.moderation.setControlledMute(userId, muted, expectedEpoch);
  }

  async releaseControlledMutes() {
    return this.moderation.releaseControlledMutes();
  }

  async persistControlledMutes() {
    return this.moderation.persistControlledMutes();
  }

  async recoverControlledMutes() {
    return this.moderation.recoverControlledMutes();
  }
}

function radioDecisionFields(classification = {}, hotMicDecision = {}) {
  return {
    radioClassification: classification.classification ?? "UNCLEAR_RADIO_TRAFFIC",
    classificationConfidence: classification.confidence ?? 0,
    classificationReason: classification.reason ?? "The transmission could not be classified with confidence.",
    containsDispatchInformation: classification.containsDispatchInformation ?? false,
    hotMicDecision: {
      previousWarningCount: hotMicDecision.previousWarningCount ?? 0,
      updatedWarningCount: hotMicDecision.updatedWarningCount ?? 0,
      action: hotMicDecision.action ?? "NONE",
    },
  };
}

function assessTranscriptLanguage(result, transcript) {
  const supplied = String(result?.detectedLanguage ?? "")
    .trim()
    .toLowerCase()
    .split(/[-_]/)[0];
  if (supplied)
    return {
      detectedLanguage: supplied,
      languageConfidence: Number.isFinite(result?.languageConfidence) ? result.languageConfidence : 0.5,
      alternativeTranscripts: Array.isArray(result?.alternativeTranscripts) ? result.alternativeTranscripts : [],
    };
  // Gemini Live does not always expose a language tag. This deliberately
  // conservative fallback only labels a transcript when several strong markers
  // agree; one ambiguous word must not turn valid radio traffic into a 10-9.
  const words =
    String(transcript ?? "")
      .toLowerCase()
      .match(/[a-z\u00c0-\u024f]+/g) ?? [];
  const spanishMarkers = new Set([
    "hola",
    "gracias",
    "por",
    "favor",
    "necesito",
    "ayuda",
    "calle",
    "vehiculo",
    "vehículo",
    "oficial",
    "policia",
    "policía",
    "fuego",
    "herido",
    "aqui",
    "aquí",
    "donde",
    "esta",
    "está",
  ]);
  const markerCount = words.filter((word) => spanishMarkers.has(word)).length;
  if (markerCount >= 2)
    return {
      detectedLanguage: "es",
      languageConfidence: Math.min(0.98, 0.65 + markerCount * 0.1),
      alternativeTranscripts: [],
    };
  return { detectedLanguage: null, languageConfidence: null, alternativeTranscripts: [] };
}

function officerWorkflowLogFields(workflow, aiContext, unit, transcript) {
  const context = workflow?.context ?? aiContext ?? {};
  const actionResults = [...(aiContext?.actionResults ?? []), ...(workflow?.context?.actionResults ?? [])];
  const failedActions = [...(aiContext?.failedActions ?? []), ...(workflow?.context?.failedActions ?? [])];
  const observation = workflow?.interpretation.vehicleObservation ?? null;
  return {
    speakerIdentity: unit.discordUserId,
    normalizedTranscript: workflow?.interpretation.normalizedTranscript ?? `[${unit.callsign}] ${transcript}`,
    existingCallCandidates: workflow?.candidates ?? [],
    activeCallId: context.activeCallId ?? null,
    orderedActions: [...new Set([...(aiContext?.orderedActions ?? []), ...(workflow?.context?.orderedActions ?? [])])],
    actionResults: dedupeActionResults(actionResults),
    requestedResourceDetails: workflow?.requestedResourceDetails ?? [],
    boloChanges: workflow?.boloChanges ?? [],
    warrantChanges: workflow?.warrantChanges ?? [],
    failedActions: dedupeActionResults(
      failedActions.map((item) => ({ action: item.action, ok: false, detail: item.reason })),
    ).map((item) => ({ action: item.action, reason: item.detail })),
    observedPlate: observation?.plate ?? null,
    vehicleObservation: observation,
    boloMatches: (workflow?.context?.boloMatches ?? []).map((match) => ({
      boloId: match.bolo.id,
      confidence: match.confidence,
      reasons: match.reasons,
      score: match.score,
      matchedFields: match.matchedFields,
      conflictingFields: match.conflictingFields,
      plateMatchType: match.plateMatchType,
      threatLevel: match.threatLevel,
      matchedAt: new Date().toISOString(),
      reportedBy: unit.callsign,
    })),
    validationResults: context.validationResults ?? [],
    interpretationDisposition: context.interpretationDisposition ?? (workflow?.handled ? "ACTIONABLE" : "UNCLEAR"),
    executionDisposition: context.executionDisposition ?? "NO_ACTION",
    replyDisposition: context.replyDisposition ?? "REPLIED",
  };
}

function dedupeActionResults(items) {
  const seen = new Set();
  return items
    .map((item) => ({
      ...item,
      disposition: item.disposition ?? (item.ok === false ? "FAILED_EXECUTION" : "EXECUTED"),
      action: String(item.action ?? "unknown").slice(0, 100),
      detail: String(item.detail ?? "No detail.").slice(0, 500),
    }))
    .filter((item) => {
      const key = `${item.action}|${item.ok}|${item.detail}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
