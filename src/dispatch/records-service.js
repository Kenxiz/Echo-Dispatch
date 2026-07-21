export class DispatchRecordsService {
  constructor({ store, units, calls, config, resolveContextCall }) {
    this.store = store;
    this.units = units;
    this.calls = calls;
    this.config = config;
    this.resolveContextCall = resolveContextCall;
  }

  async resolveInformationRequest(userId, request, context, observation = null) {
    const unit = this.units.getByUserId(userId);
    if (request === "CALL_LOCATION" || request === "LOCATION") {
      const call = this.resolveContextCall(unit);
      if (call) {
        context.activeCallId ??= call.id;
        context.informationResult = { type: "CALL_LOCATION", value: call.location, callId: call.id };
        return call;
      }
      if (request === "LOCATION" && unit.location) {
        context.informationResult = { type: "UNIT_LOCATION", value: unit.location };
        return unit;
      }
      throw new Error("No active call location is available.");
    }
    if (request === "ACTIVE_BOLOS") {
      const bolos = this.store.bolos
        .get()
        .filter((bolo) => bolo.status === "ACTIVE")
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      context.informationResult = { type: "ACTIVE_BOLOS", bolos, value: bolos.length };
      return context.informationResult;
    }
    if (request === "UNIT_STATUS") {
      context.informationResult = {
        type: "UNIT_STATUS",
        value: `${unit.callsign} is ${unit.statusCode ?? unit.status.replaceAll("_", " ")}.`,
      };
      return context.informationResult;
    }
    if (request === "PENDING_TRAFFIC") {
      const call = this.resolveContextCall(unit);
      context.informationResult = call
        ? { type: "PENDING_TRAFFIC", value: `${call.id}, ${call.incident} at ${call.location}.` }
        : { type: "PENDING_TRAFFIC", value: "No pending traffic is recorded." };
      return context.informationResult;
    }
    if (request === "REGISTRATION") {
      const plate = observation?.plate ?? null;
      const warrants = plate
        ? this.store.warrants
            .get()
            .filter((warrant) => warrant.status === "ACTIVE" && platesOverlap(warrant.plate, plate))
        : [];
      context.informationResult = {
        type: "PLATE_CHECK",
        plate,
        boloMatches: context.boloMatches ?? [],
        warrantMatches: warrants,
        verifiedRegistrationProvider: false,
        value: plate ? plate.knownCharacters || plate.normalizedPattern : null,
      };
      return context.informationResult;
    }
    context.informationResult = { type: request, value: "No verified return source is configured." };
    return context.informationResult;
  }

  async applyBolo(unit, input, callId) {
    const active = this.store.bolos
      .get()
      .filter((bolo) => bolo.status === "ACTIVE" && bolo.type === input.type && (!callId || bolo.callId === callId));
    if (input.operation === "CANCEL") {
      const target = active.at(-1);
      if (!target) throw new Error(`No active ${input.type.toLowerCase()} BOLO was found to cancel.`);
      await this.store.bolos.update((items) => {
        const record = items.find((item) => item.id === target.id);
        record.status = "CANCELLED";
        record.cancelledAt = new Date().toISOString();
        record.updatedAt = record.cancelledAt;
      });
      if (callId) await this.calls.linkRecord(callId, "BOLO", target.id, `${target.id} cancelled by ${unit.callsign}.`);
      return { id: target.id, status: "CANCELLED" };
    }
    const duplicate = active.find(
      (bolo) =>
        bolo.issuingUnit === unit.callsign && bolo.rawDescription.toLowerCase() === input.rawDescription.toLowerCase(),
    );
    if (duplicate) return duplicate;
    if (input.operation === "UPDATE") {
      const target = active.at(-1);
      if (!target) throw new Error(`No active ${input.type.toLowerCase()} BOLO was found to update.`);
      await this.store.bolos.update((items) => {
        const record = items.find((item) => item.id === target.id);
        mergeDefined(record, input, ["operation", "type"]);
        record.updatedAt = new Date().toISOString();
      });
      if (callId) await this.calls.linkRecord(callId, "BOLO", target.id, `${target.id} updated by ${unit.callsign}.`);
      return this.store.bolos.get().find((item) => item.id === target.id);
    }
    let number;
    await this.store.settings.update((settings) => {
      number = settings.nextBoloNumber++;
    });
    const timestamp = new Date().toISOString();
    const record = {
      id: `BOLO-${String(number).padStart(5, "0")}`,
      ...withoutKeys(input, ["operation"]),
      status: "ACTIVE",
      issuingUnit: unit.callsign,
      callId: callId ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: null,
      cancelledAt: null,
    };
    await this.store.bolos.update((items) => {
      items.push(record);
    });
    if (callId)
      await this.calls.linkRecord(
        callId,
        "BOLO",
        record.id,
        `${record.id} issued by ${unit.callsign}: ${record.rawDescription}`,
      );
    return this.store.bolos.get().find((item) => item.id === record.id);
  }

  async applyWarrant(unit, input, callId) {
    if (!this.isWarrantAuthorized(unit))
      throw new Error(
        `${unit.callsign} is not authorized to create, edit, or clear warrants under the agency profile.`,
      );
    const active = this.store.warrants
      .get()
      .filter((warrant) => warrant.status === "ACTIVE" && (!callId || warrant.callId === callId));
    if (input.operation === "QUERY") return active.at(-1) ?? { status: "NOT_FOUND" };
    if (input.operation === "CLEAR") {
      const target = active.at(-1);
      if (!target) throw new Error("No active warrant was found to clear.");
      await this.store.warrants.update((items) => {
        const record = items.find((item) => item.id === target.id);
        record.status = "CLEARED";
        record.clearedAt = new Date().toISOString();
        record.clearingUnit = unit.callsign;
      });
      if (callId)
        await this.calls.linkRecord(callId, "WARRANT", target.id, `${target.id} cleared by ${unit.callsign}.`);
      return { id: target.id, status: "CLEARED" };
    }
    const duplicate = active.find(
      (warrant) =>
        warrant.issuingUnit === unit.callsign &&
        warrant.subjectName === input.subjectName &&
        warrant.chargesOrReason === input.chargesOrReason,
    );
    if (duplicate) return duplicate;
    let number;
    await this.store.settings.update((settings) => {
      number = settings.nextWarrantNumber++;
    });
    const timestamp = new Date().toISOString();
    const record = {
      id: `W-${new Date().getUTCFullYear()}-${String(number).padStart(5, "0")}`,
      ...withoutKeys(input, ["operation", "rawDescription"]),
      issuingUnit: unit.callsign,
      callId: callId ?? null,
      status: "ACTIVE",
      notes: [input.rawDescription],
      createdAt: timestamp,
      clearedAt: null,
      clearingUnit: null,
    };
    await this.store.warrants.update((items) => {
      items.push(record);
    });
    if (callId) await this.calls.linkRecord(callId, "WARRANT", record.id, `${record.id} entered by ${unit.callsign}.`);
    return this.store.warrants.get().find((item) => item.id === record.id);
  }

  isWarrantAuthorized(unit) {
    if (this.config.WARRANT_ALLOW_ALL === true) return true;
    const ranks = this.config.WARRANT_AUTHORIZED_RANKS ?? [
      "sergeant",
      "lieutenant",
      "captain",
      "chief",
      "supervisor",
      "detective",
    ];
    return ranks.some((rank) => new RegExp(`\\b${escapeRegex(rank)}\\b`, "i").test(`${unit.rank} ${unit.division}`));
  }
}

function platesOverlap(expected, observed) {
  if (!expected?.knownCharacters || !observed?.knownCharacters) return false;
  const left = expected.knownCharacters.toUpperCase();
  const right = observed.knownCharacters.toUpperCase();
  return (
    left === right || left.startsWith(right) || right.startsWith(left) || left.endsWith(right) || right.endsWith(left)
  );
}

function mergeDefined(target, source, excluded = []) {
  for (const [key, value] of Object.entries(source))
    if (!excluded.includes(key) && value !== null && value !== undefined) target[key] = value;
}
function withoutKeys(value, keys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
