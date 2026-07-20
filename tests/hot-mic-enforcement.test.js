import { describe, expect, it, vi } from "vitest";
import { VoiceManager } from "../src/voice/voice-manager.js";

const confirmedHotMic = {
  classification: "CONFIRMED_HOT_MIC",
  confidence: 0.98,
  reason: "Prolonged unrelated room conversation and media audio.",
  containsDispatchInformation: false,
};

const validTraffic = {
  classification: "VALID_RADIO_TRAFFIC",
  confidence: 0.99,
  reason: "Operational dispatch information was detected.",
  containsDispatchInformation: true,
};

function createManager(config = {}) {
  const settings = { hotMicWarnings: {} };
  const dispatch = {
    store: {
      settings: {
        get: () => settings,
        update: vi.fn(async (updater) => updater(settings)),
      },
    },
  };
  const manager = new VoiceManager(
    {},
    {
      HOT_MIC_WINDOW_MS: 900_000,
      HOT_MIC_CONFIDENCE_THRESHOLD: 0.92,
      HOT_MIC_WARNING_RESET_TRANSMISSIONS: 2,
      ...config,
    },
    {
      synthesize: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    },
    dispatch,
    { warning: vi.fn().mockResolvedValue(undefined) },
  );
  return { manager, settings };
}

describe("hot-mic enforcement", () => {
  it("keeps warning counts separate for each Discord user", async () => {
    const { manager } = createManager();
    const first = await manager.evaluateHotMicDecision("unit-a", { callsign: "1L-18" }, 1, confirmedHotMic);
    const other = await manager.evaluateHotMicDecision("unit-b", { callsign: "1S-02" }, 1, confirmedHotMic);

    expect(first).toMatchObject({ previousWarningCount: 0, updatedWarningCount: 1, action: "WARNING" });
    expect(other).toMatchObject({ previousWarningCount: 0, updatedWarningCount: 1, action: "WARNING" });
    expect(other.reply).not.toContain("second hot mic warning");
  });

  it("does not count expired warnings toward enforcement", async () => {
    const { manager } = createManager();
    manager.hotMicHistory.set("unit", [Date.now() - 901_000, Date.now() - 902_000]);

    const result = await manager.evaluateHotMicDecision("unit", { callsign: "1L-18" }, 1, confirmedHotMic);

    expect(result).toMatchObject({ previousWarningCount: 0, updatedWarningCount: 1, action: "WARNING" });
    expect(result.reply).not.toContain("second hot mic warning");
  });

  it("reduces warning history after legitimate radio activity", async () => {
    const { manager } = createManager();
    manager.hotMicHistory.set("unit", [Date.now() - 2_000, Date.now() - 1_000]);

    const first = await manager.evaluateHotMicDecision("unit", { callsign: "1L-18" }, 1, validTraffic);
    const second = await manager.evaluateHotMicDecision("unit", { callsign: "1L-18" }, 1, validTraffic);

    expect(first).toMatchObject({ updatedWarningCount: 2, action: "NONE" });
    expect(second).toMatchObject({ previousWarningCount: 2, updatedWarningCount: 1, action: "REDUCED" });
    expect(manager.hotMicHistory.get("unit")).toHaveLength(1);
  });

  it("never enforces cross traffic or low-confidence guesses", async () => {
    const { manager } = createManager();
    const cross = await manager.evaluateHotMicDecision("unit", { callsign: "1L-18" }, 1, {
      classification: "CROSS_TRANSMISSION",
      confidence: 0.99,
      reason: "Two units keyed at once.",
      containsDispatchInformation: false,
    });
    const uncertain = await manager.evaluateHotMicDecision("unit", { callsign: "1L-18" }, 1, {
      ...confirmedHotMic,
      confidence: 0.89,
    });

    expect(cross).toMatchObject({ updatedWarningCount: 0, action: "NONE", reply: "" });
    expect(uncertain).toMatchObject({ updatedWarningCount: 0, action: "NONE", reply: "" });
    expect(manager.hotMicHistory.has("unit")).toBe(false);
  });

  it("requests a 10-9 for unclear traffic and records the structured decision without a warning", async () => {
    const logTransmission = vi.fn().mockResolvedValue(undefined);
    const unit = { callsign: "1L-18", discordUserId: "unit" };
    const dispatch = {
      units: { getByUserId: vi.fn().mockReturnValue(unit) },
      logTransmission,
    };
    const gemini = {
      handleTransmission: vi
        .fn()
        .mockResolvedValue({ inputTranscript: "um", outputTranscript: "", audio: Buffer.alloc(0), actions: [] }),
      synthesize: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    };
    const manager = new VoiceManager({}, {}, gemini, dispatch, {
      warning: vi.fn(),
      transcript: vi.fn().mockResolvedValue(undefined),
    });
    manager.channelOwner = "unit";
    manager.channelEpoch = 4;

    const pcm = Buffer.alloc(48_000 * 2 * 1.2);
    pcm.fill(1);
    await manager.process("unit", pcm, 4);

    expect(logTransmission).toHaveBeenCalledWith(
      expect.objectContaining({
        radioClassification: "UNCLEAR_RADIO_TRAFFIC",
        classificationConfidence: 0.75,
        containsDispatchInformation: false,
        confidenceDisposition: "REPEAT",
        hotMicDecision: { previousWarningCount: 0, updatedWarningCount: 0, action: "NONE" },
      }),
    );
    expect(logTransmission.mock.calls[0][0].dispatcherTranscript).toContain("10-9 your traffic");
  });
});
