import { access, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DataStore } from "../src/database/store.js";
describe("JSON persistence", () => {
  it("serializes concurrent updates without losing changes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "echo-dispatch-db-"));
    const store = new DataStore(directory);
    await store.init();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.settings.update((settings) => {
          settings.nextCallNumber += 1;
        }),
      ),
    );
    expect(store.settings.get().nextCallNumber).toBe(21);
  });
  it("recovers the newest valid backup when the primary file is corrupt", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "echo-dispatch-recovery-"));
    const store = new DataStore(directory);
    await store.init();
    await store.settings.update((settings) => {
      settings.nextCallNumber = 42;
    });
    await store.settings.update((settings) => {
      settings.nextCallNumber = 43;
    });
    await writeFile(path.join(directory, "settings.json"), "not-json", "utf8");
    const recovered = new DataStore(directory);
    await recovered.init();
    expect(recovered.settings.get().nextCallNumber).toBe(42);
  });
  it("versions legacy data, creates a reversible snapshot, and records the migration", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "echo-dispatch-migration-"));
    const legacyUnit = { discordUserId: "1", callsign: "1L-18", rank: "Officer", division: "Patrol" };
    await writeFile(path.join(directory, "units.json"), JSON.stringify([legacyUnit]), "utf8");
    const store = new DataStore(directory);
    const report = await store.init();
    expect(report.metadata.schemaVersion).toBe(1);
    expect(store.units.get()[0]).toMatchObject(legacyUnit);
    expect(report.snapshotPath).toBeTruthy();
    await expect(access(path.join(report.snapshotPath, "units.json"))).resolves.toBeUndefined();
    const journal = await readFile(path.join(directory, "database-audit.jsonl"), "utf8");
    expect(journal).toContain("migration_started");
    expect(journal).toContain("database_ready");
  });
  it("repairs deterministic orphan relationships while preserving their history in a snapshot", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "echo-dispatch-integrity-"));
    const store = new DataStore(directory);
    await store.init();
    await store.units.update((units) => {
      units.push({
        discordUserId: "1",
        callsign: "1L-18",
        rank: "Officer",
        division: "Patrol",
        assignedCallId: "MISSING",
        responseStatus: "ON_SCENE",
      });
    });
    const restarted = new DataStore(directory);
    const report = await restarted.init();
    expect(restarted.units.get()[0]).toMatchObject({
      assignedCallId: null,
      responseStatus: "UNASSIGNED",
      lastActiveCallId: "MISSING",
    });
    expect(report.repairs).toContain("Cleared missing call MISSING from unit 1L-18.");
    expect(report.snapshotPath).toBeTruthy();
  });
  it("archives every superseded duplicate before consolidating its active record", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "echo-dispatch-duplicates-"));
    const store = new DataStore(directory);
    await store.init();
    await store.units.update((units) => {
      units.push({ discordUserId: "1", callsign: "1L-18", rank: "Officer", division: "Patrol", active: false });
      units.push({ discordUserId: "1", callsign: "1L-18", rank: "Sergeant", division: "Patrol", active: true });
    });
    const restarted = new DataStore(directory);
    await restarted.init();
    expect(restarted.units.get()).toHaveLength(1);
    expect(restarted.units.get()[0]).toMatchObject({ rank: "Sergeant", active: true });
    expect(restarted.archives.get()).toHaveLength(1);
    expect(restarted.archives.get()[0]).toMatchObject({ dataset: "units", record: { rank: "Officer", active: false } });
  });
  it("restores an in-root snapshot and creates a pre-restore safety snapshot", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "echo-dispatch-restore-"));
    const store = new DataStore(directory);
    await store.init();
    await store.settings.update((settings) => {
      settings.nextCallNumber = 41;
    });
    const snapshot = await store.createBackup("restore-test");
    await unlink(path.join(snapshot, "archives.json"));
    await store.settings.update((settings) => {
      settings.nextCallNumber = 99;
    });
    await store.archives.update((archives) => {
      archives.push({
        id: "temporary",
        dataset: "units",
        identity: "1",
        reason: "Test record",
        archivedAt: new Date().toISOString(),
        record: { callsign: "1L-18" },
      });
    });
    const result = await store.restoreBackup(snapshot);
    expect(result.safetySnapshot).toContain("before-restore");
    const restarted = new DataStore(directory);
    await restarted.init();
    expect(restarted.settings.get().nextCallNumber).toBe(41);
    expect(restarted.archives.get()).toEqual([]);
  });
  it("refuses recovery snapshots outside the configured backup root", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "echo-dispatch-restore-boundary-"));
    const store = new DataStore(directory);
    await store.init();
    await expect(store.restoreBackup(directory)).rejects.toThrow(/inside the configured data backups directory/i);
  });
});
