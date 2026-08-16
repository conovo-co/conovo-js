import { describe, expect, it } from "vitest";
import { signWebhook, verifyWebhook } from "./webhooks.js";

const SECRET = "whsec_test_secret";
const NOW = 1_800_000_000;

describe("webhook signatures", () => {
  it("round-trips sign → verify", () => {
    const payload = JSON.stringify({ type: "contract.completed", ref: "ctr_x" });
    const header = signWebhook(payload, SECRET, NOW);
    expect(verifyWebhook(payload, header, SECRET, { now: NOW })).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const header = signWebhook('{"a":1}', SECRET, NOW);
    expect(verifyWebhook('{"a":2}', header, SECRET, { now: NOW })).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const header = signWebhook("x", SECRET, NOW);
    expect(verifyWebhook("x", header, "whsec_other", { now: NOW })).toBe(false);
  });

  it("rejects stale timestamps beyond tolerance (replay)", () => {
    const header = signWebhook("x", SECRET, NOW - 600);
    expect(verifyWebhook("x", header, SECRET, { now: NOW })).toBe(false);
    expect(
      verifyWebhook("x", header, SECRET, { now: NOW, toleranceSeconds: 3600 }),
    ).toBe(true);
  });

  it("rejects malformed headers", () => {
    expect(verifyWebhook("x", "", SECRET, { now: NOW })).toBe(false);
    expect(verifyWebhook("x", "t=abc,v1=00", SECRET, { now: NOW })).toBe(false);
    expect(verifyWebhook("x", `t=${NOW}`, SECRET, { now: NOW })).toBe(false);
  });
});
