import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DataStore } from "../src/database/store.js";
import { UnitService } from "../src/dispatch/unit-service.js";
import { CallService } from "../src/dispatch/call-service.js";
import {
  buildHeatmap,
  buildShiftStatistics,
  estimateEtaSeconds,
  findMergeCandidate,
} from "../src/dispatch/cad-intelligence.js";

let store;
let units;
let calls;
beforeEach(async () => {
  store = new DataStore(await mkdtemp(path.join(tmpdir(), "echo-cad-test-")));
  await store.init();
  units = new UnitService(store);
  calls = new CallService(store, units);
});

describe("CAD intelligence", () => {
  it("uses real CAD numbers and records a complete incident timeline", async () => {
    await units.register({ discordUserId: "1", callsign: "1L-14", rank: "Officer", division: "Patrol" });
    const call = await calls.create({
      source: "DISCORD_911",
      incident: "Alarm",
      location: "Postal 205",
      description: "Audible alarm",
      priority: 2,
    });
    expect(call.id).toMatch(/^\d{2}-\d{6}$/);
    await calls.attach("1", call.id);
    await calls.addNote(call.id, "1L-14", "Suspect detained.");
    await calls.close(call.id);
    expect(calls.get(call.id).timeline.map((event) => event.type)).toEqual(
      expect.arrayContaining(["CALL_CREATED", "UNIT_ATTACHED", "CALL_NOTE", "CALL_CLOSED"]),
    );
  });

  it("merges matching callers and escalates new officer-safety information", async () => {
    const first = await calls.create({
      source: "DISCORD_911",
      incident: "Disturbance",
      location: "County Jail",
      description: "Loud disturbance",
      priority: 3,
    });
    const input = {
      source: "DISCORD_911",
      incident: "Disturbance",
      location: "the County Jail",
      description: "Caller now sees a gun",
    };
    expect(findMergeCandidate(calls.list(), input)?.id).toBe(first.id);
    const merged = await calls.mergeReport(first.id, input, { priority: 1 });
    expect(merged).toMatchObject({ callerCount: 2, priority: 1, responseMode: "CODE_3" });
    expect(merged.timeline.some((event) => event.type === "CALL_MERGED")).toBe(true);
  });

  it("recommends available units with estimated response times and automatic staging", async () => {
    await units.register({ discordUserId: "1", callsign: "1L-14", rank: "Officer", division: "Patrol" });
    await units.setLocation("1", "Postal 201");
    const call = await calls.create({
      source: "DISCORD_911",
      incident: "Shots fired",
      location: "Postal 205",
      description: "Multiple shots",
      priority: 1,
    });
    expect(call.recommendedUnits[0]).toMatchObject({ callsign: "1L-14", etaSeconds: 30 });
    expect(call.stagedResources).toContain("EMS");
    expect(estimateEtaSeconds("Postal 201", "Postal 205")).toBe(30);
  });

  it("builds heatmap and shift statistics from persisted activity", async () => {
    const first = await calls.create({
      source: "DISCORD_911",
      incident: "Crash",
      location: "Main and Oak",
      description: "Collision",
      priority: 2,
    });
    await calls.create({
      source: "DISCORD_911",
      incident: "Crash",
      location: "Main and Oak",
      description: "Second collision",
      priority: 2,
    });
    await store.transmissions.update((items) => {
      items.push({
        id: "1",
        timestamp: new Date().toISOString(),
        discordUserId: "1",
        callsign: "1L-14",
        transcript: "traffic",
        dispatcherTranscript: "copy",
        overlap: false,
        actions: [],
      });
    });
    expect(buildHeatmap(calls.list(false))[0]).toMatchObject({ location: "Main and Oak", calls: 2, crashes: 2 });
    expect(
      buildShiftStatistics(calls.list(false), store.transmissions.get(), units.list(), first.createdAt),
    ).toMatchObject({ calls: 2, transmissions: 1, busiestUnit: "1L-14 (1 transmissions)" });
  });
});
