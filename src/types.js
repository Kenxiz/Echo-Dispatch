import { z } from "zod";
export const UNIT_STATUSES = [
    "AVAILABLE", "BUSY", "OUT_OF_SERVICE", "STANDBY", "ON_DUTY", "OFF_DUTY",
    "EN_ROUTE", "ON_SCENE", "ASSIGNMENT_COMPLETE", "TRAFFIC_STOP", "RADAR",
    "PURSUIT", "DETAINING", "DIRECTING_TRAFFIC", "ESCORT", "PRISONER_IN_CUSTODY",
    "TRANSPORTING", "AT_STATION", "MEAL_BREAK", "AT_HOSPITAL", "COURT",
    "VEHICLE_MAINTENANCE", "BUILDING_CHECK", "EMERGENCY",
];
export const RESPONSE_STATUSES = ["UNASSIGNED", "ATTACHED", "EN_ROUTE", "ON_SCENE", "HOLDING", "CLEARED", "CANCELLED"];
export const CALL_STATUSES = ["AWAITING_UNIT", "ACTIVE", "CODE_4", "CLOSED"];
export const SCENE_STATUSES = ["UNKNOWN", "UNSECURED", "ACTIVE", "STABILIZED", "SECURE"];
export const RESPONSE_MODES = ["CODE_1", "CODE_2", "CODE_3"];
export const RESOURCE_TYPES = ["EMS", "FIRE", "WRECKER", "SUPERVISOR", "ADDITIONAL_UNITS", "OTHER"];
export const unitSchema = z.object({
    discordUserId: z.string().min(1),
    callsign: z.string().min(2).max(20),
    rank: z.string().min(1).max(80),
    division: z.string().min(1).max(80),
    robloxUsername: z.string().max(30).nullable().default(null),
    status: z.enum(UNIT_STATUSES).default("AVAILABLE"),
    statusCode: z.string().nullable().default("10-8"),
    location: z.string().max(200).nullable().default(null),
    assignedCallId: z.string().nullable().default(null),
    responseStatus: z.enum(RESPONSE_STATUSES).default("UNASSIGNED"),
    responseMode: z.enum(RESPONSE_MODES).nullable().default(null),
    active: z.boolean().default(true),
});
export const callSchema = z.object({
    id: z.string(),
    source: z.enum(["DISCORD_911", "ERLC_EMERGENCY"]),
    sourceExternalId: z.string().nullable().default(null),
    incident: z.string().min(1).max(150),
    radioCode: z.string().nullable().default(null),
    location: z.string().min(1).max(250),
    description: z.string().min(1).max(1000),
    suspectInfo: z.string().max(500).nullable().default(null),
    vehicleInfo: z.string().max(500).nullable().default(null),
    weaponInfo: z.string().max(500).nullable().default(null),
    injuryInfo: z.string().max(500).nullable().default(null),
    priority: z.number().int().min(1).max(3),
    prioritySource: z.enum(["AI", "FALLBACK", "MANUAL"]).default("MANUAL"),
    priorityReason: z.string().max(200).nullable().default(null),
    status: z.enum(CALL_STATUSES).default("AWAITING_UNIT"),
    sceneStatus: z.enum(SCENE_STATUSES).default("UNKNOWN"),
    responseMode: z.enum(RESPONSE_MODES).default("CODE_2"),
    assignedUnits: z.array(z.string()).default([]),
    requestedResources: z.array(z.enum(RESOURCE_TYPES)).default([]),
    notes: z.array(z.object({ timestamp: z.string().datetime(), callsign: z.string(), text: z.string().min(1).max(500) })).default([]),
    createdAt: z.string().datetime(),
    closedAt: z.string().datetime().nullable().default(null),
    messageId: z.string().nullable().default(null),
    reannounced: z.boolean().default(false),
});
export const transmissionSchema = z.object({
    id: z.string(),
    timestamp: z.string().datetime(),
    discordUserId: z.string().nullable(),
    callsign: z.string().nullable(),
    transcript: z.string(),
    dispatcherTranscript: z.string(),
    overlap: z.boolean().default(false),
    actions: z.array(z.string()).default([]),
});
export const settingsSchema = z.object({
    nextCallNumber: z.number().int().positive().default(1),
    dispatchRunning: z.boolean().default(false),
    seenErlcEmergencyIds: z.array(z.string()).default([]),
    lastJoinLogTimestamp: z.number().nonnegative().default(0),
    lastErlcAuthWarningAt: z.string().datetime().nullable().default(null),
    controlledMuteUserIds: z.array(z.string()).default([]),
});
