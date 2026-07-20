import { z } from "zod";

export const databaseMetadataSchema = z.object({
  schemaVersion: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastSuccessfulStartupAt: z.string().datetime().nullable().default(null),
  migrations: z
    .array(
      z.object({
        fromVersion: z.number().int().nonnegative(),
        toVersion: z.number().int().positive(),
        appliedAt: z.string().datetime(),
        snapshotPath: z.string().nullable(),
        summary: z.array(z.string()),
      }),
    )
    .default([]),
  lastIntegrityReport: z
    .object({
      checkedAt: z.string().datetime(),
      repaired: z.number().int().nonnegative(),
      issues: z.array(z.string()),
    })
    .nullable()
    .default(null),
});

export function defaultDatabaseMetadata() {
  const now = new Date().toISOString();
  return {
    schemaVersion: 0,
    createdAt: now,
    updatedAt: now,
    lastSuccessfulStartupAt: null,
    migrations: [],
    lastIntegrityReport: null,
  };
}
