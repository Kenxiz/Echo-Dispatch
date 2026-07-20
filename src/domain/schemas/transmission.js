import { z } from "zod";
import {
  boloMatchSchema,
  boundedString,
  plateSchema,
  resourceRequestSchema,
  vehicleObservationSchema,
} from "./shared.js";

export const transmissionSchema = z.object({
  id: z.string(),
  timestamp: z.string().datetime(),
  discordUserId: z.string().nullable(),
  callsign: z.string().nullable(),
  transcript: z.string(),
  dispatcherTranscript: z.string(),
  overlap: z.boolean().default(false),
  rawAudioDurationMs: z.number().nonnegative().default(0),
  detectedLanguage: z.string().max(30).nullable().default(null),
  languageConfidence: z.number().min(0).max(1).nullable().default(null),
  alternativeTranscripts: z.array(boundedString(1000)).default([]),
  actions: z.array(z.string()).default([]),
  facts: z.array(boundedString(160)).default([]),
  confidence: z.number().min(0).max(1).default(1),
  confidenceDisposition: z.enum(["EXECUTE", "STANDBY", "CLARIFY", "REPEAT", "IGNORED"]).default("EXECUTE"),
  radioClassification: z
    .enum([
      "VALID_RADIO_TRAFFIC",
      "UNCLEAR_RADIO_TRAFFIC",
      "BRIEF_ACCIDENTAL_NOISE",
      "CONFIRMED_HOT_MIC",
      "CROSS_TRANSMISSION",
      "EMERGENCY_INTERRUPTION",
    ])
    .default("VALID_RADIO_TRAFFIC"),
  classificationConfidence: z.number().min(0).max(1).default(1),
  classificationReason: boundedString(500).default("Legacy transmission."),
  containsDispatchInformation: z.boolean().default(true),
  hotMicDecision: z
    .object({
      previousWarningCount: z.number().int().nonnegative(),
      updatedWarningCount: z.number().int().nonnegative(),
      action: z.enum(["NONE", "WARNING", "MUTE", "REDUCED", "EXPIRED"]),
    })
    .default({ previousWarningCount: 0, updatedWarningCount: 0, action: "NONE" }),
  speakerIdentity: z.string().nullable().default(null),
  normalizedTranscript: z.string().default(""),
  correctionsApplied: z
    .array(
      z.object({
        field: z.string().max(50),
        from: boundedString(160),
        to: boundedString(160),
        confidence: z.number().min(0).max(1),
        reason: boundedString(300),
      }),
    )
    .default([]),
  codesDetected: z.array(z.string().max(30)).default([]),
  codeDefinitionsUsed: z
    .array(
      z.object({
        code: z.string().max(30),
        meaning: z.string().max(200),
        category: z.string().max(50),
        action: z.string().max(100).nullable(),
      }),
    )
    .default([]),
  emergencyPhrases: z.array(z.string().max(100)).default([]),
  negationScopes: z.array(boundedString(250)).default([]),
  parsedIntent: boundedString(2000).default("{}"),
  existingCallCandidates: z
    .array(z.object({ callId: z.string(), score: z.number().min(0).max(1), reason: boundedString(250) }))
    .default([]),
  activeCallId: z.string().nullable().default(null),
  orderedActions: z.array(z.string()).default([]),
  actionResults: z
    .array(
      z.object({
        action: boundedString(100),
        ok: z.boolean(),
        disposition: z
          .enum([
            "EXECUTED",
            "REJECTED_VALIDATION",
            "FAILED_EXECUTION",
            "DEFERRED",
            "CANCELLED_BY_NEGATION",
            "SUPERSEDED",
          ])
          .default("EXECUTED"),
        detail: boundedString(500),
      }),
    )
    .default([]),
  validationResults: z
    .array(z.object({ action: boundedString(100), valid: z.boolean(), detail: boundedString(500) }))
    .default([]),
  interpretationDisposition: z.enum(["ACTIONABLE", "PARTIAL", "UNRELATED", "UNCLEAR"]).default("ACTIONABLE"),
  executionDisposition: z.enum(["EXECUTED", "PARTIAL", "FAILED", "NO_ACTION"]).default("NO_ACTION"),
  replyDisposition: z.enum(["REPLIED", "SUPPRESSED_POLICY", "SILENT_UNRELATED", "SYNTHESIS_FAILED"]).default("REPLIED"),
  requestedResourceDetails: z.array(resourceRequestSchema).default([]),
  boloChanges: z.array(boundedString(500)).default([]),
  warrantChanges: z.array(boundedString(500)).default([]),
  failedActions: z.array(z.object({ action: boundedString(100), reason: boundedString(500) })).default([]),
  observedPlate: plateSchema.nullable().default(null),
  vehicleObservation: vehicleObservationSchema.nullable().default(null),
  boloMatches: z.array(boloMatchSchema).default([]),
});
