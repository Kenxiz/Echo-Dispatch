import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataStore } from "../src/database/store.js";
import { UnitService } from "../src/dispatch/unit-service.js";
import { CallService } from "../src/dispatch/call-service.js";
import { DispatchTextChannel } from "../src/discord/text-channel.js";

const config = {
  DISCORD_TEXT_CHANNEL_ID: "commands",
  DISCORD_911_CALLS_CHANNEL_ID: "911",
  DISCORD_ACTIVE_UNITS_CHANNEL_ID: "units",
  DISCORD_UNIT_UPDATES_CHANNEL_ID: "unit-updates",
  DISCORD_TRANSMISSION_LOGS_CHANNEL_ID: "transmissions",
  DISCORD_SITUATION_LOGS_CHANNEL_ID: "situations",
  DISCORD_CALL_LOGS_CHANNEL_ID: "call-logs",
  DISCORD_JOIN_LOGS_CHANNEL_ID: "joins",
  DISCORD_ERROR_LOGS_CHANNEL_ID: "errors",
  DISCORD_OTHER_LOGS_CHANNEL_ID: "other",
};

function makeChannel(id) {
  const sent = [];
  const messages = new Map();
  return {
    id,
    sent,
    isTextBased: () => true,
    isDMBased: () => false,
    messages: { fetch: vi.fn(async (messageId) => messages.get(messageId) ?? null) },
    send: vi.fn(async (payload) => {
      const messageId = `${id}-${sent.length + 1}`;
      const message = {
        id: messageId,
        edit: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn(async () => {
          messages.delete(messageId);
        }),
      };
      messages.set(messageId, message);
      sent.push({ payload, message });
      return message;
    }),
  };
}

let store;
let units;
let calls;
let channels;
let text;

beforeEach(async () => {
  store = new DataStore(await mkdtemp(path.join(tmpdir(), "echo-channels-")));
  await store.init();
  units = new UnitService(store);
  calls = new CallService(store, units);
  channels = Object.fromEntries(Object.values(config).map((id) => [id, makeChannel(id)]));
  text = new DispatchTextChannel({ channels: { fetch: vi.fn(async (id) => channels[id]) } }, config, calls);
});

describe("Discord channel routing", () => {
  it("keeps a 911 card in the 911 channel, deletes it at closure, and archives the closed call", async () => {
    const call = await calls.create({
      source: "DISCORD_911",
      incident: "Alarm",
      location: "Bank",
      description: "Audible alarm",
    });
    await text.publishCall(call);
    const active = calls.get(call.id);
    const activeMessage = channels["911"].sent[0].message;

    expect(active.messageId).toBe(activeMessage.id);
    expect(channels["call-logs"].send).not.toHaveBeenCalled();

    const closed = await calls.close(call.id);
    await text.publishCall(closed);

    expect(activeMessage.delete).toHaveBeenCalledOnce();
    expect(calls.get(call.id).messageId).toBeNull();
    expect(calls.get(call.id).logMessageId).toBe(channels["call-logs"].sent[0].message.id);
  });

  it("publishes officer-initiated calls only to Call Logs", async () => {
    const call = await calls.create({
      source: "OFFICER_INITIATED",
      incident: "Traffic Stop",
      location: "Main Street",
      description: "Vehicle stop",
    });

    await text.publishCall(call);

    expect(channels["911"].send).not.toHaveBeenCalled();
    expect(channels["call-logs"].send).toHaveBeenCalledOnce();
    expect(calls.get(call.id).logMessageId).not.toBeNull();
  });

  it("maintains one persisted Active Units message by editing it", async () => {
    await units.register({ discordUserId: "1", callsign: "1L-18", rank: "Officer", division: "Patrol" });
    await text.publishActiveUnits(units.list());
    const message = channels.units.sent[0].message;
    await units.setStatus("1", "OUT_OF_SERVICE", "10-7");

    await text.publishActiveUnits(units.list());

    expect(channels.units.send).toHaveBeenCalledOnce();
    expect(message.edit).toHaveBeenCalledOnce();
    expect(store.settings.get().activeUnitsMessageId).toBe(message.id);
  });

  it("routes transmissions, errors, joins, situations, and general logs separately", async () => {
    await text.transcript("1L-18", "10-8", "Copy");
    await text.warning("test error");
    await text.joinLog({ Join: true, Player: "OfficerPlayer:1", Timestamp: Date.now() });
    await text.situation("test situation");
    await text.system("test system message");

    expect(channels.transmissions.send).toHaveBeenCalledOnce();
    expect(channels.errors.send).toHaveBeenCalledOnce();
    expect(channels.joins.send).toHaveBeenCalledOnce();
    expect(channels.situations.send).toHaveBeenCalledOnce();
    expect(channels.other.send).toHaveBeenCalledOnce();
  });
});
