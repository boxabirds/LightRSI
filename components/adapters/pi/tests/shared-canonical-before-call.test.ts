/**
 * Regression matrix: adapters/shared/canonical/before-call.ts
 *
 * applyCanonicalStablePrefix(instructions, config)
 *   P1 modules.stabilizer off                → unchanged
 *   P2 blank instructions                    → unchanged
 *   P3 no volatile lines                     → unchanged
 *   P4 target developer + volatile lines     → volatile lines moved to the tail;
 *                                              equals shared applyStablePrefixToInstructions
 *   P5 target user + volatile lines          → removed from instructions, returned as userPrefix;
 *                                              equals shared applyStablePrefixToInstructions
 *   P6 dynamicContextText equals the shared rewriteTextForStablePrefix output
 * recordCanonicalStability
 *   V1 unchanged result → writes nothing
 *   V2 changed result   → appends a stability visual snapshot for the session
 * runCanonicalBeforeCallReduction (returns messages only; system text is owned by host hooks)
 *   C1 savings > 0 → returns reduced messages and records a ux-effect for the session
 *   C2 no savings  → returns the input messages array and records nothing
 *   C3 returned messages equal reduceCanonicalEnvelope's (no extra rewriting)
 * canonicalRecoveryProtocolText / withCanonicalRecoveryProtocol
 *   RP1 text equals what the shared defaultInjectRecoveryProtocol appends
 *   RP2 appended to a non-empty system prompt after a blank line
 *   RP3 already present → unchanged (idempotent)
 *   RP4 empty system prompt → the protocol alone
 *   RP5 TOKENPILOT_DISABLE_RECOVERY_PROTOCOL set → empty text, prompt unchanged
 * CANONICAL_IDENTITY_CODEC / createCanonicalEnvelope
 *   I1 encode/decode are identities
 *   I2 envelope fields: host identity, session id, optional turn id, single session mode
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configureStatePathResolver } from "@lightrsi/artifact-store";
import { createStaticStatePathResolver, defaultInjectRecoveryProtocol, readLatestUxEffect } from "@lightrsi/host-adapter";
import { applyStablePrefixToInstructions, rewriteTextForStablePrefix } from "@lightrsi/stabilizer";

import {
  CANONICAL_IDENTITY_CODEC,
  applyCanonicalStablePrefix,
  canonicalRecoveryProtocolText,
  withCanonicalRecoveryProtocol,
  createCanonicalEnvelope,
  recordCanonicalStability,
  runCanonicalBeforeCallReduction,
} from "../../shared/canonical/before-call.js";
import { normalizeCanonicalAdapterConfig } from "../../shared/canonical/config.js";
import { reduceCanonicalEnvelope } from "../../shared/canonical/reduction.js";

const VOLATILE_PROMPT = [
  "You are a coding agent.",
  "Today's date: Mon Sep 28 2026",
  "Follow the repository conventions.",
].join("\n");
const STABLE_PROMPT = "You are a coding agent.\nFollow the repository conventions.";
const BIG = Array.from({ length: 3000 }, (_, i) => `line ${i} output from build step ok`).join("\n");

async function freshState(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tp-bc-"));
  configureStatePathResolver(createStaticStatePathResolver({ hostId: "pi", displayName: "pi", stateDir: dir, namespaceDir: "tokenpilot" }));
  return dir;
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out.push(join(entry.parentPath ?? "", entry.name));
  }
  return out;
}

const cfg = (stateDir: string, raw: Record<string, unknown> = {}) => normalizeCanonicalAdapterConfig({ ...raw, stateDir }, { defaultStateDir: stateDir });

describe("applyCanonicalStablePrefix", () => {
  let stateDir = "";
  before(async () => { stateDir = await freshState(); });

  it("P1 stabilizer off leaves the prompt unchanged", () => {
    const out = applyCanonicalStablePrefix(VOLATILE_PROMPT, cfg(stateDir, { modules: { stabilizer: false } }));
    assert.deepEqual(out, { changed: false, instructions: VOLATILE_PROMPT, dynamicContextText: "" });
  });
  it("P2 blank instructions are unchanged", () => {
    assert.equal(applyCanonicalStablePrefix("   ", cfg(stateDir)).changed, false);
  });
  it("P3 a prompt without volatile lines is unchanged", () => {
    assert.deepEqual(applyCanonicalStablePrefix(STABLE_PROMPT, cfg(stateDir)), { changed: false, instructions: STABLE_PROMPT, dynamicContextText: "" });
  });
  it("P4 developer target moves volatile lines to the tail, like the shared stabilizer", () => {
    const out = applyCanonicalStablePrefix(VOLATILE_PROMPT, cfg(stateDir));
    const shared = applyStablePrefixToInstructions({
      envelope: { session: { host: { hostId: "x" } }, model: "", instructions: VOLATILE_PROMPT, messages: [{ role: "user", content: "" }] },
      dynamicContextTarget: "developer",
      mergeDynamicContextIntoInstructions: true,
    });
    assert.equal(out.changed, true);
    assert.equal(out.instructions, shared.instructions);
    assert.ok(out.instructions.startsWith(STABLE_PROMPT));
    assert.ok(out.instructions.endsWith("Today's date: Mon Sep 28 2026"));
    assert.equal(out.userPrefix, undefined);
  });
  it("P5 user target removes volatile lines and returns them for the first user message", () => {
    const out = applyCanonicalStablePrefix(VOLATILE_PROMPT, cfg(stateDir, { hooks: { dynamicContextTarget: "user" } }));
    const shared = applyStablePrefixToInstructions({
      envelope: { session: { host: { hostId: "x" } }, model: "", instructions: VOLATILE_PROMPT, messages: [{ role: "user", content: "" }] },
      dynamicContextTarget: "user",
    });
    assert.equal(out.instructions, shared.instructions);
    assert.ok(!out.instructions.includes("Today's date"));
    assert.equal(out.userPrefix, "Today's date: Mon Sep 28 2026");
  });
  it("P6 dynamicContextText matches the shared rewrite", () => {
    assert.equal(applyCanonicalStablePrefix(VOLATILE_PROMPT, cfg(stateDir)).dynamicContextText, rewriteTextForStablePrefix(VOLATILE_PROMPT).dynamicContextText);
  });
});

describe("recordCanonicalStability", () => {
  it("V1 an unchanged result writes nothing", async () => {
    const stateDir = await freshState();
    await recordCanonicalStability({
      config: cfg(stateDir), sessionId: "s", model: "m", before: STABLE_PROMPT,
      result: { changed: false, instructions: STABLE_PROMPT, dynamicContextText: "" },
    });
    assert.deepEqual(await listFiles(stateDir), []);
  });
  it("V2 a changed result appends a stability snapshot", async () => {
    const stateDir = await freshState();
    const result = applyCanonicalStablePrefix(VOLATILE_PROMPT, cfg(stateDir));
    await recordCanonicalStability({ config: cfg(stateDir), sessionId: "s-stab", model: "m", before: VOLATILE_PROMPT, result });
    const files = await listFiles(stateDir);
    assert.ok(files.some((file) => file.includes("stability")), files.join(","));
  });
});

describe("runCanonicalBeforeCallReduction", () => {
  const toolEnvelope = (sessionId: string, text: string) => createCanonicalEnvelope({
    hostId: "pi", displayName: "pi", sessionId, model: "m",
    messages: [
      { role: "user", content: "build" },
      { role: "assistant", content: [{ type: "tool_call", toolCallId: "c1", toolName: "bash" }] },
      { role: "tool", content: [{ type: "tool_result", toolCallId: "c1", toolName: "bash", status: "success", text }] },
    ],
  });

  it("C1 savings return reduced messages and record a ux-effect", async () => {
    const stateDir = await freshState();
    const env = toolEnvelope("s-ux", BIG);
    const out = await runCanonicalBeforeCallReduction({ envelope: env, config: cfg(stateDir) });
    assert.ok((out.summary?.savedChars ?? 0) > 0);
    assert.notEqual(out.messages, env.messages);
    const latest = await readLatestUxEffect(stateDir);
    assert.equal(latest?.sessionId, "s-ux");
    assert.equal(latest?.savedCount, out.summary?.savedChars);
  });
  it("C2 no savings return the input messages and record nothing", async () => {
    const stateDir = await freshState();
    const env = toolEnvelope("s-none", "short");
    const out = await runCanonicalBeforeCallReduction({ envelope: env, config: cfg(stateDir) });
    assert.equal(out.messages, env.messages);
    assert.equal(await readLatestUxEffect(stateDir), null);
  });
  it("C3 the result equals reduceCanonicalEnvelope's modulo the archive path", async () => {
    const stateDir = await freshState();
    const env = toolEnvelope("s-eq", BIG);
    const viaPipeline = await runCanonicalBeforeCallReduction({ envelope: env, config: cfg(stateDir) });
    const direct = await reduceCanonicalEnvelope({ envelope: env, config: cfg(stateDir) });
    const strip = (value: unknown) => JSON.stringify(value).replace(/Archive: [^"\\]*/g, "Archive: <path>");
    assert.equal(strip(viaPipeline.messages), strip(direct.envelope.messages));
  });
});

