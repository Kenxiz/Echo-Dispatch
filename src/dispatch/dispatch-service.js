import { randomUUID } from "node:crypto";
export class DispatchService {
    store;
    units;
    calls;
    onCallChanged;
    constructor(store, units, calls, onCallChanged) {
        this.store = store;
        this.units = units;
        this.calls = calls;
        this.onCallChanged = onCallChanged;
    }
    async setUnitStatus(userId, status) {
        const current = this.units.getByUserId(userId);
        if (current?.assignedCallId && ["AVAILABLE", "ASSIGNMENT_COMPLETE", "OUT_OF_SERVICE", "OFF_DUTY"].includes(status)) {
            await this.detachUnit(userId);
        }
        return this.units.setStatus(userId, status);
    }
    async setUnitLocation(userId, location) {
        return this.units.setLocation(userId, location);
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
        if (status === "EN_ROUTE")
            await this.units.setStatus(userId, "EN_ROUTE");
        if (status === "ON_SCENE")
            await this.units.setStatus(userId, "ON_SCENE", "10-23");
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
        if (sceneStatus === "SECURE") {
            const closed = await this.calls.close(call.id);
            await this.onCallChanged(closed);
            return closed;
        }
        const changed = await this.calls.setSceneStatus(call.id, sceneStatus);
        await this.onCallChanged(changed);
        return changed;
    }
    async requestResourceForUnit(userId, resource, reference) {
        const unit = this.units.getByUserId(userId);
        if (!unit?.assignedCallId) throw new Error("Transmitting unit is not attached to a call.");
        const call = this.calls.findByReference(reference ?? unit.assignedCallId);
        if (!call || unit.assignedCallId !== call.id) throw new Error("Unit may only request resources for its assigned call.");
        const changed = await this.calls.requestResource(call.id, resource);
        await this.onCallChanged(changed);
        return changed;
    }
    async addCallNoteForUnit(userId, text, reference) {
        const unit = this.units.getByUserId(userId);
        if (!unit?.assignedCallId) throw new Error("Transmitting unit is not attached to a call.");
        const call = this.calls.findByReference(reference ?? unit.assignedCallId);
        if (!call || unit.assignedCallId !== call.id) throw new Error("Unit may only update its assigned call.");
        const changed = await this.calls.addNote(call.id, unit.callsign, text);
        await this.onCallChanged(changed);
        return changed;
    }
    async assignAdditionalUnits(requesterId, count, supervisorOnly) {
        const requester = this.units.getByUserId(requesterId);
        if (!requester?.assignedCallId)
            throw new Error("Transmitting unit is not attached to a call.");
        const candidates = this.units.list().filter((unit) => unit.discordUserId !== requesterId && unit.status === "AVAILABLE" && !unit.assignedCallId
            && (!supervisorOnly || /supervisor|sergeant|lieutenant|captain|chief/i.test(`${unit.rank} ${unit.division}`))).slice(0, count);
        for (const unit of candidates)
            await this.attachUnit(unit.discordUserId, requester.assignedCallId);
        return candidates.map((unit) => unit.callsign);
    }
    async closeCallForUnit(userId, reference) {
        const unit = this.units.getByUserId(userId);
        if (!unit)
            throw new Error("Transmitting unit is not registered.");
        const call = this.calls.findByReference(reference ?? unit.assignedCallId);
        if (!call)
            throw new Error("Call reference is ambiguous or not active.");
        if (unit.assignedCallId !== call.id)
            throw new Error("Unit may only close its assigned call.");
        const closed = await this.calls.close(call.id);
        await this.onCallChanged(closed);
        return closed;
    }
    async logTransmission(input) {
        await this.store.transmissions.update((items) => {
            items.push({ id: randomUUID(), timestamp: new Date().toISOString(), ...input });
            if (items.length > 500)
                items.splice(0, items.length - 500);
        });
    }
}
