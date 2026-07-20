import { EmbedBuilder } from "discord.js";

export function buildCallEmbed(call, records = {}) {
  const details =
    [
      call.suspectInfo && `**Suspect:** ${call.suspectInfo}`,
      call.vehicleInfo && `**Vehicle:** ${call.vehicleInfo}`,
      call.weaponInfo && `**Weapon:** ${call.weaponInfo}`,
      call.injuryInfo && `**Injuries:** ${call.injuryInfo}`,
    ]
      .filter(Boolean)
      .join("\n") || "None reported";
  const notes =
    call.notes
      .slice(-5)
      .map((note) => `**${note.callsign}:** ${note.text}`)
      .join("\n") || "None";
  const roles =
    call.assignedUnits
      .map((callsign) => `${callsign} — ${(call.unitRoles[callsign] ?? "BACKUP").replaceAll("_", " ")}`)
      .join("\n") || "Awaiting a unit";
  const recommendations =
    call.recommendedUnits
      .slice(0, 3)
      .map((unit) => `${unit.callsign} • ${unit.etaSeconds === null ? "ETA unavailable" : `~${unit.etaSeconds}s`}`)
      .join("\n") || "No available recommendations";
  const resourceDetails =
    call.resourceRequests
      .map(
        (request) =>
          `${request.quantity}x ${request.resourceType.replaceAll("_", " ")} | ${request.purpose.replaceAll("_", " ")} | ${request.disposition}`,
      )
      .join("\n") || "None";
  const bolos =
    (records.bolos ?? [])
      .filter((bolo) => bolo.status === "ACTIVE" && call.boloIds.includes(bolo.id))
      .map(
        (bolo) =>
          `${bolo.id} | ${bolo.type} | ${bolo.status}${bolo.plate ? ` | ${bolo.plate.normalizedPattern}` : ""}${bolo.directionOfTravel ? ` | ${bolo.directionOfTravel}` : ""}`,
      )
      .join("\n") || "None";
  const observedPlates =
    call.observedPlates
      .map(
        (entry) =>
          `${entry.plate.normalizedPattern || entry.plate.plateType} | ${entry.plate.plateType} | ${entry.reportedBy}`,
      )
      .join("\n") || "None";
  const safety = `${call.officerSafetyLevel}${call.boloRelated ? " | BOLO RELATED" : ""}${call.backupRecommended ? " | BACKUP RECOMMENDED" : ""}`;
  const stopDetails = call.stopType
    ? `${call.stopType.replaceAll("_", " ")} | ${call.riskLevel} RISK | BACKUP ${call.backupStatus.replaceAll("_", " ")}`
    : "Not a traffic stop";
  const warrants =
    (records.warrants ?? [])
      .filter((warrant) => warrant.status === "ACTIVE" && call.warrantIds.includes(warrant.id))
      .map(
        (warrant) =>
          `${warrant.id} | ${warrant.warrantType} | ${warrant.status}${warrant.plate ? ` | ${warrant.plate.normalizedPattern}` : ""}`,
      )
      .join("\n") || "None";
  const color =
    call.status === "CLOSED" ? 0x6b7280 : call.priority === 1 ? 0xdc2626 : call.priority === 2 ? 0xf59e0b : 0x2563eb;
  return new EmbedBuilder()
    .setTitle(`${call.id} • ${call.radioCode ?? call.incident}`)
    .setColor(color)
    .addFields(
      { name: "Incident", value: call.incident, inline: true },
      { name: "Location", value: call.location, inline: true },
      {
        name: "Priority / Response",
        value: `P${call.priority} / ${call.responseMode.replace("_", " ")}`,
        inline: true,
      },
      {
        name: "Priority basis",
        value: `${call.prioritySource}${call.priorityReason ? ` • ${call.priorityReason}` : ""}`.slice(0, 1024),
      },
      { name: "Call status", value: call.status.replaceAll("_", " "), inline: true },
      { name: "Scene status", value: call.sceneStatus.replaceAll("_", " "), inline: true },
      { name: "Callers reporting", value: String(call.callerCount), inline: true },
      { name: "Scene assignments", value: roles.slice(0, 1024), inline: true },
      { name: "Recommended units", value: recommendations.slice(0, 1024), inline: true },
      {
        name: "Requested resources",
        value: call.requestedResources.map((resource) => resource.replaceAll("_", " ")).join(", ") || "None",
        inline: true,
      },
      { name: "Resource details", value: resourceDetails.slice(0, 1024) },
      {
        name: "Staged resources",
        value: call.stagedResources.map((resource) => resource.replaceAll("_", " ")).join(", ") || "None",
        inline: true,
      },
      { name: "Prepared options", value: call.operationalPlan.join(", ") || "None", inline: true },
      {
        name: "Supervisor / policy guidance",
        value: call.supervisorRecommendations.join("\n").slice(0, 1024) || "None",
      },
      { name: "Active BOLOs", value: bolos.slice(0, 1024), inline: true },
      { name: "Observed plates", value: observedPlates.slice(0, 1024), inline: true },
      { name: "Officer safety", value: safety.slice(0, 1024), inline: true },
      { name: "Traffic stop", value: stopDetails, inline: true },
      { name: "Warrants", value: warrants.slice(0, 1024), inline: true },
      { name: "Related incidents", value: call.relatedCallIds.join(", ") || "None", inline: true },
      {
        name: "Pursuit",
        value: call.pursuit
          ? `${call.pursuit.active ? "ACTIVE" : "ENDED"}${call.pursuit.vehicle ? ` | ${call.pursuit.vehicle}` : ""}${call.pursuit.direction ? ` | ${call.pursuit.direction}` : ""}${call.pursuit.lastLocation ? ` | ${call.pursuit.lastLocation}` : ""}`
          : "None",
        inline: true,
      },
      { name: "Source", value: call.source.replaceAll("_", " "), inline: true },
      { name: "Description", value: call.description.slice(0, 1024) },
      { name: "Additional information", value: details.slice(0, 1024) },
      { name: "Recent updates", value: notes.slice(0, 1024) },
    )
    .setTimestamp(new Date(call.createdAt))
    .setFooter({
      text: call.closedAt
        ? `Closed ${new Date(call.closedAt).toLocaleString()}`
        : `Echo Dispatch • ${call.timeline.length} timeline events`,
    });
}

