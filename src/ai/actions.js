import { z } from "zod";
import { RESOURCE_TYPES, RESPONSE_MODES, RESPONSE_STATUSES, SCENE_STATUSES, UNIT_STATUSES } from "../types.js";
export const dispatchFunctionDeclarations = [
    {
        name: "set_unit_status",
        description: "Set the transmitting unit's general availability/activity status.",
        parameters: { type: "OBJECT", properties: {
                status: { type: "STRING", enum: [...UNIT_STATUSES] },
            }, required: ["status"] },
    },
    {
        name: "set_unit_location",
        description: "Set the transmitting unit's current location.",
        parameters: { type: "OBJECT", properties: { location: { type: "STRING" } }, required: ["location"] },
    },
    {
        name: "set_response_mode",
        description: "Set how the transmitting unit is responding: Code 1 routine, Code 2 urgent, or Code 3 emergency.",
        parameters: { type: "OBJECT", properties: { response_mode: { type: "STRING", enum: [...RESPONSE_MODES] } }, required: ["response_mode"] },
    },
    {
        name: "attach_unit_to_call",
        description: "Attach the transmitting unit to one active call. Omit call_reference only if exactly one call is active.",
        parameters: { type: "OBJECT", properties: { call_reference: { type: "STRING", nullable: true } } },
    },
    {
        name: "detach_unit_from_call",
        description: "Clear the transmitting unit from its current call and return it available.",
        parameters: { type: "OBJECT", properties: {} },
    },
    {
        name: "set_call_response_status",
        description: "Set the transmitting unit's response status on its assigned call.",
        parameters: { type: "OBJECT", properties: {
                status: { type: "STRING", enum: [...RESPONSE_STATUSES] },
            }, required: ["status"] },
    },
    {
        name: "request_additional_unit",
        description: "Request and attach available additional units to the transmitting unit's call.",
        parameters: { type: "OBJECT", properties: { count: { type: "INTEGER", minimum: 1, maximum: 5 } } },
    },
    {
        name: "set_scene_status",
        description: "Update the transmitting unit's assigned scene. When an attached unit calls Code 4, use SECURE; this closes the call and returns every attached unit to 10-8.",
        parameters: { type: "OBJECT", properties: {
                scene_status: { type: "STRING", enum: [...SCENE_STATUSES] },
                call_reference: { type: "STRING", nullable: true },
            }, required: ["scene_status"] },
    },
    {
        name: "request_resource",
        description: "Record an EMS, fire, wrecker, supervisor, additional-unit, or other resource request for the assigned call. Do not claim dispatch/arrival is confirmed.",
        parameters: { type: "OBJECT", properties: {
                resource: { type: "STRING", enum: [...RESOURCE_TYPES] },
                call_reference: { type: "STRING", nullable: true },
            }, required: ["resource"] },
    },
    {
        name: "add_call_note",
        description: "Persist a factual suspect, vehicle, hazard, direction, injury, or other operational update supplied by the transmitting unit.",
        parameters: { type: "OBJECT", properties: {
                note: { type: "STRING" },
                call_reference: { type: "STRING", nullable: true },
            }, required: ["note"] },
    },
    {
        name: "request_supervisor",
        description: "Request an available registered supervisor for the transmitting unit's call.",
        parameters: { type: "OBJECT", properties: {} },
    },
    {
        name: "close_call",
        description: "Close an active call when the officer explicitly says the incident/call is closed.",
        parameters: { type: "OBJECT", properties: { call_reference: { type: "STRING", nullable: true } } },
    },
    {
        name: "request_clarification",
        description: "Use when audio, code meaning, location, call reference, or intended action is unclear. Never guess.",
        parameters: { type: "OBJECT", properties: { reason: { type: "STRING" } }, required: ["reason"] },
    },
];
const statusArgs = z.object({ status: z.enum(UNIT_STATUSES) });
const locationArgs = z.object({ location: z.string().min(1).max(200) });
const callRefArgs = z.object({ call_reference: z.string().nullable().optional() });
const responseArgs = z.object({ status: z.enum(RESPONSE_STATUSES) });
const responseModeArgs = z.object({ response_mode: z.enum(RESPONSE_MODES) });
const sceneArgs = z.object({ scene_status: z.enum(SCENE_STATUSES), call_reference: z.string().nullable().optional() });
const resourceArgs = z.object({ resource: z.enum(RESOURCE_TYPES), call_reference: z.string().nullable().optional() });
const noteArgs = z.object({ note: z.string().min(1).max(500), call_reference: z.string().nullable().optional() });
const countArgs = z.object({ count: z.number().int().min(1).max(5).default(1) });
const clarificationArgs = z.object({ reason: z.string().min(1).max(200) });
export async function executeDispatchAction(service, discordUserId, name, args) {
    try {
        switch (name) {
            case "set_unit_status": {
                const parsed = statusArgs.parse(args);
                const unit = await service.setUnitStatus(discordUserId, parsed.status);
                return { ok: true, result: `${unit.callsign} status confirmed as ${unit.statusCode ?? unit.status}.` };
            }
            case "set_unit_location": {
                const parsed = locationArgs.parse(args);
                const unit = await service.setUnitLocation(discordUserId, parsed.location);
                return { ok: true, result: `${unit.callsign} location confirmed as ${unit.location}.` };
            }
            case "set_response_mode": {
                const parsed = responseModeArgs.parse(args);
                const unit = await service.setUnitResponseMode(discordUserId, parsed.response_mode);
                return { ok: true, result: `${unit.callsign} response mode confirmed as ${parsed.response_mode.replace("_", " ")}.` };
            }
            case "attach_unit_to_call": {
                const parsed = callRefArgs.parse(args ?? {});
                const call = await service.attachUnit(discordUserId, parsed.call_reference);
                return { ok: true, result: `Attachment confirmed to ${call.id}; respond priority ${call.priority}.`, changedCallId: call.id };
            }
            case "detach_unit_from_call": {
                const call = await service.detachUnit(discordUserId);
                return { ok: true, result: `Unit cleared from ${call.id} and returned 10-8.`, changedCallId: call.id };
            }
            case "set_call_response_status": {
                const parsed = responseArgs.parse(args);
                if (parsed.status === "CLEARED" || parsed.status === "CANCELLED") {
                    const call = await service.detachUnit(discordUserId);
                    return { ok: true, result: `Unit cleared from ${call.id} and returned 10-8.`, changedCallId: call.id };
                }
                const call = await service.setResponseStatus(discordUserId, parsed.status);
                return { ok: true, result: `Response status ${parsed.status} confirmed on ${call.id}.`, changedCallId: call.id };
            }
            case "set_scene_status": {
                const parsed = sceneArgs.parse(args);
                const call = await service.setSceneStatusForUnit(discordUserId, parsed.scene_status, parsed.call_reference);
                if (call.status === "CLOSED")
                    return { ok: true, result: `${call.id} is Code 4 and closed. All attached units returned 10-8.`, changedCallId: call.id };
                return { ok: true, result: `${call.id} scene status confirmed as ${call.sceneStatus}.`, changedCallId: call.id };
            }
            case "request_resource": {
                const parsed = resourceArgs.parse(args);
                const call = await service.requestResourceForUnit(discordUserId, parsed.resource, parsed.call_reference);
                return { ok: true, result: `${parsed.resource} request recorded on ${call.id}; response is not yet confirmed.`, changedCallId: call.id };
            }
            case "add_call_note": {
                const parsed = noteArgs.parse(args);
                const call = await service.addCallNoteForUnit(discordUserId, parsed.note, parsed.call_reference);
                return { ok: true, result: `Update recorded on ${call.id}.`, changedCallId: call.id };
            }
            case "request_additional_unit": {
                const parsed = countArgs.parse(args ?? {});
                const assigned = await service.assignAdditionalUnits(discordUserId, parsed.count, false);
                return { ok: assigned.length > 0, result: assigned.length ? `Additional units assigned: ${assigned.join(", ")}.` : "No additional registered units are available." };
            }
            case "request_supervisor": {
                const assigned = await service.assignAdditionalUnits(discordUserId, 1, true);
                return { ok: assigned.length > 0, result: assigned.length ? `Supervisor assigned: ${assigned[0]}.` : "No registered supervisor is available." };
            }
            case "close_call": {
                const parsed = callRefArgs.parse(args ?? {});
                const call = await service.closeCallForUnit(discordUserId, parsed.call_reference);
                return { ok: true, result: `${call.id} closed. Assigned units returned 10-8.`, changedCallId: call.id };
            }
            case "request_clarification": {
                const parsed = clarificationArgs.parse(args);
                return { ok: false, result: `Clarification required: ${parsed.reason}.` };
            }
            default:
                return { ok: false, result: "Unknown action rejected. Ask the unit to repeat in plain language." };
        }
    }
    catch (error) {
        return { ok: false, result: error instanceof Error ? error.message : "Action rejected." };
    }
}
