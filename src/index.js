import { loadConfig } from "./config.js";
import { createApplication } from "./bootstrap.js";
import { logger } from "./infrastructure/logger.js";

const log = logger.child("startup");
let container = null;
let shuttingDown = false;

async function main() {
  const config = loadConfig();
  container = await createApplication(config);
  const { app, client, text, webhook } = container;
  client.once("clientReady", async (readyClient) => {
    log.info(`Logged in as ${readyClient.user.tag}.`);
    try {
      webhook.start();
      await app.restore();
    } catch (error) {
      log.error("Startup restoration failed.", error);
      await text.warning(error instanceof Error ? error.message : "Startup restoration failed.").catch(() => undefined);
    }
  });
  client.on("error", (error) => log.error("Discord client error.", error));
  await client.login(config.DISCORD_TOKEN);
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}; shutting down.`);
  try {
    await container?.shutdown();
  } catch (error) {
    log.error("Shutdown failed.", error);
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("unhandledRejection", (error) => log.error("Unhandled promise rejection.", error));

main().catch((error) => {
  log.error("Fatal startup failure.", error);
  process.exitCode = 1;
});
