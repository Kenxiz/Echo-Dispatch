import { mkdir, readFile, readdir, rename, copyFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
export class JsonDatabase {
  filePath;
  schema;
  defaultValue;
  backupCount;
  value;
  queue = Promise.resolve();
  constructor(filePath, schema, defaultValue, backupCount = 3, options = {}) {
    this.filePath = filePath;
    this.schema = schema;
    this.defaultValue = defaultValue;
    this.backupCount = backupCount;
    this.name = options.name ?? path.basename(filePath, ".json");
    this.onRecovery = options.onRecovery ?? (() => undefined);
  }
  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const primary = await this.readValid(this.filePath);
    const backup = primary === null ? await this.readNewestBackup() : null;
    const loaded = primary?.value ?? backup?.value;
    const source = primary !== null ? "primary" : backup ? "backup" : "default";
    this.value = structuredClone(loaded ?? this.defaultValue);
    if (source !== "primary" || !primary.canonical) await this.persist(this.value);
    if (source !== "primary")
      await this.onRecovery({ dataset: this.name, source, backupPath: backup?.filePath ?? null });
    return { source, backupPath: backup?.filePath ?? null };
  }
  get() {
    return structuredClone(this.value);
  }
  async update(mutator) {
    let result;
    let failure;
    this.queue = this.queue.then(async () => {
      try {
        const draft = structuredClone(this.value);
        const replacement = await mutator(draft);
        const validated = this.schema.parse(replacement === undefined ? draft : replacement);
        await this.persist(validated);
        this.value = validated;
        result = structuredClone(validated);
      } catch (error) {
        failure = error;
      }
    });
    await this.queue;
    if (failure) throw failure;
    return result;
  }
  async readValid(target) {
    try {
      const raw = JSON.parse(await readFile(target, "utf8"));
      const value = this.schema.parse(raw);
      return { value, canonical: JSON.stringify(raw) === JSON.stringify(value) };
    } catch {
      return null;
    }
  }
  async readNewestBackup() {
    try {
      const directory = path.dirname(this.filePath);
      const prefix = `${path.basename(this.filePath)}.bak-`;
      const files = (await readdir(directory))
        .filter((name) => name.startsWith(prefix))
        .sort()
        .reverse();
      for (const file of files) {
        const valid = await this.readValid(path.join(directory, file));
        if (valid) return { value: valid.value, filePath: path.join(directory, file) };
      }
    } catch {
      // The directory or backups may not exist on first run.
    }
    return null;
  }
  async persist(value) {
    const serialized = `${JSON.stringify(this.schema.parse(value), null, 2)}\n`;
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, serialized, { encoding: "utf8", flag: "wx" });
    try {
      await copyFile(this.filePath, `${this.filePath}.bak-${Date.now()}`);
    } catch {
      // No current file exists on first run.
    }
    await rename(tempPath, this.filePath);
    await this.trimBackups();
  }
  async trimBackups() {
    const directory = path.dirname(this.filePath);
    const prefix = `${path.basename(this.filePath)}.bak-`;
    const files = (await readdir(directory))
      .filter((name) => name.startsWith(prefix))
      .sort()
      .reverse();
    await Promise.all(
      files.slice(this.backupCount).map((name) => unlink(path.join(directory, name)).catch(() => undefined)),
    );
  }
}
