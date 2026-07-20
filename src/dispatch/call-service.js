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
        return this.store.calls.get().find((call) => call.id.toUpperCase() === id.toUpperCase());
    }
    findByReference(reference) {
        const active = this.list(true);
        if (!reference)
            return active.length === 1 ? active[0] : undefined;
        const normalized = reference.toLowerCase();
        return active.find((call) => call.id.toLowerCase() === normalized)
            ?? active.find((call) => call.radioCode?.toLowerCase() === normalized)
            ?? active.find((call) => call.incident.toLowerCase().includes(normalized));
    }
    async create(input) {
        if (input.sourceExternalId && this.store.calls.get().some((call) => call.sourceExternalId === input.sourceExternalId)) {
            throw new Error("This emergency call has already been accepted.");
        }
        let number = 0;
        await this.store.settings.update((settings) => { number = settings.nextCallNumber++; });
        const priority = Math.min(3, Math.max(1, input.priority ?? 2));
        const created = {
            id: `CALL-${String(number).padStart(4, "0")}`,
            source: input.source,
            sourceExternalId: input.sourceExternalId ?? null,
            incident: input.incident.trim(),
            radioCode: input.radioCode ?? null,
            location: input.location.trim(),
            description: input.description.trim(),
            suspectInfo: input.suspectInfo?.trim() || null,
            vehicleInfo: input.vehicleInfo?.trim() || null,
            weaponInfo: input.weaponInfo?.trim() || null,
            injuryInfo: input.injuryInfo?.trim() || null,
            priority,
            prioritySource: input.prioritySource ?? "MANUAL",
            priorityReason: input.priorityReason?.trim() || null,
            status: "AWAITING_UNIT",
            sceneStatus: "UNKNOWN",
            responseMode: input.responseMode ?? (priority === 1 ? "CODE_3" : priority === 3 ? "CODE_1" : "CODE_2"),
            assignedUnits: [],
            requestedResources: [],
            notes: [],
            createdAt: new Date().toISOString(),
            closedAt: null,
            messageId: null,
            reannounced: false,
        };
        await this.store.calls.update((calls) => { calls.push(created); });
        return created;
    }
    async attach(discordUserId, reference) {
        const unit = this.units.getByUserId(discordUserId);
        if (!unit)
            throw new Error("No active unit is registered for this user.");
        if (unit.assignedCallId)
            throw new Error(`Unit is already assigned to ${unit.assignedCallId}.`);
        const call = this.findByReference(reference);
        if (!call)
            throw new Error("Call reference is ambiguous or not active.");
        let changed;
        await this.store.calls.update((calls) => {
            const target = calls.find((candidate) => candidate.id === call.id && ["AWAITING_UNIT", "ACTIVE"].includes(candidate.status));
            if (!target)
                throw new Error("The call is no longer active.");
            if (!target.assignedUnits.includes(unit.callsign))
                target.assignedUnits.push(unit.callsign);
            target.status = "ACTIVE";
            if (target.sceneStatus === "UNKNOWN") target.sceneStatus = "UNSECURED";
            changed = structuredClone(target);
        });
        await this.units.setAssignment(discordUserId, call.id, "ATTACHED");
        await this.units.setResponseMode(discordUserId, changed.responseMode);
        return changed;
    }
    async setResponseStatus(discordUserId, status) {
        const unit = this.units.getByUserId(discordUserId);
        if (!unit?.assignedCallId)
            throw new Error("Unit is not attached to a call.");
        const call = this.get(unit.assignedCallId);
        if (!call || call.status === "CLOSED")
            throw new Error("The assigned call is not active.");
        await this.units.setAssignment(discordUserId, call.id, status);
        return call;
    }
    async detach(discordUserId) {
        const unit = this.units.getByUserId(discordUserId);
        if (!unit?.assignedCallId)
            throw new Error("Unit is not attached to a call.");
        let changed;
        await this.store.calls.update((calls) => {
            const call = calls.find((candidate) => candidate.id === unit.assignedCallId);
            if (!call)
                throw new Error("Assigned call was not found.");
            call.assignedUnits = call.assignedUnits.filter((callsign) => callsign !== unit.callsign);
            if (call.assignedUnits.length === 0 && call.status === "ACTIVE")
                call.status = "AWAITING_UNIT";
            changed = structuredClone(call);
        });
        await this.units.setAssignment(discordUserId, null, "UNASSIGNED");
        await this.units.setResponseMode(discordUserId, null);
        await this.units.setStatus(discordUserId, "AVAILABLE", "10-8");
        return changed;
    }
    async close(id) {
        const call = this.get(id);
        if (!call || call.status === "CLOSED")
            throw new Error("Active call not found.");
        let changed;
        await this.store.calls.update((calls) => {
            const target = calls.find((candidate) => candidate.id === call.id);
            target.status = "CLOSED";
            target.sceneStatus = "SECURE";
            target.closedAt = new Date().toISOString();
            changed = structuredClone(target);
        });
        for (const callsign of call.assignedUnits) {
            const unit = this.units.getByCallsign(callsign);
            if (unit) {
                await this.units.setAssignment(unit.discordUserId, null, "UNASSIGNED");
                await this.units.setResponseMode(unit.discordUserId, null);
                await this.units.setStatus(unit.discordUserId, "AVAILABLE", "10-8");
            }
        }
        return changed;
    }
    async setMessageId(id, messageId) {
        await this.store.calls.update((calls) => {
            const call = calls.find((candidate) => candidate.id === id);
            if (call)
                call.messageId = messageId;
        });
    }
    async markReannounced(id) {
        await this.store.calls.update((calls) => {
            const call = calls.find((candidate) => candidate.id === id);
            if (call)
                call.reannounced = true;
        });
    }
    async setStatus(id, status) {
        let changed;
        await this.store.calls.update((calls) => {
            const call = calls.find((candidate) => candidate.id.toUpperCase() === id.toUpperCase() && candidate.status !== "CLOSED");
            if (!call) throw new Error("Active call not found.");
            if (status === "AWAITING_UNIT" && call.assignedUnits.length > 0) throw new Error("A call with assigned units cannot be marked awaiting unit.");
            call.status = status;
            if (status === "CODE_4") call.sceneStatus = "SECURE";
            if (status === "ACTIVE" && call.sceneStatus === "SECURE") call.sceneStatus = "ACTIVE";
            changed = structuredClone(call);
        });
        return changed;
    }
    async setSceneStatus(id, sceneStatus) {
        let changed;
        await this.store.calls.update((calls) => {
            const call = calls.find((candidate) => candidate.id.toUpperCase() === id.toUpperCase() && candidate.status !== "CLOSED");
            if (!call) throw new Error("Active call not found.");
            call.sceneStatus = sceneStatus;
            if (sceneStatus === "SECURE") call.status = "CODE_4";
            else if (call.status === "CODE_4") call.status = "ACTIVE";
            changed = structuredClone(call);
        });
        return changed;
    }
    async setResponseMode(id, responseMode) {
        let changed;
        await this.store.calls.update((calls) => {
            const call = calls.find((candidate) => candidate.id.toUpperCase() === id.toUpperCase() && candidate.status !== "CLOSED");
            if (!call) throw new Error("Active call not found.");
            call.responseMode = responseMode;
            changed = structuredClone(call);
        });
        return changed;
    }
    async requestResource(id, resource) {
        let changed;
        await this.store.calls.update((calls) => {
            const call = calls.find((candidate) => candidate.id.toUpperCase() === id.toUpperCase() && candidate.status !== "CLOSED");
            if (!call) throw new Error("Active call not found.");
            if (!call.requestedResources.includes(resource)) call.requestedResources.push(resource);
            changed = structuredClone(call);
        });
        return changed;
    }
    async addNote(id, callsign, text) {
        const note = text.trim();
        if (!note) throw new Error("Call note cannot be empty.");
        let changed;
        await this.store.calls.update((calls) => {
            const call = calls.find((candidate) => candidate.id.toUpperCase() === id.toUpperCase() && candidate.status !== "CLOSED");
            if (!call) throw new Error("Active call not found.");
            call.notes.push({ timestamp: new Date().toISOString(), callsign, text: note });
            if (call.notes.length > 50) call.notes.splice(0, call.notes.length - 50);
            changed = structuredClone(call);
        });
        return changed;
    }
}
