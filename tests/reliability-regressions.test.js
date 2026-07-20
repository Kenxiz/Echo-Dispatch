import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataStore } from "../src/database/store.js";
import { UnitService } from "../src/dispatch/unit-service.js";
import { CallService } from "../src/dispatch/call-service.js";
import { DispatchService } from "../src/dispatch/dispatch-service.js";
import { RadioCodebook } from "../src/radio/codebook.js";
import { normalizeRadioTransmission } from "../src/radio/normalizer.js";
import { classifyEmergencyTraffic } from "../src/voice/audio-gate.js";
import { interpretOfficerTransmission, parsePlate, parseResources } from "../src/dispatch/officer-incident.js";

const codebook = await RadioCodebook.load(path.resolve("config/radio-codes.json"));
const fixtures = JSON.parse(await readFile(new URL("./fixtures/radio-transmissions.json", import.meta.url), "utf8"));
let store;
let units;
let calls;
let dispatch;

beforeEach(async () => {
  store = new DataStore(await mkdtemp(path.join(tmpdir(), "echo-reliability-")));
  await store.init();
  units = new UnitService(store);
  calls = new CallService(store, units);
  dispatch = new DispatchService(
    store,
    units,
    calls,
    vi.fn(),
    { CODE4_DEFAULT_ACTION: "SCENE_SECURE", BOLO_MATCH_THRESHOLD: 0.5 },
    codebook,
  );
  await units.register({ discordUserId: "primary", callsign: "1L-18", rank: "Officer", division: "Patrol" });
});

describe("deterministic normalization and configured code execution", () => {
  it.each(["10-71", "10 71", "1071", "ten seventy-one", "ten seven one", "one zero seven one"])(
    "recognizes 10-71 from %s",
    (spoken) => {
      expect(codebook.detect(spoken).map((match) => match.code)).toContain("10-71");
    },
  );

  it.each(fixtures)("normalizes the real-traffic fixture: $name", (fixture) => {
    const normalized = normalizeRadioTransmission(fixture.transcript, { callsign: "1L-18" }, codebook);
    expect(normalized.codesDetected.map((match) => match.code)).toEqual(expect.arrayContaining(fixture.codes));
  });

  it("executes multiple understood code actions and never asks for a configured definition", async () => {
    const result = await dispatch.processOfficerTransmission("primary", fixtures[0].transcript);
    expect(result.context.actionResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "radio_code:10-8:status", disposition: "EXECUTED" }),
        expect.objectContaining({ action: "radio_code:10-71:activity", disposition: "EXECUTED" }),
      ]),
    );
    expect(result.context.validationResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "radio_code:10-8:status", valid: true }),
        expect.objectContaining({ action: "radio_code:10-71:activity", valid: true }),
      ]),
    );
    expect(units.getByUserId("primary")).toMatchObject({
      status: "AVAILABLE",
      statusCode: "10-8",
      activeRadioCodes: [expect.objectContaining({ code: "10-71" })],
    });
    expect(result.response).toContain("10-71, Improper Use of Radio");
    expect(result.response).not.toContain("do not have a definition");
  });

  it("preserves spoken 10-11 rather than substituting 10-61", async () => {
    const result = await dispatch.processOfficerTransmission("primary", "1 Lincoln 18, show me 10-11.");
    expect(units.getByUserId("primary")).toMatchObject({ status: "ON_DUTY", statusCode: "10-11" });
    expect(result.response).toContain("10-11");
    expect(result.response).not.toContain("10-61");
  });

  it("executes known actions while asking only about an unknown secondary code", async () => {
    const result = await dispatch.processOfficerTransmission("primary", "Show me 10-8, active 10-999.");
    expect(units.getByUserId("primary")).toMatchObject({ status: "AVAILABLE", statusCode: "10-8" });
    expect(result.context.actionResults).toContainEqual(
      expect.objectContaining({ action: "radio_code:10-8:status", disposition: "EXECUTED" }),
    );
    expect(result.response).toContain("10-999");
  });

  it("records high-confidence callsign and code corrections", () => {
    const normalized = normalizeRadioTransmission(
      "One link in eighteen show me tonight",
      { callsign: "1L-18" },
      codebook,
    );
    expect(normalized.normalizedTraffic).toBe("show me 10-8");
    expect(normalized.normalizedTranscript).toBe("[1L-18] show me 10-8");
    expect(normalized.corrections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "CALLSIGN", to: "1L-18", confidence: expect.any(Number) }),
        expect.objectContaining({ field: "RADIO_CODE", to: "10-8" }),
      ]),
    );
  });

  it.each([
    ["Only can 18 any active bolos.", "any active bolos."],
    ["One league in eighteen are there any active bolos?", "are there any active bolos?"],
    [
      "1Lincoln18 requesting plate check on plate Echo Mike Papa 982",
      "requesting plate check on plate Echo Mike Papa 982",
    ],
  ])("recovers a clipped or mistranscribed registered callsign in %s", (traffic, expected) => {
    const normalized = normalizeRadioTransmission(traffic, { callsign: "1L-18" }, codebook);
    expect(normalized.normalizedTraffic).toBe(expected);
    expect(normalized.normalizedTranscript).toBe(`[1L-18] ${expected}`);
    expect(normalized.corrections).toContainEqual(expect.objectContaining({ field: "CALLSIGN", to: "1L-18" }));
  });
});

