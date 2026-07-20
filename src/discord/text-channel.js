import {
  buildActiveUnitsEmbed,
  buildCallEmbed,
  buildPanicEmbed,
  buildSimpleEmbed,
  buildTranscriptEmbed,
  buildUnitEmbed,
} from "./embeds.js";
import { logger } from "../infrastructure/logger.js";

const CHANNEL_CONFIG_KEYS = Object.freeze({
  commands: "DISCORD_TEXT_CHANNEL_ID",
  calls911: "DISCORD_911_CALLS_CHANNEL_ID",
  activeUnits: "DISCORD_ACTIVE_UNITS_CHANNEL_ID",
  unitUpdates: "DISCORD_UNIT_UPDATES_CHANNEL_ID",
  transmissions: "DISCORD_TRANSMISSION_LOGS_CHANNEL_ID",
  situations: "DISCORD_SITUATION_LOGS_CHANNEL_ID",
  callLogs: "DISCORD_CALL_LOGS_CHANNEL_ID",
  joins: "DISCORD_JOIN_LOGS_CHANNEL_ID",
  errors: "DISCORD_ERROR_LOGS_CHANNEL_ID",
  other: "DISCORD_OTHER_LOGS_CHANNEL_ID",
});

export class DispatchTextChannel {
  constructor(client, config, calls) {
    this.client = client;
    this.config = config;
    this.calls = calls;
    this.channelCache = new Map();
    this.activeUnitsTimer = null;
    this.logger = logger.child("discord:text");
  }

  async channel(kind = "commands") {
    const configKey = CHANNEL_CONFIG_KEYS[kind];
    if (!configKey) throw new Error(`Unknown Discord channel route: ${kind}.`);
    const channelId = this.config[configKey];
    const cached = this.channelCache.get(channelId);
    if (cached) return cached;
    const channel = await this.client.channels.fetch(channelId);
    if (!channel?.isTextBased() || channel.isDMBased())
      throw new Error(`Configured ${kind} channel is unavailable or is not a guild text channel.`);
    this.channelCache.set(channelId, channel);
    return channel;
  }

  callEmbed(call) {
    return buildCallEmbed(call, {
      bolos: this.calls.store.bolos?.get() ?? [],
      warrants: this.calls.store.warrants?.get() ?? [],
    });
  }
  unitEmbed(unit, previous = null, reason = "UNIT_UPDATED") {
    return buildUnitEmbed(unit, previous, reason);
  }
  activeUnitsEmbed(units) {
    return buildActiveUnitsEmbed(units);
  }

  async publishCall(call) {
    const is911 = call.source === "DISCORD_911" || call.source === "ERLC_EMERGENCY";
    if (is911 && call.status === "CLOSED") {
      await this.delete911Card(call);
      await this.upsertCallLog(this.calls.get(call.id) ?? call);
    } else if (is911) {
      const message = await this.upsertMessage("calls911", call.messageId, this.callEmbed(call));
      if (message.id !== call.messageId) await this.calls.setMessageId(call.id, message.id);
    } else await this.upsertCallLog(call);
  }

  async delete911Card(call) {
    if (!call.messageId) return;
    const channel = await this.channel("calls911");
    const message = await channel.messages.fetch(call.messageId).catch(() => null);
    if (message) await message.delete().catch(() => undefined);
    await this.calls.setMessageId(call.id, null);
  }

  async upsertCallLog(call) {
    const message = await this.upsertMessage("callLogs", call.logMessageId, this.callEmbed(call));
    if (message.id !== call.logMessageId) await this.calls.setLogMessageId(call.id, message.id);
  }

  async upsertMessage(kind, messageId, embed) {
    const channel = await this.channel(kind);
    if (messageId) {
      const existing = await channel.messages.fetch(messageId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed] });
        return existing;
      }
    }
    return channel.send({ embeds: [embed] });
  }

  async publishActiveUnits(units = this.calls.units.list()) {
    const settings = this.calls.store.settings.get();
    const message = await this.upsertMessage(
      "activeUnits",
      settings.activeUnitsMessageId,
      this.activeUnitsEmbed(units),
    );
    if (message.id !== settings.activeUnitsMessageId)
      await this.calls.store.settings.update((current) => {
        current.activeUnitsMessageId = message.id;
      });
    return message;
  }

  scheduleActiveUnitsUpdate() {
    if (this.activeUnitsTimer) clearTimeout(this.activeUnitsTimer);
    this.activeUnitsTimer = setTimeout(() => {
      this.activeUnitsTimer = null;
      void this.publishActiveUnits().catch((error) => this.logger.error("Active Units panel update failed.", error));
    }, 200);
    this.activeUnitsTimer.unref?.();
  }

  async unitUpdate(unit, previous = null, reason = "UNIT_UPDATED") {
    this.scheduleActiveUnitsUpdate();
    const statusChanged = !previous || previous.status !== unit.status || previous.statusCode !== unit.statusCode;
    const assignmentChanged = !previous || previous.assignedCallId !== unit.assignedCallId;
    const presenceChanged =
      !previous || previous.erlcPresent !== unit.erlcPresent || previous.erlcTeam !== unit.erlcTeam;
    if (statusChanged || assignmentChanged || presenceChanged)
      await (await this.channel("unitUpdates")).send({ embeds: [this.unitEmbed(unit, previous, reason)] });
  }

  async transcript(callsign, officer, dispatcher) {
    await (await this.channel("transmissions")).send({ embeds: [buildTranscriptEmbed(callsign, officer, dispatcher)] });
  }
  async panic(unit, location, locationSource, transcript) {
    await (
      await this.channel("situations")
    ).send({ embeds: [buildPanicEmbed(unit, location, locationSource, transcript)] });
  }
  async joinLog(log) {
    await (
      await this.channel("joins")
    ).send({
      embeds: [
        buildSimpleEmbed(
          `ER:LC player ${log.Join ? "joined" : "left"}`,
          log.Player ?? "Unknown player",
          log.Join ? 0x16a34a : 0x6b7280,
          new Date(Number(log.Timestamp) || Date.now()),
        ),
      ],
    });
  }
  async situation(message) {
    await (
      await this.channel("situations")
    ).send({ embeds: [buildSimpleEmbed("Situation update", message, 0xf59e0b)] });
  }
  async warning(message) {
    await (
      await this.channel("errors")
    ).send({ embeds: [buildSimpleEmbed("Echo Dispatch warning", message, 0xdc2626)] });
  }
  async system(message) {
    await (await this.channel("other")).send({ embeds: [buildSimpleEmbed("Echo Dispatch", message, 0x2563eb)] });
  }
}
