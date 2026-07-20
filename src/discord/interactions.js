import { MessageFlags } from "discord.js";
import { buildGuideEmbed } from "./guide.js";
import { handleDebug, handleRadioCode } from "./handlers/admin.js";
import { handleCad } from "./handlers/cad.js";
import { handle911, handleCall, handleDispatch, handlePlayback, handleUnit } from "./handlers/operations.js";

export function createInteractionHandler(app, dispatch) {
  const handlers = {
    guide: (interaction) =>
      interaction.reply({
        embeds: [buildGuideEmbed(interaction.options.getString("topic") ?? "overview")],
        flags: MessageFlags.Ephemeral,
      }),
    dispatch: (interaction) => handleDispatch(interaction, app),
    unit: (interaction) => handleUnit(interaction, app, dispatch),
    911: (interaction) => handle911(interaction, app),
    playback: (interaction) => handlePlayback(interaction, app),
    cad: (interaction) => handleCad(interaction, app),
    call: (interaction) => handleCall(interaction, app),
    radiocode: (interaction) => handleRadioCode(interaction, app),
    debug: (interaction) => handleDebug(interaction, app, dispatch),
  };
  return async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (
      interaction.guildId !== app.config.DISCORD_GUILD_ID ||
      interaction.channelId !== app.config.DISCORD_TEXT_CHANNEL_ID
    ) {
      await interaction.reply({
        content: "Use Echo Dispatch commands in the configured dispatch text channel.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    try {
      const handler = handlers[interaction.commandName];
      if (!handler) throw new Error(`Unsupported command: ${interaction.commandName}.`);
      await handler(interaction);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command failed.";
      if (interaction.replied || interaction.deferred)
        await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
      else await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  };
}
