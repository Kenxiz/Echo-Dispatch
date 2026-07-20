import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DataStore } from "../src/database/store.js";
import { UnitService } from "../src/dispatch/unit-service.js";
import { CallService } from "../src/dispatch/call-service.js";
import { DispatchService } from "../src/dispatch/dispatch-service.js";
let store;
let units;
let calls;
beforeEach(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "echo-dispatch-test-"));
  store = new DataStore(directory);
  await store.init();
  units = new UnitService(store);
  calls = new CallService(store, units);
});
describe("unit registration", () => {
  it("normalizes callsigns and prevents active duplicates", async () => {
    const first = await units.register({ discordUserId: "1", callsign: "1l-18", rank: "Officer", division: "Patrol" });
    expect(first.callsign).toBe("1L-18");
    await expect(units.register({ discordUserId: "2", callsign: "1L-18", rank: "Officer", division: "Patrol" })).rejects.toThrow("already active");
    await expect(units.register({ discordUserId: "1", callsign: "1T-12", rank: "Officer", division: "Traffic" })).rejects.toThrow("already have");
  });
});
describe("call lifecycle", () => {
  it("keeps general unit status separate from call-response status", async () => {
    await units.register({ discordUserId: "1", callsign: "1L-18", rank: "Officer", division: "Patrol" });
    const call = await calls.create({ source: "DISCORD_911", incident: "Crash", radioCode: "10-50", location: "Postal 205", description: "Two vehicles." });
    await calls.attach("1", call.id);
    await calls.setResponseStatus("1", "EN_ROUTE");
    expect(units.getByUserId("1")).toMatchObject({ status: "AVAILABLE", responseStatus: "EN_ROUTE", assignedCallId: call.id });
    await units.setStatus("1", "EN_ROUTE");
    expect(units.getByUserId("1")).toMatchObject({ status: "EN_ROUTE", responseStatus: "EN_ROUTE" });
  });
  it("requires clarification when multiple active calls make a voice reference ambiguous", async () => {
    await units.register({ discordUserId: "1", callsign: "1L-18", rank: "Officer", division: "Patrol" });
    await calls.create({ source: "DISCORD_911", incident: "Crash", location: "Postal 205", description: "Collision" });
    await calls.create({ source: "DISCORD_911", incident: "Suspicious person", location: "Bank", description: "Caller reporting a person" });
    await expect(calls.attach("1")).rejects.toThrow("ambiguous");
  });
  it("closes a call and clears all assigned units", async () => {
    await units.register({ discordUserId: "1", callsign: "1L-18", rank: "Officer", division: "Patrol" });
    const call = await calls.create({ source: "DISCORD_911", incident: "Alarm", location: "Bank", description: "Audible alarm" });
    await calls.attach("1", call.id);
    const closed = await calls.close(call.id);
    expect(closed.status).toBe("CLOSED");
    expect(units.getByUserId("1")).toMatchObject({ status: "AVAILABLE", statusCode: "10-8", assignedCallId: null, responseStatus: "UNASSIGNED" });
  });
  it("closes an attached scene on Code 4 and returns every assigned unit to 10-8", async () => {
    await units.register({ discordUserId: "1", callsign: "1L-18", rank: "Officer", division: "Patrol" });
    await units.register({ discordUserId: "2", callsign: "1A-12", rank: "Officer", division: "Patrol" });
    const call = await calls.create({ source: "DISCORD_911", incident: "Alarm", location: "Bank", description: "Audible alarm" });
    await calls.attach("1", call.id);
    await calls.attach("2", call.id);
    await units.setStatus("1", "ON_SCENE");
    await units.setStatus("2", "ON_SCENE");
    const published = [];
    const dispatch = new DispatchService(store, units, calls, async (changed) => published.push(changed));

    const closed = await dispatch.setSceneStatusForUnit("1", "SECURE");

    expect(closed).toMatchObject({ status: "CLOSED", sceneStatus: "SECURE" });
    expect(closed.closedAt).not.toBeNull();
    expect(units.getByUserId("1")).toMatchObject({ status: "AVAILABLE", statusCode: "10-8", assignedCallId: null, responseStatus: "UNASSIGNED", responseMode: null });
    expect(units.getByUserId("2")).toMatchObject({ status: "AVAILABLE", statusCode: "10-8", assignedCallId: null, responseStatus: "UNASSIGNED", responseMode: null });
    expect(published).toHaveLength(1);
    expect(published[0].status).toBe("CLOSED");
  });
  it("tracks response mode and Code 4 scene status without prematurely closing", async () => {
    await units.register({ discordUserId: "1", callsign: "1L-18", rank: "Officer", division: "Patrol" });
    const call = await calls.create({ source: "DISCORD_911", incident: "Alarm", location: "Bank", description: "Audible alarm", priority: 1 });
    expect(call).toMatchObject({ responseMode: "CODE_3", sceneStatus: "UNKNOWN" });
    await calls.attach("1", call.id);
    expect(units.getByUserId("1")).toMatchObject({ responseMode: "CODE_3" });

    const secure = await calls.setSceneStatus(call.id, "SECURE");
    expect(secure).toMatchObject({ status: "CODE_4", sceneStatus: "SECURE", closedAt: null });
    await calls.detach("1");
    expect(calls.get(call.id)).toMatchObject({ status: "CODE_4", sceneStatus: "SECURE" });
  });

  it("maps expanded operational unit statuses to department codes", async () => {
    await units.register({ discordUserId: "1", callsign: "1L-18", rank: "Officer", division: "Patrol" });
    expect(await units.setStatus("1", "ON_DUTY")).toMatchObject({ statusCode: "10-41" });
    expect(await units.setStatus("1", "PURSUIT")).toMatchObject({ statusCode: "10-43" });
    expect(await units.setStatus("1", "BUILDING_CHECK")).toMatchObject({ statusCode: "10-108" });
  });
  it("tracks requested resources and bounded factual call updates", async () => {
    const call = await calls.create({ source: "DISCORD_911", incident: "Crash", location: "Postal 205", description: "Two vehicles" });
    await calls.requestResource(call.id, "EMS");
    await calls.requestResource(call.id, "EMS");
    await calls.addNote(call.id, "1L-18", "Northbound lane blocked.");
    expect(calls.get(call.id)).toMatchObject({
      requestedResources: ["EMS"],
      notes: [{ callsign: "1L-18", text: "Northbound lane blocked." }],
    });
  });
});
