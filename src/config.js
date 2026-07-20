import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configSchema } from "./config/schema.js";
import { resolveProjectPaths } from "./config/paths.js";

const defaultRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadConfig(rootDir = defaultRootDir) {
  const paths = resolveProjectPaths(rootDir);
  let raw;
  try {
    raw = JSON.parse(readFileSync(paths.configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Unable to read ${paths.configPath}. Copy config.example.json to config.json and fill in the credentials. ${error instanceof Error ? error.message : ""}`.trim(),
    );
  }
  return { ...parseConfig(raw), ...paths };
}

export function parseConfig(raw) {
  const parsed = configSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const invalid = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`Invalid config.json: ${invalid}`);
}