describe("scene, context, felony-stop, and information reliability", () => {
  it("upgrades an existing traffic stop for Code 5 without creating a second call", async () => {
    const started = await dispatch.processOfficerTransmission("primary", "Starting a traffic stop at 100 Oak Road.");
    const result = await dispatch.processOfficerTransmission("primary", "Upgrade this to Code 5, high-risk stop.");
    expect(calls.list()).toHaveLength(1);
    expect(result.context.actionResults).toContainEqual(
      expect.objectContaining({ action: "upgrade_felony_stop", disposition: "EXECUTED" }),
    );
    expect(calls.get(started.call.id)).toMatchObject({
      stopType: "FELONY_STOP",
      riskLevel: "CRITICAL",
      priority: 1,
      responseMode: "CODE_3",
      backupRecommended: true,
    });
    expect(result.response).toContain("felony-stop traffic");
  });

  it("keeps scene secure, speaker clear, and full closure as separate operations", async () => {
    await units.register({ discordUserId: "backup", callsign: "1A-12", rank: "Officer", division: "Patrol" });
    const call = await calls.create({
      source: "DISCORD_911",
      incident: "Alarm",
      location: "Bank",
      description: "Audible alarm",
      priority: 2,
    });
    await calls.attach("primary", call.id);
    await calls.attach("backup", call.id);

    await dispatch.processOfficerTransmission("primary", "Scene is Code 4, keep me attached.");
    expect(calls.get(call.id)).toMatchObject({
      status: "CODE_4",
      sceneStatus: "SECURE",
      assignedUnits: ["1L-18", "1A-12"],
    });
    const closed = await dispatch.processOfficerTransmission("primary", "Code 4, all units can clear.");
    expect(closed.call).toMatchObject({ status: "CLOSED", sceneStatus: "SECURE" });
    expect(units.getByUserId("primary").assignedCallId).toBeNull();
    expect(units.getByUserId("backup").assignedCallId).toBeNull();
  });

  it("automatically closes a traffic stop when its initiating unit calls Code 4", async () => {
    const started = await dispatch.processOfficerTransmission(
      "primary",
      "Starting a traffic stop at 100 Oak Road with a blue sedan.",
    );

    const result = await dispatch.processOfficerTransmission("primary", "Code 4.");

    expect(result.context.effectiveSceneResolution).toBe("CLOSE_ALL");
    expect(calls.get(started.call.id)).toMatchObject({ status: "CLOSED", sceneStatus: "SECURE" });
    expect(units.getByUserId("primary")).toMatchObject({
      status: "AVAILABLE",
      statusCode: "10-8",
      assignedCallId: null,
    });
    expect(result.response).toContain("the call is closed");
  });

  it("honors an explicit keep-attached instruction on a Code 4 traffic stop", async () => {
    const started = await dispatch.processOfficerTransmission("primary", "Starting a traffic stop at 100 Oak Road.");

    const result = await dispatch.processOfficerTransmission("primary", "Scene is Code 4, keep me attached.");

    expect(result.context.effectiveSceneResolution).toBe("SCENE_SECURE_KEEP_ATTACHED");
    expect(calls.get(started.call.id)).toMatchObject({ status: "CODE_4", assignedUnits: ["1L-18"] });
    expect(units.getByUserId("primary").assignedCallId).toBe(started.call.id);
  });

  it("reads back an available call location over radio", async () => {
    const call = await calls.create({
      source: "DISCORD_911",
      incident: "Disturbance",
      location: "4031 Independence Parkway, postal 403",
      description: "Verbal disturbance",
      priority: 2,
    });
    await calls.attach("primary", call.id);
    const result = await dispatch.processOfficerTransmission("primary", "Repeat the last location.");
    expect(result.response).toContain("4031 Independence Parkway, postal 403");
  });

  it("resolves last call to the latest active call rather than a later closed record", async () => {
    const active = await calls.create({
      source: "DISCORD_911",
      incident: "Disturbance",
      location: "Oak Road",
      description: "Active",
      priority: 2,
    });
    const closed = await calls.create({
      source: "DISCORD_911",
      incident: "Alarm",
      location: "Pine Road",
      description: "Closed",
      priority: 3,
    });
    await calls.close(closed.id);
    const result = await dispatch.processOfficerTransmission("primary", "Attach me to the last call.");
    expect(result.context.selectedCallId).toBe(active.id);
    expect(units.getByUserId("primary").assignedCallId).toBe(active.id);
  });
});

