import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataStore } from "../src/database/store.js";
import { UnitService } from "../src/dispatch/unit-service.js";
import { CallService } from "../src/dispatch/call-service.js";
import { DispatchService } from "../src/dispatch/dispatch-service.js";
import {
  findActiveBoloMatches,
  parseAdditionalUnitIntent,
  parsePlate,
  parseResources,
  parseVehicleObservation,
} from "../src/dispatch/officer-incident.js";
import { VoiceManager } from "../src/voice/voice-manager.js";

let store;
let units;
let calls;
let dispatch;

beforeEach(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "echo-bolo-match-"));
  store = new DataStore(directory);
  await store.init();
  units = new UnitService(store);
  calls = new CallService(store, units);
  dispatch = new DispatchService(store, units, calls, vi.fn(), {
    BOLO_MATCH_THRESHOLD: 0.5,
    BOLO_AUTO_REQUEST_BACKUP: false,
  });
  await units.register({ discordUserId: "unit", callsign: "1L-18", rank: "Officer", division: "Patrol" });
});

describe("resource request intent", () => {
  it("does not request backup for an explicit negative", () => {
    expect(parseAdditionalUnitIntent("No additional units needed.")).toEqual({
      additionalUnits: "NEGATIVE",
      quantity: null,
    });
    expect(parseResources("No additional units needed.")).toEqual([]);
  });

  it("creates one request for clear affirmative intent", () => {
    expect(parseResources("Need one additional unit.")).toEqual([
      expect.objectContaining({ resourceType: "LAW_ENFORCEMENT", quantity: 1, purpose: "BACKUP" }),
    ]);
  });

  it("lets a negative statement override earlier affirmative keywords", () => {
    expect(parseResources("Start me another unit—disregard backup, I'm good.")).toEqual([]);
    expect(parseAdditionalUnitIntent("Need one additional unit, cancel additional units.").additionalUnits).toBe(
      "NEGATIVE",
    );
  });

  it("does not create duplicate backup requests", async () => {
    await dispatch.processOfficerTransmission(
      "unit",
      "Starting a traffic stop at 125 Maple Street. Need another unit.",
    );
    await dispatch.processOfficerTransmission("unit", "Need another unit.");
    const lawRequests = calls
      .list()[0]
      .resourceRequests.filter((request) => request.resourceType === "LAW_ENFORCEMENT");
    expect(lawRequests).toHaveLength(1);
  });
});

