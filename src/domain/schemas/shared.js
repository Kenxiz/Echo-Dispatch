import { z } from "zod";
import { PLATE_TYPES, RESOURCE_STATUSES, RESOURCE_TYPES, RESPONSE_MODES } from "../constants.js";

export const boundedString = (maximum) =>
  z.string().transform((value) => (value.length > maximum ? value.slice(0, maximum) : value));

export const plateSchema = z.object({
  plateType: z.enum(PLATE_TYPES),
  jurisdiction: z.string().max(80).nullable().default(null),
  rawTranscript: z.string().max(1000),
  normalizedPattern: z.string().max(30),
  knownCharacters: z.string().max(20),
  unknownCharacterCount: z.number().int().nonnegative().nullable().default(null),
  confidence: z.number().min(0).max(1),
  parsingWarnings: z.array(z.string().max(160)).default([]),
});

export const resourceRequestSchema = z.object({
  id: z.string(),
  resourceType: z.enum(RESOURCE_TYPES),
  quantity: z.number().int().min(1).max(20).default(1),
  purpose: z.string().min(1).max(100).default("GENERAL_ASSISTANCE"),
  responseMode: z.enum(RESPONSE_MODES).default("CODE_2"),
  status: z.enum(RESOURCE_STATUSES).default("REQUESTED"),
  requestedBy: z.string().max(30),
  disposition: z.enum(["RESPOND", "STAGE"]).default("RESPOND"),
  requestedAt: z.string().datetime(),
  assignedUnits: z.array(z.string().max(30)).default([]),
  etaSeconds: z.number().int().nonnegative().nullable().default(null),
  cancelledAt: z.string().datetime().nullable().default(null),
  cancellationReason: z.string().max(250).nullable().default(null),
});

export const vehicleObservationSchema = z.object({
  rawTranscript: z.string().max(1000),
  colors: z.array(z.string().max(50)).default([]),
  make: z.string().max(80).nullable().default(null),
  model: z.string().max(80).nullable().default(null),
  vehicleType: z.string().max(80).nullable().default(null),
  damage: z.string().max(250).nullable().default(null),
  occupantCount: z.number().int().nonnegative().nullable().default(null),
  directionOfTravel: z.string().max(100).nullable().default(null),
  location: z.string().max(250).nullable().default(null),
  plate: plateSchema.nullable().default(null),
});

export const boloMatchSchema = z.object({
  boloId: z.string(),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string().max(120)).default([]),
  matchedAt: z.string().datetime(),
  reportedBy: z.string().max(30),
  score: z.number().min(0).max(1).optional(),
  matchedFields: z.array(z.string().max(120)).default([]),
  conflictingFields: z.array(z.string().max(120)).default([]),
  plateMatchType: z.enum(["EXACT", "PARTIAL_PREFIX", "PARTIAL_SUFFIX", "WILDCARD", "POSSIBLE", "NONE"]).default("NONE"),
  threatLevel: z.string().max(80).default("UNKNOWN"),
});

export const timelineEntrySchema = z.object({
  timestamp: z.string().datetime(),
  type: z.string().min(1).max(50),
  actor: z.string().max(80).nullable().default(null),
  text: z.string().min(1).max(500),
});
