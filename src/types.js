// Compatibility facade. Domain constants and schemas live in focused modules;
// existing integrations may continue importing from this path.
export * from "./domain/constants.js";
export * from "./domain/schemas/shared.js";
export * from "./domain/schemas/unit.js";
export * from "./domain/schemas/call.js";
export * from "./domain/schemas/transmission.js";
export * from "./domain/schemas/records.js";
export * from "./domain/schemas/settings.js";
