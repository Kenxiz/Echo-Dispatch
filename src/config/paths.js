import path from "node:path";

export function resolveProjectPaths(rootDir) {
  return {
    rootDir,
    configPath: path.join(rootDir, "config.json"),
    dataDir: path.join(rootDir, "data"),
    radioCodesPath: path.join(rootDir, "config", "radio-codes.json"),
    signalsPath: path.join(rootDir, "config", "signals.json"),
    responseCodesPath: path.join(rootDir, "config", "response-codes.json"),
    callsignDesignatorsPath: path.join(rootDir, "config", "callsign-designators.json"),
    phoneticAlphabetPath: path.join(rootDir, "config", "phonetic-alphabet.json"),
  };
}
