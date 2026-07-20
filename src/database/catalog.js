import { z } from "zod";
import {
  archivedRecordSchema,
  boloSchema,
  callSchema,
  settingsSchema,
  transmissionSchema,
  unitSchema,
  warrantSchema,
} from "../types.js";
import { DEFAULT_SETTINGS } from "../domain/schemas/settings.js";

export const DATABASE_SCHEMA_VERSION = 1;

export const DATASET_CATALOG = Object.freeze({
  units: { fileName: "units.json", schema: z.array(unitSchema), defaultValue: [] },
  calls: { fileName: "calls.json", schema: z.array(callSchema), defaultValue: [] },
  settings: { fileName: "settings.json", schema: settingsSchema, defaultValue: DEFAULT_SETTINGS },
  transmissions: { fileName: "transmissions.json", schema: z.array(transmissionSchema), defaultValue: [] },
  bolos: { fileName: "bolos.json", schema: z.array(boloSchema), defaultValue: [] },
  warrants: { fileName: "warrants.json", schema: z.array(warrantSchema), defaultValue: [] },
  archives: { fileName: "archives.json", schema: z.array(archivedRecordSchema), defaultValue: [] },
});

export const DATASET_NAMES = Object.freeze(Object.keys(DATASET_CATALOG));
