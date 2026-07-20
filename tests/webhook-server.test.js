import { describe, expect, it, vi } from "vitest";
import { ErlcWebhookServer } from "../src/erlc/webhook-server.js";

describe("ER:LC webhook server", () => {
  it("loads the documented Ed25519 public key during startup", () => {
    expect(() => new ErlcWebhookServer(3000, { ingest: vi.fn() }, vi.fn())).not.toThrow();
  });
});
