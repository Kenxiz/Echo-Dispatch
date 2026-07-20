import { AttachmentBuilder, EmbedBuilder, MessageFlags } from "discord.js";
import { findActiveBoloMatches, parseVehicleObservation } from "../../dispatch/officer-incident.js";
import { compactObject, replyJson, requireAdministrator, safeName, splitList } from "./shared.js";

export async function handleRadioCode(interaction, app) {
  requireAdministrator(interaction);
  if (!app.codebook) throw new Error("The radio codebook service is unavailable.");
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "list") {
    const rows = app.codebook
      .list()
      .map((entry) => `**${entry.code}** — ${entry.meaning} · ${entry.category}`)
      .join("\n");
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle("Active agency radio codebook")
          .setColor(0x2563eb)
          .setDescription(rows.slice(0, 4096)),
      ],
      flags: MessageFlags.Ephemeral,
    });
  } else if (subcommand === "view") {
    const definition = app.codebook.get(interaction.options.getString("code", true));
    if (!definition) throw new Error("Radio code not found.");
    await replyJson(interaction, `radio-code-${safeName(definition.code)}.json`, definition);
  } else if (subcommand === "add" || subcommand === "edit") {
    const code = interaction.options.getString("code", true);
    const changes = compactObject({
      code,
      meaning: interaction.options.getString("meaning"),
      category: interaction.options.getString("category"),
      action: interaction.options.getString("action"),
      actionValue: interaction.options.getString("action_value"),
      aliases: splitList(interaction.options.getString("aliases")),
      priority: interaction.options.getInteger("priority"),
      responseCode: interaction.options.getInteger("response_code"),
    });
    const definition = subcommand === "add" ? await app.codebook.add(changes) : await app.codebook.edit(code, changes);
    app.gemini.updateCodebook?.(app.codebook.export());
    await interaction.reply({
      content: `${definition.code} saved as ${definition.meaning}.`,
      flags: MessageFlags.Ephemeral,
    });
  } else if (subcommand === "remove") {
    const removed = await app.codebook.remove(interaction.options.getString("code", true));
    app.gemini.updateCodebook?.(app.codebook.export());
    await interaction.reply({ content: `${removed.code} removed.`, flags: MessageFlags.Ephemeral });
  } else if (subcommand === "reset") {
    await app.codebook.reset();
    app.gemini.updateCodebook?.(app.codebook.export());
    await interaction.reply({
      content: "The radio codebook was reset to its startup definitions.",
      flags: MessageFlags.Ephemeral,
    });
  } else if (subcommand === "import") {
    const attachment = interaction.options.getAttachment("file", true);
    if (!attachment.name.toLowerCase().endsWith(".json")) throw new Error("Codebook import must be a JSON file.");
    const response = await fetch(attachment.url);
    if (!response.ok) throw new Error(`Could not download codebook (${response.status}).`);
    await app.codebook.import(JSON.parse(await response.text()));
    app.gemini.updateCodebook?.(app.codebook.export());
    await interaction.reply({
      content: `Imported ${app.codebook.list().length} validated definitions.`,
      flags: MessageFlags.Ephemeral,
    });
  } else if (subcommand === "export")
    await replyJson(interaction, "echo-dispatch-radio-codes.json", app.codebook.export());
  else {
    const issues = app.codebook.validate();
    const text = issues.length
      ? issues.map((issue) => `[${issue.severity}] ${issue.type}: ${issue.detail}`).join("\n")
      : "No codebook conflicts or validation errors found.";
    await interaction.reply({
      content: text.slice(0, 1900),
      files:
        text.length > 1900 ? [new AttachmentBuilder(Buffer.from(text), { name: "radio-code-validation.txt" })] : [],
      flags: MessageFlags.Ephemeral,
    });
  }
}

export async function handleDebug(interaction, app, dispatch) {
  requireAdministrator(interaction);
  const subcommand = interaction.options.getSubcommand();
  let value;
  if (subcommand === "transmission") {
    const id = interaction.options.getString("id");
    value = id ? app.store.transmissions.get().find((item) => item.id === id) : app.store.transmissions.get().at(-1);
  } else if (subcommand === "unit")
    value = dispatch.units.getByCallsign(interaction.options.getString("callsign", true));
  else if (subcommand === "call") value = app.calls.get(interaction.options.getString("call_id", true));
  else if (subcommand === "code") {
    const traffic = interaction.options.getString("traffic", true);
    value = { traffic, matches: app.codebook?.detect(traffic) ?? [], validation: app.codebook?.validate() ?? [] };
  } else if (subcommand === "bolo-match") {
    const observation = parseVehicleObservation(interaction.options.getString("observation", true));
    value = {
      observation,
      matches: findActiveBoloMatches(app.store.bolos.get(), observation, 0).map(({ bolo, ...match }) => ({
        boloId: bolo.id,
        ...match,
      })),
    };
  } else value = app.voice.debugState?.() ?? { connected: app.voice.isConnected() };
  if (!value) throw new Error("No matching debug record was found.");
  await replyJson(interaction, `echo-debug-${subcommand}.json`, value);
}
