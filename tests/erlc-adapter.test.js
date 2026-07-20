import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataStore } from "../src/database/store.js";
import { ErlcApiError } from "../src/erlc/client.js";
import { EmergencyCallAdapter } from "../src/erlc/emergency-call-adapter.js";
afterEach(() => vi.useRealTimers());
async function createStore() {
  const directory = await mkdtemp(path.join(tmpdir(), "echo-dispatch-erlc-"));
  const store = new DataStore(directory);
  await store.init();
  return store;
}
describe("ER:LC polling safety", () => {
  it("stops polling after a forbidden server-key response", async () => {
    vi.useFakeTimers();
    const fetchServerInfo = vi.fn().mockRejectedValue(new ErlcApiError(403, "Malformed Server-Key"));
    const adapter = new EmergencyCallAdapter(
      { fetchServerInfo },
      await createStore(),
      5e3,
      async () => void 0,
      async () => void 0,
      async () => void 0,
    );
    adapter.start();
    await vi.advanceTimersByTimeAsync(6e4);
    expect(fetchServerInfo).toHaveBeenCalledTimes(1);
  });
  it("honors Retry-After before polling again", async () => {
    vi.useFakeTimers();
    const response = {
      Name: "Test",
      OwnerId: 1,
      CoOwnerIds: [],
      CurrentPlayers: 0,
      MaxPlayers: 40,
      JoinKey: "Test",
      AccVerifiedReq: "Disabled",
      TeamBalance: false,
    };
    const fetchServerInfo = vi
      .fn()
      .mockRejectedValueOnce(new ErlcApiError(429, "Rate limited", 3e4))
      .mockResolvedValue(response);
    const adapter = new EmergencyCallAdapter(
      { fetchServerInfo },
      await createStore(),
      5e3,
      async () => void 0,
      async () => void 0,
      async () => void 0,
    );
    adapter.start();
    await vi.advanceTimersByTimeAsync(29999);
    expect(fetchServerInfo).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchServerInfo).toHaveBeenCalledTimes(2);
    adapter.stop();
  });
  it("suppresses repeated forbidden-key warnings across restarts for one hour", async () => {
    vi.useFakeTimers();
    const store = await createStore();
    const onError = vi.fn();
    const makeAdapter = () =>
      new EmergencyCallAdapter(
        { fetchServerInfo: vi.fn().mockRejectedValue(new ErlcApiError(403, "Malformed Server-Key")) },
        store,
        5e3,
        async () => void 0,
        async () => void 0,
        onError,
      );

    const first = makeAdapter();
    first.running = true;
    await first.poll();
    const second = makeAdapter();
    second.running = true;
    await second.poll();

    expect(onError).toHaveBeenCalledTimes(1);
  });
  it("forwards each player snapshot for continuous registered-unit location tracking", async () => {
    const players = [{ Player: "OfficerPlayer:123", Callsign: "1L-18", Location: { PostalCode: "205" } }];
    const onPlayers = vi.fn().mockResolvedValue(undefined);
    const adapter = new EmergencyCallAdapter(
      { fetchServerInfo: vi.fn().mockResolvedValue({ Players: players }) },
      await createStore(),
      10_000,
      async () => undefined,
      async () => undefined,
      async () => undefined,
      onPlayers,
    );
    adapter.running = true;
    await adapter.poll();
    adapter.stop();
    expect(onPlayers).toHaveBeenCalledWith(players);
  });
});
