import { z } from "zod";
import { CALL_STATUSES, RESOURCE_TYPES, RESPONSE_MODES, SCENE_ROLES, SCENE_STATUSES } from "../constants.js";
import {
  boloMatchSchema,
  plateSchema,
  resourceRequestSchema,
  timelineEntrySchema,
  vehicleObservationSchema,
} from "./shared.js";

export const callSchema = z.object({
  id: z.string(),
  source: z.enum(["DISCORD_911", "ERLC_EMERGENCY", "OFFICER_INITIATED"]),
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
  stopType: z.enum(["ROUTINE_STOP", "FELONY_STOP", "INVESTIGATIVE_STOP"]).nullable().default(null),
  riskLevel: z.enum(["NORMAL", "ELEVATED", "HIGH", "CRITICAL"]).default("NORMAL"),
  backupStatus: z.enum(["NOT_NEEDED", "RECOMMENDED", "REQUESTED", "ASSIGNED", "ON_SCENE"]).default("NOT_NEEDED"),
  assignedUnits: z.array(z.string()).default([]),
  requestedResources: z.array(z.enum(RESOURCE_TYPES)).default([]),
  resourceRequests: z.array(resourceRequestSchema).default([]),
  stagedResources: z.array(z.enum(RESOURCE_TYPES)).default([]),
  operationalPlan: z.array(z.string().max(160)).default([]),
  supervisorRecommendations: z.array(z.string().max(200)).default([]),
  relatedCallIds: z.array(z.string()).default([]),
  boloIds: z.array(z.string()).default([]),
  boloRelated: z.boolean().default(false),
  officerSafetyLevel: z.enum(["NORMAL", "ELEVATED", "HIGH", "CRITICAL"]).default("NORMAL"),
  backupRecommended: z.boolean().default(false),
  boloMatches: z.array(boloMatchSchema).default([]),
  observedPlates: z
    .array(z.object({ plate: plateSchema, reportedBy: z.string().max(30), reportedAt: z.string().datetime() }))
    .default([]),
  vehicleObservations: z
    .array(
      z.object({
        observation: vehicleObservationSchema,
        reportedBy: z.string().max(30),
        reportedAt: z.string().datetime(),
      }),
    )
    .default([]),
  warrantIds: z.array(z.string()).default([]),
  pursuit: z
    .object({
      active: z.boolean(),
      type: z.enum(["VEHICLE", "FOOT"]).default("VEHICLE"),
      primaryUnit: z.string().max(30).nullable().default(null),
      secondaryUnit: z.string().max(30).nullable().default(null),
      supervisorUnit: z.string().max(30).nullable().default(null),
      vehicle: z.string().max(250).nullable(),
      plate: plateSchema.nullable().default(null),
      occupants: z.number().int().nonnegative().nullable().default(null),
      speed: z.number().nonnegative().nullable().default(null),
      direction: z.string().max(120).nullable(),
      road: z.string().max(200).nullable().default(null),
      postal: z.string().max(20).nullable().default(null),
      lastLocation: z.string().max(250).nullable(),
      trafficConditions: z.string().max(200).nullable().default(null),
      weather: z.string().max(200).nullable().default(null),
      reason: z.string().max(250).nullable().default(null),
      weapons: z.string().max(250).nullable().default(null),
      pitStatus: z.enum(["NONE", "REQUESTED", "AUTHORIZED", "DENIED"]).default("NONE"),
      spikeStripsRequested: z.boolean().default(false),
      bailout: z.boolean().default(false),
      startedAt: z.string().datetime(),
      endedAt: z.string().datetime().nullable(),
    })
    .nullable()
    .default(null),
  unitRoles: z.record(z.string(), z.enum(SCENE_ROLES)).default({}),
  recommendedUnits: z
    .array(
      z.object({
        callsign: z.string(),
        etaSeconds: z.number().int().nonnegative().nullable().default(null),
        reason: z.string().max(160),
      }),
    )
    .default([]),
  callerCount: z.number().int().positive().default(1),
  sourceExternalIds: z.array(z.string()).default([]),
  timeline: z.array(timelineEntrySchema).default([]),
  lastActivityAt: z.string().datetime().optional(),
  watchdogLevel: z.number().int().min(0).max(3).default(0),
  notes: z
    .array(z.object({ timestamp: z.string().datetime(), callsign: z.string(), text: z.string().min(1).max(500) }))
    .default([]),
  createdAt: z.string().datetime(),
  closedAt: z.string().datetime().nullable().default(null),
  messageId: z.string().nullable().default(null),
  logMessageId: z.string().nullable().default(null),
  reannounced: z.boolean().default(false),
});
