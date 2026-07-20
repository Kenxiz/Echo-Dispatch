import { readFile } from "node:fs/promises";
import { loadConfig } from "./config.js";
import { DataStore } from "./database/store.js";
import { UnitService } from "./dispatch/unit-service.js";
import { CallService } from "./dispatch/call-service.js";
import { DispatchService } from "./dispatch/dispatch-service.js";
import { createDiscordClient } from "./discord/client.js";
import { DispatchTextChannel } from "./discord/text-channel.js";
import { GeminiDispatcher } from "./ai/gemini.js";
import { VoiceManager } from "./voice/voice-manager.js";
import { ErlcClient } from "./erlc/client.js";
import { EmergencyCallAdapter } from "./erlc/emergency-call-adapter.js";
import { ErlcWebhookServer } from "./erlc/webhook-server.js";
import { EchoDispatchApp } from "./app.js";
import { createInteractionHandler } from "./discord/interactions.js";
const config = loadConfig();
const radioCodes = JSON.parse(await readFile(config.radioCodesPath, "utf8"));
const store = new DataStore(config.dataDir);
await store.init();
const client = createDiscordClient();
const units = new UnitService(store);
const calls = new CallService(store, units);
const text = new DispatchTextChannel(client, config, calls);
const dispatch = new DispatchService(store, units, calls, (call) => text.publishCall(call));
const gemini = new GeminiDispatcher(config, radioCodes);
const erlc = new ErlcClient(config);
const voice = new VoiceManager(client, config, gemini, dispatch, text, erlc);
let app;
const emergencyAdapter = new EmergencyCallAdapter(erlc, store, config.ERLC_POLL_INTERVAL_MS, (call) => app.createErlcCall(call).then(() => undefined), (log) => text.system(`ER:LC player ${log.Join ? "joined" : "left"}: ${log.Player}`), (error) => text.warning(error.message));
app = new EchoDispatchApp(config, store, calls, text, voice, gemini, erlc, emergencyAdapter);
const webhook = new ErlcWebhookServer(config.HTTP_PORT, emergencyAdapter, (error) => text.warning(`Webhook: ${error.message}`));
client.on("interactionCreate", createInteractionHandler(app, dispatch));
client.once("clientReady", async (readyClient) => {
    console.log(`Echo Dispatch logged in as ${readyClient.user.tag}.`);
    try {
        webhook.start();
        await app.restore();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Startup restoration failed.";
        console.error(message);
        await text.warning(message).catch(() => undefined);
    }
});
client.on("error", (error) => { console.error("Discord client error:", error); });
let shuttingDown = false;
async function shutdown() {
    if (shuttingDown)
        return;
    shuttingDown = true;
    emergencyAdapter.stop();
    webhook.stop();
    await voice.stop();
    client.destroy();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
await client.login(config.DISCORD_TOKEN);
