import { EmbedBuilder } from "discord.js";
export class DispatchTextChannel {
    client;
    config;
    calls;
    constructor(client, config, calls) {
        this.client = client;
        this.config = config;
        this.calls = calls;
    }
    async channel() {
        const channel = await this.client.channels.fetch(this.config.DISCORD_TEXT_CHANNEL_ID);
        if (!channel?.isTextBased() || channel.isDMBased())
            throw new Error("Configured text channel is unavailable or is not a guild text channel.");
        return channel;
    }
    callEmbed(call) {
        const details = [
            call.suspectInfo && `**Suspect:** ${call.suspectInfo}`,
            call.vehicleInfo && `**Vehicle:** ${call.vehicleInfo}`,
            call.weaponInfo && `**Weapon:** ${call.weaponInfo}`,
            call.injuryInfo && `**Injuries:** ${call.injuryInfo}`,
        ].filter(Boolean).join("\n") || "None reported";
        const notes = call.notes.slice(-5).map((note) => `**${note.callsign}:** ${note.text}`).join("\n") || "None";
        const color = call.status === "CLOSED" ? 0x6b7280 : call.priority === 1 ? 0xdc2626 : call.priority === 2 ? 0xf59e0b : 0x2563eb;
        return new EmbedBuilder()
            .setTitle(`${call.id} • ${call.radioCode ?? call.incident}`)
            .setColor(color)
            .addFields({ name: "Incident", value: call.incident, inline: true }, { name: "Location", value: call.location, inline: true }, { name: "Priority / Response", value: `P${call.priority} / ${call.responseMode.replace("_", " ")}`, inline: true }, { name: "Priority basis", value: `${call.prioritySource}${call.priorityReason ? ` • ${call.priorityReason}` : ""}`.slice(0, 1024) }, { name: "Call status", value: call.status.replaceAll("_", " "), inline: true }, { name: "Scene status", value: call.sceneStatus.replaceAll("_", " "), inline: true }, { name: "Assigned units", value: call.assignedUnits.join(", ") || "Awaiting a unit", inline: true }, { name: "Requested resources", value: call.requestedResources.map((resource) => resource.replaceAll("_", " ")).join(", ") || "None", inline: true }, { name: "Source", value: call.source.replaceAll("_", " "), inline: true }, { name: "Description", value: call.description.slice(0, 1024) }, { name: "Additional information", value: details.slice(0, 1024) }, { name: "Recent updates", value: notes.slice(0, 1024) })
            .setTimestamp(new Date(call.createdAt))
            .setFooter({ text: call.closedAt ? `Closed ${new Date(call.closedAt).toLocaleString()}` : "Echo Dispatch" });
    }
    unitEmbed(unit) {
        return new EmbedBuilder().setTitle(`Unit ${unit.callsign}`).setColor(0x2563eb).addFields({ name: "Member", value: `<@${unit.discordUserId}>`, inline: true }, { name: "Rank / Division", value: `${unit.rank} • ${unit.division}`, inline: true }, { name: "Status", value: `${unit.status.replaceAll("_", " ")}${unit.statusCode ? ` (${unit.statusCode})` : ""}`, inline: true }, { name: "Location", value: unit.location ?? "Not set", inline: true }, { name: "Assigned call", value: unit.assignedCallId ?? "None", inline: true }, { name: "Call response", value: unit.responseStatus.replaceAll("_", " "), inline: true }, { name: "Response mode", value: unit.responseMode?.replace("_", " ") ?? "Not set", inline: true }, { name: "Roblox", value: unit.robloxUsername ?? "Not linked", inline: true });
    }
    async publishCall(call) {
        const channel = await this.channel();
        if (call.messageId) {
            const message = await channel.messages.fetch(call.messageId).catch(() => null);
            if (message) {
                await message.edit({ embeds: [this.callEmbed(call)] });
                return;
            }
        }
        const message = await channel.send({ embeds: [this.callEmbed(call)] });
        await this.calls.setMessageId(call.id, message.id);
    }
    async transcript(callsign, officer, dispatcher) {
        const embed = new EmbedBuilder().setTitle(`Radio • ${callsign}`).setColor(0x374151)
            .addFields({ name: callsign, value: officer || "(unintelligible)" }, { name: "Echo Dispatch", value: dispatcher || "(audio response)" })
            .setTimestamp();
        await (await this.channel()).send({ embeds: [embed] });
    }
    async panic(unit, location, locationSource, transcript) {
        const embed = new EmbedBuilder()
            .setTitle(`MASS PANIC • ${unit.callsign}`)
            .setColor(0x991b1b)
            .setDescription("Officer emergency traffic received. All available units respond Code 3.")
            .addFields(
                { name: "Unit", value: unit.callsign, inline: true },
                { name: "Location", value: location ?? "Unavailable — unit advise when able", inline: true },
                { name: "Location source", value: locationSource.toUpperCase(), inline: true },
                { name: "Emergency traffic", value: transcript.slice(0, 1024) || "Unintelligible panic transmission" },
            )
            .setTimestamp();
        await (await this.channel()).send({ embeds: [embed] });
    }
    async warning(message) {
        await (await this.channel()).send({ embeds: [new EmbedBuilder().setTitle("Echo Dispatch warning").setDescription(message.slice(0, 4000)).setColor(0xdc2626).setTimestamp()] });
    }
    async system(message) {
        await (await this.channel()).send({ embeds: [new EmbedBuilder().setTitle("Echo Dispatch").setDescription(message.slice(0, 4000)).setColor(0x2563eb).setTimestamp()] });
    }
}
