import { REST, Routes } from "discord.js";
import { commandData } from "./discord/commands.js";
import { loadConfig } from "./config.js";
import { logger } from "./infrastructure/logger.js";

const config = loadConfig();
const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);
await rest.put(Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID), {
  body: commandData,
});
logger.child("commands").info(`Registered ${commandData.length} guild commands.`);
