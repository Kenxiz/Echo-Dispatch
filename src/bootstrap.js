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
import { UnitWatchdog } from "./dispatch/unit-watchdog.js";
import { createInteractionHandler } from "./discord/interactions.js";
import { RadioCodebook } from "./radio/codebook.js";

export async function createApplication(config) {
  const codebook = await RadioCodebook.load(config.radioCodesPath);
  const store = new DataStore(config.dataDir, { backupCount: config.DATABASE_BACKUP_COUNT });
  await store.init();
  const client = createDiscordClient();
  const units = new UnitService(store, config);
  const calls = new CallService(store, units);
  const text = new DispatchTextChannel(client, config, calls);
  units.setOnChanged((unit, previous, reason) => text.unitUpdate(unit, previous, reason));

  const runtime = { app: null, voice: null };
  const dispatch = new DispatchService(
    store,
    units,
    calls,
    async (call, event = {}) => {
      await text.publishCall(call);
      if (event.upgraded && runtime.app)
        void runtime.voice
          .announce(
            `Attention units. ${call.id} at ${call.location} upgraded from Priority ${event.previousPriority} to Priority ${call.priority}. Units respond ${call.responseMode.replace("_", " ")}.`,
            true,
            `PRIORITY_${call.priority}`,
          )
          .catch(() => undefined);
    },
    config,
    codebook,
  );
  const gemini = new GeminiDispatcher(config, codebook.export());
  const erlc = new ErlcClient(config);
  const voice = new VoiceManager(client, config, gemini, dispatch, text, erlc);
  const watchdog = new UnitWatchdog(config, calls, units, voice, text);
  const emergencyAdapter = new EmergencyCallAdapter(
    erlc,
    store,
    config.ERLC_POLL_INTERVAL_MS,
    (call) => app.createErlcCall(call).then(() => undefined),
    async (log) => {
      await dispatch.handleErlcJoinLog(log);
      await text.joinLog(log);
    },
    (error) => text.warning(error.message),
    (players) => dispatch.syncErlcPlayers(players),
  );
  const app = new EchoDispatchApp(
    config,
    store,
    calls,
    text,
    voice,
    gemini,
    erlc,
    emergencyAdapter,
    watchdog,
    codebook,
  );
  runtime.app = app;
  runtime.voice = voice;
  const webhook = new ErlcWebhookServer(config.HTTP_PORT, emergencyAdapter, (error) =>
    text.warning(`Webhook: ${error.message}`),
  );
  client.on("interactionCreate", createInteractionHandler(app, dispatch));

  return {
    app,
    client,
    store,
    units,
    calls,
    dispatch,
    text,
    voice,
    watchdog,
    emergencyAdapter,
    webhook,
    async shutdown() {
      emergencyAdapter.stop();
      watchdog.stop();
      webhook.stop();
      await voice.stop();
      client.destroy();
    },
  };
}
