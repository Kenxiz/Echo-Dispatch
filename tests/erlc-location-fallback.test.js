import { describe, expect, it, vi } from "vitest";
import { EchoDispatchApp } from "../src/app.js";

describe("ER:LC emergency location fallback", () => {
  it("replaces a fully tagged in-game report with the caller's current player location", async () => {
    const calls = {
      list: vi.fn(() => []),
      create: vi.fn(async (input) => ({ ...input, id: "26-000001", status: "ACTIVE", priority: input.priority })),
    };
    const text = { publishCall: vi.fn().mockResolvedValue(undefined), warning: vi.fn().mockResolvedValue(undefined) };
    const voice = { announceCall: vi.fn().mockResolvedValue(undefined) };
    const gemini = { triageCall: vi.fn().mockResolvedValue({ priority: 2, reason: "Urgent report." }) };
    const erlc = {
      locateEmergencyCaller: vi.fn().mockResolvedValue({ found: true, location: "125 Maple Street, postal 205" }),
    };
    const app = new EchoDispatchApp({ CALL_REANNOUNCE_DELAY_MS: 120000 }, {}, calls, text, voice, gemini, erlc, {});

    const call = await app.createErlcCall({
      Caller: 123,
      CallNumber: 44,
      StartedAt: 100,
      Description: "Suspicious person",
      PositionDescriptor: "#### ####",
      Position: [-654.6, 666.5],
    });

    expect(erlc.locateEmergencyCaller).toHaveBeenCalledWith(expect.objectContaining({ Caller: 123 }));
    expect(call.location).toBe("125 Maple Street, postal 205");
  });

  it("never replaces a Discord 911 location", async () => {
    const calls = {
      list: vi.fn(() => []),
      create: vi.fn(async (input) => ({ ...input, id: "26-000001", status: "ACTIVE" })),
    };
    const app = new EchoDispatchApp(
      {},
      {},
      calls,
      { publishCall: vi.fn().mockResolvedValue(undefined), warning: vi.fn() },
      { announceCall: vi.fn().mockResolvedValue(undefined) },
      { triageCall: vi.fn().mockResolvedValue({ priority: 3, reason: "Routine." }) },
      { locateEmergencyCaller: vi.fn() },
      {},
    );
    const call = await app.createCall({
      source: "DISCORD_911",
      incident: "Report",
      location: "#### ####",
      description: "Discord report",
    });
    expect(call.location).toBe("#### ####");
    expect(app.erlc.locateEmergencyCaller).not.toHaveBeenCalled();
  });
});
