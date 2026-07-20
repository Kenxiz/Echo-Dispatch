import { normalizeCallsign } from "../utils/radio.js";
const statusCodes = {
    AVAILABLE: "10-8",
    BUSY: "10-6",
    OUT_OF_SERVICE: "10-7",
    STANDBY: "10-12",
    ON_DUTY: "10-41",
    OFF_DUTY: "10-42",
    EN_ROUTE: "10-17",
    ON_SCENE: "10-23",
    ASSIGNMENT_COMPLETE: "10-24",
    TRAFFIC_STOP: "10-61",
    RADAR: "10-92",
    PURSUIT: "10-43",
    DETAINING: "10-48",
    DIRECTING_TRAFFIC: "10-58",
    ESCORT: "10-59",
    PRISONER_IN_CUSTODY: "10-72",
    AT_STATION: "10-81",
    MEAL_BREAK: "10-96",
    AT_HOSPITAL: "10-97",
    COURT: "10-106",
    VEHICLE_MAINTENANCE: "10-107",
    BUILDING_CHECK: "10-108",
    EMERGENCY: "10-33",
};
export class UnitService {
    store;
    constructor(store) {
        this.store = store;
    }
    list(activeOnly = true) {
        return this.store.units.get().filter((unit) => !activeOnly || unit.active);
    }
    getByUserId(discordUserId) {
        return this.store.units.get().find((unit) => unit.discordUserId === discordUserId && unit.active);
    }
    getByCallsign(callsign) {
        const normalized = normalizeCallsign(callsign);
        return this.store.units.get().find((unit) => unit.callsign === normalized && unit.active);
    }
    async register(input) {
        const callsign = normalizeCallsign(input.callsign);
        if (!/^[0-9A-Z]+(?:-[0-9A-Z]+)+$/.test(callsign))
            throw new Error("Callsign must use a format such as 1L-18.");
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
                assignedCallId: null,
                responseStatus: "UNASSIGNED",
                responseMode: null,
                active: true,
            };
            units.push(created);
        });
        return created;
    }
    async unregister(discordUserId) {
        let changed;
        await this.store.units.update((units) => {
            const unit = units.find((candidate) => candidate.discordUserId === discordUserId && candidate.active);
            if (!unit)
                throw new Error("You do not have an active unit.");
            unit.active = false;
            unit.status = "OUT_OF_SERVICE";
            unit.statusCode = "10-7";
            unit.assignedCallId = null;
            unit.responseStatus = "UNASSIGNED";
            unit.responseMode = null;
            changed = structuredClone(unit);
        });
        return changed;
    }
    async setStatus(discordUserId, status) {
        return this.modify(discordUserId, (unit) => {
            unit.status = status;
            unit.statusCode = statusCodes[status] ?? null;
        });
    }
    async setLocation(discordUserId, location) {
        if (!location.trim())
            throw new Error("A location is required.");
        return this.modify(discordUserId, (unit) => { unit.location = location.trim(); });
    }
    async setAssignment(discordUserId, callId, responseStatus) {
        return this.modify(discordUserId, (unit) => {
            unit.assignedCallId = callId;
            unit.responseStatus = responseStatus;
        });
    }
    async setResponseMode(discordUserId, responseMode) {
        return this.modify(discordUserId, (unit) => { unit.responseMode = responseMode; });
    }
    async modify(discordUserId, mutate) {
        let changed;
        await this.store.units.update((units) => {
            const unit = units.find((candidate) => candidate.discordUserId === discordUserId && candidate.active);
            if (!unit)
                throw new Error("No active unit is registered for this user.");
            mutate(unit);
            changed = structuredClone(unit);
        });
        return changed;
    }
}
