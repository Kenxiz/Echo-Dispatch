import { defaultStaging, recommendUnits, recommendedPriority } from "./cad-intelligence.js";
import { randomUUID } from "node:crypto";
import { buildCallRecord } from "./call-factory.js";
import { HISTORY_LIMITS } from "../domain/limits.js";

export class CallService {
  store;
  units;
  constructor(store, units) {
    this.store = store;
    this.units = units;
  }
  list(activeOnly = true) {
    return this.store.calls.get().filter((call) => !activeOnly || call.status !== "CLOSED");
  }
  get(id) {
    if (typeof id !== "string" || !id.trim()) return undefined;
    const normalized = id.toUpperCase();
    return this.store.calls.get().find((call) => call.id.toUpperCase() === normalized);
  }
  findByReference(reference) {
    const active = this.list(true);
    if (!reference) return active.length === 1 ? active[0] : undefined;
    const normalized = reference.toLowerCase();
    return (
      active.find((call) => call.id.toLowerCase() === normalized) ??
      active.find((call) => call.radioCode?.toLowerCase() === normalized) ??
      active.find((call) => call.incident.toLowerCase().includes(normalized))
    );
  }
  async create(input) {
    if (
      input.sourceExternalId &&
      this.store.calls.get().some((call) => call.sourceExternalId === input.sourceExternalId)
    ) {
      throw new Error("This emergency call has already been accepted.");
    }
    let number = 0;
    const year = Number(new Date().getUTCFullYear().toString().slice(-2));
    await this.store.settings.update((settings) => {
      if (settings.callNumberYear !== year) {
        settings.callNumberYear = year;
        settings.nextCallNumber = 1;
      }
      number = settings.nextCallNumber++;
    });
    const created = buildCallRecord(input, {
      id: `${String(year).padStart(2, "0")}-${String(number).padStart(6, "0")}`,
      availableUnits: this.units.list(),
    });
    await this.store.settings.update((settings) => {
      settings.mostRecentCreatedCallId = created.id;
      settings.mostRecentActiveCallId = created.id;
    });
    await this.store.calls.update((calls) => {
      calls.push(created);
    });
    return created;
  }
  async mergeReport(id, input, triage) {
    let changed;
    await this.store.calls.update((calls) => {
      const call = calls.find((candidate) => candidate.id === id && candidate.status !== "CLOSED");
      if (!call) throw new Error("Active call not found.");
      const timestamp = new Date().toISOString();
      call.callerCount += 1;
      if (input.sourceExternalId && !call.sourceExternalIds.includes(input.sourceExternalId))
        call.sourceExternalIds.push(input.sourceExternalId);
      const report = [input.description, input.weaponInfo, input.injuryInfo, input.suspectInfo, input.vehicleInfo]
        .filter(Boolean)
        .join(" | ");
      call.notes.push({ timestamp, callsign: "CALLER", text: `Additional caller: ${report}`.slice(0, 500) });
      const previous = call.priority;
      call.priority = Math.min(
        call.priority,
        triage?.priority ?? call.priority,
        recommendedPriority(report, call.priority),
      );
      if (call.priority < previous) {
        call.responseMode = call.priority === 1 ? "CODE_3" : "CODE_2";
        call.prioritySource = triage?.source ?? "FALLBACK";
        call.priorityReason = triage?.reason ?? "Additional caller reported higher-risk circumstances.";
        call.timeline.push({
          timestamp,
          type: "PRIORITY_UPGRADED",
          actor: "CALLER",
          text: `Call upgraded from Priority ${previous} to Priority ${call.priority}.`,
        });
      }
      call.timeline.push({
        timestamp,
        type: "CALL_MERGED",
        actor: "CALLER",
        text: `Additional report merged; ${call.callerCount} callers reporting.`,
      });
      call.lastActivityAt = timestamp;
      call.watchdogLevel = 0;
      call.stagedResources = [...new Set([...call.stagedResources, ...defaultStaging(call)])];
      call.recommendedUnits = recommendUnits(call, this.units.list());
      changed = structuredClone(call);
    });
    return changed;
  }
  async attach(discordUserId, reference) {
    const unit = this.units.getByUserId(discordUserId);
    if (!unit) throw new Error("No active unit is registered for this user.");
    if (unit.assignedCallId) throw new Error(`Unit is already assigned to ${unit.assignedCallId}.`);
    const call = this.findByReference(reference);
    if (!call) throw new Error("Call reference is ambiguous or not active.");
    let changed;
    await this.store.calls.update((calls) => {
      const target = calls.find(
        (candidate) => candidate.id === call.id && ["AWAITING_UNIT", "ACTIVE"].includes(candidate.status),
      );
      if (!target) throw new Error("The call is no longer active.");
      if (!target.assignedUnits.includes(unit.callsign)) target.assignedUnits.push(unit.callsign);
      const sceneRole = target.assignedUnits.length === 1 ? "PRIMARY" : "BACKUP";
      target.unitRoles[unit.callsign] = sceneRole;
      target.status = "ACTIVE";
      if (target.sceneStatus === "UNKNOWN") target.sceneStatus = "UNSECURED";
      this.pushTimeline(
        target,
        "UNIT_ATTACHED",
        unit.callsign,
        `${unit.callsign} attached as ${sceneRole.toLowerCase()}.`,
      );
      changed = structuredClone(target);
    });
    await this.units.setAssignment(discordUserId, call.id, "ATTACHED");
    await this.store.settings.update((settings) => {
      settings.mostRecentActiveCallId = call.id;
    });
    await this.units.setResponseMode(discordUserId, changed.responseMode);
    await this.units.setSceneRole(discordUserId, changed.unitRoles[unit.callsign]);
    return this.setRecommendations(changed.id);
  }
  async setResponseStatus(discordUserId, status) {
    const unit = this.units.getByUserId(discordUserId);
    if (!unit?.assignedCallId) throw new Error("Unit is not attached to a call.");
    const call = this.get(unit.assignedCallId);
    if (!call || call.status === "CLOSED") throw new Error("The assigned call is not active.");
    await this.units.setAssignment(discordUserId, call.id, status);
    let changed;
    await this.store.calls.update((calls) => {
      const target = calls.find((candidate) => candidate.id === call.id);
      if (target) {
        this.pushTimeline(
          target,
          "RESPONSE_STATUS",
          unit.callsign,
          `${unit.callsign} ${status.replaceAll("_", " ").toLowerCase()}.`,
        );
        changed = structuredClone(target);
      }
    });
    return changed;
  }
  async detach(discordUserId) {
    const unit = this.units.getByUserId(discordUserId);
    if (!unit?.assignedCallId) throw new Error("Unit is not attached to a call.");
    let changed;
    await this.store.calls.update((calls) => {
      const call = calls.find((candidate) => candidate.id === unit.assignedCallId);
      if (!call) throw new Error("Assigned call was not found.");
      call.assignedUnits = call.assignedUnits.filter((callsign) => callsign !== unit.callsign);
      delete call.unitRoles[unit.callsign];
      if (call.assignedUnits.length === 0 && call.status === "ACTIVE") call.status = "AWAITING_UNIT";
      this.pushTimeline(call, "UNIT_DETACHED", unit.callsign, `${unit.callsign} cleared from the call.`);
      changed = structuredClone(call);
    });
    await this.units.setAssignment(discordUserId, null, "UNASSIGNED");
    await this.units.setResponseMode(discordUserId, null);
    await this.units.setSceneRole(discordUserId, null);
    await this.units.setStatus(discordUserId, "AVAILABLE", "10-8");
    return this.setRecommendations(changed.id);
  }
  async close(id) {
    const call = this.get(id);
    if (!call || call.status === "CLOSED") throw new Error("Active call not found.");
    let changed;
    await this.store.calls.update((calls) => {
      const target = calls.find((candidate) => candidate.id === call.id);
      target.status = "CLOSED";
      target.sceneStatus = "SECURE";
      target.closedAt = new Date().toISOString();
      this.pushTimeline(target, "CALL_CLOSED", null, "Scene Code 4; call closed and attached units returned 10-8.");
      changed = structuredClone(target);
    });
    for (const callsign of call.assignedUnits) {
      const unit = this.units.getByCallsign(callsign);
      if (unit) {
        await this.units.setAssignment(unit.discordUserId, null, "UNASSIGNED");
        await this.units.markCallClosed(unit.discordUserId, call.id);
        await this.units.setResponseMode(unit.discordUserId, null);
        await this.units.setSceneRole(unit.discordUserId, null);
        await this.units.setStatus(unit.discordUserId, "AVAILABLE", "10-8");
      }
    }
    await this.store.settings.update((settings) => {
      if (settings.mostRecentActiveCallId === call.id)
        settings.mostRecentActiveCallId =
          this.list()
            .filter((candidate) => candidate.id !== call.id)
            .at(-1)?.id ?? null;
    });
    return changed;
  }
  async setMessageId(id, messageId) {
    await this.store.calls.update((calls) => {
      const call = calls.find((candidate) => candidate.id === id);
      if (call) call.messageId = messageId;
    });
  }
  async setLogMessageId(id, messageId) {
    await this.store.calls.update((calls) => {
      const call = calls.find((candidate) => candidate.id === id);
      if (call) call.logMessageId = messageId;
    });
  }
  async markReannounced(id) {
    await this.store.calls.update((calls) => {
      const call = calls.find((candidate) => candidate.id === id);
      if (call) call.reannounced = true;
    });
  }
  async setStatus(id, status) {
    let changed;
    await this.store.calls.update((calls) => {
      const call = calls.find(
        (candidate) => candidate.id.toUpperCase() === String(id ?? "").toUpperCase() && candidate.status !== "CLOSED",
      );
      if (!call) throw new Error("Active call not found.");
      if (status === "AWAITING_UNIT" && call.assignedUnits.length > 0)
        throw new Error("A call with assigned units cannot be marked awaiting unit.");
      call.status = status;
      if (status === "CODE_4") call.sceneStatus = "SECURE";
      if (status === "ACTIVE" && call.sceneStatus === "SECURE") call.sceneStatus = "ACTIVE";
      this.pushTimeline(call, "CALL_STATUS", null, `Call status set to ${status.replaceAll("_", " ")}.`);
      changed = structuredClone(call);
    });
    return changed;
  }
  async setSceneStatus(id, sceneStatus) {
    let changed;
    await this.store.calls.update((calls) => {
      const call = calls.find(
        (candidate) => candidate.id.toUpperCase() === String(id ?? "").toUpperCase() && candidate.status !== "CLOSED",
      );
      if (!call) throw new Error("Active call not found.");
      call.sceneStatus = sceneStatus;
      if (sceneStatus === "SECURE") call.status = "CODE_4";
      else if (call.status === "CODE_4") call.status = "ACTIVE";
      this.pushTimeline(call, "SCENE_STATUS", null, `Scene status set to ${sceneStatus.replaceAll("_", " ")}.`);
      changed = structuredClone(call);
    });
    return changed;
  }
  async setResponseMode(id, responseMode) {
    let changed;
    await this.store.calls.update((calls) => {
      const call = calls.find(
        (candidate) => candidate.id.toUpperCase() === String(id ?? "").toUpperCase() && candidate.status !== "CLOSED",
      );
      if (!call) throw new Error("Active call not found.");
      call.responseMode = responseMode;
      this.pushTimeline(call, "RESPONSE_MODE", null, `Response mode set to ${responseMode.replace("_", " ")}.`);
      changed = structuredClone(call);
    });
    return changed;
  }
  async setPriority(id, priority, source, reason) {
    let changed;
    await this.store.calls.update((calls) => {
      const call = calls.find((candidate) => candidate.id === id && candidate.status !== "CLOSED");
      if (!call) throw new Error("Active call not found.");
      const previous = call.priority;
      call.priority = Math.max(1, Math.min(3, priority));
      call.prioritySource = source;
      call.priorityReason = reason;
      call.responseMode = call.priority === 1 ? "CODE_3" : call.priority === 2 ? "CODE_2" : "CODE_1";
      if (call.priority !== previous)
        this.pushTimeline(
          call,
          call.priority < previous ? "PRIORITY_UPGRADED" : "PRIORITY_REFINED",
          "DISPATCH",
          `Priority changed from ${previous} to ${call.priority} after structured triage.`,
        );
      changed = structuredClone(call);
    });
    return changed;
  }
  async requestResource(id, resource) {
    return this.requestStructuredResource(id, {
      resourceType: resource,
      quantity: 1,
      purpose: "GENERAL_ASSISTANCE",
      responseMode: "CODE_2",
      requestedBy: "DISPATCH",
      disposition: "RESPOND",
    });
  }
  async requestStructuredResource(id, request) {
    let changed;
    await this.store.calls.update((calls) => {
      const call = calls.find(
        (candidate) => candidate.id.toUpperCase() === String(id ?? "").toUpperCase() && candidate.status !== "CLOSED",
      );
      if (!call) throw new Error("Active call not found.");
      const resource = request.resourceType;
      if (!call.requestedResources.includes(resource)) call.requestedResources.push(resource);
      if (request.disposition !== "STAGE")
        call.stagedResources = call.stagedResources.filter((candidate) => candidate !== resource);
      else if (!call.stagedResources.includes(resource)) call.stagedResources.push(resource);
      const existing = call.resourceRequests.find(
        (candidate) =>
          candidate.resourceType === resource &&
          candidate.purpose === request.purpose &&
          candidate.status === "REQUESTED" &&
          candidate.requestedBy === request.requestedBy &&
          candidate.disposition === (request.disposition ?? "RESPOND"),
      );
      if (existing) existing.quantity = Math.max(existing.quantity, request.quantity ?? 1);
      else
        call.resourceRequests.push({
          id: randomUUID(),
          resourceType: resource,
          quantity: request.quantity ?? 1,
          purpose: request.purpose ?? "GENERAL_ASSISTANCE",
          responseMode: request.responseMode ?? call.responseMode,
          status: "REQUESTED",
          requestedBy: request.requestedBy,
          disposition: request.disposition ?? "RESPOND",
          requestedAt: new Date().toISOString(),
          assignedUnits: [],
          etaSeconds: null,
          cancelledAt: null,
          cancellationReason: null,
        });
      const quantity = request.quantity ?? 1;
      const purpose = (request.purpose ?? "GENERAL_ASSISTANCE").replaceAll("_", " ").toLowerCase();
      const disposition = request.disposition === "STAGE" ? " to stage" : "";
      this.pushTimeline(
        call,
        "RESOURCE_REQUESTED",
        request.requestedBy,
        `${quantity} ${resource.replaceAll("_", " ")} requested${disposition} for ${purpose}.`,
      );
      changed = structuredClone(call);
    });
    return changed;
  }
  async cancelResource(id, resourceType, callsign, reason = "Cancelled by radio traffic") {
    let changed;
    await this.store.calls.update((calls) => {
      const call = calls.find(
        (candidate) => candidate.id.toUpperCase() === String(id ?? "").toUpperCase() && candidate.status !== "CLOSED",
      );
      if (!call) throw new Error("Active call not found.");
      const requests = call.resourceRequests.filter(
        (request) => request.resourceType === resourceType && !["CANCELLED", "ON_SCENE"].includes(request.status),
      );
      for (const request of requests) {
        request.status = "CANCELLED";
        request.cancelledAt = new Date().toISOString();
        request.cancellationReason = reason;
      }
      call.requestedResources = call.requestedResources.filter(
        (resource) =>
          resource !== resourceType ||
          call.resourceRequests.some((request) => request.resourceType === resource && request.status !== "CANCELLED"),
      );
      call.stagedResources = call.stagedResources.filter((resource) => resource !== resourceType);
      this.pushTimeline(
        call,
        "RESOURCE_CANCELLED",
        callsign,
        `${resourceType.replaceAll("_", " ")} cancelled: ${reason}.`,
      );
      changed = structuredClone(call);
    });
    return changed;
  }
  async setTrafficStopRisk(id, input, callsign) {
    let changed;
    await this.store.calls.update((calls) => {
      const call = calls.find((candidate) => candidate.id === id && candidate.status !== "CLOSED");
      if (!call) throw new Error("Active traffic stop not found.");
      call.stopType = input.stopType ?? "FELONY_STOP";
      call.riskLevel = input.riskLevel ?? "CRITICAL";
      call.officerSafetyLevel = input.riskLevel ?? "CRITICAL";
      call.backupRecommended = true;
      call.backupStatus = call.resourceRequests.some(
        (request) => request.resourceType === "LAW_ENFORCEMENT" && request.status !== "CANCELLED",
      )
        ? "REQUESTED"
        : "RECOMMENDED";
      call.priority = 1;
      call.prioritySource = "FALLBACK";
      call.priorityReason = "Felony/high-risk vehicle stop reported by an officer.";
      call.responseMode = "CODE_3";
      call.operationalPlan = [
        ...new Set([
          ...call.operationalPlan,
          "Restrict routine radio traffic",
          "Supervisor response",
          "High-risk vehicle extraction",
          "Fire/EMS staging if weapons or injuries are reported",
        ]),
      ];
      this.pushTimeline(call, "FELONY_STOP", callsign, `${callsign} upgraded the stop to a felony/high-risk stop.`);
      changed = structuredClone(call);
    });
    return changed;
  }
  async addNote(id, callsign, text) {
    const note = text.trim();
    if (!note) throw new Error("Call note cannot be empty.");
    let changed;
    await this.store.calls.update((calls) => {
      const call = calls.find(
        (candidate) => candidate.id.toUpperCase() === String(id ?? "").toUpperCase() && candidate.status !== "CLOSED",
      );
      if (!call) throw new Error("Active call not found.");
      const duplicate = call.notes
        .slice(-5)
        .some((candidate) => candidate.callsign === callsign && candidate.text.toLowerCase() === note.toLowerCase());
      if (!duplicate) call.notes.push({ timestamp: new Date().toISOString(), callsign, text: note });
      if (call.notes.length > HISTORY_LIMITS.callNotes)
        call.notes.splice(0, call.notes.length - HISTORY_LIMITS.callNotes);
      const previousPriority = call.priority;
      call.priority = recommendedPriority(note, call.priority);
      if (call.priority < previousPriority) {
        call.responseMode = call.priority === 1 ? "CODE_3" : "CODE_2";
        call.prioritySource = "FALLBACK";
        call.priorityReason = "Officer-safety update automatically escalated the incident.";
        this.pushTimeline(
          call,
          "PRIORITY_UPGRADED",
          callsign,
          `Safety update upgraded the call from Priority ${previousPriority} to Priority ${call.priority}.`,
        );
        call.stagedResources = [...new Set([...call.stagedResources, ...defaultStaging(call)])];
      }
      if (!duplicate) this.pushTimeline(call, "CALL_NOTE", callsign, note);
      changed = structuredClone(call);
    });
    return changed;
  }
  async setUnitRole(id, callsign, role) {
    let changed;
    await this.store.calls.update((calls) => {
      const call = calls.find(
        (candidate) => candidate.id.toUpperCase() === String(id ?? "").toUpperCase() && candidate.status !== "CLOSED",
      );
      if (!call || !call.assignedUnits.includes(callsign)) throw new Error("Assigned unit not found on active call.");
      call.unitRoles[callsign] = role;
      this.pushTimeline(call, "UNIT_ROLE", callsign, `${callsign} assigned ${role.toLowerCase()} role.`);
      changed = structuredClone(call);
    });
    const unit = this.units.getByCallsign(callsign);
    if (unit) await this.units.setSceneRole(unit.discordUserId, role);
    return changed;
  }
  async setRecommendations(id) {
    let changed;
    await this.store.calls.update((calls) => {
      const call = calls.find((candidate) => candidate.id === id && candidate.status !== "CLOSED");
      if (!call) throw new Error("Active call not found.");
      call.recommendedUnits = recommendUnits(call, this.units.list());
      changed = structuredClone(call);
    });
    return changed;
  }
  async refreshRecommendations() {
    await this.store.calls.update((calls) => {
      for (const call of calls.filter((candidate) => candidate.status !== "CLOSED"))
        call.recommendedUnits = recommendUnits(call, this.units.list());
    });
  }
  async setWatchdogLevel(id, level, text) {
    let changed;
    await this.store.calls.update((calls) => {
      const call = calls.find((candidate) => candidate.id === id && candidate.status !== "CLOSED");
      if (!call) throw new Error("Active call not found.");
      call.watchdogLevel = level;
      this.pushTimeline(call, "STATUS_CHECK", "DISPATCH", text);
      changed = structuredClone(call);
    });
    return changed;
  }
  async addOperationalPlan(id, items) {
    let changed;
    await this.store.calls.update((calls) => {
      const call = calls.find((candidate) => candidate.id === id && candidate.status !== "CLOSED");
      if (!call) throw new Error("Active call not found.");
      call.operationalPlan = [...new Set([...call.operationalPlan, ...items.map((item) => item.slice(0, 160))])];
      this.pushTimeline(call, "PREDICTIVE_PLAN", "DISPATCH", `Prepared options: ${items.join(", ")}.`);
      changed = structuredClone(call);
    });
    return changed;
  }
  async linkRecord(id, kind, recordId, summary) {
    let changed;
    await this.store.calls.update((calls) => {
      const call = calls.find((candidate) => candidate.id === id && candidate.status !== "CLOSED");
      if (!call) throw new Error("Active call not found.");
      const field = kind === "BOLO" ? "boloIds" : "warrantIds";
      if (!call[field].includes(recordId)) call[field].push(recordId);
      this.pushTimeline(call, `${kind}_UPDATED`, null, summary);
      changed = structuredClone(call);
    });
    return changed;
  }
  async setPursuit(id, update, actor) {
    let changed;
    await this.store.calls.update((calls) => {
      const call = calls.find((candidate) => candidate.id === id && candidate.status !== "CLOSED");
      if (!call) throw new Error("Active call not found.");
      const timestamp = new Date().toISOString();
      call.pursuit = call.pursuit ?? {
        active: true,
        type: "VEHICLE",
        primaryUnit: actor,
        secondaryUnit: null,
        supervisorUnit: null,
        vehicle: null,
        plate: null,
        occupants: null,
        speed: null,
        direction: null,
        road: null,
        postal: null,
        lastLocation: null,
        trafficConditions: null,
        weather: null,
        reason: null,
        weapons: null,
        pitStatus: "NONE",
        spikeStripsRequested: false,
        bailout: false,
        startedAt: timestamp,
        endedAt: null,
      };
      for (const [key, value] of Object.entries(update))
        if (value !== null && value !== undefined && !(key === "pitStatus" && value === "NONE"))
          call.pursuit[key] = value;
      if (update.active === false) call.pursuit.endedAt = timestamp;
      this.pushTimeline(
        call,
        update.active === false ? "PURSUIT_ENDED" : "PURSUIT_UPDATE",
        actor,
        update.active === false
          ? "Pursuit terminated."
          : `Pursuit updated${update.direction ? `; ${update.direction}` : ""}${update.lastLocation ? ` at ${update.lastLocation}` : ""}.`,
      );
      changed = structuredClone(call);
    });
    return changed;
  }
  async recordVehicleObservation(id, observation, callsign) {
    let changed;
    await this.store.calls.update((calls) => {
      const call = calls.find((candidate) => candidate.id === id && candidate.status !== "CLOSED");
      if (!call) throw new Error("Active call not found.");
      if (observation.plate) {
        const duplicate = call.observedPlates.some(
          (entry) =>
            entry.reportedBy === callsign &&
            entry.plate.normalizedPattern === observation.plate.normalizedPattern &&
            entry.plate.rawTranscript === observation.plate.rawTranscript,
        );
        if (!duplicate)
          call.observedPlates.push({
            plate: observation.plate,
            reportedBy: callsign,
            reportedAt: new Date().toISOString(),
          });
        if (call.observedPlates.length > HISTORY_LIMITS.observedPlatesPerCall)
          call.observedPlates.splice(0, call.observedPlates.length - HISTORY_LIMITS.observedPlatesPerCall);
        if (!duplicate)
          this.pushTimeline(
            call,
            "PLATE_OBSERVED",
            callsign,
            `${callsign} reported plate ${observation.plate.normalizedPattern || observation.plate.plateType} (${observation.plate.plateType.toLowerCase()}).`,
          );
      }
      const observationKey = JSON.stringify({
        colors: observation.colors,
        make: observation.make,
        model: observation.model,
        vehicleType: observation.vehicleType,
        damage: observation.damage,
        occupantCount: observation.occupantCount,
        directionOfTravel: observation.directionOfTravel,
        plate: observation.plate?.normalizedPattern,
      });
      if (
        !call.vehicleObservations.some(
          (entry) =>
            entry.reportedBy === callsign &&
            JSON.stringify({
              colors: entry.observation.colors,
              make: entry.observation.make,
              model: entry.observation.model,
              vehicleType: entry.observation.vehicleType,
              damage: entry.observation.damage,
              occupantCount: entry.observation.occupantCount,
              directionOfTravel: entry.observation.directionOfTravel,
              plate: entry.observation.plate?.normalizedPattern,
            }) === observationKey,
        )
      ) {
        call.vehicleObservations.push({ observation, reportedBy: callsign, reportedAt: new Date().toISOString() });
        if (call.vehicleObservations.length > HISTORY_LIMITS.vehicleObservationsPerCall)
          call.vehicleObservations.splice(
            0,
            call.vehicleObservations.length - HISTORY_LIMITS.vehicleObservationsPerCall,
          );
      }
      const summary = [
        observation.colors?.join(" and "),
        observation.make,
        observation.model,
        observation.vehicleType,
        observation.damage,
        observation.occupantCount !== null
          ? `${observation.occupantCount} occupant${observation.occupantCount === 1 ? "" : "s"}`
          : null,
        observation.directionOfTravel,
        observation.plate?.normalizedPattern,
      ]
        .filter(Boolean)
        .join(" | ");
      if (summary) call.vehicleInfo = summary.slice(0, 500);
      changed = structuredClone(call);
    });
    return changed;
  }
  async recordBoloMatch(id, match, callsign, safetyLevel = "HIGH") {
    let changed;
    await this.store.calls.update((calls) => {
      const call = calls.find((candidate) => candidate.id === id && candidate.status !== "CLOSED");
      if (!call) throw new Error("Active call not found.");
      if (!call.boloIds.includes(match.bolo.id)) call.boloIds.push(match.bolo.id);
      call.boloRelated = true;
      call.officerSafetyLevel = higherSafety(call.officerSafetyLevel, safetyLevel);
      call.backupRecommended = true;
      const existing = call.boloMatches.find(
        (entry) => entry.boloId === match.bolo.id && entry.reportedBy === callsign,
      );
      if (existing) {
        existing.confidence = Math.max(existing.confidence, match.confidence);
        existing.reasons = [...new Set([...existing.reasons, ...match.reasons])];
        existing.matchedAt = new Date().toISOString();
        existing.score = match.score;
        existing.matchedFields = match.matchedFields;
        existing.conflictingFields = match.conflictingFields;
        existing.plateMatchType = match.plateMatchType;
        existing.threatLevel = match.threatLevel;
      } else
        call.boloMatches.push({
          boloId: match.bolo.id,
          confidence: match.confidence,
          score: match.score,
          reasons: match.reasons,
          matchedFields: match.matchedFields,
          conflictingFields: match.conflictingFields,
          plateMatchType: match.plateMatchType,
          threatLevel: match.threatLevel,
          matchedAt: new Date().toISOString(),
          reportedBy: callsign,
        });
      this.pushTimeline(
        call,
        "BOLO_MATCH",
        callsign,
        `${callsign} possible match to ${match.bolo.id} at ${Math.round(match.confidence * 100)}% confidence: ${match.reasons.join(", ")}.`,
      );
      changed = structuredClone(call);
    });
    return changed;
  }
  pushTimeline(call, type, actor, text) {
    const timestamp = new Date().toISOString();
    call.timeline.push({ timestamp, type, actor, text: text.slice(0, 500) });
    if (call.timeline.length > HISTORY_LIMITS.callTimeline)
      call.timeline.splice(0, call.timeline.length - HISTORY_LIMITS.callTimeline);
    call.lastActivityAt = timestamp;
    if (type !== "STATUS_CHECK") call.watchdogLevel = 0;
  }
}

function higherSafety(current, requested) {
  const levels = ["NORMAL", "ELEVATED", "HIGH", "CRITICAL"];
  return levels[Math.max(levels.indexOf(current), levels.indexOf(requested))];
}
