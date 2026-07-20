import { EmbedBuilder } from "discord.js";

export async function handleCad(interaction, app) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "heatmap") {
    const rows = app.heatmap();
    const description = rows.length
      ? rows
          .map(
            (row, index) =>
              `**${index + 1}. ${row.location}** — ${row.calls} calls • ${row.pursuits} pursuits • ${row.crashes} crashes • ${row.robberies} robberies`,
          )
          .join("\n")
      : "No incident data for this shift.";
    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle("Incident heatmap").setColor(0x7c3aed).setDescription(description)],
    });
  } else if (subcommand === "shift") {
    const stats = app.shiftStatistics();
    const embed = new EmbedBuilder()
      .setTitle("Echo Dispatch shift summary")
      .setColor(0x2563eb)
      .addFields(
        { name: "Radio transmissions", value: String(stats.transmissions), inline: true },
        { name: "Calls / Priority 1", value: `${stats.calls} / ${stats.priorityOne}`, inline: true },
        {
          name: "Average response",
          value: stats.averageResponseSeconds === null ? "Not available" : `${stats.averageResponseSeconds} seconds`,
          inline: true,
        },
        { name: "Busiest unit", value: stats.busiestUnit, inline: true },
        { name: "Longest call", value: stats.longestCall, inline: true },
        { name: "Active units", value: String(stats.activeUnits), inline: true },
      )
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
  } else if (subcommand === "reset-shift") {
    const startedAt = await app.resetShift();
    await interaction.reply(`New shift statistics period started at ${new Date(startedAt).toLocaleString()}.`);
  } else if (subcommand === "timeline" || subcommand === "replay") {
    const call = app.calls.get(interaction.options.getString("call_id", true));
    if (!call) throw new Error("Call not found.");
    const limit = subcommand === "timeline" ? 25 : app.config.INCIDENT_REPLAY_EVENTS;
    const events = call.timeline.slice(-limit);
    const lines = events.map((event, index) =>
      subcommand === "timeline"
        ? `**${new Date(event.timestamp).toLocaleTimeString()}** • ${event.text}`
        : `${index + 1}. **${new Date(event.timestamp).toLocaleTimeString()}** [${event.type}]${event.actor ? ` ${event.actor}:` : ""} ${event.text}`,
    );
    const description =
      subcommand === "timeline"
        ? lines.join("\n") || "No timeline entries."
        : `**${call.incident}** at **${call.location}** | P${call.priority} ${call.responseMode.replace("_", " ")} | ${call.status.replaceAll("_", " ")}\n\n${lines.join("\n") || "No recorded events."}`;
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(subcommand === "timeline" ? `${call.id} incident timeline` : `Incident replay | ${call.id}`)
          .setColor(subcommand === "timeline" ? 0x475569 : 0x0f766e)
          .setDescription(description.slice(0, 4096))
          .setTimestamp(),
      ],
    });
  } else if (subcommand === "recommend") {
    const call = await app.calls.setRecommendations(interaction.options.getString("call_id", true));
    await app.text.publishCall(call);
    const lines = call.recommendedUnits.map(
      (unit) =>
        `**${unit.callsign}** • ${unit.etaSeconds === null ? "ETA unavailable" : `~${unit.etaSeconds} seconds`} • ${unit.reason}`,
    );
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(`Recommended units • ${call.id}`)
          .setColor(0x16a34a)
          .setDescription(lines.join("\n") || "No available units to recommend."),
      ],
    });
  }
}