describe("recovery protocol", () => {
  const sharedText = () => defaultInjectRecoveryProtocol(createCanonicalEnvelope({
    hostId: "x", displayName: "x", sessionId: "s", model: "m", instructions: "", messages: [],
  })).instructions;
  it("RP1 text equals the shared injector's", () => {
    assert.equal(canonicalRecoveryProtocolText(), sharedText());
    assert.ok(canonicalRecoveryProtocolText().startsWith("[Recovery Protocol]"));
  });
  it("RP2 appended after a blank line to a non-empty prompt", () => {
    assert.deepEqual(withCanonicalRecoveryProtocol("SYS"), { changed: true, text: `SYS\n\n${canonicalRecoveryProtocolText()}` });
  });
  it("RP3 idempotent when already present", () => {
    const once = withCanonicalRecoveryProtocol("SYS").text;
    assert.deepEqual(withCanonicalRecoveryProtocol(once), { changed: false, text: once });
  });
  it("RP4 an empty prompt becomes the protocol alone", () => {
    assert.deepEqual(withCanonicalRecoveryProtocol(""), { changed: true, text: canonicalRecoveryProtocolText() });
  });
  it("RP5 the disable env var turns injection off", () => {
    const previous = process.env.TOKENPILOT_DISABLE_RECOVERY_PROTOCOL;
    process.env.TOKENPILOT_DISABLE_RECOVERY_PROTOCOL = "1";
    try {
      assert.equal(canonicalRecoveryProtocolText(), "");
      assert.deepEqual(withCanonicalRecoveryProtocol("SYS"), { changed: false, text: "SYS" });
    } finally {
      if (previous === undefined) delete process.env.TOKENPILOT_DISABLE_RECOVERY_PROTOCOL;
      else process.env.TOKENPILOT_DISABLE_RECOVERY_PROTOCOL = previous;
    }
  });
});

describe("identity codec and envelope factory", () => {
  it("I1 encode and decode are identities", () => {
    const env = createCanonicalEnvelope({ hostId: "pi", displayName: "pi", sessionId: "s", model: "m", messages: [] });
    assert.equal(CANONICAL_IDENTITY_CODEC.encodeRequest(env), env);
    assert.equal(CANONICAL_IDENTITY_CODEC.decodeRequest(env), env);
  });
  it("I2 envelope fields", () => {
    const withTurn = createCanonicalEnvelope({ hostId: "pi", displayName: "pi", sessionId: "s", turnId: "t1", model: "m", instructions: "sys", messages: [] });
    assert.deepEqual(withTurn.session, { host: { hostId: "pi", displayName: "pi" }, sessionId: "s", turnId: "t1", sessionMode: "single" });
    assert.equal(withTurn.instructions, "sys");
    const withoutTurn = createCanonicalEnvelope({ hostId: "pi", displayName: "pi", sessionId: "s", model: "m", messages: [] });
    assert.equal("turnId" in withoutTurn.session, false);
    assert.equal("instructions" in withoutTurn, false);
  });
});
