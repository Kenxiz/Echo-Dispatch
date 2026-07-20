import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ErlcClient,
  findErlcCallerPlayer,
  findErlcPlayer,
  formatErlcLocation,
  isFilteredErlcLocation,
} from "../src/erlc/client.js";

afterEach(() => vi.unstubAllGlobals());

describe("ER:LC client authentication safety", () => {
  it("explains malformed keys and blocks repeat network requests", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 2001, message: "Malformed Server-Key" }), { status: 403 }),
      );
    vi.stubGlobal("fetch", fetch);
    const client = new ErlcClient({
      ERLC_API_BASE_URL: "https://api.erlc.gg",
      ERLC_SERVER_KEY: "bad-key",
    });

    await expect(client.fetchServerInfo()).rejects.toThrow("Generate a new key");
    await expect(client.fetchServerInfo()).rejects.toThrow("Generate a new key");
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe("ER:LC officer location lookup", () => {
  const players = [
    {
      Player: "JointedScripter:123",
      Callsign: "1L-18",
      Location: {
        BuildingNumber: "2083",
        StreetName: "Park Street",
        PostalCode: "218",
        LocationX: 1084,
        LocationZ: 2302,
      },
    },
  ];

  it("matches exact Roblox username first and formats a radio-ready location", () => {
    const player = findErlcPlayer(players, { robloxUsername: "jointedscripter", callsign: "9Z-99" });
    expect(player).toBe(players[0]);
    expect(formatErlcLocation(player.Location)).toBe("2083 Park Street, postal 218");
  });

  it("falls back to normalized ER:LC callsign matching", () => {
    expect(findErlcPlayer(players, { robloxUsername: null, callsign: "1l18" })).toBe(players[0]);
  });
  it("matches an emergency caller ID and recognizes fully tagged Roblox locations", () => {
    expect(findErlcCallerPlayer(players, 123)).toBe(players[0]);
    expect(isFilteredErlcLocation("#### ####")).toBe(true);
    expect(isFilteredErlcLocation("County Jail")).toBe(false);
  });
});
