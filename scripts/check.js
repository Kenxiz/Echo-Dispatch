import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const roots = ["src", "tests", "scripts"];
const files = roots.flatMap(collectJavaScript).concat("vitest.config.js");

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`Syntax checked ${files.length} JavaScript files.`);

function collectJavaScript(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectJavaScript(target);
    return entry.isFile() && entry.name.endsWith(".js") ? [target] : [];
  });
}
