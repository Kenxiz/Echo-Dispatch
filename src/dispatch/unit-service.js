import { normalizeCallsign } from "../utils/radio.js";
import { erlcPlayerName, findErlcPlayer, formatErlcLocation } from "../erlc/client.js";
import { logger } from "../infrastructure/logger.js";
const statusCodes = {
  AVAILABLE: "10-8",
  BUSY: "10-6",
  OUT_OF_SERVICE: "10-7",
  STANDBY: "10-12",
  ON_DUTY: "10-41",
  OFF_DUTY: "10-42",
  EN_ROUTE: "10-76",
  ON_SCENE: "10-23",
  ASSIGNMENT_COMPLETE: "10-37",
  TRAFFIC_STOP: "10-11",
  RADAR: "Signal 11",
  PURSUIT: "10-80",
  PARK_WALK_TALK: "10-44",
  DELAYED: "10-85",
  IN_AREA: "Code 6",
  EMERGENCY: "10-99",
};
export class UnitService {
  store;
  constructor(store, config = {}) {
    this.store = store;
    this.config = config;
    this.onChanged = async () => undefined;
  }
  setOnChanged(handler) {
    this.onChanged = handler ?? (async () => undefined);
  }
  list(activeOnly = true) {
    return this.store.units.get().filter((unit) => !activeOnly || unit.active);
  }
  getByUserId(discordUserId) {
    return this.store.units.get().find((unit) => unit.discordUserId === discordUserId && unit.active);
  }
  getByCallsign(callsign) {
    const normalized = normalizeCallsign(callsign);
    const compact = String(callsign)
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "");
    return this.store.units
      .get()
      .find(
        (unit) =>
          unit.active &&
          (unit.callsign === normalized ||
            unit.radioAliases.some((alias) => alias.toUpperCase().replace(/[^A-Z0-9]/g, "") === compact)),
      );
  }
  getByRobloxUsername(username) {
    const normalized = erlcPlayerName(username).toLowerCase();
    return this.store.units.get().find((unit) => unit.active && unit.robloxUsername?.toLowerCase() === normalized);
  }
  async register(input) {
    const callsign = normalizeCallsign(input.callsign);
    if (!/^[0-9A-Z]+(?:-[0-9A-Z]+)+$/.test(callsign)) throw new Error("Callsign must use a format such as 1L-18.");
    let created;
    await this.store.units.update((units) => {
      if (units.some((unit) => unit.discordUserId === input.discordUserId && unit.active))
        throw new Error("You already have an active unit.");
      if (units.some((unit) => unit.callsign === callsign && unit.active))
        throw new Error("That callsign is already active.");
      created = {
        discordUserId: input.discordUserId,
        callsign,
        rank: input.rank.trim(),
        division: input.division.trim(),
        robloxUsername: input.robloxUsername?.trim() || null,
        status: "AVAILABLE",
        statusCode: "10-8",
        location: null,
        locationSource: null,
        locationUpdatedAt: null,
        postal: null,
        street: null,
        coordinates: null,
        previousLocation: null,
        heading: null,
        locationFresh: false,
        assignedCallId: null,
        lastActiveCallId: null,
        lastClosedCallId: null,
        responseStatus: "UNASSIGNED",
        responseMode: null,
        sceneRole: null,
        lastRadioAt: null,
        lastStatusCheckAt: null,
        radioAliases: [],
        activeRadioCodes: [],
        erlcPresent: false,
        erlcTeam: null,
        lastSeenErlcAt: null,
        erlcMissingPolls: 0,
        active: true,
      };
      units.push(created);
    });
    await this.notify(created, null, "UNIT_REGISTERED");
    return created;
  }
  async unregister(discordUserId) {
    let changed;
    let previous;
    await this.store.units.update((units) => {
      const unit = units.find((candidate) => candidate.discordUserId === discordUserId && candidate.active);
      if (!unit) throw new Error("You do not have an active unit.");
      previous = structuredClone(unit);
      unit.active = false;
      unit.status = "OUT_OF_SERVICE";
      unit.statusCode = "10-7";
      unit.assignedCallId = null;
      unit.responseStatus = "UNASSIGNED";
      unit.responseMode = null;
      unit.sceneRole = null;
      changed = structuredClone(unit);
    });
    await this.notify(changed, previous, "UNIT_UNREGISTERED");
    return changed;
  }
  async setStatus(discordUserId, status, statusCodeOverride = undefined) {
    return this.modify(
      discordUserId,
      (unit) => {
        unit.status = status;
        unit.statusCode = statusCodeOverride === undefined ? (statusCodes[status] ?? null) : statusCodeOverride;
      },
      "STATUS_CHANGED",
    );
  }
  async setLocation(discordUserId, location, source = "RADIO", details = {}) {
    if (!location.trim()) throw new Error("A location is required.");
    return this.modify(
      discordUserId,
      (unit) => {
        if (unit.location && unit.location !== location.trim()) unit.previousLocation = unit.location;
        unit.location = location.trim();
        unit.locationSource = source;
        unit.locationUpdatedAt = new Date().toISOString();
        unit.postal = details.postal ?? extractLocationPart(location, /\bpostal\s*(\d{1,5})\b/i) ?? unit.postal;
        unit.street = details.street ?? extractLocationPart(location, /^([^,]+)/) ?? unit.street;
        unit.coordinates = details.coordinates ?? unit.coordinates;
        unit.heading = details.heading ?? unit.heading;
        unit.locationFresh = true;
      },
      "LOCATION_CHANGED",
    );
  }
  async setAssignment(discordUserId, callId, responseStatus) {
    return this.modify(
      discordUserId,
      (unit) => {
        if (callId) unit.lastActiveCallId = callId;
        unit.assignedCallId = callId;
        unit.responseStatus = responseStatus;
      },
      "ASSIGNMENT_CHANGED",
    );
  }
  async markCallClosed(discordUserId, callId) {
    return this.modify(
      discordUserId,
      (unit) => {
        unit.lastClosedCallId = callId;
      },
      "CALL_CONTEXT_CHANGED",
    );
  }
  async setRadioActivity(discordUserId, code, meaning, active = true) {
    return this.modify(
      discordUserId,
      (unit) => {
        unit.activeRadioCodes = unit.activeRadioCodes.filter((entry) => entry.code !== code);
        if (active) unit.activeRadioCodes.push({ code, meaning, updatedAt: new Date().toISOString() });
        if (unit.activeRadioCodes.length > 10) unit.activeRadioCodes.splice(0, unit.activeRadioCodes.length - 10);
      },
      "RADIO_ACTIVITY_CHANGED",
    );
  }
  async setResponseMode(discordUserId, responseMode) {
    return this.modify(
      discordUserId,
      (unit) => {
        unit.responseMode = responseMode;
      },
      "RESPONSE_MODE_CHANGED",
    );
  }
  async setSceneRole(discordUserId, sceneRole) {
    return this.modify(
      discordUserId,
      (unit) => {
        unit.sceneRole = sceneRole;
      },
      "SCENE_ROLE_CHANGED",
    );
  }
  async markRadioActivity(discordUserId, timestamp = new Date().toISOString()) {
    return this.modify(
      discordUserId,
      (unit) => {
        unit.lastRadioAt = timestamp;
        unit.lastStatusCheckAt = null;
      },
      "RADIO_ACTIVITY_CHANGED",
    );
  }
  async markStatusCheck(discordUserId, timestamp = new Date().toISOString()) {
    return this.modify(
      discordUserId,
      (unit) => {
        unit.lastStatusCheckAt = timestamp;
      },
      "STATUS_CHECKED",
    );
  }
  async learnRadioAlias(discordUserId, transcript) {
    const opening = String(transcript)
      .split(/,|\b(?:show me|be advised|i have|i'm|i am|start|out with)\b/i)[0]
      .trim();
    if (!opening || opening.length > 40 || !/\d/.test(opening) || /^dispatch$/i.test(opening))
      return this.getByUserId(discordUserId);
    return this.modify(
      discordUserId,
      (unit) => {
        const compact = opening.toUpperCase().replace(/[^A-Z0-9]/g, "");
        const full = unit.callsign.toUpperCase().replace(/[^A-Z0-9]/g, "");
        if (
          compact !== full &&
          !unit.radioAliases.some((alias) => alias.toUpperCase().replace(/[^A-Z0-9]/g, "") === compact)
        ) {
          unit.radioAliases.push(opening);
          if (unit.radioAliases.length > 10) unit.radioAliases.shift();
        }
      },
      "RADIO_ALIAS_LEARNED",
    );
  }
  async syncErlcLocations(players) {
    const changes = [];
    const timestamp = new Date().toISOString();
    const missingThreshold = this.config.ERLC_MISSING_POLLS_BEFORE_OUT_OF_SERVICE ?? 2;
    await this.store.units.update((units) => {
      for (const unit of units.filter((candidate) => candidate.active)) {
        const player = findErlcPlayer(players, unit);
        const location = formatErlcLocation(player?.Location);
        const previous = structuredClone(unit);
        if (!player) {
          if (!unit.erlcPresent) continue;
          unit.erlcMissingPolls += 1;
          unit.locationFresh = false;
          if (unit.erlcMissingPolls >= missingThreshold) {
            unit.erlcPresent = false;
            unit.status = "OUT_OF_SERVICE";
            unit.statusCode = "10-7";
            changes.push({ unit: structuredClone(unit), previous, reason: "ERLC_LEFT_GAME" });
          }
          continue;
        }
        const team = String(player.Team ?? "").trim() || null;
        const changedTeam = unit.erlcPresent && unit.erlcTeam && team && unit.erlcTeam !== team;
        unit.erlcPresent = true;
        unit.erlcMissingPolls = 0;
        unit.lastSeenErlcAt = timestamp;
        unit.erlcTeam = team;
        if (changedTeam) {
          unit.status = "OUT_OF_SERVICE";
          unit.statusCode = "10-7";
        }
        if (location && (unit.location !== location || unit.locationSource !== "ERLC")) {
          if (unit.location && unit.location !== location) unit.previousLocation = unit.location;
          unit.location = location;
          unit.locationSource = "ERLC";
          unit.locationUpdatedAt = timestamp;
          unit.postal = String(player?.Location?.PostalCode ?? player?.Location?.Postal ?? "").trim() || unit.postal;
          unit.street = String(player?.Location?.StreetName ?? player?.Location?.Street ?? "").trim() || unit.street;
          unit.coordinates =
            normalizeCoordinates(player?.Location?.Coordinates ?? player?.Location?.Position ?? player?.Position) ??
            unit.coordinates;
          unit.heading = String(player?.Location?.Heading ?? player?.Heading ?? "").trim() || unit.heading;
          unit.locationFresh = true;
        } else if (location) {
          unit.locationUpdatedAt = timestamp;
        }
        const materiallyChanged =
          previous.erlcPresent !== unit.erlcPresent ||
          previous.erlcTeam !== unit.erlcTeam ||
          previous.location !== unit.location ||
          previous.status !== unit.status ||
          previous.statusCode !== unit.statusCode;
        if (materiallyChanged)
          changes.push({
            unit: structuredClone(unit),
            previous,
            reason: changedTeam ? "ERLC_TEAM_CHANGED" : "ERLC_SYNC",
          });
      }
    });
    for (const change of changes) await this.notify(change.unit, change.previous, change.reason);
    return changes.map((change) => change.unit);
  }
  async applyErlcJoinLog(log) {
    const unit = this.getByRobloxUsername(log.Player);
    if (!unit) return null;
    return this.modify(
      unit.discordUserId,
      (current) => {
        current.erlcPresent = Boolean(log.Join);
        current.erlcMissingPolls = log.Join ? 0 : (this.config.ERLC_MISSING_POLLS_BEFORE_OUT_OF_SERVICE ?? 2);
        current.locationFresh = Boolean(log.Join) && current.locationFresh;
        if (log.Join) current.lastSeenErlcAt = new Date().toISOString();
        else {
          current.status = "OUT_OF_SERVICE";
          current.statusCode = "10-7";
        }
      },
      log.Join ? "ERLC_JOINED_GAME" : "ERLC_LEFT_GAME",
    );
  }
  async modify(discordUserId, mutate, reason = "UNIT_UPDATED") {
    let changed;
    let previous;
    await this.store.units.update((units) => {
      const unit = units.find((candidate) => candidate.discordUserId === discordUserId && candidate.active);
      if (!unit) throw new Error("No active unit is registered for this user.");
      previous = structuredClone(unit);
      mutate(unit);
      changed = structuredClone(unit);
    });
    await this.notify(changed, previous, reason);
    return changed;
  }
  async notify(unit, previous, reason) {
    try {
      await this.onChanged(structuredClone(unit), previous ? structuredClone(previous) : null, reason);
    } catch (error) {
      logger.child("units").error("Unit Discord update failed.", error);
    }
  }
}

function extractLocationPart(value, pattern) {
  return String(value).match(pattern)?.[1]?.trim() ?? null;
}
function normalizeCoordinates(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const numbers = value.slice(0, 3).map(Number);
  if (numbers.some((number) => !Number.isFinite(number))) return null;
  while (numbers.length < 3) numbers.push(0);
  return numbers;
}
