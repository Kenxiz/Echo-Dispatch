import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { EchoDispatchApp } from "../src/app.js";
import { VoiceManager } from "../src/voice/voice-manager.js";

function constantPcm(amplitude, durationMs, sampleRate = 48_000) {
  const samples = Math.floor((sampleRate * durationMs) / 1000);
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) buffer.writeInt16LE(amplitude, index * 2);
  return buffer;
}

describe("voice behavior", () => {
  it("handles handshake errors before readiness and retries without crashing", async () => {
    const makeConnection = () => {
      const connection = new EventEmitter();
      connection.state = { status: "ready" };
      connection.receiver = { speaking: new EventEmitter() };
      connection.destroy = vi.fn();
      return connection;
    };
    const first = makeConnection();
    const second = makeConnection();
    const joinVoiceChannel = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const entersState = vi
      .fn()
      .mockImplementationOnce(async () => {
        first.emit("error", new Error("Cannot perform IP discovery - socket closed"));
        throw new Error("Connection destroyed");
      })
      .mockResolvedValueOnce(second);
    const voiceApi = { joinVoiceChannel, entersState, delay: vi.fn().mockResolvedValue(undefined) };
    const channel = { id: "voice", isVoiceBased: () => true, guild: { id: "guild", voiceAdapterCreator: {} } };
    const manager = new VoiceManager(
      { channels: { fetch: vi.fn().mockResolvedValue(channel) } },
      { DISCORD_VOICE_CHANNEL_ID: "voice" },
      {},
      {},
      { warning: vi.fn().mockResolvedValue(undefined) },
      null,
      voiceApi,
    );
    manager.playback.setConnection = vi.fn();

    await manager.start();

    expect(joinVoiceChannel).toHaveBeenCalledTimes(2);
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(manager.connection).toBe(second);
    expect(manager.playback.setConnection).toHaveBeenCalledWith(second);
  });

  it("queues automatic call announcements", async () => {
    const call = { id: "CALL-0001", status: "ACTIVE", priority: 1 };
    const calls = { create: vi.fn().mockResolvedValue(call) };
    const text = { publishCall: vi.fn().mockResolvedValue(undefined), warning: vi.fn().mockResolvedValue(undefined) };
    const voice = { announceCall: vi.fn().mockResolvedValue(undefined) };
    const gemini = { triageCall: vi.fn().mockResolvedValue({ priority: 1, reason: "Immediate threat to life." }) };
    const app = new EchoDispatchApp({}, {}, calls, text, voice, gemini, {}, {});

    await app.createCall({ source: "DISCORD_911" });

    expect(text.publishCall).toHaveBeenCalledWith(call);
    expect(calls.create).toHaveBeenCalledWith(
      expect.objectContaining({ priority: 1, prioritySource: "AI", priorityReason: "Immediate threat to life." }),
    );
    expect(voice.announceCall).toHaveBeenCalledWith(call, true);
  });

  it("uses structured call synthesis for 911 announcements", async () => {
    const call = { id: "CALL-0001", priority: 1 };
    const synthesizeCall = vi.fn().mockResolvedValue(Buffer.from([1, 2]));
    const synthesize = vi.fn();
    const manager = new VoiceManager({}, {}, { synthesizeCall, synthesize }, {}, { warning: vi.fn() });
    manager.connection = { state: { status: "ready" } };
    manager.playback.play = vi.fn().mockResolvedValue(undefined);

    await manager.announceCall(call, true);

    expect(synthesizeCall).toHaveBeenCalledWith(call, false);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("accepts a call with a conservative fallback when AI triage is unavailable", async () => {
    const calls = { create: vi.fn(async (input) => ({ ...input, id: "CALL-0001", status: "ACTIVE" })) };
    const text = { publishCall: vi.fn().mockResolvedValue(undefined), warning: vi.fn().mockResolvedValue(undefined) };
    const voice = { announceCall: vi.fn().mockResolvedValue(undefined) };
    const gemini = { triageCall: vi.fn().mockRejectedValue(new Error("Triage offline")) };
    const app = new EchoDispatchApp({}, {}, calls, text, voice, gemini, {}, {});

    const call = await app.createCall({
      source: "DISCORD_911",
      incident: "Shots fired",
      location: "County Jail",
      description: "Caller hears gunfire",
    });

    expect(call).toMatchObject({ priority: 1, prioritySource: "FALLBACK" });
    expect(text.warning).toHaveBeenCalledOnce();
    expect(voice.announceCall).toHaveBeenCalledWith(call, true);
  });

  it("holds announcements until the current unit and dispatcher exchange clears", async () => {
    const synthesize = vi.fn().mockResolvedValue(Buffer.from([1, 2]));
    const manager = new VoiceManager({}, {}, { synthesize }, {}, { warning: vi.fn() });
    manager.connection = { state: { status: "ready" } };
    manager.playback.play = vi.fn().mockResolvedValue(undefined);
    manager.channelOwner = "unit";
    manager.channelEpoch = 7;

    const announcement = manager.announce("Automatic 911 call", true);
    await Promise.resolve();
    expect(synthesize).not.toHaveBeenCalled();

    await manager.releaseChannel("unit", 7);
    await announcement;
    expect(synthesize).toHaveBeenCalledWith("Automatic 911 call");
  });

  it("releases only server mutes that Echo Dispatch applied", async () => {
    const setMute = vi.fn().mockResolvedValue(undefined);
    const member = { voice: { channelId: "voice", serverMute: false, setMute } };
    const manager = new VoiceManager({}, {}, {}, {}, { warning: vi.fn() });
    manager.guild = { members: { cache: new Map([["unit", member]]), fetch: vi.fn() } };

    await manager.setControlledMute("unit", true);
    await manager.setControlledMute("unit", false);

    expect(setMute.mock.calls.map(([muted]) => muted)).toEqual([true, false]);
  });

  it("does not remove a moderator's existing server mute", async () => {
    const setMute = vi.fn();
    const member = { voice: { channelId: "voice", serverMute: true, setMute } };
    const manager = new VoiceManager({}, {}, {}, {}, { warning: vi.fn() });
    manager.guild = { members: { cache: new Map([["unit", member]]), fetch: vi.fn() } };

    await manager.setControlledMute("unit", true);
    await manager.setControlledMute("unit", false);

    expect(setMute).not.toHaveBeenCalled();
  });

  it("rolls back a mute if the protected transmission clears while Discord applies it", async () => {
    const manager = new VoiceManager({}, {}, {}, {}, { warning: vi.fn() });
    const setMute = vi.fn().mockImplementation(async (muted) => {
      if (muted) {
        manager.channelOwner = null;
        manager.channelEpoch = 8;
      }
    });
    const member = { voice: { channelId: "voice", serverMute: false, setMute } };
    manager.guild = { members: { cache: new Map([["unit", member]]), fetch: vi.fn() } };
    manager.channelOwner = "other-unit";
    manager.channelEpoch = 7;

    await manager.setControlledMute("unit", true, 7);

    expect(setMute.mock.calls.map(([muted]) => muted)).toEqual([true, false]);
    expect(manager.controlledMutes.has("unit")).toBe(false);
  });

  it("never applies a stale interruption mute", async () => {
    const setMute = vi.fn();
    const member = { voice: { channelId: "voice", serverMute: false, setMute } };
    const manager = new VoiceManager({}, {}, {}, {}, { warning: vi.fn() });
    manager.guild = { members: { cache: new Map([["unit", member]]), fetch: vi.fn() } };
    manager.channelOwner = null;
    manager.channelEpoch = 8;

    await manager.setControlledMute("unit", true, 7);

    expect(setMute).not.toHaveBeenCalled();
  });

  it("bounds simultaneous emergency classifiers during heavy chatter", async () => {
    const pending = [];
    const detectEmergency = vi.fn(() => new Promise((resolve) => pending.push(resolve)));
    const manager = new VoiceManager({}, {}, { detectEmergency }, {}, { warning: vi.fn() });
    const checks = Array.from({ length: 10 }, () => manager.detectEmergencyQueued(Buffer.alloc(2)));

    expect(detectEmergency).toHaveBeenCalledTimes(4);
    pending.shift()({ transcript: "", emergency: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(detectEmergency).toHaveBeenCalledTimes(5);

    while (pending.length) pending.shift()({ transcript: "", emergency: false });
    manager.stop();
    await Promise.all(checks);
  });

  it("preempts a lower-priority dispatcher announcement", async () => {
    const manager = new VoiceManager({}, {}, {}, {}, { warning: vi.fn() });
    manager.connection = { state: { status: "ready" } };
    manager.announcementRunning = true;
    manager.currentAnnouncement = { level: 200 };
    manager.playback.interrupt = vi.fn();

    const pending = manager.queueAnnouncement({ text: "Priority one", level: 400 });

    expect(manager.playback.interrupt).toHaveBeenCalledOnce();
    manager.announcementQueue.shift().resolve();
    await pending;
  });

  it("retains and replays up to thirty seconds of channel audio", async () => {
    const manager = new VoiceManager({}, {}, {}, {}, { warning: vi.fn() });
    manager.connection = { state: { status: "ready" } };
    manager.playback.play = vi.fn().mockResolvedValue(undefined);
    const pcm = Buffer.alloc(48_000 * 2);
    pcm.writeInt16LE(2000, 0);
    manager.rememberAudio(pcm);

    await manager.playbackRecent(15);

    expect(manager.playback.play).toHaveBeenCalledWith(expect.any(Buffer));
    expect(manager.playback.play.mock.calls[0][0].length).toBe(48_000);
  });

  it("queues overlapping routine units in key-up order and processes each independently", async () => {
    const manager = new VoiceManager({}, {}, {}, {}, { warning: vi.fn() });
    manager.connection = { state: { status: "ready" } };
    manager.process = vi.fn().mockResolvedValue(undefined);
    manager.pendingTraffic = [
      { userId: "first", pcm: Buffer.from([1, 2]), startedAt: 10, sequence: 0, overlap: true },
      { userId: "second", pcm: Buffer.from([3, 4]), startedAt: 11, sequence: 1, overlap: true },
    ];

    manager.pumpPendingTraffic();
    await manager.radioQueue;
    await Promise.resolve();
    await manager.radioQueue;

    expect(manager.process.mock.calls.map(([userId]) => userId)).toEqual(["first", "second"]);
    expect(manager.process.mock.calls.every((call) => call[4].overlap)).toBe(true);
  });

  it("promotes emergency cut-ins while the original unit is still transmitting", async () => {
    const oldSetMute = vi.fn().mockResolvedValue(undefined);
    const manager = new VoiceManager(
      {},
      { VOICE_RMS_THRESHOLD: 450, CROSS_TRANSMISSION_EMERGENCY_CHECK_MS: 650 },
      {
        detectEmergency: vi.fn().mockResolvedValue({ transcript: "emergency traffic, shots fired", emergency: true }),
      },
      {},
      { warning: vi.fn() },
    );
    manager.connection = { state: { status: "ready" } };
    manager.guild = {
      members: {
        cache: new Map([["old", { voice: { channelId: "voice", serverMute: false, setMute: oldSetMute } }]]),
        fetch: vi.fn(),
      },
    };
    manager.playback.stop = vi.fn();
    manager.channelOwner = "old";
    manager.channelEpoch = 5;
    const state = {
      role: "interrupter",
      epoch: 5,
      chunks: [constantPcm(2200, 700)],
      startedAt: 1,
      sequence: 1,
      prepared: null,
    };
    manager.active.set("emergency", state);

    await manager.probeEmergencyCutIn("emergency", state);

    expect(manager.channelOwner).toBe("emergency");
    expect(state).toMatchObject({ role: "owner", emergencyPromoted: true });
    expect(manager.playback.stop).toHaveBeenCalledOnce();
    expect(oldSetMute).toHaveBeenCalledWith(true, "Echo Dispatch radio channel control");
  });

  it("warns twice for confirmed hot mics, then applies and restores a two-minute mute", async () => {
    const setMute = vi.fn().mockResolvedValue(undefined);
    const member = { voice: { channelId: "voice", serverMute: false, setMute } };
    const manager = new VoiceManager(
      {},
      { HOT_MIC_WINDOW_MS: 900000, HOT_MIC_MUTE_MS: 120000 },
      {
        synthesize: vi.fn().mockResolvedValue(Buffer.from([1, 2])),
      },
      {},
      { warning: vi.fn() },
    );
    manager.connection = { state: { status: "ready" } };
    manager.guild = { members: { cache: new Map([["unit", member]]), fetch: vi.fn() } };
    manager.channelOwner = "unit";
    manager.channelEpoch = 8;
    manager.playback.play = vi.fn().mockResolvedValue(undefined);
    const unit = { callsign: "1L-18" };
    const confirmed = {
      classification: "CONFIRMED_HOT_MIC",
      confidence: 0.98,
      reason: "Prolonged unrelated room conversation.",
      containsDispatchInformation: false,
    };

    expect((await manager.evaluateHotMicDecision("unit", unit, 8, confirmed)).reply).toContain(
      "hot mic. Secure your radio",
    );
    expect((await manager.evaluateHotMicDecision("unit", unit, 8, confirmed)).reply).toContain(
      "second hot mic warning",
    );
    expect((await manager.evaluateHotMicDecision("unit", unit, 8, confirmed)).reply).toContain("muted for two minutes");
    expect(setMute).toHaveBeenCalledWith(true, "Echo Dispatch repeated hot mic enforcement");

    await manager.releaseHotMicMute("unit");
    expect(setMute).toHaveBeenLastCalledWith(false, "Echo Dispatch hot mic timeout expired");
  });

  it("prewarms Gemini once sustained speech begins", () => {
    const prepareTransmission = vi.fn().mockResolvedValue({ complete: vi.fn(), cancel: vi.fn() });
    const unit = { callsign: "1L-18", discordUserId: "unit" };
    const dispatch = { units: { getByUserId: vi.fn().mockReturnValue(unit) } };
    const manager = new VoiceManager({}, { VOICE_RMS_THRESHOLD: 450 }, { prepareTransmission }, dispatch, {
      warning: vi.fn(),
    });
    const pcm = Buffer.alloc(48_000 * 2 * 0.14);
    for (let index = 0; index < pcm.length / 2; index++) pcm.writeInt16LE(2200, index * 2);
    const state = { chunks: [pcm], prepared: null };
    manager.active.set("unit", state);

    manager.maybePrepareTransmission("unit", state);

    expect(prepareTransmission).toHaveBeenCalledWith(unit, dispatch);
  });

  it("does not delay voice playback on Discord transcript delivery", async () => {
    const transcript = vi.fn(() => new Promise(() => undefined));
    const unit = { callsign: "1L-18", discordUserId: "unit" };
    const dispatch = {
      units: { getByUserId: vi.fn().mockReturnValue(unit) },
      logTransmission: vi.fn().mockResolvedValue(undefined),
    };
    const gemini = {
      handleTransmission: vi.fn().mockResolvedValue({
        inputTranscript: "Dispatch, 1 Lincoln 18, show me 10-8.",
        outputTranscript: "1 Lincoln 18, 10-4.",
        audio: Buffer.from([1, 2]),
        actions: [],
      }),
    };
    const manager = new VoiceManager({}, {}, gemini, dispatch, { transcript, warning: vi.fn() });
    manager.channelOwner = "unit";
    manager.channelEpoch = 3;
    manager.playback.play = vi.fn().mockResolvedValue(undefined);

    await manager.process("unit", Buffer.alloc(48_000 * 2), 3);

    expect(transcript).toHaveBeenCalledOnce();
    expect(manager.playback.play).toHaveBeenCalledOnce();
  });

  it("replies 10-9 when a valid captured transmission is unintelligible", async () => {
    const unit = { callsign: "1L-18", discordUserId: "unit" };
    const dispatch = {
      units: { getByUserId: vi.fn().mockReturnValue(unit) },
      logTransmission: vi.fn().mockResolvedValue(undefined),
    };
    const gemini = {
      handleTransmission: vi
        .fn()
        .mockResolvedValue({ inputTranscript: "", outputTranscript: "", audio: Buffer.from([9]), actions: [] }),
      synthesize: vi.fn().mockResolvedValue(Buffer.from([1, 2])),
    };
    const text = { transcript: vi.fn().mockResolvedValue(undefined), warning: vi.fn().mockResolvedValue(undefined) };
    const manager = new VoiceManager({}, {}, gemini, dispatch, text);
    manager.channelOwner = "unit";
    manager.channelEpoch = 3;
    manager.playback.play = vi.fn().mockResolvedValue(undefined);

    await manager.process("unit", Buffer.alloc(48_000 * 2), 3);

    expect(gemini.synthesize).toHaveBeenCalledWith("1-Lincoln-18, 10-9 your traffic.");
    expect(manager.playback.play).toHaveBeenCalledWith(Buffer.from([1, 2]));
    expect(dispatch.logTransmission).toHaveBeenCalledWith(
      expect.objectContaining({ dispatcherTranscript: "1-Lincoln-18, 10-9 your traffic." }),
    );
  });

  it("asks directed non-English traffic to repeat without treating it as a hot mic", async () => {
    const unit = { callsign: "1L-18", discordUserId: "unit" };
    const dispatch = {
      units: { getByUserId: vi.fn().mockReturnValue(unit) },
      logTransmission: vi.fn().mockResolvedValue(undefined),
    };
    const gemini = {
      handleTransmission: vi.fn().mockResolvedValue({
        inputTranscript: "Dispatch, necesito ayuda por favor.",
        outputTranscript: "",
        audio: Buffer.alloc(0),
        actions: [],
        detectedLanguage: "es",
        languageConfidence: 0.96,
      }),
      synthesize: vi.fn().mockResolvedValue(Buffer.from([1, 2])),
    };
    const text = { transcript: vi.fn().mockResolvedValue(undefined), warning: vi.fn().mockResolvedValue(undefined) };
    const manager = new VoiceManager({}, { RADIO_LANGUAGE_CONFIDENCE_THRESHOLD: 0.75 }, gemini, dispatch, text);
    manager.channelOwner = "unit";
    manager.channelEpoch = 3;
    manager.playback.play = vi.fn().mockResolvedValue(undefined);

    await manager.process("unit", Buffer.alloc(48_000 * 2), 3);

    expect(gemini.synthesize).toHaveBeenCalledWith("1-Lincoln-18, 10-9 your traffic.");
    expect(dispatch.logTransmission).toHaveBeenCalledWith(
      expect.objectContaining({
        detectedLanguage: "es",
        languageConfidence: 0.96,
        dispatcherTranscript: "1-Lincoln-18, 10-9 your traffic.",
        confidenceDisposition: "REPEAT",
      }),
    );
  });

  it("falls back to a 10-9 reply when radio understanding fails", async () => {
    const unit = { callsign: "1L-18", discordUserId: "unit" };
    const dispatch = {
      units: { getByUserId: vi.fn().mockReturnValue(unit) },
      logTransmission: vi.fn().mockResolvedValue(undefined),
    };
    const gemini = {
      handleTransmission: vi.fn().mockRejectedValue(new Error("Live session failed")),
      synthesize: vi.fn().mockResolvedValue(Buffer.from([3])),
    };
    const text = { transcript: vi.fn().mockResolvedValue(undefined), warning: vi.fn().mockResolvedValue(undefined) };
    const manager = new VoiceManager({}, {}, gemini, dispatch, text);
    manager.channelOwner = "unit";
    manager.channelEpoch = 4;
    manager.playback.play = vi.fn().mockResolvedValue(undefined);

    await manager.process("unit", Buffer.alloc(2), 4);

    expect(manager.playback.play).toHaveBeenCalledWith(Buffer.from([3]));
    expect(text.transcript).toHaveBeenCalledWith("1L-18", "", "1-Lincoln-18, 10-9 your traffic.");
  });

  it("broadcasts a mass panic using the unit's live ER:LC location", async () => {
    const unit = {
      callsign: "1L-18",
      discordUserId: "unit",
      robloxUsername: "OfficerPlayer",
      assignedCallId: "CALL-0002",
      location: null,
    };
    const dispatch = {
      units: { getByUserId: vi.fn().mockReturnValue(unit) },
      setUnitStatus: vi.fn().mockResolvedValue(undefined),
      setUnitResponseMode: vi.fn().mockResolvedValue(undefined),
      setUnitLocation: vi.fn().mockResolvedValue(undefined),
      addCallNoteForUnit: vi.fn().mockResolvedValue(undefined),
    };
    const gemini = { synthesize: vi.fn().mockResolvedValue(Buffer.from([4, 5])) };
    const erlc = {
      locateUnit: vi.fn().mockResolvedValue({ found: true, location: "2083 Park Street, postal 218", stale: false }),
    };
    const text = { panic: vi.fn().mockResolvedValue(undefined), warning: vi.fn().mockResolvedValue(undefined) };
    const manager = new VoiceManager({}, { PANIC_COOLDOWN_MS: 15000 }, gemini, dispatch, text, erlc);
    manager.connection = { state: { status: "ready" } };
    manager.playback.play = vi.fn().mockResolvedValue(undefined);

    const reply = await manager.escalateOfficerPanic("unit", "1 Lincoln 18, shots fired, taking fire");

    expect(reply).toContain("All units, mass panic");
    expect(reply).toContain("2083 Park Street, postal 218");
    expect(reply).toContain("respond Code 3");
    expect(dispatch.setUnitStatus).toHaveBeenCalledWith("unit", "EMERGENCY");
    expect(dispatch.setUnitResponseMode).toHaveBeenCalledWith("unit", "CODE_3");
    expect(dispatch.setUnitLocation).toHaveBeenCalledWith("unit", "2083 Park Street, postal 218", "PANIC");
    expect(text.panic).toHaveBeenCalledWith(
      unit,
      "2083 Park Street, postal 218",
      "live ER:LC",
      expect.stringContaining("shots fired"),
    );
    expect(manager.playback.play).toHaveBeenCalledWith(Buffer.from([4, 5]), true);
  });
});
