import { z } from "zod";

export const settingsSchema = z.object({
  nextCallNumber: z.number().int().positive().default(1),
  dispatchRunning: z.boolean().default(false),
  seenErlcEmergencyIds: z.array(z.string()).default([]),
  lastJoinLogTimestamp: z.number().nonnegative().default(0),
  lastErlcAuthWarningAt: z.string().datetime().nullable().default(null),
  controlledMuteUserIds: z.array(z.string()).default([]),
  callNumberYear: z.number().int().min(0).max(99).optional(),
  shiftStartedAt: z.string().datetime().nullable().default(null),
  hotMicMutes: z.array(z.object({ userId: z.string(), expiresAt: z.string().datetime() })).default([]),
  hotMicWarnings: z.record(z.string(), z.array(z.string().datetime())).default({}),
  nextBoloNumber: z.number().int().positive().default(1),
  nextWarrantNumber: z.number().int().positive().default(1),
  mostRecentCreatedCallId: z.string().nullable().default(null),
  mostRecentAnnouncedCallId: z.string().nullable().default(null),
  mostRecentActiveCallId: z.string().nullable().default(null),
  activeUnitsMessageId: z.string().nullable().default(null),
});

export const DEFAULT_SETTINGS = Object.freeze({
  nextCallNumber: 1,
  dispatchRunning: false,
  seenErlcEmergencyIds: [],
  lastJoinLogTimestamp: 0,
  lastErlcAuthWarningAt: null,
  controlledMuteUserIds: [],
  callNumberYear: undefined,
  shiftStartedAt: null,
  hotMicMutes: [],
  hotMicWarnings: {},
  nextBoloNumber: 1,
  nextWarrantNumber: 1,
  mostRecentCreatedCallId: null,
  mostRecentAnnouncedCallId: null,
  mostRecentActiveCallId: null,
  activeUnitsMessageId: null,
});
