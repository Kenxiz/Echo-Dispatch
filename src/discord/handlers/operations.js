import { EmbedBuilder, MessageFlags } from "discord.js";
import { detectRadioCode } from "../../utils/radio.js";

export async function handlePlayback(interaction, app) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const seconds = interaction.options.getInteger("seconds") ?? 15;
  await app.voice.playbackRecent(seconds);
  await interaction.editReply(`Replayed the most recent ${seconds} seconds available on the dispatch channel.`);
}

export async function handleDispatch(interaction, app) {
  const subcommand = interaction.options.getSubcommand();
  await interaction.deferReply();
  if (subcommand === "start") {
    await app.start();
    await interaction.editReply("Echo Dispatch is running.");
  } else if (subcommand === "stop") {
    await app.stop();
    await interaction.editReply("Echo Dispatch is stopped.");
  } else await interaction.editReply({ embeds: [await app.statusEmbed()] });
}

export async function handleUnit(interaction, app, dispatch) {
  const subcommand = interaction.options.getSubcommand();
  const userId = interaction.user.id;
  if (subcommand === "register") {
    const unit = await dispatch.units.register({
      discordUserId: userId,
      callsign: interaction.options.getString("callsign", true),
      rank: interaction.options.getString("rank", true),
      division: interaction.options.getString("division", true),
      robloxUsername: interaction.options.getString("roblox_username"),
    });
    await interaction.reply({ embeds: [app.text.unitEmbed(unit)] });
  } else if (subcommand === "unregister") {
    const current = dispatch.units.getByUserId(userId);
    if (current?.assignedCallId) await dispatch.detachUnit(userId);
    const unit = await dispatch.units.unregister(userId);
    await interaction.reply(`Unit ${unit.callsign} unregistered.`);
  } else if (subcommand === "list") {
    const units = dispatch.units.list();
    const description = units.length
      ? units
          .map(
            (unit) =>
              `**${unit.callsign}** • ${unit.status.replaceAll("_", " ")} • ${unit.location ?? "Location not set"}${unit.assignedCallId ? ` • ${unit.assignedCallId}` : ""}`,
          )
          .join("\n")
      : "No units are registered.";
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Active units").setColor(0x2563eb).setDescription(description)],
    });
  } else if (subcommand === "info") {
    const callsign = interaction.options.getString("callsign");
    const unit = callsign ? dispatch.units.getByCallsign(callsign) : dispatch.units.getByUserId(userId);
    if (!unit) throw new Error("Active unit not found.");
    await interaction.reply({ embeds: [app.text.unitEmbed(unit)] });
  } else {
    const action = { status: "setUnitStatus", response: "setUnitResponseMode", location: "setUnitLocation" }[
      subcommand
    ];
    const option =
      subcommand === "status"
        ? interaction.options.getString("status", true)
        : subcommand === "response"
          ? interaction.options.getString("mode", true)
          : interaction.options.getString("location", true);
    const unit = await dispatch[action](userId, option, ...(subcommand === "location" ? ["MANUAL"] : []));
    await interaction.reply({ embeds: [app.text.unitEmbed(unit)] });
  }
}

export async function handle911(interaction, app) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const incident = interaction.options.getString("incident", true);
  const call = await app.createCall({
    source: "DISCORD_911",
    incident,
    radioCode: detectRadioCode(incident),
    location: interaction.options.getString("location", true),
    description: interaction.options.getString("description", true),
    suspectInfo: interaction.options.getString("suspect"),
    vehicleInfo: interaction.options.getString("vehicle"),
    weaponInfo: interaction.options.getString("weapon"),
    injuryInfo: interaction.options.getString("injuries"),
  });
  await interaction.editReply(`Accepted as ${call.id}.`);
}

export async function handleCall(interaction, app) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "list") {
    const calls = app.calls.list();
    const description = calls.length
      ? calls
          .map(
            (call) =>
              `**${call.id}** • ${call.radioCode ?? call.incident} • ${call.location} • P${call.priority} • ${call.assignedUnits.join(", ") || "Unassigned"}`,
          )
          .join("\n")
      : "No active calls.";
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Active calls").setColor(0xf59e0b).setDescription(description)],
    });
  } else if (subcommand === "info") {
    const call = app.calls.get(interaction.options.getString("call_id", true));
    if (!call) throw new Error("Call not found.");
    await interaction.reply({ embeds: [app.text.callEmbed(call)] });
  } else if (["status", "scene", "response", "resource"].includes(subcommand)) {
    const id = interaction.options.getString("call_id", true);
    const method = {
      status: "setStatus",
      scene: "setSceneStatus",
      response: "setResponseMode",
      resource: "requestResource",
    }[subcommand];
    const optionName = { status: "status", scene: "status", response: "mode", resource: "resource" }[subcommand];
    const value = interaction.options.getString(optionName, true);
    const call = await app.calls[method](id, value);
    await app.text.publishCall(call);
    await interaction.reply(`Updated ${call.id}: ${value.replaceAll("_", " ")}.`);
  } else if (subcommand === "note") {
    const callId = interaction.options.getString("call_id", true);
    const previous = app.calls.get(callId);
    const call = await app.calls.addNote(
      callId,
      interaction.user.username,
      interaction.options.getString("note", true),
    );
    await app.text.publishCall(call);
    if (previous && call.priority < previous.priority)
      void app.voice
        .announce(
          `Attention units. ${call.id} at ${call.location} upgraded from Priority ${previous.priority} to Priority ${call.priority}. Units respond ${call.responseMode.replace("_", " ")}.`,
          true,
          `PRIORITY_${call.priority}`,
        )
        .catch(() => undefined);
    await interaction.reply(`Added a note to ${call.id}.`);
  } else if (subcommand === "close") {
    const call = await app.closeCall(interaction.options.getString("call_id", true));
    await interaction.reply(`Closed ${call.id}.`);
  }
}
