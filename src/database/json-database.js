import { mkdir, readFile, readdir, rename, copyFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
export class JsonDatabase {
    filePath;
    schema;
    defaultValue;
    backupCount;
    value;
    queue = Promise.resolve();
    constructor(filePath, schema, defaultValue, backupCount = 3) {
        this.filePath = filePath;
        this.schema = schema;
        this.defaultValue = defaultValue;
        this.backupCount = backupCount;
    }
    async init() {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        const loaded = await this.readValid(this.filePath) ?? await this.readNewestBackup();
        this.value = structuredClone(loaded ?? this.defaultValue);
        await this.persist(this.value);
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
            }
            catch (error) {
                failure = error;
            }
        });
        await this.queue;
        if (failure)
            throw failure;
        return result;
    }
    async readValid(target) {
        try {
            return this.schema.parse(JSON.parse(await readFile(target, "utf8")));
        }
        catch {
            return null;
        }
    }
    async readNewestBackup() {
        try {
            const directory = path.dirname(this.filePath);
            const prefix = `${path.basename(this.filePath)}.bak-`;
            const files = (await readdir(directory)).filter((name) => name.startsWith(prefix)).sort().reverse();
            for (const file of files) {
                const valid = await this.readValid(path.join(directory, file));
                if (valid)
                    return valid;
            }
        }
        catch {
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
        }
        catch {
            // No current file exists on first run.
        }
        await rename(tempPath, this.filePath);
        await this.trimBackups();
    }
    async trimBackups() {
        const directory = path.dirname(this.filePath);
        const prefix = `${path.basename(this.filePath)}.bak-`;
        const files = (await readdir(directory)).filter((name) => name.startsWith(prefix)).sort().reverse();
        await Promise.all(files.slice(this.backupCount).map((name) => unlink(path.join(directory, name)).catch(() => undefined)));
    }
}
