import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("config.json", () => {
  it("validates the supplied channel routing and JSON-native boolean/array options", async () => {
    const example = JSON.parse(await readFile(new URL("../config.example.json", import.meta.url), "utf8"));
    const config = parseConfig({
      ...example,
      DISCORD_TOKEN: "discord-token",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "guild-id",
      GEMINI_API_KEY: "gemini-key",
      ERLC_SERVER_KEY: "server-key",
    });

    expect(config).toMatchObject({
      DISCORD_VOICE_CHANNEL_ID: "1528383462229278854",
      DISCORD_TEXT_CHANNEL_ID: "1528383462229278853",
      DISCORD_911_CALLS_CHANNEL_ID: "1528846836574589129",
      DISCORD_ACTIVE_UNITS_CHANNEL_ID: "1528845910979641365",
      BOLO_AUTO_REQUEST_BACKUP: false,
      WARRANT_AUTHORIZED_RANKS: expect.any(Array),
    });
  });
});
