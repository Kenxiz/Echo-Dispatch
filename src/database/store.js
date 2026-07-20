import path from "node:path";
import { z } from "zod";
import { JsonDatabase } from "./json-database.js";
import { callSchema, settingsSchema, transmissionSchema, unitSchema } from "../types.js";
export class DataStore {
    units;
    calls;
    settings;
    transmissions;
    constructor(dataDir) {
        this.units = new JsonDatabase(path.join(dataDir, "units.json"), z.array(unitSchema), []);
        this.calls = new JsonDatabase(path.join(dataDir, "calls.json"), z.array(callSchema), []);
        this.settings = new JsonDatabase(path.join(dataDir, "settings.json"), settingsSchema, {
            nextCallNumber: 1,
            dispatchRunning: false,
            seenErlcEmergencyIds: [],
            lastJoinLogTimestamp: 0,
            lastErlcAuthWarningAt: null,
            controlledMuteUserIds: [],
        });
        this.transmissions = new JsonDatabase(path.join(dataDir, "transmissions.json"), z.array(transmissionSchema), []);
    }
    async init() {
        await Promise.all([
            this.units.init(), this.calls.init(), this.settings.init(), this.transmissions.init(),
        ]);
    }
}
