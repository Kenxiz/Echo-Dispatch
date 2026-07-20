import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DataStore } from "../src/database/store.js";
describe("JSON persistence", () => {
  it("serializes concurrent updates without losing changes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "echo-dispatch-db-"));
    const store = new DataStore(directory);
    await store.init();
    await Promise.all(Array.from({ length: 20 }, () => store.settings.update((settings) => {
      settings.nextCallNumber += 1;
    })));
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
});
