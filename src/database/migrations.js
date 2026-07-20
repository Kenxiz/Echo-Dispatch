import { DATABASE_SCHEMA_VERSION } from "./catalog.js";
import { repairDatabaseIntegrity } from "./integrity.js";

const MIGRATIONS = new Map([
  [
    1,
    {
      description: "Canonicalize domain records and repair referential integrity.",
      apply(data) {
        return repairDatabaseIntegrity(data);
      },
    },
  ],
]);

export function migrateDatabase(data, fromVersion) {
  if (fromVersion > DATABASE_SCHEMA_VERSION)
    throw new Error(`Database schema ${fromVersion} is newer than supported schema ${DATABASE_SCHEMA_VERSION}.`);
  let current = structuredClone(data);
  const summary = [];
  for (let version = fromVersion + 1; version <= DATABASE_SCHEMA_VERSION; version += 1) {
    const migration = MIGRATIONS.get(version);
    if (!migration) throw new Error(`Missing database migration for schema version ${version}.`);
    const result = migration.apply(current);
    current = result.data;
    summary.push(`v${version}: ${migration.description}`, ...result.changes);
  }
  return { data: current, summary, toVersion: DATABASE_SCHEMA_VERSION };
}
