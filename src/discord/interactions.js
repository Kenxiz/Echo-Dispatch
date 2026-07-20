import { EmbedBuilder, MessageFlags } from "discord.js";
import { detectRadioCode } from "../utils/radio.js";
import { buildGuideEmbed } from "./guide.js";
export function createInteractionHandler(app, dispatch) {
    return async (interaction) => {
        if (!interaction.isChatInputCommand())
            return;
        if (interaction.guildId !== app.config.DISCORD_GUILD_ID || interaction.channelId !== app.config.DISCORD_TEXT_CHANNEL_ID) {
            await interaction.reply({ content: "Use Echo Dispatch commands in the configured dispatch text channel.", flags: MessageFlags.Ephemeral });
            return;
        }
        try {
            if (interaction.commandName === "guide")
                await interaction.reply({ embeds: [buildGuideEmbed(interaction.options.getString("topic") ?? "overview")], flags: MessageFlags.Ephemeral });
            if (interaction.commandName === "dispatch")
                await handleDispatch(interaction, app);
            if (interaction.commandName === "unit")
                await handleUnit(interaction, app, dispatch);
            if (interaction.commandName === "911")
                await handle911(interaction, app);
            if (interaction.commandName === "call")
                await handleCall(interaction, app);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Command failed.";
            if (interaction.replied || interaction.deferred)
                await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
            else
                await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
        }
    };
}
async function handleDispatch(interaction, app) {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "start") {
        await interaction.deferReply();
        await app.start();
        await interaction.editReply("Echo Dispatch is running.");
    }
    else if (subcommand === "stop") {
        await interaction.deferReply();
        await app.stop();
        await interaction.editReply("Echo Dispatch is stopped.");
    }
    else {
        await interaction.deferReply();
        await interaction.editReply({ embeds: [await app.statusEmbed()] });
    }
}
async function handleUnit(interaction, app, dispatch) {
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
    }
    else if (subcommand === "unregister") {
        const current = dispatch.units.getByUserId(userId);
        if (current?.assignedCallId)
            await dispatch.detachUnit(userId);
        const unit = await dispatch.units.unregister(userId);
        await interaction.reply(`Unit ${unit.callsign} unregistered.`);
    }
    else if (subcommand === "list") {
        const units = dispatch.units.list();
        const embed = new EmbedBuilder().setTitle("Active units").setColor(0x2563eb).setDescription(units.length
            ? units.map((unit) => `**${unit.callsign}** • ${unit.status.replaceAll("_", " ")} • ${unit.location ?? "Location not set"}${unit.assignedCallId ? ` • ${unit.assignedCallId}` : ""}`).join("\n")
            : "No units are registered.");
        await interaction.reply({ embeds: [embed] });
    }
    else if (subcommand === "info") {
        const callsign = interaction.options.getString("callsign");
        const unit = callsign ? dispatch.units.getByCallsign(callsign) : dispatch.units.getByUserId(userId);
        if (!unit)
            throw new Error("Active unit not found.");
        await interaction.reply({ embeds: [app.text.unitEmbed(unit)] });
    }
    else if (subcommand === "status") {
        const unit = await dispatch.setUnitStatus(userId, interaction.options.getString("status", true));
        await interaction.reply({ embeds: [app.text.unitEmbed(unit)] });
    }
    else if (subcommand === "response") {
        const unit = await dispatch.setUnitResponseMode(userId, interaction.options.getString("mode", true));
        await interaction.reply({ embeds: [app.text.unitEmbed(unit)] });
    }
    else if (subcommand === "location") {
        const unit = await dispatch.setUnitLocation(userId, interaction.options.getString("location", true));
        await interaction.reply({ embeds: [app.text.unitEmbed(unit)] });
    }
}
async function handle911(interaction, app) {
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
async function handleCall(interaction, app) {
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "list") {
        const calls = app.calls.list();
        const embed = new EmbedBuilder().setTitle("Active calls").setColor(0xf59e0b).setDescription(calls.length
            ? calls.map((call) => `**${call.id}** • ${call.radioCode ?? call.incident} • ${call.location} • P${call.priority} • ${call.assignedUnits.join(", ") || "Unassigned"}`).join("\n")
            : "No active calls.");
        await interaction.reply({ embeds: [embed] });
    }
    else if (subcommand === "info") {
        const call = app.calls.get(interaction.options.getString("call_id", true));
        if (!call)
            throw new Error("Call not found.");
        await interaction.reply({ embeds: [app.text.callEmbed(call)] });
    }
    else if (subcommand === "status") {
        const call = await app.calls.setStatus(interaction.options.getString("call_id", true), interaction.options.getString("status", true));
        await app.text.publishCall(call);
        await interaction.reply(`Updated ${call.id} to ${call.status.replaceAll("_", " ")}.`);
    }
    else if (subcommand === "scene") {
        const call = await app.calls.setSceneStatus(interaction.options.getString("call_id", true), interaction.options.getString("status", true));
        await app.text.publishCall(call);
        await interaction.reply(`Updated ${call.id} scene to ${call.sceneStatus.replaceAll("_", " ")}.`);
    }
    else if (subcommand === "response") {
        const call = await app.calls.setResponseMode(interaction.options.getString("call_id", true), interaction.options.getString("mode", true));
        await app.text.publishCall(call);
        await interaction.reply(`Updated ${call.id} response to ${call.responseMode.replace("_", " ")}.`);
    }
    else if (subcommand === "resource") {
        const call = await app.calls.requestResource(interaction.options.getString("call_id", true), interaction.options.getString("resource", true));
        await app.text.publishCall(call);
        await interaction.reply(`Recorded ${interaction.options.getString("resource", true).replaceAll("_", " ")} for ${call.id}.`);
    }
    else if (subcommand === "note") {
        const call = await app.calls.addNote(interaction.options.getString("call_id", true), interaction.user.username, interaction.options.getString("note", true));
        await app.text.publishCall(call);
        await interaction.reply(`Added a note to ${call.id}.`);
    }
    else if (subcommand === "close") {
        const call = await app.closeCall(interaction.options.getString("call_id", true));
        await interaction.reply(`Closed ${call.id}.`);
    }
}
