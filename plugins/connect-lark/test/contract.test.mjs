// Runtime contract tests for @oh-summy/connect-lark.
//
// These exist because compiling is not enough: v5's resolveAppSecret() type-checked but
// threw at runtime, because it received a parsed (volatile-wrapped) config where it expected
// a plain string. Every helper below is exercised against the REAL parsed config produced
// by `new z(Config.toJSON())({})`, not a hand-written plain object.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isVolatile } from "@deepseek-ai/cosmokit";

// Import the built artifact, so the test also proves the build output is usable.
const { Config, plainConfig, resolveAppSecret, buildUserMessage, inject, CONTRACT_NOTES } =
  await import("../lib/index.mjs");

// NOTE: `new z(Config.toJSON())` is NOT the runtime parser. Cordis parses at startup via
// `Config["~standard"].validate()` (cordis lib/index.js:958); `new z(schema.toJSON())` is only
// used by dsh-settings to build the FORM schema (and it deletes meta.volatile). Both paths
// are covered below: parseLikeHost (toJSON rehydration) + the ~standard.validate tests.
const Schema = (await import("@deepseek-ai/schemastery")).default;
const parseLikeHost = (input) => new Schema(Config.toJSON())(input);

const FIELD_COUNT = 18;
const FIELDS = [
  "enabled", "appId", "appSecretRef", "defaultPath", "openId", "accessMode", "domain",
  "requireMention", "agentOwnership", "attachSessionId", "provider", "model",
  "senderAllowlist", "groupAllowlist", "thinkingPolicy", "reasoningEffort", "appSecretPreview", "permissionPreset",
];

test("dsh-settings gate: Config exposes toJSON", () => {
  assert.equal(typeof Config.toJSON, "function");
});

test("parsed config has every field and the right defaults", () => {
  const parsed = parseLikeHost({});
  assert.deepEqual(Object.keys(parsed).sort(), [...FIELDS].sort());
  assert.equal(parsed.enabled.get(), false);
  assert.equal(parsed.domain.get(), "feishu");
  assert.equal(parsed.requireMention.get(), true);
  assert.equal(parsed.agentOwnership.get(), "owned-per-chat");
  assert.equal(parsed.accessMode.get(), "app");
  assert.equal(parsed.thinkingPolicy.get(), "cot-visible");
  assert.equal(parsed.reasoningEffort.get(), "");
  assert.deepEqual(parsed.senderAllowlist.get(), []);
});

test("every field is volatile, so the auto-form is populated", () => {
  const parsed = parseLikeHost({});
  for (const field of FIELDS) {
    assert.ok(isVolatile(parsed[field]), `field ${field} is not volatile — the form would drop it`);
  }
});

test("credential field carries role=credential-ref", () => {
  // Field metadata lives on Config.dict, not on toJSON() (toJSON() returns {uid, refs}).
  const meta = Config.dict.appSecretRef.meta;
  assert.equal(meta.role, "credential-ref");
  assert.equal(meta.default, "CONNECT_LARK_APP_SECRET");
  assert.equal(meta.volatile, true);
});

test("appSecretRef is a wrapper object after parse, NOT a string (the v5 trap)", () => {
  const parsed = parseLikeHost({});
  assert.notEqual(typeof parsed.appSecretRef, "string");
  assert.equal(typeof parsed.appSecretRef.get, "function");
  assert.equal(parsed.appSecretRef.get(), "CONNECT_LARK_APP_SECRET");
});

test("plainConfig unwraps every volatile field to plain values", () => {
  const plain = plainConfig(parseLikeHost({}));
  for (const field of FIELDS) {
    assert.ok(!isVolatile(plain[field]), `plainConfig left ${field} volatile`);
  }
  assert.equal(plain.enabled, false);
  assert.equal(plain.appId, "");
  assert.equal(plain.appSecretRef, "CONNECT_LARK_APP_SECRET");
  assert.equal(plain.domain, "feishu");
  assert.equal(plain.accessMode, "app");
  assert.deepEqual(plain.senderAllowlist, []);
});

test("plainConfig accepts an already-plain config (isVolatile is false for plain values)", () => {
  const alreadyPlain = {
    enabled: true, appId: "cli_x", appSecretRef: "CONNECT_LARK_APP_SECRET",
    defaultPath: "", openId: "ou_x", domain: "lark", requireMention: false,
    agentOwnership: "owned-per-chat", attachSessionId: "s1", provider: "p", model: "m",
    senderAllowlist: ["ou_a"], groupAllowlist: ["oc_b"], thinkingPolicy: "stream-only",
  };
  const plain = plainConfig(alreadyPlain);
  assert.equal(plain.enabled, true);
  assert.equal(plain.domain, "lark");
  assert.deepEqual(plain.senderAllowlist, ["ou_a"]);
});

test("resolveAppSecret: parsed config + mock credential seam resolves the secret", async () => {
  const ctx = { credentials: { resolve: async (ref) => ({ value: "s3cr3t" }) } };
  const out = await resolveAppSecret(ctx, parseLikeHost({}));
  assert.equal(out, "s3cr3t");
});

