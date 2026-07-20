import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export class AuditJournal {
  constructor(dataDir, fileName = "database-audit.jsonl") {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, fileName);
    this.queue = Promise.resolve();
  }

  async record(event, detail = {}) {
    const entry = `${JSON.stringify({ timestamp: new Date().toISOString(), event, ...detail })}\n`;
    this.queue = this.queue.then(async () => {
      await mkdir(this.dataDir, { recursive: true });
      await appendFile(this.filePath, entry, "utf8");
    });
    return this.queue;
  }
}
