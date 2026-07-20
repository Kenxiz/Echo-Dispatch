import path from "node:path";
import { JsonDatabase } from "./json-database.js";
import { DATASET_CATALOG, DATASET_NAMES } from "./catalog.js";
import { AuditJournal } from "./audit-journal.js";
import { PersistenceCoordinator } from "./persistence-coordinator.js";
import { inspectDatabaseIntegrity } from "./integrity.js";
import { logger as rootLogger } from "../infrastructure/logger.js";
export class DataStore {
  units;
  calls;
  settings;
  transmissions;
  bolos;
  warrants;
  constructor(dataDir, options = {}) {
    this.dataDir = dataDir;
    this.logger = options.logger ?? rootLogger.child("database");
    this.journal = new AuditJournal(dataDir);
    this.coordinator = new PersistenceCoordinator(dataDir, this.journal, this.logger);
    for (const name of DATASET_NAMES) {
      const definition = DATASET_CATALOG[name];
      this[name] = new JsonDatabase(
        path.join(dataDir, definition.fileName),
        definition.schema,
        definition.defaultValue,
        options.backupCount ?? 3,
        {
          name,
          onRecovery: (event) => this.journal.record("dataset_recovered", event),
        },
      );
    }
  }
  async init() {
    const preparation = await this.coordinator.prepare();
    await Promise.all(DATASET_NAMES.map((name) => this[name].init()));
    this.startupReport = await this.coordinator.finalize(this, preparation);
    return this.startupReport;
  }

  repositories() {
    return Object.fromEntries(DATASET_NAMES.map((name) => [name, this[name]]));
  }
  audit() {
    const data = Object.fromEntries(DATASET_NAMES.map((name) => [name, this[name].get()]));
    return inspectDatabaseIntegrity(data);
  }
  createBackup(reason = "manual") {
    return this.coordinator.createSnapshot(reason.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80));
  }
  restoreBackup(snapshotPath) {
    return this.coordinator.restoreSnapshot(snapshotPath);
  }
}