test("resolveAppSecret: honours a custom ref name from parsed config", async () => {
  let seen = null;
  const ctx = { credentials: { resolve: async (ref) => { seen = ref; return { value: "v" }; } } };
  const parsed = parseLikeHost({ appSecretRef: "MY_LARK_SECRET" });
  const out = await resolveAppSecret(ctx, parsed);
  assert.equal(out, "v");
  assert.equal(String(seen), "MY_LARK_SECRET");
});

test('resolveAppSecret: FAILS CLOSED on a blank resolved value (v5 returned "")', async () => {
  const ctx = { credentials: { resolve: async () => ({ value: "" }) } };
  await assert.rejects(() => resolveAppSecret(ctx, parseLikeHost({})), /unusable value/);
});

test("resolveAppSecret: FAILS CLOSED when the credential is absent", async () => {
  const ctx = { credentials: { resolve: async () => null } };
  await assert.rejects(() => resolveAppSecret(ctx, parseLikeHost({})), /unusable value/);
});

test("resolveAppSecret: FAILS CLOSED on an invalid ref name", async () => {
  const ctx = { credentials: { resolve: async () => ({ value: "x" }) } };
  await assert.rejects(
    () => resolveAppSecret(ctx, parseLikeHost({ appSecretRef: "not a valid name!" })),
    /not a valid credential/,
  );
});

test("resolveAppSecret: never returns an empty string", async () => {
  for (const ctx of [
    { credentials: { resolve: async () => ({ value: "" }) } },
    { credentials: { resolve: async () => null } },
    { credentials: { resolve: async () => undefined } },
  ]) {
    const out = await resolveAppSecret(ctx, parseLikeHost({})).then(
      (v) => v, (e) => e,
    );
    assert.ok(out instanceof Error, `expected a throw, got ${JSON.stringify(out)}`);
  }
});

test("buildUserMessage: produces a real user message with a source and an id", () => {
  const msg = buildUserMessage([{ type: "text", text: "hello" }]);
  assert.equal(msg.role, "user");
  assert.equal(msg.source?.kind, "user");
  assert.ok(msg.id);
});

test("buildUserMessage: accepts an explicit source", () => {
  const msg = buildUserMessage([{ type: "text", text: "hi" }], { kind: "user" });
  assert.equal(msg.source?.kind, "user");
});

test("inject declares every service the plugin touches", () => {
  assert.deepEqual(
    [...inject].sort(),
    ["agents", "attachments", "credentials", "llm", "permissionPresets", "sessionController", "workspaceRegistry"].sort(),
  );
});

test("CONTRACT_NOTES is exported and non-empty", () => {
  assert.ok(CONTRACT_NOTES.createAgent.includes("ctx.agents.create"));
  assert.ok(CONTRACT_NOTES.drive.includes("handle.agent.followup"));
  assert.ok(CONTRACT_NOTES.parsedUnwrap.includes("plainConfig"));
  assert.ok(CONTRACT_NOTES.failClosed.includes("never return an empty secret"));
});

test("host path: Cordis resolveConfig() output is already parsed — plainConfig handles it", () => {
  // This is the EXACT path Cordis takes: runtime.Config["~standard"].validate(raw) -> result.value.
  const raw = { enabled: true, appId: "cli_x", appSecretRef: "CONNECT_LARK_APP_SECRET" };
  const validated = Config["~standard"].validate(raw);
  assert.equal(validated.issues, undefined, "raw config should validate cleanly");
  const hostParsed = validated.value;
  // volatile field is a wrapper object, not a plain string
  assert.notEqual(typeof hostParsed.enabled, "boolean");
  assert.equal(typeof hostParsed.enabled.get, "function");
  // plainConfig must unwrap it
  const plain = plainConfig(hostParsed);
  assert.equal(plain.enabled, true);
  assert.equal(plain.appId, "cli_x");
  assert.equal(plain.appSecretRef, "CONNECT_LARK_APP_SECRET");
});

test("guard: calling Config() again on host-parsed config throws (regression for the v5/v6 comment bug)", () => {
  // Cordis passes the PARSED value to apply(). Re-validating it is wrong and throws.
  const hostParsed = Config["~standard"].validate({ enabled: true }).value;
  assert.throws(
    () => Config(hostParsed),
    /expected boolean but got \[object Object\]/,
  );
});

test("guard: resolveAppSecret accepts host-parsed config directly (no manual Config() call)", async () => {
  const hostParsed = Config["~standard"].validate({ appSecretRef: "CONNECT_LARK_APP_SECRET" }).value;
  const ctx = { credentials: { resolve: async () => ({ value: "s3cr3t" }) } };
  const out = await resolveAppSecret(ctx, hostParsed);
  assert.equal(out, "s3cr3t");
});

test("FIELDS count matches the schema (guards against drift)", () => {
  assert.equal(FIELDS.length, FIELD_COUNT);
  assert.deepEqual(Object.keys(Config.dict).sort(), [...FIELDS].sort());
});


test("apply listens for volatile updates and re-reads config before reconnecting", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../lib/index.mjs", import.meta.url), "utf8");
  assert.match(source, /ctx\.on\("loader\/volatile-update"/);
  assert.match(source, /plain\s*=\s*plainConfig\(config\)/);
});
