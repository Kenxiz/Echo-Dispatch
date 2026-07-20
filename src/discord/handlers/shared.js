import { AttachmentBuilder, MessageFlags, PermissionFlagsBits } from "discord.js";

export function requireAdministrator(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator))
    throw new Error("Administrator permission is required.");
}
export function splitList(value) {
  return value === null
    ? undefined
    : value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}
export function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}
export function safeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
export async function replyJson(interaction, name, value) {
  const json = JSON.stringify(value, null, 2);
  await interaction.reply({
    content: `Debug export: ${name}`,
    files: [new AttachmentBuilder(Buffer.from(json), { name })],
    flags: MessageFlags.Ephemeral,
  });
}
