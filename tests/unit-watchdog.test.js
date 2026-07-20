import { describe, expect, it, vi } from "vitest";
import { UnitWatchdog } from "../src/dispatch/unit-watchdog.js";

describe("unit watchdog", () => {
  it("requests status and escalates an ignored call to a supervisor notification", async () => {
    const call = {
      id: "26-000143",
      status: "ACTIVE",
      assignedUnits: ["1L-14"],
      lastActivityAt: new Date(0).toISOString(),
      watchdogLevel: 0,
    };
    const calls = {
      list: vi.fn(() => [call]),
      setWatchdogLevel: vi.fn(async (_id, level) => {
        call.watchdogLevel = level;
        call.lastActivityAt = new Date(0).toISOString();
        return call;
      }),
    };
    const units = { list: vi.fn(() => [{ callsign: "1S-02", rank: "Sergeant", division: "Patrol" }]) };
    const voice = { announce: vi.fn().mockResolvedValue(undefined) };
    const text = { system: vi.fn().mockResolvedValue(undefined), warning: vi.fn() };
    const watchdog = new UnitWatchdog(
      { UNIT_WATCHDOG_FIRST_MS: 1000, UNIT_WATCHDOG_SECOND_MS: 500 },
      calls,
      units,
      voice,
      text,
    );

    await watchdog.check(10_000);
    await watchdog.check(10_000);
    await watchdog.check(10_000);

    expect(voice.announce).toHaveBeenCalledTimes(3);
    expect(text.system).toHaveBeenCalledWith(expect.stringContaining("Recommended supervisor: 1S-02"));
    expect(call.watchdogLevel).toBe(3);
  });
});