export function buildUnitEmbed(unit, previous = null, reason = "UNIT_UPDATED") {
  return new EmbedBuilder()
    .setTitle(`Unit update • ${unit.callsign}`)
    .setColor(unit.status === "OUT_OF_SERVICE" ? 0x6b7280 : 0x2563eb)
    .setDescription(reason.replaceAll("_", " "))
    .addFields(
      { name: "Member", value: `<@${unit.discordUserId}>`, inline: true },
      { name: "Rank / Division", value: `${unit.rank} • ${unit.division}`, inline: true },
      {
        name: "Status",
        value: `${unit.status.replaceAll("_", " ")}${unit.statusCode ? ` (${unit.statusCode})` : ""}`,
        inline: true,
      },
      {
        name: "Previous status",
        value: previous
          ? `${previous.status.replaceAll("_", " ")}${previous.statusCode ? ` (${previous.statusCode})` : ""}`
          : "New registration",
        inline: true,
      },
      { name: "Location", value: unit.location ?? "Not set", inline: true },
      { name: "Assigned call", value: unit.assignedCallId ?? "None", inline: true },
      { name: "Roblox", value: unit.robloxUsername ?? "Not linked", inline: true },
      {
        name: "ER:LC presence",
        value: unit.erlcPresent ? `In game${unit.erlcTeam ? ` • ${unit.erlcTeam}` : ""}` : "Not detected",
        inline: true,
      },
    )
    .setTimestamp();
}

export function buildActiveUnitsEmbed(units) {
  const rows = units
    .slice()
    .sort((a, b) => a.callsign.localeCompare(b.callsign))
    .map((unit) => {
      const status = unit.statusCode
        ? `${unit.statusCode} • ${unit.status.replaceAll("_", " ")}`
        : unit.status.replaceAll("_", " ");
      return `**${unit.callsign}** — ${status} | ${unit.assignedCallId ?? "No call"} | ${unit.location ?? "Location unavailable"}`;
    });
  return new EmbedBuilder()
    .setTitle("Echo Dispatch • Active Units")
    .setColor(0x2563eb)
    .setDescription((rows.join("\n") || "No registered units.").slice(0, 4096))
    .setFooter({ text: `${units.length} registered unit${units.length === 1 ? "" : "s"} • automatically maintained` })
    .setTimestamp();
}

export function buildTranscriptEmbed(callsign, officer, dispatcher) {
  return new EmbedBuilder()
    .setTitle(`Radio • ${callsign}`)
    .setColor(0x374151)
    .addFields(
      { name: callsign, value: officer || "(unintelligible)" },
      { name: "Echo Dispatch", value: dispatcher || "(audio response)" },
    )
    .setTimestamp();
}

export function buildPanicEmbed(unit, location, locationSource, transcript) {
  return new EmbedBuilder()
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
}

export function buildSimpleEmbed(title, message, color, timestamp = new Date()) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(String(message).slice(0, 4000))
    .setColor(color)
    .setTimestamp(timestamp);
}