describe("emergency, resources, and plate safeguards", () => {
  it("distinguishes an officer panic from a report of shots fired", () => {
    expect(classifyEmergencyTraffic("Shots fired near the county jail.").kind).toBe("URGENT_OFFICER_SAFETY");
    expect(classifyEmergencyTraffic("Shots fired at me, send everybody!").kind).toBe("OFFICER_PANIC");
    expect(classifyEmergencyTraffic("Panic, panic, panic, officer down.").kind).toBe("OFFICER_PANIC");
  });

  it("turns a non-panic shots-fired report into a Priority One officer call", async () => {
    const result = await dispatch.processOfficerTransmission(
      "primary",
      "Shots fired at 900 Madison Road, possible rifle fire.",
    );
    expect(result.handled).toBe(true);
    expect(result.call).toMatchObject({ incident: "Shots Fired", priority: 1, responseMode: "CODE_3" });
  });

  it("activates complete local emergency state for an officer panic", async () => {
    await units.register({ discordUserId: "backup", callsign: "1A-12", rank: "Officer", division: "Patrol" });
    const call = await dispatch.activateOfficerEmergency("primary", {
      transcript: "Panic, panic, panic, shots fired at me!",
      description: "is taking fire",
      location: "County Jail, postal 205",
      stageMedical: true,
    });
    expect(units.getByUserId("primary")).toMatchObject({
      status: "EMERGENCY",
      statusCode: "10-33",
      responseMode: "CODE_3",
      assignedCallId: call.id,
      sceneRole: "ENDANGERED",
    });
    expect(call).toMatchObject({
      incident: "Officer Emergency",
      priority: 1,
      responseMode: "CODE_3",
      riskLevel: "CRITICAL",
      unitRoles: { "1L-18": "ENDANGERED" },
    });
    expect(call.resourceRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceType: "LAW_ENFORCEMENT", purpose: "OFFICER_ASSIST", responseMode: "CODE_3" }),
        expect.objectContaining({ resourceType: "SUPERVISOR" }),
        expect.objectContaining({ resourceType: "EMS", disposition: "STAGE" }),
        expect.objectContaining({ resourceType: "FIRE", disposition: "STAGE" }),
      ]),
    );
  });

  it("separates multiple resources and resolves complete-transmission cancellation", async () => {
    const resources = parseResources("Send two additional units for traffic control, Fire, EMS, and a tow.");
    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceType: "LAW_ENFORCEMENT", quantity: 2, purpose: "TRAFFIC_CONTROL" }),
        expect.objectContaining({ resourceType: "FIRE" }),
        expect.objectContaining({ resourceType: "EMS" }),
        expect.objectContaining({ resourceType: "WRECKER" }),
      ]),
    );
    const call = await calls.create({
      source: "DISCORD_911",
      incident: "Crash",
      location: "Oak Road",
      description: "Crash",
      priority: 2,
    });
    await calls.attach("primary", call.id);
    await calls.requestStructuredResource(call.id, {
      resourceType: "EMS",
      quantity: 1,
      purpose: "MEDICAL_RESPONSE",
      responseMode: "CODE_2",
      requestedBy: "1L-18",
      disposition: "RESPOND",
    });
    await dispatch.processOfficerTransmission("primary", "Cancel EMS, no additional units needed.");
    expect(calls.get(call.id).resourceRequests.find((request) => request.resourceType === "EMS")).toMatchObject({
      status: "CANCELLED",
      cancellationReason: "Cancelled by complete officer transmission",
    });
    expect(calls.get(call.id).requestedResources).not.toContain("LAW_ENFORCEMENT");
  });

  it("separates Idaho jurisdiction from phonetic plate characters", () => {
    expect(parsePlate("Partial plate 2 Echo Nora, Idaho plate, remaining characters Papa Mike.")).toMatchObject({
      jurisdiction: "Idaho",
      plateType: "PARTIAL",
      knownCharacters: "2ENPM",
      normalizedPattern: "2ENPM*",
    });
    expect(parsePlate("Partial plate 2 Echo Nora Idaho Papa Mike.")).toMatchObject({
      jurisdiction: null,
      knownCharacters: "2ENIPM",
    });
  });

  it("does not create a warrant or stolen-vehicle incident from explicit negation", () => {
    const unit = units.getByUserId("primary");
    expect(interpretOfficerTransmission("Do not create a warrant for John Smith.", unit, codebook).warrant).toBeNull();
    expect(interpretOfficerTransmission("Be advised, vehicle is not stolen.", unit, codebook).incident).toBeNull();
  });
});
