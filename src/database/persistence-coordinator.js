import { copyFile, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DATASET_CATALOG, DATASET_NAMES, DATABASE_SCHEMA_VERSION } from "./catalog.js";
import { databaseMetadataSchema, defaultDatabaseMetadata } from "./metadata.js";
import { inspectDatabaseIntegrity, repairDatabaseIntegrity } from "./integrity.js";
import { migrateDatabase } from "./migrations.js";

export class PersistenceCoordinator {
  constructor(dataDir, journal, logger) {
    this.dataDir = dataDir;
    this.journal = journal;
    this.logger = logger;
    this.metadataPath = path.join(dataDir, "database-meta.json");
  }

  async prepare() {
    await mkdir(this.dataDir, { recursive: true });
    await this.preserveStaleTemporaryFiles();
    const metadata = await this.readMetadata();
    let snapshotPath = null;
    if (metadata.schemaVersion !== DATABASE_SCHEMA_VERSION) {
      snapshotPath = await this.createSnapshot(`schema-v${metadata.schemaVersion}-to-v${DATABASE_SCHEMA_VERSION}`);
      await this.journal.record("migration_started", {
        fromVersion: metadata.schemaVersion,
        toVersion: DATABASE_SCHEMA_VERSION,
        snapshotPath,
      });
    }
    return { metadata, snapshotPath };
  }

  async finalize(repositories, preparation) {
    const loaded = Object.fromEntries(DATASET_NAMES.map((name) => [name, repositories[name].get()]));
    let nextData = loaded;
    let migrationSummary = [];
    if (preparation.metadata.schemaVersion !== DATABASE_SCHEMA_VERSION) {
      const migrated = migrateDatabase(loaded, preparation.metadata.schemaVersion);
      nextData = migrated.data;
      migrationSummary = migrated.summary;
    } else {
      const repaired = repairDatabaseIntegrity(loaded);
      nextData = repaired.data;
      migrationSummary = repaired.changes;
      if (migrationSummary.length) preparation.snapshotPath = await this.createSnapshot("integrity-repair");
    }

    await this.applyChangedDatasets(repositories, loaded, nextData);
    const issues = inspectDatabaseIntegrity(nextData);
    const now = new Date().toISOString();
    const metadata = {
      ...preparation.metadata,
      schemaVersion: DATABASE_SCHEMA_VERSION,
      updatedAt: now,
      lastSuccessfulStartupAt: now,
      lastIntegrityReport: { checkedAt: now, repaired: migrationSummary.length, issues },
      migrations:
        preparation.metadata.schemaVersion === DATABASE_SCHEMA_VERSION
          ? preparation.metadata.migrations
          : [
              ...preparation.metadata.migrations,
              {
                fromVersion: preparation.metadata.schemaVersion,
                toVersion: DATABASE_SCHEMA_VERSION,
                appliedAt: now,
                snapshotPath: preparation.snapshotPath,
                summary: migrationSummary.slice(0, 500),
              },
            ],
    };
    await this.writeMetadata(metadata);
    await this.journal.record("database_ready", {
      schemaVersion: DATABASE_SCHEMA_VERSION,
      repairs: migrationSummary,
      remainingIssues: issues,
    });
    if (issues.length) this.logger.warn("Database integrity audit completed with unresolved issues.", { issues });
    else
      this.logger.info("Database integrity audit passed.", {
        schemaVersion: DATABASE_SCHEMA_VERSION,
        repairs: migrationSummary.length,
      });
    return { metadata, repairs: migrationSummary, issues, snapshotPath: preparation.snapshotPath };
  }

  async createSnapshot(reason) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const snapshotPath = path.join(this.dataDir, "backups", `${stamp}-${reason}`);
    await mkdir(snapshotPath, { recursive: true });
    for (const fileName of [...DATASET_NAMES.map((name) => DATASET_CATALOG[name].fileName), "database-meta.json"]) {
      await copyFile(path.join(this.dataDir, fileName), path.join(snapshotPath, fileName)).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    }
    await writeFile(
      path.join(snapshotPath, "snapshot.json"),
      `${JSON.stringify({ createdAt: new Date().toISOString(), reason, schemaVersion: DATABASE_SCHEMA_VERSION }, null, 2)}\n`,
      "utf8",
    );
    return snapshotPath;
  }

  async restoreSnapshot(snapshotPath) {
    const backupRoot = path.resolve(this.dataDir, "backups");
    const resolved = path.resolve(snapshotPath);
    if (!(resolved === backupRoot || resolved.startsWith(`${backupRoot}${path.sep}`)))
      throw new Error("Recovery snapshot must be inside the configured data backups directory.");
    if (!(await stat(path.join(resolved, "snapshot.json")).catch(() => null)))
      throw new Error("Recovery snapshot is missing snapshot metadata.");
    const safetySnapshot = await this.createSnapshot("before-restore");
    for (const fileName of [...DATASET_NAMES.map((name) => DATASET_CATALOG[name].fileName), "database-meta.json"]) {
      const source = path.join(resolved, fileName);
      const destination = path.join(this.dataDir, fileName);
      await copyFile(source, destination).catch(async (error) => {
        if (error?.code !== "ENOENT") throw error;
        await unlink(destination).catch((unlinkError) => {
          if (unlinkError?.code !== "ENOENT") throw unlinkError;
        });
      });
    }
    await this.journal.record("snapshot_restored", { snapshotPath: resolved, safetySnapshot });
    return { snapshotPath: resolved, safetySnapshot };
  }

  async readMetadata() {
    try {
      return databaseMetadataSchema.parse(JSON.parse(await readFile(this.metadataPath, "utf8")));
    } catch {
      return defaultDatabaseMetadata();
    }
  }

  async writeMetadata(metadata) {
    const validated = databaseMetadataSchema.parse(metadata);
    const tempPath = `${this.metadataPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, this.metadataPath);
  }

  async applyChangedDatasets(repositories, previous, next) {
    for (const name of DATASET_NAMES) {
      if (JSON.stringify(previous[name]) === JSON.stringify(next[name])) continue;
      await repositories[name].update(() => next[name]);
    }
  }

  async preserveStaleTemporaryFiles() {
    const names = await readdir(this.dataDir).catch(() => []);
    const stale = names.filter((name) => name.endsWith(".tmp"));
    if (!stale.length) return;
    const recoveryDir = path.join(this.dataDir, "recovery", "stale-temporary-files");
    await mkdir(recoveryDir, { recursive: true });
    for (const name of stale) {
      const target = path.join(recoveryDir, `${Date.now()}-${name}`);
      await rename(path.join(this.dataDir, name), target);
      await this.journal.record("stale_temporary_file_preserved", { fileName: name, recoveryPath: target });
    }
  }
}
