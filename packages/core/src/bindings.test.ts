import { describe, expect, it } from "vitest";
import { applyPayloadAdditions, flattenPayload, resolvePath } from "./bindings.js";

const SAMPLE = {
  org: { name: "Leigh H Designs", address: { city: "Minneapolis" } },
  client: { fullName: "Sarah Chen", email: "sarah@example.com" },
  deal: { total: 450000, startDate: "2026-03-04" },
};

describe("flattenPayload", () => {
  it("flattens nested objects to dot paths with JSON-encoded examples", () => {
    const flat = flattenPayload(SAMPLE);
    expect(flat).toContainEqual({ path: "org.address.city", example: '"Minneapolis"' });
    expect(flat).toContainEqual({ path: "deal.total", example: "450000" });
  });

  it("treats arrays as leaves rather than descending into them", () => {
    const flat = flattenPayload({ tags: ["a", "b"] });
    expect(flat).toEqual([{ path: "tags", example: '["a","b"]' }]);
  });
});

describe("applyPayloadAdditions", () => {
  it("adds a new leaf under an existing object without touching siblings", () => {
    const { patched, applied, rejected } = applyPayloadAdditions(SAMPLE, [
      { path: "client.taxId", value: "12-3456789" },
    ]);
    expect(applied).toEqual(["client.taxId"]);
    expect(rejected).toEqual([]);
    expect(resolvePath(patched, "client.taxId")).toBe("12-3456789");
    expect(resolvePath(patched, "client.fullName")).toBe("Sarah Chen");
    expect(resolvePath(patched, "deal.total")).toBe(450000);
  });

  it("creates intermediate objects for a deep new path", () => {
    const { patched, applied } = applyPayloadAdditions(SAMPLE, [
      { path: "billing.contact.email", value: "ap@example.com" },
    ]);
    expect(applied).toEqual(["billing.contact.email"]);
    expect(resolvePath(patched, "billing.contact.email")).toBe("ap@example.com");
  });

  it("does not mutate the input sample", () => {
    const before = JSON.stringify(SAMPLE);
    applyPayloadAdditions(SAMPLE, [{ path: "client.taxId", value: "x" }]);
    expect(JSON.stringify(SAMPLE)).toBe(before);
  });

  it("rejects a path that already resolves — it isn't a gap", () => {
    const { applied, rejected } = applyPayloadAdditions(SAMPLE, [
      { path: "client.fullName", value: "someone else" },
    ]);
    expect(applied).toEqual([]);
    expect(rejected).toEqual([
      { path: "client.fullName", reason: "already in the payload" },
    ]);
  });

  it("rejects a path that would tunnel through an existing scalar", () => {
    const { patched, applied, rejected } = applyPayloadAdditions(SAMPLE, [
      { path: "client.fullName.first", value: "Sarah" },
    ]);
    expect(applied).toEqual([]);
    expect(rejected[0]!.reason).toContain("already a value");
    // The existing scalar survives untouched.
    expect(resolvePath(patched, "client.fullName")).toBe("Sarah Chen");
  });

  it("rejects empty path segments", () => {
    const { applied, rejected } = applyPayloadAdditions(SAMPLE, [
      { path: "client..taxId", value: "x" },
      { path: "", value: "x" },
    ]);
    expect(applied).toEqual([]);
    expect(rejected).toHaveLength(2);
  });

  it("applies the good additions and reports the bad ones in one pass", () => {
    const { patched, applied, rejected } = applyPayloadAdditions(SAMPLE, [
      { path: "client.taxId", value: "12-3456789" },
      { path: "client.fullName", value: "nope" },
      { path: "deal.poNumber", value: "PO-1042" },
    ]);
    expect(applied).toEqual(["client.taxId", "deal.poNumber"]);
    expect(rejected).toHaveLength(1);
    expect(resolvePath(patched, "deal.poNumber")).toBe("PO-1042");
  });

  it("starts from an empty object when no schema is registered yet", () => {
    const { patched, applied } = applyPayloadAdditions(null, [
      { path: "client.fullName", value: "Sarah Chen" },
    ]);
    expect(applied).toEqual(["client.fullName"]);
    expect(patched).toEqual({ client: { fullName: "Sarah Chen" } });
  });

  it("does not treat an array sample as an object to patch into", () => {
    const { patched } = applyPayloadAdditions([1, 2, 3], [
      { path: "a", value: 1 },
    ]);
    expect(patched).toEqual({ a: 1 });
  });
});

/**
 * The paths here come from a model (proposePayloadPatch), and the model's
 * input derives from tenant contract data — field keys and provenance — so a
 * hostile document can steer what it proposes. Writing through __proto__
 * reached Object.prototype and changed every object in the API process.
 */
describe("prototype-chain paths", () => {
  it("does not pollute Object.prototype", () => {
    const { applied, rejected } = applyPayloadAdditions(SAMPLE, [
      { path: "__proto__.polluted", value: "yes" },
      { path: "client.__proto__.polluted", value: "yes" },
      { path: "constructor.prototype.polluted", value: "yes" },
    ]);
    expect(applied).toEqual([]);
    expect(rejected).toHaveLength(3);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect((SAMPLE as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("rejects them as data, with a reason an engineer can read", () => {
    const { rejected } = applyPayloadAdditions(SAMPLE, [
      { path: "__proto__.x", value: 1 },
    ]);
    expect(rejected[0]?.reason).toContain("__proto__");
  });

  it("leaves a field that merely mentions one alone", () => {
    // "constructor" as a substring is fine — only a whole segment is refused.
    const { applied } = applyPayloadAdditions(SAMPLE, [
      { path: "deal.constructorName", value: "Acme Build Co" },
    ]);
    expect(applied).toEqual(["deal.constructorName"]);
  });
});

describe("resolvePath", () => {
  it("reads ordinary payload paths", () => {
    expect(resolvePath(SAMPLE, "org.address.city")).toBe("Minneapolis");
    expect(resolvePath(SAMPLE, "deal.missing")).toBeUndefined();
  });

  it("never hands back the prototype chain", () => {
    // A confirmed bindingPath naming one of these is a bug or an attack; the
    // honest answer is a payload miss, which the resolver already reports.
    expect(resolvePath(SAMPLE, "constructor")).toBeUndefined();
    expect(resolvePath(SAMPLE, "__proto__")).toBeUndefined();
    expect(resolvePath(SAMPLE, "client.constructor.name")).toBeUndefined();
  });

  it("ignores inherited properties, reading only the payload's own data", () => {
    expect(resolvePath(SAMPLE, "toString")).toBeUndefined();
    expect(resolvePath(SAMPLE, "hasOwnProperty")).toBeUndefined();
  });
});
