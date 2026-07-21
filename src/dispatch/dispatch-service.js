import { randomUUID } from "node:crypto";
import {
  findActiveBoloMatches,
  interpretOfficerTransmission,
  parsePlate,
  scoreOfficerCallCandidates,
} from "./officer-incident.js";
import { normalizeRadioTransmission } from "../radio/normalizer.js";
import { buildOfficerAcknowledgement } from "./acknowledgement.js";
import { sanitizeTransmissionLog } from "./transmission-log.js";
import { describeActionResult, joinWords } from "../utils/format.js";
import { DispatchRecordsService } from "./records-service.js";
import { HISTORY_LIMITS } from "../domain/limits.js";
export class DispatchService {
  store;
  units;
  calls;
  onCallChanged;
  config;
  codebook;
  constructor(store, units, calls, onCallChanged, config = {}, codebook = null) {
    this.store = store;
    this.units = units;
    this.calls = calls;
    this.onCallChanged = onCallChanged;
    this.config = config;
    this.codebook = codebook;
    this.records = new DispatchRecordsService({
      store,
      units,
      calls,
      config,
      resolveContextCall: (unit, mode) => this.resolveContextCall(unit, mode),
    });
  }
  async setUnitStatus(userId, status) {
    const current = this.units.getByUserId(userId);
    if (
      current?.assignedCallId &&
      ["AVAILABLE", "ASSIGNMENT_COMPLETE", "OUT_OF_SERVICE", "OFF_DUTY"].includes(status)
    ) {
      await this.detachUnit(userId);
    }
    const unit = await this.units.setStatus(userId, status);
    void this.refreshRecommendations().catch(() => undefined);
    return unit;
  }
  async setUnitLocation(userId, location, source = "RADIO") {
    const unit = await this.units.setLocation(userId, location, source);
    void this.refreshRecommendations().catch(() => undefined);
    return unit;
  }
  async syncErlcPlayers(players) {
    const changed = await this.units.syncErlcLocations(players);
    for (const unit of changed.filter(
      (candidate) => candidate.status === "OUT_OF_SERVICE" && candidate.assignedCallId,
    )) {
      await this.calls.detach(unit.discordUserId).catch(() => undefined);
      await this.units.setStatus(unit.discordUserId, "OUT_OF_SERVICE", "10-7").catch(() => undefined);
    }
    if (changed.length) await this.calls.refreshRecommendations();
    return changed;
  }
  async handleErlcJoinLog(log) {
    const before = this.units.getByRobloxUsername(log.Player);
    if (!before) return null;
    if (!log.Join && before.assignedCallId) {
      await this.calls.detach(before.discordUserId).catch(() => undefined);
    }
    const changed = await this.units.applyErlcJoinLog(log);
    if (!log.Join) await this.units.setStatus(before.discordUserId, "OUT_OF_SERVICE", "10-7");
    await this.calls.refreshRecommendations();
    return changed;
  }
  async setUnitResponseMode(userId, responseMode) {
    return this.units.setResponseMode(userId, responseMode);
  }
  async attachUnit(userId, reference) {
    const call = await this.calls.attach(userId, reference);
    await this.onCallChanged(call);
    return call;
  }
  async detachUnit(userId) {
    const call = await this.calls.detach(userId);
    await this.onCallChanged(call);
    return call;
  }
  async setResponseStatus(userId, status) {
    const call = await this.calls.setResponseStatus(userId, status);
    if (status === "EN_ROUTE") await this.units.setStatus(userId, "EN_ROUTE");
    if (status === "ON_SCENE") await this.units.setStatus(userId, "ON_SCENE", "10-23");
    if (status === "ON_SCENE" && ["UNKNOWN", "UNSECURED"].includes(call.sceneStatus)) {
      const changed = await this.calls.setSceneStatus(call.id, "ACTIVE");
      await this.onCallChanged(changed);
      return changed;
    }
    await this.onCallChanged(call);
    return call;
  }
  async setSceneStatusForUnit(userId, sceneStatus, reference) {
    const unit = this.units.getByUserId(userId);
    if (!unit) throw new Error("Transmitting unit is not registered.");
    const call = this.calls.findByReference(reference ?? unit.assignedCallId);
    if (!call) throw new Error("Call reference is ambiguous or not active.");
    if (unit.assignedCallId !== call.id) throw new Error("Unit may only update its assigned scene.");
    const changed = await this.calls.setSceneStatus(call.id, sceneStatus);
    await this.onCallChanged(changed);
    return changed;
  }
  async requestResourceForUnit(userId, resource, reference) {
    const unit = this.units.getByUserId(userId);
    if (!unit?.assignedCallId) throw new Error("Transmitting unit is not attached to a call.");
    const call = this.calls.findByReference(reference ?? unit.assignedCallId);
    if (!call || unit.assignedCallId !== call.id)
      throw new Error("Unit may only request resources for its assigned call.");
    const changed = await this.calls.requestResource(call.id, resource);
    await this.onCallChanged(changed);
    return changed;
  }
  createExecutionContext(userId) {
    const unit = this.units.getByUserId(userId);
    if (!unit) throw new Error("Transmitting unit is not registered.");
    return {
      transmissionId: randomUUID(),
      unitId: userId,
      discordUserId: userId,
      callsign: unit.callsign,
      currentCallId: unit.assignedCallId,
      matchedCallId: null,
      createdCallId: null,
      activeCallId: unit.assignedCallId,
      selectedCallId: null,
      extractedActions: [],
      orderedActions: [],
      validationResults: [],
      actionResults: [],
      successfulActions: [],
      failedActions: [],
      interpretationDisposition: "ACTIONABLE",
      executionDisposition: "NO_ACTION",
      replyDisposition: "REPLIED",
    };
  }
  normalizeTransmission(userId, transcript) {
    const unit = this.units.getByUserId(userId);
    return normalizeRadioTransmission(transcript, unit, this.codebook);
  }
  async createOfficerCallAction(userId, input, context = this.createExecutionContext(userId)) {
    const unit = this.units.getByUserId(userId);
    if (!unit) throw new Error("Transmitting unit is not registered.");
    const interpretation = {
      classification: "OFFICER_INITIATED_INCIDENT",
      incident: {
        type: input.incidentType,
        description: input.description,
        location: input.location,
        radioCode: input.radioCode ?? null,
      },
      unitUpdates: { location: input.location },
    };
    const candidates = scoreOfficerCallCandidates(
      this.calls.list(),
      interpretation,
      unit,
      this.config.OFFICER_CALL_MATCH_THRESHOLD ?? 0.72,
    );
    const strongMatches = candidates.filter((candidate) => candidate.strong);
    if (strongMatches.length > 1 && strongMatches[0].score - strongMatches[1].score < 0.1) {
      const choices = strongMatches.slice(0, 3).map((candidate) => {
        const match = this.calls.get(candidate.callId);
        return `${match.incident} at ${match.location}`;
      });
      throw new Error(`Multiple plausible active calls: ${joinWords(choices)}. Confirm which incident.`);
    }
    const match = strongMatches[0];
    let call;
    if (match) {
      call = this.calls.get(match.callId);
      context.matchedCallId = call.id;
    } else {
      const relatedCallIds = this.findRelatedCallIds(input.location, input.description);
      call = await this.calls.create({
        source: "OFFICER_INITIATED",
        incident: input.incidentType,
        radioCode: input.radioCode ?? null,
        location: input.location,
        description: input.description,
        priority: input.priority,
        responseMode: `CODE_${input.responseCode}`,
        prioritySource: input.prioritySource ?? "FALLBACK",
        priorityReason: input.priorityReason ?? "Officer-reported circumstances.",
        relatedCallIds,
      });
      context.createdCallId = call.id;
    }
    context.activeCallId = call.id;
    const current = this.units.getByUserId(userId);
    if (!current.assignedCallId) call = await this.calls.attach(userId, call.id);
    else if (current.assignedCallId !== call.id)
      throw new Error(
        `Unit is already assigned to ${current.assignedCallId}; new incident ${call.id} was preserved but could not replace that assignment automatically.`,
      );
    if (this.calls.get(call.id).unitRoles[unit.callsign] !== "PRIMARY")
      call = await this.calls.setUnitRole(call.id, unit.callsign, "PRIMARY");
    await this.onCallChanged(call);
    return call;
  }
  async requestResourceInContext(userId, request, context) {
    const unit = this.units.getByUserId(userId);
    const callId = context?.activeCallId ?? unit?.assignedCallId;
    if (!unit || !callId) throw new Error("No active incident exists for the resource request.");
    const changed = await this.calls.requestStructuredResource(callId, { ...request, requestedBy: unit.callsign });
    if (context) context.activeCallId = changed.id;
    await this.onCallChanged(changed);
    return changed;
  }
  async addCallNoteInContext(userId, note, context) {
    const unit = this.units.getByUserId(userId);
    const callId = context?.activeCallId ?? unit?.assignedCallId;
    if (!unit || !callId) throw new Error("No active incident exists for the call note.");
    const changed = await this.calls.addNote(callId, unit.callsign, note);
    if (context) context.activeCallId = changed.id;
    await this.onCallChanged(changed);
    return changed;
  }
  async processOfficerTransmission(userId, transcript, suppliedInterpretation = null, suggestedActions = []) {
    const unit = this.units.getByUserId(userId);
    if (!unit) throw new Error("Transmitting unit is not registered.");
    const normalization = this.normalizeTransmission(userId, transcript);
    const interpretation =
      suppliedInterpretation ?? interpretOfficerTransmission(transcript, unit, this.codebook, normalization);
    const context = this.createExecutionContext(userId);
    context.extractedActions = [
      ...interpretation.codeOperations.map((operation) => `${operation.action}:${operation.code}`),
      ...interpretation.resources.map((resource) => `REQUEST_RESOURCE:${resource.resourceType}`),
      ...interpretation.resourceCancellations.map((resource) => `CANCEL_RESOURCE:${resource}`),
      ...suggestedActions.map((action) => `AI_SUGGESTION:${action.name}`),
    ];
    const candidates = scoreOfficerCallCandidates(
      this.calls.list(),
      interpretation,
      unit,
      this.config.OFFICER_CALL_MATCH_THRESHOLD ?? 0.72,
    );
    const isOperational = interpretation.classification !== "ROUTINE_TRAFFIC" || suggestedActions.length > 0;
    if (!isOperational) return { handled: false, interpretation, context, candidates, response: "" };
    await this.units.learnRadioAlias(userId, transcript).catch(() => undefined);

    const run = async (action, operation) => {
      context.orderedActions.push(action);
      try {
        const value = await operation();
        context.validationResults.push({
          action,
          valid: true,
          detail: "Local validation and state preconditions passed.",
        });
        const result = { action, ok: true, disposition: "EXECUTED", detail: describeActionResult(value) };
        context.actionResults.push(result);
        context.successfulActions.push(result);
        context.executionDisposition = context.failedActions.length ? "PARTIAL" : "EXECUTED";
        return value;
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Action failed.";
        context.validationResults.push({ action, valid: false, detail: reason });
        const result = { action, ok: false, disposition: "FAILED_EXECUTION", detail: reason };
        context.actionResults.push(result);
        context.failedActions.push({ action, reason, disposition: "FAILED_EXECUTION" });
        context.executionDisposition = context.successfulActions.length ? "PARTIAL" : "FAILED";
        return null;
      }
    };

    let call = null;
    const newIncident = interpretation.classification === "OFFICER_INITIATED_INCIDENT" && interpretation.incident;
    if (newIncident) {
      call = await run("create_or_match_call", () =>
        this.createOfficerCallAction(
          userId,
          {
            incidentType: interpretation.incident.type,
            radioCode: interpretation.incident.radioCode,
            location: interpretation.incident.location ?? unit.location ?? "Location pending",
            priority: interpretation.incident.priority,
            responseCode: interpretation.incident.responseCode,
            description: interpretation.incident.description,
            prioritySource: "FALLBACK",
            priorityReason: "Officer-reported circumstances evaluated locally.",
          },
          context,
        ),
      );
    } else {
      const assigned = unit.assignedCallId && this.calls.get(unit.assignedCallId);
      const strong = candidates.find((candidate) => candidate.strong);
      call = assigned ?? (strong && this.calls.get(strong.callId)) ?? null;
      if (call) {
        context.matchedCallId = call.id;
        context.activeCallId = call.id;
      }
    }
    if (interpretation.contextAction) {
      const selected = this.resolveContextCall(unit);
      if (interpretation.contextAction === "CLOSE_LAST")
        call = await run("context:close_last", () =>
          selected ? this.calls.close(selected.id) : Promise.reject(new Error("No unresolved last call is available.")),
        );
      else
        call = await run(`context:${interpretation.contextAction.toLowerCase()}`, () =>
          selected ? this.calls.attach(userId, selected.id) : Promise.reject(new Error("No active call is available.")),
        );
      if (call) {
        context.activeCallId = call.id;
        context.selectedCallId = call.id;
      }
    }

    for (const operation of interpretation.codeOperations.filter(
      (operation) => !operation.negated && operation.action === "ACTIVATE_EMERGENCY",
    )) {
      call = await run(`radio_code:${operation.code}:emergency`, () =>
        this.activateOfficerEmergency(userId, {
          transcript,
          description: `${unit.callsign} activated ${operation.code}, ${operation.meaning}.`,
          location: unit.location,
          stageMedical: true,
        }),
      );
      if (call) context.activeCallId = call.id;
    }
    for (const operation of interpretation.codeOperations.filter(
      (operation) => !operation.negated && operation.action === "SET_UNIT_STATUS",
    )) {
      await run(`radio_code:${operation.code}:status`, async () => {
        const changed = await this.setUnitStatus(userId, operation.value);
        return operation.code === changed.statusCode
          ? changed
          : this.units.setStatus(userId, operation.value, operation.code);
      });
    }
    for (const operation of interpretation.codeOperations.filter(
      (operation) => !operation.negated && operation.action === "SET_RESPONSE_MODE",
    )) {
      await run(`radio_code:${operation.code}:response`, async () => {
        await this.units.setResponseMode(userId, operation.value);
        if (context.activeCallId) return this.calls.setResponseMode(context.activeCallId, operation.value);
        return this.units.getByUserId(userId);
      });
    }
    for (const operation of interpretation.codeOperations.filter(
      (operation) => !operation.negated && operation.action === "SET_UNIT_ACTIVITY",
    )) {
      await run(`radio_code:${operation.code}:activity`, () =>
        this.units.setRadioActivity(userId, operation.code, operation.meaning),
      );
    }
    for (const operation of interpretation.codeOperations.filter(
      (operation) => !operation.negated && operation.action === "ACKNOWLEDGE_CODE",
    ))
      await run(`radio_code:${operation.code}:acknowledge`, async () => ({
        code: operation.code,
        meaning: operation.meaning,
      }));
    for (const operation of interpretation.codeOperations.filter(
      (operation) => !operation.negated && operation.action === "SET_SCENE_STATUS",
    )) {
      const sceneCall = this.resolveContextCall(this.units.getByUserId(userId), "CURRENT_OR_UNRESOLVED");
      if (sceneCall) context.activeCallId = sceneCall.id;
      call = await run(`radio_code:${operation.code}:scene`, () =>
        sceneCall
          ? this.calls.setSceneStatus(sceneCall.id, operation.value)
          : Promise.reject(new Error("No current or unresolved call exists for the scene update.")),
      );
    }
    if (interpretation.unitUpdates.location)
      await run("set_unit_location", () => this.setUnitLocation(userId, interpretation.unitUpdates.location));
    if (interpretation.unitUpdates.status === "ON_SCENE") {
      await run("set_unit_status:ON_SCENE", () => this.units.setStatus(userId, "ON_SCENE", "10-23"));
      if (context.activeCallId)
        await run("set_call_response_status:ON_SCENE", () => {
          if (this.units.getByUserId(userId)?.assignedCallId !== context.activeCallId)
            throw new Error(
              `Unit is not attached to ${context.activeCallId}; the new incident remains active for review.`,
            );
          return this.calls.setResponseStatus(userId, "ON_SCENE");
        });
    } else if (
      interpretation.unitUpdates.status &&
      !interpretation.codeOperations.some((operation) => operation.action === "SET_UNIT_STATUS")
    )
      await run(`set_unit_status:${interpretation.unitUpdates.status}`, () =>
        this.units.setStatus(userId, interpretation.unitUpdates.status),
      );

    if (interpretation.sceneResolution) {
      let resolution =
        interpretation.sceneResolution === "SCENE_SECURE"
          ? (this.config.CODE4_DEFAULT_ACTION ?? "SCENE_SECURE")
          : interpretation.sceneResolution;
      const sceneCall = this.resolveContextCall(this.units.getByUserId(userId), "CURRENT_OR_UNRESOLVED");
      const explicitKeepAttached = /\b(?:keep|leave)\s+(?:me\s+)?attached\b|\bremain\s+attached\b/i.test(transcript);
      if (
        resolution === "SCENE_SECURE" &&
        !explicitKeepAttached &&
        isTrafficStopCall(sceneCall) &&
        isInitiatingUnit(sceneCall, unit.callsign)
      )
        resolution = "CLOSE_ALL";
      context.effectiveSceneResolution = resolution;
      call = await run(`scene_resolution:${resolution}`, () => this.resolveSceneTraffic(userId, resolution, context));
    }
    if (interpretation.felonyStop && context.activeCallId) {
      call = await run("upgrade_felony_stop", () =>
        this.calls.setTrafficStopRisk(
          context.activeCallId,
          { stopType: "FELONY_STOP", riskLevel: "CRITICAL" },
          unit.callsign,
        ),
      );
      if (
        (this.config.FELONY_STOP_AUTO_BACKUP_COUNT ?? 0) > 0 &&
        !interpretation.resources.some((resource) => resource.resourceType === "LAW_ENFORCEMENT")
      )
        await run("request_resource:LAW_ENFORCEMENT:FELONY_POLICY", () =>
          this.requestResourceInContext(
            userId,
            {
              resourceType: "LAW_ENFORCEMENT",
              quantity: this.config.FELONY_STOP_AUTO_BACKUP_COUNT,
              purpose: "FELONY_STOP_BACKUP",
              responseMode: "CODE_3",
              disposition: "RESPOND",
            },
            context,
          ),
        );
      if (
        this.config.FELONY_STOP_AUTO_SUPERVISOR === true &&
        !interpretation.resources.some((resource) => resource.resourceType === "SUPERVISOR")
      )
        await run("request_resource:SUPERVISOR:FELONY_POLICY", () =>
          this.requestResourceInContext(
            userId,
            {
              resourceType: "SUPERVISOR",
              quantity: 1,
              purpose: "FELONY_STOP_COMMAND",
              responseMode: "CODE_3",
              disposition: "RESPOND",
            },
            context,
          ),
        );
    }
    context.boloMatches = [];
    if (interpretation.vehicleObservation && !interpretation.bolo) {
      if (context.activeCallId)
        await run("record_vehicle_observation", () =>
          this.calls.recordVehicleObservation(context.activeCallId, interpretation.vehicleObservation, unit.callsign),
        );
      context.boloMatches = findActiveBoloMatches(
        this.store.bolos.get(),
        interpretation.vehicleObservation,
        this.config.BOLO_MATCH_THRESHOLD ?? 0.5,
      );
      for (const match of context.boloMatches.slice(0, 3)) {
        if (context.activeCallId)
          await run(`bolo_match:${match.bolo.id}`, () =>
            this.calls.recordBoloMatch(context.activeCallId, match, unit.callsign, boloSafetyLevel(match.bolo)),
          );
      }
      const alreadyHasBackup =
        interpretation.resources.some((request) => request.resourceType === "LAW_ENFORCEMENT") ||
        (context.activeCallId &&
          this.calls
            .get(context.activeCallId)
            ?.resourceRequests.some(
              (request) => request.resourceType === "LAW_ENFORCEMENT" && request.status !== "CANCELLED",
            ));
      if (
        context.boloMatches.length &&
        !alreadyHasBackup &&
        this.config.BOLO_AUTO_REQUEST_BACKUP === true &&
        interpretation.resourceIntent?.additionalUnits !== "NEGATIVE" &&
        context.activeCallId
      ) {
        await run("request_resource:LAW_ENFORCEMENT:BOLO_POLICY", () =>
          this.requestResourceInContext(
            userId,
            {
              resourceType: "LAW_ENFORCEMENT",
              quantity: 1,
              purpose: "BOLO_MATCH_BACKUP",
              responseMode: "CODE_2",
              disposition: "RESPOND",
            },
            context,
          ),
        );
      }
    }
    for (const resource of interpretation.resourceCancellations) {
      if (context.activeCallId)
        await run(`cancel_resource:${resource}`, () =>
          this.calls.cancelResource(
            context.activeCallId,
            resource,
            unit.callsign,
            "Cancelled by complete officer transmission",
          ),
        );
      else {
        const action = `cancel_resource:${resource}`;
        const detail = "No active call exists for the cancellation.";
        context.orderedActions.push(action);
        context.validationResults.push({ action, valid: false, detail });
        context.actionResults.push({ action, ok: false, disposition: "REJECTED_VALIDATION", detail });
        context.failedActions.push({ action, reason: detail, disposition: "REJECTED_VALIDATION" });
        context.executionDisposition = context.successfulActions.length ? "PARTIAL" : "FAILED";
      }
    }
    for (const operation of interpretation.codeOperations.filter(
      (operation) =>
        !operation.negated &&
        operation.action === "REQUEST_RESOURCE" &&
        !interpretation.resources.some((resource) => resource.resourceType === operation.value),
    ))
      await run(`radio_code:${operation.code}:resource`, () =>
        this.requestResourceInContext(
          userId,
          {
            resourceType: operation.value,
            quantity: 1,
            purpose: `RADIO_CODE_${operation.code.replace(/[^A-Z0-9]+/gi, "_")}`,
            responseMode: `CODE_${operation.responseCode ?? 2}`,
            disposition: "RESPOND",
          },
          context,
        ),
      );
    for (const resource of interpretation.resources)
      await run(`request_resource:${resource.resourceType}`, () =>
        this.requestResourceInContext(userId, resource, context),
      );
    for (const note of interpretation.notes)
      if (context.activeCallId) await run("add_call_note", () => this.addCallNoteInContext(userId, note, context));
    let boloChange = null;
    if (interpretation.bolo) {
      const boloInput = { ...interpretation.bolo };
      const activeCall = context.activeCallId && this.calls.get(context.activeCallId);
      if (boloInput.type === "VEHICLE" && activeCall) {
        boloInput.plate ??=
          activeCall.notes
            .slice()
            .reverse()
            .map((note) => parsePlate(note.text))
            .find(Boolean) ?? null;
        boloInput.lastKnownLocation ??= activeCall.location;
      }
      boloChange = await run(`bolo:${boloInput.operation}`, () =>
        this.applyBolo(unit, boloInput, context.activeCallId),
      );
    }
    let warrantChange = null;
    if (interpretation.warrant)
      warrantChange = await run(`warrant:${interpretation.warrant.operation}`, () =>
        this.applyWarrant(unit, interpretation.warrant, context.activeCallId),
      );
    if (interpretation.pursuit && context.activeCallId) {
      call = await run("update_pursuit", () =>
        this.calls.setPursuit(context.activeCallId, interpretation.pursuit, unit.callsign),
      );
      if (interpretation.pursuit.active)
        await run("prepare_pursuit_options", () =>
          this.calls.addOperationalPlan(context.activeCallId, [
            "Supervisor response",
            "Closest available units",
            "Air support if available",
            "Spike-strip locations",
            "EMS staging",
          ]),
        );
    }
    if (interpretation.informationRequest)
      await run(`information:${interpretation.informationRequest}`, () =>
        this.resolveInformationRequest(
          userId,
          interpretation.informationRequest,
          context,
          interpretation.vehicleObservation,
        ),
      );

    if (context.activeCallId) {
      call = this.calls.get(context.activeCallId);
      if (call) await this.onCallChanged(call);
    }
    const requestedResourceDetails =
      context.activeCallId && interpretation.resources.length
        ? (this.calls
            .get(context.activeCallId)
            ?.resourceRequests.filter((request) => request.requestedBy === unit.callsign)
            .slice(-interpretation.resources.length) ?? [])
        : [];
    return {
      handled: isOperational,
      interpretation,
      context,
      candidates: candidates.map(({ strong: _strong, ...candidate }) => candidate),
      call: context.activeCallId ? this.calls.get(context.activeCallId) : null,
      requestedResourceDetails,
      boloChanges: boloChange ? [describeActionResult(boloChange)] : [],
      warrantChanges: warrantChange ? [describeActionResult(warrantChange)] : [],
      response: buildOfficerAcknowledgement(unit, interpretation, context, this.calls.get(context.activeCallId)),
    };
  }
  async resolveSceneTraffic(userId, resolution, context) {
    const unit = this.units.getByUserId(userId);
    const call = this.resolveContextCall(unit, "CURRENT_OR_UNRESOLVED");
    if (!call) throw new Error("No current or unresolved call exists for the scene update.");
    context.activeCallId = call.id;
    context.selectedCallId = call.id;
    if (resolution === "CLOSE_ALL") return this.calls.close(call.id);
    if (resolution === "CLEAR_SELF") return this.calls.detach(userId);
    if (resolution === "RELEASE_BACKUP") {
      const keep = new Set([
        unit.callsign,
        ...Object.entries(call.unitRoles)
          .filter(([, role]) => role === "PRIMARY")
          .map(([callsign]) => callsign),
      ]);
      for (const callsign of call.assignedUnits.filter((callsign) => !keep.has(callsign))) {
        const candidate = this.units.getByCallsign(callsign);
        if (candidate) await this.calls.detach(candidate.discordUserId);
      }
      return this.calls.setSceneStatus(call.id, "SECURE");
    }
    return this.calls.setSceneStatus(call.id, "SECURE");
  }
  resolveContextCall(unit, mode = "ACTIVE") {
    if (unit?.assignedCallId) {
      const current = this.calls.get(unit.assignedCallId);
      if (current?.status !== "CLOSED") return current;
    }
    if (unit?.lastActiveCallId) {
      const recent = this.calls.get(unit.lastActiveCallId);
      if (recent?.status !== "CLOSED") return recent;
    }
    const settings = this.store.settings.get();
    const candidates = [
      settings.mostRecentActiveCallId,
      settings.mostRecentAnnouncedCallId,
      settings.mostRecentCreatedCallId,
    ]
      .map((id) => this.calls.get(id))
      .filter((call) => call && call.status !== "CLOSED");
    return (
      candidates[0] ??
      (mode === "CURRENT_OR_UNRESOLVED"
        ? (this.calls
            .list()
            .filter((call) => call.status !== "CLOSED")
            .at(-1) ?? null)
        : null)
    );
  }
  async resolveInformationRequest(userId, request, context, observation = null) {
    return this.records.resolveInformationRequest(userId, request, context, observation);
  }
  async activateOfficerEmergency(userId, input) {
    const unit = this.units.getByUserId(userId);
    if (!unit) throw new Error("Emergency unit is not registered.");
    let call = this.resolveContextCall(unit);
    if (!call || unit.assignedCallId !== call.id) {
      call = await this.calls.create({
        source: "OFFICER_INITIATED",
        incident: "Officer Emergency",
        radioCode: "10-99",
        location: input.location ?? unit.location ?? "Location unavailable",
        description: input.description ?? "Officer declared emergency traffic.",
        priority: 1,
        responseMode: "CODE_3",
        prioritySource: "FALLBACK",
        priorityReason: "Officer panic activation.",
        riskLevel: "CRITICAL",
      });
      call = await this.calls.attach(userId, call.id);
    }
    await this.units.setStatus(userId, "EMERGENCY", "10-99");
    await this.units.setResponseMode(userId, "CODE_3");
    call = await this.calls.setPriority(call.id, 1, "FALLBACK", "Officer panic activation.");
    await this.calls.setUnitRole(call.id, unit.callsign, "ENDANGERED");
    const available = this.units
      .list()
      .filter(
        (candidate) =>
          candidate.discordUserId !== userId && candidate.status === "AVAILABLE" && !candidate.assignedCallId,
      ).length;
    await this.calls.requestStructuredResource(call.id, {
      resourceType: "LAW_ENFORCEMENT",
      quantity: Math.max(1, Math.min(20, available)),
      purpose: "OFFICER_ASSIST",
      responseMode: "CODE_3",
      requestedBy: "DISPATCH",
      disposition: "RESPOND",
    });
    await this.calls.requestStructuredResource(call.id, {
      resourceType: "SUPERVISOR",
      quantity: 1,
      purpose: "OFFICER_ASSIST_COMMAND",
      responseMode: "CODE_3",
      requestedBy: "DISPATCH",
      disposition: "RESPOND",
    });
    if (input.stageMedical) {
      await this.calls.requestStructuredResource(call.id, {
        resourceType: "EMS",
        quantity: 1,
        purpose: "OFFICER_SAFETY_STAGING",
        responseMode: "CODE_3",
        requestedBy: "DISPATCH",
        disposition: "STAGE",
      });
      await this.calls.requestStructuredResource(call.id, {
        resourceType: "FIRE",
        quantity: 1,
        purpose: "OFFICER_SAFETY_STAGING",
        responseMode: "CODE_3",
        requestedBy: "DISPATCH",
        disposition: "STAGE",
      });
    }
    await this.calls.addNote(
      call.id,
      unit.callsign,
      `Mass panic: ${input.description ?? "emergency traffic"}. Original transcript: ${input.transcript}`.slice(0, 500),
    );
    const changed = this.calls.get(call.id);
    await this.onCallChanged(changed);
    return changed;
  }
  async applyBolo(unit, input, callId) {
    return this.records.applyBolo(unit, input, callId);
  }
  async applyWarrant(unit, input, callId) {
    return this.records.applyWarrant(unit, input, callId);
  }
  isWarrantAuthorized(unit) {
    return this.records.isWarrantAuthorized(unit);
  }
  findRelatedCallIds(location, description) {
    const terms = new Set(
      String(description)
        .toLowerCase()
        .match(/[a-z0-9]{4,}/g) ?? [],
    );
    return this.calls
      .list(false)
      .filter(
        (call) =>
          call.location.toLowerCase() === String(location).toLowerCase() ||
          [...terms].some((term) => `${call.incident} ${call.description}`.toLowerCase().includes(term)),
      )
      .slice(-5)
      .map((call) => call.id);
  }
  recentTransmissionsForUser(userId, limit = 5) {
    return this.store.transmissions
      .get()
      .filter((item) => item.discordUserId === userId)
      .slice(-limit)
      .map((item) => ({ officer: item.transcript, dispatcher: item.dispatcherTranscript, callId: item.activeCallId }));
  }
  async refineOfficerCallPriority(callId, triage) {
    const previous = this.calls.get(callId);
    if (!previous) throw new Error("Officer-initiated call not found for AI triage.");
    const changed = await this.calls.setPriority(
      callId,
      Math.min(previous.priority, triage.priority),
      "AI",
      triage.reason,
    );
    await this.onCallChanged(changed, {
      upgraded: changed.priority < previous.priority,
      previousPriority: previous.priority,
    });
    return changed;
  }
  async addCallNoteForUnit(userId, text, reference) {
    const unit = this.units.getByUserId(userId);
    if (!unit?.assignedCallId) throw new Error("Transmitting unit is not attached to a call.");
    const call = this.calls.findByReference(reference ?? unit.assignedCallId);
    if (!call || unit.assignedCallId !== call.id) throw new Error("Unit may only update its assigned call.");
    const changed = await this.calls.addNote(call.id, unit.callsign, text);
    await this.inferOperationalPlan(userId, changed, text);
    const latest = this.calls.get(changed.id);
    await this.onCallChanged(latest, { upgraded: latest.priority < call.priority, previousPriority: call.priority });
    return latest;
  }
  async setUnitSceneRole(userId, role, reference) {
    const unit = this.units.getByUserId(userId);
    if (!unit?.assignedCallId) throw new Error("Transmitting unit is not attached to a call.");
    const call = this.calls.findByReference(reference ?? unit.assignedCallId);
    if (!call || call.id !== unit.assignedCallId) throw new Error("Unit may only update its assigned scene role.");
    const changed = await this.calls.setUnitRole(call.id, unit.callsign, role);
    await this.onCallChanged(changed);
    return changed;
  }
  async assignAdditionalUnits(requesterId, count, supervisorOnly) {
    const requester = this.units.getByUserId(requesterId);
    if (!requester?.assignedCallId) throw new Error("Transmitting unit is not attached to a call.");
    const candidates = this.units
      .list()
      .filter(
        (unit) =>
          unit.discordUserId !== requesterId &&
          unit.status === "AVAILABLE" &&
          !unit.assignedCallId &&
          (!supervisorOnly || /supervisor|sergeant|lieutenant|captain|chief/i.test(`${unit.rank} ${unit.division}`)),
      )
      .slice(0, count);
    for (const unit of candidates) {
      await this.attachUnit(unit.discordUserId, requester.assignedCallId);
      if (supervisorOnly) await this.setUnitSceneRole(unit.discordUserId, "SUPERVISOR", requester.assignedCallId);
    }
    return candidates.map((unit) => unit.callsign);
  }
  async closeCallForUnit(userId, reference) {
    const unit = this.units.getByUserId(userId);
    if (!unit) throw new Error("Transmitting unit is not registered.");
    const call = this.calls.findByReference(reference ?? unit.assignedCallId);
    if (!call) throw new Error("Call reference is ambiguous or not active.");
    if (unit.assignedCallId !== call.id) throw new Error("Unit may only close its assigned call.");
    const closed = await this.calls.close(call.id);
    await this.onCallChanged(closed);
    return closed;
  }
  async logTransmission(input) {
    if (input.discordUserId && this.units.getByUserId(input.discordUserId))
      await this.units.markRadioActivity(input.discordUserId).catch(() => undefined);
    const safeInput = sanitizeTransmissionLog(input);
    await this.store.transmissions.update((items) => {
      items.push({ id: randomUUID(), timestamp: new Date().toISOString(), ...safeInput });
      if (items.length > HISTORY_LIMITS.transmissions) items.splice(0, items.length - HISTORY_LIMITS.transmissions);
    });
  }
  async inferOperationalPlan(userId, call, text) {
    const plan = [];
    if (/\b(?:pursuit|fleeing|not stopping|losing him)\b/i.test(text))
      plan.push("Nearby units", "Supervisor review", "Air support if enabled", "Spike strips", "EMS standby");
    if (/\b(?:k-?9|canine)\b/i.test(text)) plan.push("K9 availability check");
    if (/\b(?:swat|tactical)\b/i.test(text)) plan.push("SWAT availability check");
    if (/\b(?:roadblock)\b/i.test(text)) plan.push("Roadblock locations");
    if (plan.length) {
      await this.calls.addOperationalPlan(call.id, plan);
      await this.calls.setRecommendations(call.id);
    }
    if (/\b(?:traffic control|direct traffic|blocking traffic)\b/i.test(text))
      await this.setUnitSceneRole(userId, "TRAFFIC", call.id).catch(() => undefined);
    if (/\b(?:primary|lead unit)\b/i.test(text))
      await this.setUnitSceneRole(userId, "PRIMARY", call.id).catch(() => undefined);
  }
  async refreshRecommendations() {
    for (const call of this.calls.list()) {
      const changed = await this.calls.setRecommendations(call.id);
      await this.onCallChanged(changed);
    }
  }
}

function isTrafficStopCall(call) {
  return Boolean(
    call &&
    (call.stopType ||
      call.radioCode === "10-11" ||
      /\b(?:traffic|vehicle|felony|high-risk)\s+stop\b/i.test(call.incident)),
  );
}
function isInitiatingUnit(call, callsign) {
  return Boolean(call && (call.unitRoles?.[callsign] === "PRIMARY" || call.assignedUnits?.[0] === callsign));
}
function boloSafetyLevel(bolo) {
  return /\b(?:armed|weapon|gun|knife|dangerous|violent|shoot|hostage)\b/i.test(bolo.threatInformation ?? "")
    ? "CRITICAL"
    : "HIGH";
}
