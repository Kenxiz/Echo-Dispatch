import path from "node:path";
import { DataStore } from "../src/database/store.js";

const [command = "audit", suppliedDirectory] = process.argv.slice(2);
const dataDir = path.resolve(suppliedDirectory ?? "data");
const store = new DataStore(dataDir);

if (command === "restore") {
  const snapshotPath = process.argv[4];
  if (!snapshotPath) throw new Error("Usage: npm run db:restore -- <data-directory> <snapshot-directory>");
  const result = await store.restoreBackup(path.resolve(snapshotPath));
  console.log(`Restored ${result.snapshotPath}. Pre-restore safety snapshot: ${result.safetySnapshot}`);
  process.exit(0);
}

const report = await store.init();
if (command === "audit") {
  const issues = store.audit();
  console.log(
    issues.length ? issues.join("\n") : `Database schema v${report.metadata.schemaVersion}: integrity checks passed.`,
  );
} else if (command === "backup") {
  console.log(await store.createBackup("manual"));
} else {
  throw new Error(`Unknown database maintenance command: ${command}`);
}
