import { z } from "zod";
import { RESPONSE_MODES, RESPONSE_STATUSES, SCENE_ROLES, UNIT_STATUSES } from "../constants.js";

export const unitSchema = z.object({
  discordUserId: z.string().min(1),
  callsign: z.string().min(2).max(20),
  rank: z.string().min(1).max(80),
  division: z.string().min(1).max(80),
  robloxUsername: z.string().max(30).nullable().default(null),
  status: z.enum(UNIT_STATUSES).default("AVAILABLE"),
  statusCode: z.string().nullable().default("10-8"),
  location: z.string().max(200).nullable().default(null),
  locationSource: z.enum(["MANUAL", "RADIO", "ERLC", "PANIC"]).nullable().default(null),
  locationUpdatedAt: z.string().datetime().nullable().default(null),
  postal: z.string().max(20).nullable().default(null),
  street: z.string().max(200).nullable().default(null),
  coordinates: z.tuple([z.number(), z.number(), z.number()]).nullable().default(null),
  previousLocation: z.string().max(200).nullable().default(null),
  heading: z.string().max(80).nullable().default(null),
  locationFresh: z.boolean().default(false),
  assignedCallId: z.string().nullable().default(null),
  lastActiveCallId: z.string().nullable().default(null),
  lastClosedCallId: z.string().nullable().default(null),
  responseStatus: z.enum(RESPONSE_STATUSES).default("UNASSIGNED"),
  responseMode: z.enum(RESPONSE_MODES).nullable().default(null),
  sceneRole: z.enum(SCENE_ROLES).nullable().default(null),
  lastRadioAt: z.string().datetime().nullable().default(null),
  lastStatusCheckAt: z.string().datetime().nullable().default(null),
  radioAliases: z.array(z.string().min(1).max(40)).default([]),
  activeRadioCodes: z
    .array(z.object({ code: z.string().max(30), meaning: z.string().max(200), updatedAt: z.string().datetime() }))
    .default([]),
  erlcPresent: z.boolean().default(false),
  erlcTeam: z.string().max(100).nullable().default(null),
  lastSeenErlcAt: z.string().datetime().nullable().default(null),
  erlcMissingPolls: z.number().int().nonnegative().default(0),
  active: z.boolean().default(true),
});