describe("vehicle BOLO matching", () => {
  it("normalizes spoken phonetic plates", () => {
    expect(parsePlate("partial license plate 2 Echo Nora Idaho Papa Mike")).toMatchObject({
      plateType: "PARTIAL",
      rawTranscript: "partial license plate 2 Echo Nora Idaho Papa Mike",
      knownCharacters: "2ENIPM",
      normalizedPattern: "2ENIPM*",
    });
  });

  it("matches partial and prefix-only BOLO plates", () => {
    const bolo = activeVehicleBolo("BOLO-1", "partial plate 2 Echo Nora");
    const observed = parseVehicleObservation("Traffic stop, possible plate 2 Echo Nora Idaho Papa Mike.");
    const matches = findActiveBoloMatches([bolo], observed);
    expect(matches[0]).toMatchObject({ bolo: { id: "BOLO-1" }, confidence: 0.74 });
    expect(matches[0].reasons[0]).toContain("2EN*");
  });

  it("matches an exact full plate", () => {
    const bolo = activeVehicleBolo("BOLO-2", "plate Adam Boy Charles 1 2 3");
    const observed = parseVehicleObservation("Vehicle plate ABC123.");
    expect(findActiveBoloMatches([bolo], observed)[0]).toMatchObject({ bolo: { id: "BOLO-2" }, confidence: 0.82 });
  });

  it("matches suffix wildcards and strong vehicle descriptions without a plate", () => {
    const suffix = activeVehicleBolo("BOLO-SUFFIX", "last three are 4 7 2");
    expect(
      findActiveBoloMatches([suffix], parseVehicleObservation("Vehicle plate Adam Boy Charles 4 7 2."))[0].bolo.id,
    ).toBe("BOLO-SUFFIX");

    const described = {
      ...activeVehicleBolo("BOLO-VEHICLE", "no plate"),
      color: "red",
      make: "Chevrolet",
      model: "Tahoe",
      vehicleType: "SUV",
      occupantCount: 2,
      directionOfTravel: "westbound",
      lastKnownLocation: "700 Oak Road",
    };
    const observation = parseVehicleObservation(
      "Traffic stop at 700 Oak Road with a red Chevy Tahoe SUV, occupied two times, heading west.",
    );
    expect(findActiveBoloMatches([described], observation)[0]).toMatchObject({
      bolo: { id: "BOLO-VEHICLE" },
      reasons: expect.arrayContaining(["make Chevrolet", "model Tahoe", "vehicle type SUV", "2 occupants"]),
    });
  });

  it("returns the highest-confidence match first", () => {
    const broad = activeVehicleBolo("BOLO-BROAD", "partial plate Adam Boy Charles");
    const exact = activeVehicleBolo("BOLO-EXACT", "plate ABC123");
    const observed = parseVehicleObservation("Plate Adam Boy Charles 1 2 3.");
    expect(findActiveBoloMatches([broad, exact], observed).map((match) => match.bolo.id)).toEqual([
      "BOLO-EXACT",
      "BOLO-BROAD",
    ]);
  });

  it("checks active BOLOs before replying and persists a usable plate record", async () => {
    await dispatch.processOfficerTransmission(
      "unit",
      "Put out a vehicle BOLO for a red sedan, partial plate 2 Echo Nora.",
    );
    dispatch.config.BOLO_AUTO_REQUEST_BACKUP = true;
    const bolo = store.bolos.get()[0];
    const transcript =
      "1 Lincoln 18, show me on 1811 with a red and black sedan, partial license plate 2 Echo Nora Idaho Papa Mike, 7095 Franklin Court, one occupant, no additional units needed.";
    const result = await dispatch.processOfficerTransmission("unit", transcript);
    const call = calls.get(result.context.activeCallId);

    expect(result.interpretation).toMatchObject({
      classification: "OFFICER_INITIATED_INCIDENT",
      resourceIntent: { additionalUnits: "NEGATIVE" },
      vehicleObservation: {
        occupantCount: 1,
        location: "7095 Franklin Court",
        plate: { normalizedPattern: "2ENIPM*" },
      },
    });
    expect(result.context.boloMatches[0].bolo.id).toBe(bolo.id);
    expect(result.response).toContain(`Possible BOLO match, ${bolo.id}`);
    expect(result.response).toContain("partial plate beginning with 2 Echo Nora");
    expect(call).toMatchObject({
      boloRelated: true,
      officerSafetyLevel: "HIGH",
      backupRecommended: true,
      boloIds: [bolo.id],
    });
    expect(call.requestedResources).not.toContain("LAW_ENFORCEMENT");
    expect(call.observedPlates).toContainEqual(
      expect.objectContaining({
        reportedBy: "1L-18",
        plate: expect.objectContaining({
          rawTranscript: "partial license plate 2 Echo Nora Idaho Papa Mike",
          normalizedPattern: "2ENIPM*",
        }),
      }),
    );
    expect(call.timeline.map((entry) => entry.type)).toEqual(expect.arrayContaining(["PLATE_OBSERVED", "BOLO_MATCH"]));
  });

  it("writes normalized observed plates and BOLO matches to transmission logs", async () => {
    await dispatch.processOfficerTransmission(
      "unit",
      "Put out a vehicle BOLO for a blue sedan, partial plate Echo Nora Papa.",
    );
    const transcript =
      "1 Lincoln 18, starting a traffic stop at 500 Liberty Way with a blue sedan, plate Echo Nora Papa Mike 4 2.";
    const gemini = {
      handleTransmission: vi.fn().mockResolvedValue({
        inputTranscript: transcript,
        outputTranscript: "Copy.",
        audio: Buffer.alloc(0),
        actions: [],
      }),
      synthesize: vi.fn().mockResolvedValue(Buffer.from([1])),
    };
    const manager = new VoiceManager({}, {}, gemini, dispatch, {
      transcript: vi.fn().mockResolvedValue(undefined),
      warning: vi.fn().mockResolvedValue(undefined),
    });
    manager.channelOwner = "unit";
    manager.channelEpoch = 1;
    manager.playback.play = vi.fn().mockResolvedValue(undefined);

    await manager.process("unit", Buffer.alloc(48_000 * 2), 1);

    expect(store.transmissions.get()[0]).toMatchObject({
      observedPlate: { rawTranscript: "plate Echo Nora Papa Mike 4 2", normalizedPattern: "ENPM42" },
      vehicleObservation: { colors: ["blue"], vehicleType: "sedan" },
      boloMatches: [expect.objectContaining({ boloId: store.bolos.get()[0].id, reportedBy: "1L-18" })],
    });
  });

  it("does not duplicate an affirmative backup request when BOLO policy automation is enabled", async () => {
    dispatch.config.BOLO_AUTO_REQUEST_BACKUP = true;
    await dispatch.processOfficerTransmission(
      "unit",
      "Put out a vehicle BOLO for a black sedan, partial plate Nora Papa Mike.",
    );
    const result = await dispatch.processOfficerTransmission(
      "unit",
      "Starting a traffic stop at 800 Oak Road with a black sedan, plate Nora Papa Mike 4 2. Need another unit.",
    );
    const requests = result.call.resourceRequests.filter((request) => request.resourceType === "LAW_ENFORCEMENT");
    expect(requests).toHaveLength(1);
    expect(requests[0].purpose).toBe("BACKUP");
  });
});

function activeVehicleBolo(id, spokenPlate) {
  return {
    id,
    type: "VEHICLE",
    status: "ACTIVE",
    plate: parsePlate(spokenPlate),
    color: null,
    make: null,
    model: null,
    vehicleType: null,
    occupantCount: null,
    directionOfTravel: null,
    lastKnownLocation: null,
  };
}
