import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataStore } from "../src/database/store.js";
import { UnitService } from "../src/dispatch/unit-service.js";
import { CallService } from "../src/dispatch/call-service.js";
import { DispatchService } from "../src/dispatch/dispatch-service.js";
import { interpretOfficerTransmission, parsePlate } from "../src/dispatch/officer-incident.js";
import { executeDispatchAction } from "../src/ai/actions.js";
import { VoiceManager } from "../src/voice/voice-manager.js";

let store;
let units;
let calls;
let dispatch;
let published;

beforeEach(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "echo-officer-incident-"));
  store = new DataStore(directory);
  await store.init();
  units = new UnitService(store);
  calls = new CallService(store, units);
  published = [];
  dispatch = new DispatchService(
    store,
    units,
    calls,
    vi.fn(async (call) => published.push(call)),
    { OFFICER_CALL_MATCH_THRESHOLD: 0.72 },
  );
  await units.register({ discordUserId: "unit", callsign: "1L-18", rank: "Officer", division: "Patrol" });
});

describe("officer-initiated incident workflow", () => {
  it("creates and fully applies the clipped-callsign two-vehicle crash transmission", async () => {
    const transcript =
      "On 19, show me on scene of a dual motor vehicle accident at 7064 Franklin Court requesting two additional units for traffic control as well as FD and EMS.";

    const result = await dispatch.processOfficerTransmission("unit", transcript);
    const call = calls.get(result.context.createdCallId);

    expect(result.handled).toBe(true);
    expect(call).toMatchObject({
      source: "OFFICER_INITIATED",
      incident: "Motor Vehicle Accident",
      description: "Two-vehicle motor vehicle accident",
      location: "7064 Franklin Court",
      priority: 2,
      responseMode: "CODE_2",
      assignedUnits: ["1L-18"],
      unitRoles: { "1L-18": "PRIMARY" },
    });
    expect(units.getByUserId("unit")).toMatchObject({
      status: "ON_SCENE",
      statusCode: "10-23",
      location: "7064 Franklin Court",
      assignedCallId: call.id,
      sceneRole: "PRIMARY",
      radioAliases: ["On 19"],
    });
    expect(call.resourceRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resourceType: "LAW_ENFORCEMENT",
          quantity: 2,
          purpose: "TRAFFIC_CONTROL",
          status: "REQUESTED",
          requestedBy: "1L-18",
        }),
        expect.objectContaining({ resourceType: "FIRE", quantity: 1 }),
        expect.objectContaining({ resourceType: "EMS", quantity: 1 }),
      ]),
    );
    expect(call.notes).toContainEqual(expect.objectContaining({ callsign: "1L-18", text: transcript }));
    expect(call.timeline.map((event) => event.type)).toEqual(
      expect.arrayContaining(["CALL_CREATED", "UNIT_ATTACHED", "RESPONSE_STATUS", "RESOURCE_REQUESTED", "CALL_NOTE"]),
    );
    expect(result.context.failedActions).toEqual([]);
    expect(result.response).toContain(
      "1-Lincoln-18, copy. You're 10-23 at 7064 Franklin Court with a two-vehicle motor vehicle accident",
    );
    expect(result.response).toContain("Two additional units requested for traffic control");
    expect(result.response).toContain("Fire and EMS");
    expect(published.at(-1).id).toBe(call.id);
  });

  it("updates a strong active-call match instead of creating a duplicate", async () => {
    const existing = await calls.create({
      source: "DISCORD_911",
      incident: "Motor Vehicle Accident",
      location: "7064 Franklin Court",
      description: "Two vehicles collided",
      priority: 2,
    });

    const result = await dispatch.processOfficerTransmission(
      "unit",
      "Show me on scene of a motor vehicle accident at 7064 Franklin Court. Requesting EMS.",
    );

    expect(calls.list()).toHaveLength(1);
    expect(result.context).toMatchObject({
      matchedCallId: existing.id,
      activeCallId: existing.id,
      createdCallId: null,
    });
    expect(calls.get(existing.id).requestedResources).toContain("EMS");
    expect(units.getByUserId("unit").assignedCallId).toBe(existing.id);
  });

  it.each([
    ["Starting a traffic stop at 125 Maple Street.", "Traffic Stop", 3],
    ["Show me out with a suspicious person at 400 Freedom Avenue.", "Suspicious Person", 2],
  ])("creates a new officer call for %s", async (transcript, incident, priority) => {
    const result = await dispatch.processOfficerTransmission("unit", transcript);
    expect(result.handled).toBe(true);
    expect(calls.get(result.context.createdCallId)).toMatchObject({
      source: "OFFICER_INITIATED",
      incident,
      priority,
      assignedUnits: ["1L-18"],
    });
  });

  it("uses the assigned call for contextual follow-ups and carries a partial plate into a vehicle BOLO", async () => {
    const created = await dispatch.processOfficerTransmission(
      "unit",
      "Show me on scene of a two vehicle accident at 7064 Franklin Court.",
    );
    await dispatch.processOfficerTransmission("unit", "Add that one driver is complaining of neck pain.");
    await dispatch.processOfficerTransmission("unit", "Vehicle one is a black sedan, partial plate King-2-7.");
    const boloResult = await dispatch.processOfficerTransmission(
      "unit",
      "Put out a BOLO for that vehicle. It just fled westbound.",
    );
    const call = calls.get(created.context.activeCallId);
    const bolo = store.bolos.get()[0];

    expect(call.notes.map((note) => note.text)).toEqual(
      expect.arrayContaining([
        "Add that one driver is complaining of neck pain.",
        "Vehicle one is a black sedan, partial plate King-2-7.",
      ]),
    );
    expect(bolo).toMatchObject({
      type: "VEHICLE",
      callId: call.id,
      status: "ACTIVE",
      directionOfTravel: "westbound",
      plate: { plateType: "PARTIAL", normalizedPattern: "K27*" },
    });
    expect(call.boloIds).toContain(bolo.id);
    expect(boloResult.response).toContain("vehicle BOLO has been issued");
  });

  it("creates, updates, and cancels person and vehicle BOLOs without inventing descriptors", async () => {
    await dispatch.processOfficerTransmission(
      "unit",
      "Put out a BOLO for a tall male wearing black clothing and a ski mask, last seen northbound on foot.",
    );
    expect(store.bolos.get()[0]).toMatchObject({
      type: "PERSON",
      sex: "male",
      clothing: "black clothing and a ski mask",
      directionOfTravel: "northbound",
      travelMode: "ON_FOOT",
      color: null,
    });
    await dispatch.processOfficerTransmission("unit", "Add that the subject may be armed. Update the BOLO.");
    expect(store.bolos.get()[0].threatInformation).toMatch(/armed/i);
    await dispatch.processOfficerTransmission("unit", "Cancel the BOLO, subject is in custody.");
    expect(store.bolos.get()[0].status).toBe("CANCELLED");

    await dispatch.processOfficerTransmission(
      "unit",
      "BOLO for a red Dodge Charger with heavy front-end damage, occupied two times, plate Adam-Boy-Charles-1-2-3.",
    );
    expect(store.bolos.get()[1]).toMatchObject({
      type: "VEHICLE",
      color: "red",
      make: "Dodge",
      model: "Charger",
      damage: "heavy front-end damage",
      occupantCount: 2,
      plate: { plateType: "FULL", normalizedPattern: "ABC123" },
    });
  });

  it.each([
    "Only can 18 any active bolos.",
    "One league in eighteen are there any active bolos?",
    "Are there any active bolos?",
  ])("reads back active BOLOs for query variant: %s", async (query) => {
    await dispatch.processOfficerTransmission(
      "unit",
      "One Lincoln 18, active BOLO out for a black four-door sedan, partial plate Echo Mike Papa, last seen heading south on Highway 55.",
    );

    const result = await dispatch.processOfficerTransmission("unit", query);

    expect(result.handled).toBe(true);
    expect(result.interpretation).toMatchObject({
      classification: "INFORMATION_REQUEST",
      informationRequest: "ACTIVE_BOLOS",
    });
    expect(result.response).toMatch(/one active BOLO/i);
    expect(result.response).toContain("BOLO-00001");
    expect(result.response).toContain("Edward-Mary-Paul");
    expect(result.response).toContain("Highway 55");
    expect(result.response).not.toContain("10-9");
  });

  it("runs a spoken plate against active BOLOs before returning the local records result", async () => {
    await dispatch.processOfficerTransmission(
      "unit",
      "One Lincoln 18, active BOLO out for a black four-door sedan, partial plate Echo Mike Papa, last seen heading south on Highway 55.",
    );

    const result = await dispatch.processOfficerTransmission(
      "unit",
      "1Lincoln18 requesting plate check on a black four-door sedan with the license plate Echo Mike Papa 982",
    );

    expect(result.interpretation).toMatchObject({
      classification: "INFORMATION_REQUEST",
      informationRequest: "REGISTRATION",
      vehicleObservation: { plate: { normalizedPattern: "EMP982" } },
    });
    expect(result.context.boloMatches[0]).toMatchObject({
      bolo: { id: "BOLO-00001" },
      plateMatchType: "PARTIAL_PREFIX",
    });
    expect(result.response).toContain("Possible BOLO match, BOLO-00001");
    expect(result.response).toContain("no records provider is configured");
    expect(result.response).not.toContain("standby");
  });

  it("reports no active BOLOs directly instead of requesting a repeat", async () => {
    const result = await dispatch.processOfficerTransmission("unit", "Are there any active BOLOs?");
    expect(result.response).toContain("There are no active BOLOs");
    expect(result.response).not.toContain("10-9");
  });

  it("handles a standalone BOLO with historical calls but no active call context", async () => {
    await calls.create({
      source: "DISCORD_911",
      incident: "Alarm",
      location: "County Bank",
      description: "Prior unrelated alarm",
      priority: 2,
    });

    const result = await dispatch.processOfficerTransmission(
      "unit",
      "Put out a BOLO for a white male wearing a red hoodie, last seen eastbound on foot.",
    );

    expect(result.handled).toBe(true);
    expect(result.context.activeCallId).toBeNull();
    expect(result.response).toContain("person BOLO has been issued");
    expect(store.bolos.get()[0]).toMatchObject({ status: "ACTIVE", callId: null, directionOfTravel: "eastbound" });
  });

  it("normalizes full, partial, phonetic, unreadable, and uncertain plates without promoting uncertainty", () => {
    expect(parsePlate("Plate Adam-Boy-Charles-1-2-3.")).toMatchObject({
      plateType: "FULL",
      normalizedPattern: "ABC123",
      knownCharacters: "ABC123",
    });
    expect(parsePlate("Partial plate starts with Kilo-David.")).toMatchObject({
      plateType: "PARTIAL",
      normalizedPattern: "KD*",
      unknownCharacterCount: null,
    });
    expect(parsePlate("Last three are 4-7-2.")).toMatchObject({ plateType: "PARTIAL", normalizedPattern: "*472" });
    expect(parsePlate("Possible plate is Bravo-8-1, remaining characters unknown.")).toMatchObject({
      plateType: "POSSIBLE",
      normalizedPattern: "B81*",
      unknownCharacterCount: null,
    });
    expect(parsePlate("Florida plate, partial George-Tom-9.")).toMatchObject({
      jurisdiction: "Florida",
      normalizedPattern: "GT9*",
    });
    expect(parsePlate("Temporary tag, no readable plate.")).toMatchObject({ plateType: "TEMPORARY_TAG" });
    expect(parsePlate("No readable plate.")).toMatchObject({ plateType: "UNREADABLE" });
    expect(parsePlate("No plate.")).toMatchObject({ plateType: "NO_PLATE" });
    expect(parsePlate("Plate may be ABC123 or ABC128.")).toMatchObject({
      plateType: "POSSIBLE",
      normalizedPattern: "ABC123|ABC128",
      knownCharacters: "ABC12",
    });
  });

  it("requires an explicit warrant instruction and enforces rank permissions", async () => {
    expect(interpretOfficerTransmission("He should have a warrant.", units.getByUserId("unit")).warrant).toBeNull();
    const denied = await dispatch.processOfficerTransmission(
      "unit",
      "Enter a warrant for John Smith for felony evasion.",
    );
    expect(store.warrants.get()).toEqual([]);
    expect(denied.context.failedActions[0].reason).toContain("not authorized");

    await units.register({ discordUserId: "supervisor", callsign: "1S-01", rank: "Sergeant", division: "Patrol" });
    const entered = await dispatch.processOfficerTransmission(
      "supervisor",
      "Enter an arrest warrant for John Smith for felony evasion. Add caution, subject may be armed.",
    );
    expect(entered.handled).toBe(true);
    expect(store.warrants.get()[0]).toMatchObject({
      subjectName: "John Smith",
      warrantType: "ARREST",
      status: "ACTIVE",
      issuingUnit: "1S-01",
    });
    await dispatch.processOfficerTransmission("supervisor", "Clear the warrant, subject is in custody.");
    expect(store.warrants.get()[0]).toMatchObject({ status: "CLEARED", clearingUnit: "1S-01" });
  });

  it("lets create_call establish context for dependent resource and note actions", async () => {
    const context = dispatch.createExecutionContext("unit");
    const created = await executeDispatchAction(
      dispatch,
      "unit",
      "create_call",
      {
        incidentType: "Road Hazard",
        location: "500 Liberty Way",
        priority: 2,
        responseCode: 2,
        description: "Debris blocking traffic",
        primaryUnit: "1L-18",
      },
      context,
    );
    const resource = await executeDispatchAction(
      dispatch,
      "unit",
      "request_resource",
      { resource: "DOT", quantity: 1, purpose: "ROADWAY_CONTROL", response_mode: "CODE_2", disposition: "RESPOND" },
      context,
    );
    const note = await executeDispatchAction(
      dispatch,
      "unit",
      "add_call_note",
      { note: "Eastbound lane blocked." },
      context,
    );

    expect(created.ok).toBe(true);
    expect(resource.ok).toBe(true);
    expect(note.ok).toBe(true);
    expect(context.activeCallId).toBe(created.changedCallId);
    expect(calls.get(context.activeCallId)).toMatchObject({
      requestedResources: ["DOT"],
      notes: [expect.objectContaining({ text: "Eastbound lane blocked." })],
    });
  });

  it("provides deterministic local parsing when AI interpretation is unavailable", () => {
    const fallback = interpretOfficerTransmission(
      "Show me out with a disabled vehicle at 900 Madison Road requesting a tow.",
      units.getByUserId("unit"),
    );
    expect(fallback).toMatchObject({
      classification: "OFFICER_INITIATED_INCIDENT",
      incident: { type: "Disabled Vehicle", location: "900 Madison Road" },
      resources: [expect.objectContaining({ resourceType: "WRECKER" })],
    });
  });

  it("selects incident-specific fallback priorities and response codes", () => {
    const unit = units.getByUserId("unit");
    expect(
      interpretOfficerTransmission(
        "Show me on scene of a minor property damage crash with no injuries at 100 Oak Road.",
        unit,
      ).incident,
    ).toMatchObject({ priority: 3, responseCode: 1 });
    expect(
      interpretOfficerTransmission(
        "Show me on scene of a crash blocking traffic with unknown injuries at 100 Oak Road.",
        unit,
      ).incident,
    ).toMatchObject({ priority: 2, responseCode: 2 });
    expect(
      interpretOfficerTransmission("Starting a felony stop on an armed wanted suspect at 100 Oak Road.", unit).incident,
    ).toMatchObject({ priority: 1, responseCode: 3 });
  });

  it("integrates the fallback workflow into voice processing and writes structured debugging data", async () => {
    const transcript =
      "On 19, show me on scene of a dual motor vehicle accident at 7064 Franklin Court requesting two additional units for traffic control as well as FD and EMS.";
    const gemini = {
      handleTransmission: vi.fn().mockResolvedValue({
        inputTranscript: transcript,
        outputTranscript: "Confirm the call?",
        audio: Buffer.alloc(0),
        actions: [],
      }),
      synthesize: vi.fn().mockResolvedValue(Buffer.from([1, 2])),
    };
    const text = { transcript: vi.fn().mockResolvedValue(undefined), warning: vi.fn().mockResolvedValue(undefined) };
    const manager = new VoiceManager({}, {}, gemini, dispatch, text);
    manager.channelOwner = "unit";
    manager.channelEpoch = 3;
    manager.playback.play = vi.fn().mockResolvedValue(undefined);

    await manager.process("unit", Buffer.alloc(48_000 * 2), 3);

    const log = store.transmissions.get()[0];
    expect(log).toMatchObject({
      discordUserId: "unit",
      callsign: "1L-18",
      transcript,
      normalizedTranscript: `[1L-18] ${transcript}`,
      activeCallId: calls.list()[0].id,
      radioClassification: "VALID_RADIO_TRAFFIC",
      orderedActions: expect.arrayContaining([
        "create_or_match_call",
        "set_unit_location",
        "request_resource:FIRE",
        "request_resource:EMS",
        "add_call_note",
      ]),
      requestedResourceDetails: expect.arrayContaining([
        expect.objectContaining({ resourceType: "LAW_ENFORCEMENT", quantity: 2 }),
        expect.objectContaining({ resourceType: "FIRE" }),
        expect.objectContaining({ resourceType: "EMS" }),
      ]),
      failedActions: [],
    });
    expect(log.dispatcherTranscript).not.toContain("confirm the call");
    expect(manager.playback.play).toHaveBeenCalledWith(Buffer.from([1, 2]));
  });
});
