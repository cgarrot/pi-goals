// test/e2e-regressions.test.ts — v0.1.x fix batch regressions (TDD, red first).
//
// Every test mirrors the EXACT evidence from the pi-goals E2E session
// 2026-08-14T18-43-00 (playground store; the fix batch #2 section at the
// bottom mirrors session 2026-08-14T21-02-40):
//   BUG-3  needs_review deadlock: add_goal_todo can CREATE needs_review, but
//          block failed claim_required (no bound claim) and every other exit
//          was rejected → no legal escape. claim_returned-without-claim had
//          the same shape.
//   BUG-2  accept_goal_todo_claim accepted an oracle_required claim whose only
//          validation was WARN (autoAccept false displayed but not binding).
//   BUG-1  validate_goal_todo_claim with agent:"oracle" → store_write_failed
//          "claim_validated validation is malformed" (parser rejected agent).
//   BUG-4  blockingIssues persisted CLEARTEXT in claims.log.jsonl (the only
//          unhashed text field in the claims pipeline).
//   SCHEMA-1  cas revision slots declared optional but required in practice
//          by create_goal/add_goal_todos/validate/accept/record_goal_oracle/
//          update_goal (zob parity: absent slot = unchecked).
//   GAP-1/2/4  no link_goal_todo_delegation/return_goal_todo_claim tools, no
//          bin CLI entry, update_goal_todo status stripped silently, empty
//          tree propose listed ZERO blockers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntimeGoalEngine } from "../src/runtime/engine.js";
import type { GoalEngineError, GoalRuntimeEngine } from "../src/runtime/engine.js";
import { buildGoalTodoClaimHash } from "../src/core/claims.js";
import { summarizeGoalTodos } from "../src/core/tree.js";
import type { GoalTodoNode } from "../src/core/types.js";
import { renderGoalTodoTree } from "../src/extension/hud.js";
import { parseClaimValidationRecord } from "../src/store/events.js";
import { goalStorePaths } from "../src/store/log.js";
import goalsExtension from "../src/extension/index.js";
import type { GoalsRuntime } from "../src/extension/tools.js";
import type { ExtensionAPI, SessionContext, ToolDefinition, ToolResult } from "../src/extension/pi-types.js";

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Engine harness (same style as runtime-engine.test.ts)
// ---------------------------------------------------------------------------

interface EngineHarness {
  engine: GoalRuntimeEngine;
  stateDir: string;
}

let mutationCounter = 0;

function makeEngineHarness(): EngineHarness {
  const stateDir = mkdtempSync(path.join(tmpdir(), "pi-goals-reg-state-"));
  const runtimeDir = mkdtempSync(path.join(tmpdir(), "pi-goals-reg-runtime-"));
  let now = 1_700_000_000_000;
  let seed = 0;
  const engine = createRuntimeGoalEngine({
    stateDir,
    runtimeDir,
    clock: (): number => (now += 1_000),
    randomBytes: (count: number): Uint8Array => {
      const bytes = new Uint8Array(count);
      seed += 1;
      for (let index = 0; index < count; index += 1) bytes[index] = (seed * 31 + index * 17) % 256;
      return bytes;
    },
  });
  return { engine, stateDir };
}

function cas(tag: string): { mutationId: string } {
  mutationCounter += 1;
  return { mutationId: `reg-${tag}-${mutationCounter}` };
}

function engineFailure(outcome: { ok: boolean }): GoalEngineError {
  assert.equal(outcome.ok, false, `expected engine failure: ${JSON.stringify(outcome)}`);
  return outcome as GoalEngineError;
}

function readJsonl(filePath: string): Record<string, unknown>[] {
  try {
    const text = readFileSync(filePath, "utf8");
    return text === "" ? [] : text.split("\n").slice(0, -1).map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function claimsLogText(h: EngineHarness, goalId: string): string {
  return readFileSync(goalStorePaths(h.stateDir, goalId).claimsLog, "utf8");
}

// ---------------------------------------------------------------------------
// Tool harness (same fake-API pattern as extension.test.ts)
// ---------------------------------------------------------------------------

interface ToolHarness {
  tools: Map<string, ToolDefinition>;
  hooks: Map<string, Array<(event: unknown, ctx: SessionContext) => unknown>>;
  ctx: SessionContext;
  stateDir: string;
  runtimeDir: string;
  getRuntime: () => GoalsRuntime | null;
}

function makeToolHarness(): ToolHarness {
  const stateDir = mkdtempSync(path.join(tmpdir(), "pi-goals-reg-ext-"));
  const runtimeDir = mkdtempSync(path.join(tmpdir(), "pi-goals-reg-ext-run-"));
  const tools = new Map<string, ToolDefinition>();
  const hooks = new Map<string, Array<(event: unknown, ctx: SessionContext) => unknown>>();
  const pi: ExtensionAPI = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: (event, handler) => {
      const list = hooks.get(event) ?? [];
      list.push(handler);
      hooks.set(event, list);
    },
    appendEntry: () => {},
  };
  const ctx: SessionContext = {
    cwd: stateDir,
    sessionManager: { getSessionId: () => "sess-reg" },
    ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
  };
  let now = 1_800_000_000_000;
  let seed = 0;
  const ext = goalsExtension(pi, {
    stateDir,
    runtimeDir,
    clock: (): number => (now += 1_000),
    randomBytes: (count: number): Uint8Array => {
      const bytes = new Uint8Array(count);
      seed += 1;
      for (let index = 0; index < count; index += 1) bytes[index] = (seed * 37 + index * 13) % 256;
      return bytes;
    },
  });
  return { tools, hooks, ctx, stateDir, runtimeDir, getRuntime: ext.getRuntime };
}

function startSession(h: ToolHarness): void {
  const handlers = h.hooks.get("session_start");
  assert.ok(handlers !== undefined && handlers.length > 0);
  handlers[0]!(undefined, h.ctx);
}

async function callTool(h: ToolHarness, name: string, params: Record<string, unknown>): Promise<ToolResult> {
  const tool = h.tools.get(name);
  assert.ok(tool !== undefined, `tool ${name} registered`);
  return tool.execute("tc-reg", params, undefined, undefined, h.ctx);
}

function textOf(result: ToolResult): string {
  assert.ok(result.content[0] !== undefined);
  return result.content[0]!.type === "text" ? result.content[0]!.text : "";
}

function detailsOf(result: ToolResult): Record<string, unknown> {
  assert.ok(result.details !== undefined);
  return result.details!;
}

// ---------------------------------------------------------------------------
// FIX-1 (BUG-3): needs_review / claim-bearing-state block deadlock escape
// ---------------------------------------------------------------------------

test("FIX-1 engine: needs_review created via add_goal_todo blocks, reopens, and completes (session deadlock escape)", () => {
  const h = makeEngineHarness();
  const created = h.engine.createGoal("Goal", cas("create"));
  assert.ok(created.ok);
  const goalId = created.result.goalId;

  // session evidence: add_goal_todo can CREATE needs_review directly
  const added = h.engine.addTodos([{ input: { title: "review me", status: "needs_review", required: true } }], cas("add"));
  assert.ok(added.ok);

  // session evidence: block used to fail claim_required here (no bound claim)
  const blocked = h.engine.resolveTodo({ todoPath: "1" }, "block", { reason: "waiting on external review" }, cas("block"));
  assert.ok(blocked.ok, `block must escape needs_review without a claim: ${!blocked.ok ? blocked.message : ""}`);
  assert.equal(blocked.result.node.status, "blocked");

  const reopened = h.engine.resolveTodo({ todoPath: "1" }, "reopen", { reason: "review resolved" }, cas("reopen"));
  assert.ok(reopened.ok);
  assert.equal(reopened.result.node.status, "ready");

  const completed = h.engine.resolveTodo({ todoPath: "1" }, "complete", {}, cas("complete"));
  assert.ok(completed.ok);
  assert.equal(completed.result.node.status, "done");
  assert.equal(h.engine.getGoal(goalId).goal?.summary.done, 1);
});

test("FIX-1 engine: claim_returned WITHOUT a bound claim blocks freely; WITH a bound claim stays claim_resolution_required", () => {
  const h = makeEngineHarness();
  assert.ok(h.engine.createGoal("Goal", cas("create")).ok);

  // synthetic claim_returned without a delegation binding (add_goal_todo path)
  assert.ok(h.engine.addTodos([{ input: { title: "synthetic", status: "claim_returned" } }], cas("add")).ok);
  const blocked = h.engine.resolveTodo({ todoPath: "1" }, "block", { reason: "no real claim bound" }, cas("block"));
  assert.ok(blocked.ok, `claim_returned WITHOUT a claim must block: ${!blocked.ok ? blocked.message : ""}`);
  assert.equal(blocked.result.node.status, "blocked");

  // real bound claim: D3 preserved — accept_claim or reject_claim only
  assert.ok(h.engine.addTodos([{ input: { title: "delegated work" } }], cas("add2")).ok);
  const linked = h.engine.linkDelegation({ todoPath: "2" }, { validationPolicy: "parent_review" }, cas("link"));
  assert.ok(linked.ok);
  const returned = h.engine.returnClaim(linked.result.attempt.attemptId, { claimText: "done" }, cas("return"));
  assert.ok(returned.ok);
  const refused = engineFailure(h.engine.resolveTodo({ todoPath: "2" }, "block", { reason: "bury the claim" }, cas("block2")));
  assert.equal(refused.code, "transition_rejected");
  assert.equal(refused.transitionCode, "claim_resolution_required");
});

// ---------------------------------------------------------------------------
// FIX-2 (BUG-2): oracle_required accept gate enforcement
// ---------------------------------------------------------------------------

test("FIX-2 engine: oracle_required accept after a WARN validation is rejected; strict PASS on a fresh attempt accepts", () => {
  const h = makeEngineHarness();
  assert.ok(h.engine.createGoal("Goal", cas("create")).ok);
  assert.ok(h.engine.addTodos([{ input: { title: "Tests unitaires", required: true } }], cas("add")).ok);

  const linked = h.engine.linkDelegation({ todoPath: "1" }, { validationPolicy: "oracle_required" }, cas("link"));
  assert.ok(linked.ok);
  const attempt = linked.result.attempt.attemptId;
  const claimHash = buildGoalTodoClaimHash("tests shipped");
  assert.ok(h.engine.returnClaim(attempt, { claimHash }, cas("return")).ok);

  // session evidence: WARN validation displayed autoAccept false…
  const warned = h.engine.recordClaimValidation(attempt, {
    verdict: "WARN",
    recommendedAction: "needs_review",
    noShip: false,
    confidence: "MEDIUM",
    outputHash: sha256("out-warn"),
  }, cas("validate"));
  assert.ok(warned.ok);
  assert.equal(warned.result.claimRule.autoAccept, false);

  // …but accept USED to succeed anyway (BUG-2). Now it must be rejected.
  const refused = engineFailure(h.engine.resolveTodo({ todoPath: "1" }, "accept_claim", { claimHash, attemptId: attempt, validationPolicy: "oracle_required" }, cas("accept-warn")));
  assert.equal(refused.code, "claim_error");
  assert.equal(refused.claimCode, "claim_validation_not_pass");
  assert.equal(refused.retryPolicy, "after_context_change");
  // the node must STILL be claim_returned (no half-applied transition)
  const view = h.engine.getGoal();
  assert.ok(view.goal);
  assert.equal(view.goal.nodes[0]!.status, "claim_returned");
  assert.equal(view.goal.claims.settlements[attempt], undefined);

  // recover: reject the WARN claim, re-delegate, strict PASS, then accept
  assert.ok(h.engine.resolveTodo({ todoPath: "1" }, "reject_claim", { claimHash, attemptId: attempt, validationPolicy: "oracle_required", reason: "WARN is not shippable" }, cas("reject")).ok);
  const relinked = h.engine.linkDelegation({ todoPath: "1" }, { validationPolicy: "oracle_required" }, cas("relink"));
  assert.ok(relinked.ok);
  const attempt2 = relinked.result.attempt.attemptId;
  const claimHash2 = buildGoalTodoClaimHash("tests shipped strictly");
  assert.ok(h.engine.returnClaim(attempt2, { claimHash: claimHash2 }, cas("return2")).ok);
  const passed = h.engine.recordClaimValidation(attempt2, {
    verdict: "PASS",
    recommendedAction: "accept_claim",
    noShip: false,
    confidence: "HIGH",
    outputHash: sha256("out-pass"),
  }, cas("validate2"));
  assert.ok(passed.ok);
  assert.equal(passed.result.claimRule.autoAccept, true);

  const accepted = h.engine.resolveTodo({ todoPath: "1" }, "accept_claim", { claimHash: claimHash2, attemptId: attempt2, validationPolicy: "oracle_required" }, cas("accept-pass"));
  assert.ok(accepted.ok);
  assert.equal(accepted.result.node.status, "done");
  assert.equal(accepted.result.settlement?.settlement, "accepted");
});

test("FIX-2 core: parent_review claims keep manual accept (no oracle record required)", () => {
  const h = makeEngineHarness();
  assert.ok(h.engine.createGoal("Goal", cas("create")).ok);
  assert.ok(h.engine.addTodos([{ input: { title: "reviewed by parent" } }], cas("add")).ok);
  const linked = h.engine.linkDelegation({ todoPath: "1" }, { validationPolicy: "parent_review" }, cas("link"));
  assert.ok(linked.ok);
  const attempt = linked.result.attempt.attemptId;
  const claimHash = buildGoalTodoClaimHash("parent reviewed this text");
  assert.ok(h.engine.returnClaim(attempt, { claimHash }, cas("return")).ok);
  const accepted = h.engine.resolveTodo({ todoPath: "1" }, "accept_claim", { claimHash, attemptId: attempt, validationPolicy: "parent_review" }, cas("accept"));
  assert.ok(accepted.ok);
  assert.equal(accepted.result.node.status, "done");
});

// ---------------------------------------------------------------------------
// FIX-3 (BUG-1): agent/run_id provenance persistence
// ---------------------------------------------------------------------------

test("FIX-3 engine: validate_goal_todo_claim with agent 'oracle' and run_id persists and round-trips", () => {
  const h = makeEngineHarness();
  const created = h.engine.createGoal("Goal", cas("create"));
  assert.ok(created.ok);
  const goalId = created.result.goalId;
  assert.ok(h.engine.addTodos([{ input: { title: "work" } }], cas("add")).ok);
  const linked = h.engine.linkDelegation({ todoPath: "1" }, { runId: "run-42", agent: "child", validationPolicy: "oracle_required" }, cas("link"));
  assert.ok(linked.ok);
  const attempt = linked.result.attempt.attemptId;
  assert.ok(h.engine.returnClaim(attempt, { claimText: "done with provenance" }, cas("return")).ok);

  // session evidence: agent:"oracle" used to fail store_write_failed
  const validated = h.engine.recordClaimValidation(attempt, {
    verdict: "PASS",
    recommendedAction: "accept_claim",
    noShip: false,
    confidence: "HIGH",
    outputHash: sha256("prov"),
    agent: "oracle",
    runId: "run-42",
  }, cas("validate"));
  assert.ok(validated.ok, `validate with agent must persist: ${!validated.ok ? validated.message : ""}`);
  assert.equal(validated.result.validation.agent, "oracle");
  assert.equal(validated.result.validation.runId, "run-42");

  // the persisted claim_validated line parses and round-trips through restore
  const logText = claimsLogText(h, goalId);
  assert.match(logText, /claim_validated/);
  const line = readJsonl(goalStorePaths(h.stateDir, goalId).claimsLog).find((entry) => entry.kind === "claim_validated");
  assert.ok(line);
  const validation = (line.data as { validation: unknown }).validation;
  const parsed = parseClaimValidationRecord(validation);
  assert.ok(parsed, "persisted claim_validated record must be canonical");
  assert.equal(parsed.agent, "oracle");
  assert.equal(parsed.runId, "run-42");
  const view = h.engine.getGoal(goalId);
  assert.ok(view.goal);
  assert.equal(view.goal.claims.validations[attempt]?.agent, "oracle");
  assert.equal(view.goal.claims.validations[attempt]?.runId, "run-42");
});

test("FIX-3 parser: legacy claim_validated lines without agent/run_id still parse", () => {
  const legacy = {
    validationVersion: 1,
    attemptId: "attempt-legacy",
    claimHash: "a".repeat(64),
    validationPolicy: "oracle_required",
    status: "passed",
    verdict: "PASS",
    recommendedAction: "accept_claim",
    noShip: false,
    confidence: "HIGH",
    blockingIssuesHash: sha256("[]"),
    blockingIssuesCount: 0,
    outputHash: "b".repeat(64),
    evidenceRefs: [],
    validationCommands: [],
    validatedAt: 1,
  };
  const parsed = parseClaimValidationRecord(legacy);
  assert.ok(parsed);
  assert.equal(parsed.agent, undefined);
  assert.equal(parsed.runId, undefined);
});

// ---------------------------------------------------------------------------
// FIX-4 (BUG-4): blockingIssues stored hash-only
// ---------------------------------------------------------------------------

test("FIX-4 engine: blocking issues persist as hash+count only — cleartext never reaches the store", () => {
  const h = makeEngineHarness();
  const created = h.engine.createGoal("Goal", cas("create"));
  assert.ok(created.ok);
  const goalId = created.result.goalId;
  assert.ok(h.engine.addTodos([{ input: { title: "work" } }], cas("add")).ok);
  const linked = h.engine.linkDelegation({ todoPath: "1" }, { validationPolicy: "oracle_required" }, cas("link"));
  assert.ok(linked.ok);
  const attempt = linked.result.attempt.attemptId;
  assert.ok(h.engine.returnClaim(attempt, { claimText: "partial" }, cas("return")).ok);

  // session evidence cleartext: division-by-zero coverage gap
  const cleartext = "Couverture des cas limites insuffisante (division par zéro non testée)";
  const validated = h.engine.recordClaimValidation(attempt, {
    verdict: "WARN",
    recommendedAction: "needs_review",
    noShip: false,
    confidence: "MEDIUM",
    blockingIssues: [cleartext],
    outputHash: sha256("out"),
  }, cas("validate"));
  assert.ok(validated.ok);

  const logText = claimsLogText(h, goalId);
  // the persisted line carries the hash + count…
  assert.match(logText, /"blockingIssuesHash":"[a-f0-9]{64}"/);
  assert.match(logText, /"blockingIssuesCount":1/);
  assert.equal(validated.result.validation.blockingIssuesHash, sha256(JSON.stringify([cleartext])));
  assert.equal(validated.result.validation.blockingIssuesCount, 1);
  // …and NEVER the cleartext anywhere in the store
  assert.ok(!logText.includes("division par zéro"), "cleartext blocking issue must not appear in claims.log.jsonl");
  const storeRoot = path.dirname(goalStorePaths(h.stateDir, goalId).claimsLog);
  for (const file of readdirSync(storeRoot, { recursive: true })) {
    const full = path.join(storeRoot, String(file));
    if (!statSync(full).isFile()) continue;
    if (!/\.(jsonl|json)$/.test(full)) continue;
    assert.ok(!readFileSync(full, "utf8").includes("division par zéro"), `${file} must stay hash-only`);
  }
});

test("FIX-4 parser: legacy cleartext blockingIssues lines still parse (v0.1.x back-compat)", () => {
  const legacyCleartext = {
    validationVersion: 1,
    attemptId: "attempt-legacy",
    claimHash: "a".repeat(64),
    validationPolicy: "oracle_required",
    status: "blocked",
    verdict: "WARN",
    recommendedAction: "needs_review",
    noShip: false,
    confidence: "MEDIUM",
    blockingIssues: ["legacy cleartext blocker"],
    outputHash: "b".repeat(64),
    evidenceRefs: [],
    validationCommands: [],
    validatedAt: 1,
  };
  const parsed = parseClaimValidationRecord(legacyCleartext);
  assert.ok(parsed, "legacy cleartext blockingIssues must keep parsing within v0.1.x");
  assert.equal(parsed.blockingIssuesHash, sha256(JSON.stringify(["legacy cleartext blocker"])));
  assert.equal(parsed.blockingIssuesCount, 1);
});

// ---------------------------------------------------------------------------
// FIX-5 (SCHEMA-1): cas fully optional (zob parity)
// ---------------------------------------------------------------------------

test("FIX-5 engine: every mutation succeeds with mutation_id only (no revision slots)", () => {
  const h = makeEngineHarness();
  // create_goal without expectedGoalRevision (session: cas_invalid before)
  const created = h.engine.createGoal("Goal", cas("create"));
  assert.ok(created.ok, `create_goal must work without expectedGoalRevision: ${!created.ok ? created.message : ""}`);

  // add_goal_todos without expectedGraphRevision (session: cas_invalid before)
  const added = h.engine.addTodos([{ input: { title: "A", required: true } }, { input: { title: "B", required: false } }], cas("add"));
  assert.ok(added.ok, `add_goal_todos must work without expectedGraphRevision: ${!added.ok ? added.message : ""}`);

  assert.ok(h.engine.resolveTodo({ todoPath: "1" }, "complete", {}, cas("complete")).ok);
  assert.ok(h.engine.resolveTodo({ todoPath: "2" }, "skip", { reason: "optional" }, cas("skip")).ok);

  // propose_goal_completion without revision slots (session: cas_invalid before)
  const proposed = h.engine.proposeCompletion({
    completionSummary: "done",
    requirementsChecked: ["r"],
    evidenceRefs: ["e"],
    validationCommands: ["npm test"],
    knownRisks: [],
    noShip: false,
  }, cas("propose"));
  assert.ok(proposed.ok, `propose must work cas-less: ${!proposed.ok ? proposed.message : ""}`);

  // record_goal_oracle without revision slots (session: cas_invalid before)
  const oracle = h.engine.recordOracleDecision({ verdict: "PASS", noShip: false, evidenceSummary: "checked" }, cas("oracle"));
  assert.ok(oracle.ok, `record_goal_oracle must work cas-less: ${!oracle.ok ? oracle.message : ""}`);

  // update_goal (complete) without revision slots (session: cas_invalid before)
  const completed = h.engine.completeGoal(cas("complete-goal"), {
    expectedProposalHash: proposed.result.proposal?.proposalHash,
    expectedOracleDecisionHash: oracle.result.decision.oracleDecisionHash,
  });
  assert.ok(completed.ok, `update_goal must work cas-less: ${!completed.ok ? completed.message : ""}`);
  assert.equal(completed.result.goal.status, "complete");
});

test("FIX-5 engine: cas entirely absent works (auto-generated non-replayed mutation ids)", () => {
  const h = makeEngineHarness();
  const created = h.engine.createGoal("No cas at all");
  assert.ok(created.ok, `create_goal must work with NO cas: ${!created.ok ? created.message : ""}`);
  const added = h.engine.addTodos([{ input: { title: "X" } }], undefined);
  assert.ok(added.ok, `add_goal_todos must work with NO cas: ${!added.ok ? added.message : ""}`);
  const resolved = h.engine.resolveTodo({ todoPath: "1" }, "complete", {}, undefined);
  assert.ok(resolved.ok, `complete must work with NO cas: ${!resolved.ok ? resolved.message : ""}`);
});

test("FIX-5 engine: a PROVIDED wrong revision slot still rejects with the friendly current-revision hint", () => {
  const h = makeEngineHarness();
  assert.ok(h.engine.createGoal("Goal", cas("create")).ok);
  const stale = engineFailure(h.engine.addTodos([{ input: { title: "X" } }], { ...cas("add-stale"), expectedGraphRevision: 99 }));
  assert.equal(stale.code, "cas_stale");
  assert.deepEqual([...stale.staleCodes ?? []], ["stale_graph_revision"]);
  assert.match(stale.message, /current todos revision 0/);
});

test("FIX-5 engine: mutation_id-only replay stays idempotent", () => {
  const h = makeEngineHarness();
  assert.ok(h.engine.createGoal("Goal", cas("create")).ok);
  const guard = cas("replayable");
  const first = h.engine.addTodos([{ input: { title: "Once" } }], guard);
  assert.ok(first.ok);
  assert.equal(first.status, "applied");
  const second = h.engine.addTodos([{ input: { title: "Once" } }], guard);
  assert.ok(second.ok);
  assert.equal(second.status, "replayed");
  assert.equal(second.result.created.length, 0);
});

// ---------------------------------------------------------------------------
// FIX-6 (GAP-1/2/4): delegation tools, CLI packaging, status rejection, empty tree
// ---------------------------------------------------------------------------

test("FIX-6a tools: link_goal_todo_delegation and return_goal_todo_claim are registered and drive the full claim flow", async () => {
  const h = makeToolHarness();
  const names = [...h.tools.keys()];
  assert.ok(names.includes("link_goal_todo_delegation"), "link_goal_todo_delegation registered");
  assert.ok(names.includes("return_goal_todo_claim"), "return_goal_todo_claim registered");
  startSession(h);

  const created = await callTool(h, "create_goal", { objective: "Delegation surface", cas: { mutation_id: "d1" } });
  assert.match(textOf(created), /^created goal_/);
  const added = await callTool(h, "add_goal_todos", { todos: [{ title: "Delegated work", required: true }], cas: { mutation_id: "d2" } });
  assert.match(textOf(added), /added 1 todo/);

  const linked = await callTool(h, "link_goal_todo_delegation", {
    todo_path: "1",
    run_id: "run-d1",
    agent: "worker-1",
    validation_policy: "oracle_required",
    cas: { mutation_id: "d3" },
  });
  assert.match(textOf(linked), /delegated/);
  const attemptId = detailsOf(linked).attemptId as string | undefined;
  assert.ok(typeof attemptId === "string" && attemptId.length > 0, "link result exposes the attempt id");

  const claimText = "child delivered the module; npm test green";
  const returned = await callTool(h, "return_goal_todo_claim", {
    expected_attempt_id: attemptId,
    claim_text: claimText,
    evidence_refs: ["reports/claim.txt"],
    no_ship: false,
    cas: { mutation_id: "d4" },
  });
  assert.match(textOf(returned), /claim_returned/);

  const validated = await callTool(h, "validate_goal_todo_claim", {
    todo_path: "1",
    claim_hash: sha256(claimText),
    expected_attempt_id: attemptId,
    expected_validation_policy: "oracle_required",
    verdict: "PASS",
    recommended_action: "accept_claim",
    no_ship: false,
    confidence: "HIGH",
    output_hash: sha256("out-d"),
    agent: "oracle",
    cas: { mutation_id: "d5" },
  });
  assert.match(textOf(validated), /autoAccept true/);

  const accepted = await callTool(h, "accept_goal_todo_claim", {
    todo_path: "1",
    expected_claim_hash: sha256(claimText),
    expected_attempt_id: attemptId,
    expected_validation_policy: "oracle_required",
    cas: { mutation_id: "d6" },
  });
  assert.match(textOf(accepted), /claim accepted/);
});

test("FIX-6c tools: update_goal_todo with a status parameter is explicitly rejected (no silent strip)", async () => {
  const h = makeToolHarness();
  startSession(h);
  await callTool(h, "create_goal", { objective: "Status rejection", cas: { mutation_id: "s0" } });
  await callTool(h, "add_goal_todo", { title: "Todo", cas: { mutation_id: "s1" } });
  const rejected = await callTool(h, "update_goal_todo", { todo_path: "1", status: "done", cas: { mutation_id: "s2" } });
  assert.match(textOf(rejected), /fix_input/);
  assert.match(textOf(rejected), /resolve_goal_todo/);
  assert.equal(detailsOf(rejected).parameter, "status");
  // schema declares status so hosts never strip it before the executor
  const tool = h.tools.get("update_goal_todo")!;
  const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
  assert.ok(props.status !== undefined, "update_goal_todo schema declares status explicitly");
});

test("FIX-6d engine: empty-tree propose lists an explicit 'todo tree is empty' blocker", () => {
  const h = makeEngineHarness();
  assert.ok(h.engine.createGoal("Empty", cas("create")).ok);
  const refused = engineFailure(h.engine.proposeCompletion({
    completionSummary: "nothing to do",
    requirementsChecked: [],
    evidenceRefs: [],
    validationCommands: [],
    knownRisks: [],
    noShip: false,
  }, cas("propose")));
  assert.equal(refused.code, "completion_not_ready");
  const blockers = refused.blockers ?? [];
  assert.ok(blockers.length > 0, "empty-tree rejection must list at least one blocker");
  assert.ok(blockers.some((blocker) => blocker.reason.includes("todo tree is empty")), `blockers: ${JSON.stringify(blockers)}`);
});

test("FIX-6b packaging: bin entry, published files, and CLI shebang exist", async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
    bin?: Record<string, string>;
    files?: string[];
  };
  assert.equal(pkg.bin?.goals, "./dist/src/cli/goals.js", "package.json exposes bin.goals");
  for (const entry of ["skills", "scripts", "docs"]) {
    assert.ok((pkg.files ?? []).includes(entry), `package.json files includes ${entry}`);
  }
  const cliPath = path.join(root, "dist", "src", "cli", "goals.js");
  assert.ok(existsSync(cliPath), "compiled CLI exists");
  const firstLine = readFileSync(cliPath, "utf8").split("\n")[0]!;
  assert.equal(firstLine, "#!/usr/bin/env node", "CLI carries a shebang");
});

// ---------------------------------------------------------------------------
// Fix batch #2 (session 2026-08-14T21-02-40): re-validation parity, CLI
// exit-code uniformity + post-quarantine warnings, cosmetics
// ---------------------------------------------------------------------------

test("FIX-A engine: WARN → re-validate PASS on the SAME attempt → accept succeeds; claims stream keeps both events", () => {
  const h = makeEngineHarness();
  assert.ok(h.engine.createGoal("Goal", cas("create")).ok);
  const goalId = h.engine.getGoal().goal!.goal.goalId;
  assert.ok(h.engine.addTodos([{ input: { title: "work", required: true } }], cas("add")).ok);
  const linked = h.engine.linkDelegation({ todoPath: "1" }, { validationPolicy: "oracle_required" }, cas("link"));
  assert.ok(linked.ok);
  const attempt = linked.result.attempt.attemptId;
  const claimHash = buildGoalTodoClaimHash("session batch-2 claim text");
  assert.ok(h.engine.returnClaim(attempt, { claimHash }, cas("return")).ok);

  // session evidence: WARN validation displayed autoAccept false…
  const warned = h.engine.recordClaimValidation(attempt, {
    verdict: "WARN",
    recommendedAction: "needs_review",
    noShip: false,
    confidence: "MEDIUM",
    outputHash: sha256("out-warn"),
  }, cas("v-warn"));
  assert.ok(warned.ok);
  // …accept is correctly refused while only the WARN validation exists…
  const refused = engineFailure(h.engine.resolveTodo({ todoPath: "1" }, "accept_claim", { claimHash, attemptId: attempt, validationPolicy: "oracle_required" }, cas("acc-warn")));
  assert.equal(refused.claimCode, "claim_validation_not_pass");

  // …and re-validating the SAME attempt used to die with
  // claim_error validation_already_settled (parity break vs zob). The
  // re-validation must now be recorded and SUPERSEDE the WARN.
  const passed = h.engine.recordClaimValidation(attempt, {
    verdict: "PASS",
    recommendedAction: "accept_claim",
    noShip: false,
    confidence: "HIGH",
    outputHash: sha256("out-pass"),
  }, cas("v-pass"));
  assert.ok(passed.ok);
  const view = h.engine.getGoal();
  assert.equal(view.goal!.claims.validations[attempt]!.verdict, "PASS", "the LATEST validation is the effective one");

  // accept now succeeds against the superseding validation
  const accepted = h.engine.resolveTodo({ todoPath: "1" }, "accept_claim", { claimHash, attemptId: attempt, validationPolicy: "oracle_required" }, cas("acc-pass"));
  assert.ok(accepted.ok);
  assert.equal(accepted.result.node.status, "done");
  assert.equal(accepted.result.settlement?.settlement, "accepted");

  // the append-only claims stream keeps the FULL validation history
  const events = readJsonl(goalStorePaths(h.stateDir, goalId).claimsLog).filter((entry) => entry.kind === "claim_validated");
  assert.equal(events.length, 2, "both validation events stay in the stream (last wins in the view)");
  // …and settlement stays final: a third validation after accept is refused
  const after = engineFailure(h.engine.recordClaimValidation(attempt, {
    verdict: "PASS",
    recommendedAction: "accept_claim",
    noShip: false,
    confidence: "HIGH",
    outputHash: sha256("out-3"),
  }, cas("v-after")));
  assert.equal(after.code, "claim_error");
  assert.equal(after.claimCode, "attempt_already_settled");
});

function cliEntryPoint(): string {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  return path.join(root, "dist", "src", "cli", "goals.js");
}

function runCli(stateDir: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [cliEntryPoint(), "--state-dir", stateDir, ...args], { encoding: "utf8" });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** Seeded healthy store (one goal, one required todo) for the CLI matrix. */
function makeCliStore(): string {
  const h = makeEngineHarness();
  assert.ok(h.engine.createGoal("CLI matrix goal", cas("cli-create")).ok);
  assert.ok(h.engine.addTodos([{ input: { title: "todo 1", required: true } }, { input: { title: "todo 2", required: true } }], cas("cli-add")).ok);
  return h.stateDir;
}

/** Fresh copy of a seeded store with a truncated todos stream tail. */
function makeCorruptCliStore(): string {
  const h = makeEngineHarness();
  assert.ok(h.engine.createGoal("CLI corrupt goal", cas("cli-c-create")).ok);
  assert.ok(h.engine.addTodos([{ input: { title: "todo 1", required: true } }], cas("cli-c-add")).ok);
  const goalId = h.engine.getGoal().goal!.goal.goalId;
  const todosPath = goalStorePaths(h.stateDir, goalId).todosLog;
  const data = readFileSync(todosPath);
  writeFileSyncTruncated(todosPath, data);
  return h.stateDir;
}

function writeFileSyncTruncated(filePath: string, data: Buffer): void {
  writeFileSync(filePath, data.subarray(0, data.length - 6));
}

test("FIX-B CLI: restore-blocked exits 1 on EVERY subcommand (tree included); usage errors exit 2", () => {
  for (const args of [["status"], ["tree"], ["list"], ["stats"], ["export"]]) {
    const store = makeCorruptCliStore();
    const run = runCli(store, ...args);
    assert.equal(run.status, 1, `${args[0]} on a corrupt store must exit 1`);
    assert.match(run.stderr, /restore-blocked store/, `${args[0]} must print the fail-closed diagnostics`);
  }
  // healthy store: every subcommand exits 0 and stays silent on stderr
  const healthy = makeCliStore();
  for (const args of [["status"], ["tree"], ["list"], ["stats"], ["export"]]) {
    const run = runCli(healthy, ...args);
    assert.equal(run.status, 0, `${args[0]} on a healthy store must exit 0`);
    assert.equal(run.stderr, "", `${args[0]} on a healthy store stays silent on stderr`);
  }
  // usage errors: unknown command, unknown flag, too many args → exit 2 + usage hint
  for (const args of [["bogus"], ["--frob"], ["tree", "a", "b", "c"]]) {
    const run = runCli(makeCliStore(), ...args);
    assert.equal(run.status, 2, `${args.join(" ")} is a usage error and must exit 2`);
    assert.match(run.stderr, /goals: /);
    assert.match(run.stderr, /usage: goals /, `${args.join(" ")} must print the usage hint`);
  }
});

test("FIX-B CLI: post-quarantine list/stats/export warn on stderr and stay exit 0", () => {
  const store = makeCorruptCliStore();
  // first contact fails closed AND quarantines the corrupt stream (exit 1)
  const first = runCli(store, "status");
  assert.equal(first.status, 1);
  assert.match(first.stderr, /restore-blocked store/);
  // subsequent commands run on the post-quarantine store: exit 0 but the
  // goals may be incomplete → a stderr warning must say so (session J21)
  for (const args of [["list"], ["stats"], ["export"]]) {
    const run = runCli(store, ...args);
    assert.equal(run.status, 0, `post-quarantine ${args[0]} stays exit 0`);
    assert.match(run.stderr, /^warning: 1 quarantined stream\(s\) — goals may be incomplete\n$/, `post-quarantine ${args[0]} prints the stderr warning`);
  }
});

test("FIX-C tools: get_goal with an unknown goal_id answers 'goal <id> not found'", async () => {
  const h = makeToolHarness();
  startSession(h);
  // bare call on an empty store keeps the honest no-active-goal line
  const bare = await callTool(h, "get_goal", {});
  assert.match(textOf(bare), /no active goal/);
  // a PROVIDED unknown goal_id is a distinct, precise answer
  const missing = await callTool(h, "get_goal", { goal_id: "goal_0123456789ab" });
  assert.equal(textOf(missing), "goal goal_0123456789ab not found");
  // and still distinct once goals exist
  await callTool(h, "create_goal", { objective: "exists", cas: { mutation_id: "b2-c1" } });
  const missingAfter = await callTool(h, "get_goal", { goal_id: "goal_0123456789ab" });
  assert.equal(textOf(missingAfter), "goal goal_0123456789ab not found");
});

test("FIX-C tools: get_goal_todos schema keeps todo_id/todo_path optional (plain object root; bare call = full tree)", async () => {
  const h = makeToolHarness();
  startSession(h);
  const tool = h.tools.get("get_goal_todos")!;
  const parameters = tool.parameters as { type?: string; required?: string[]; anyOf?: unknown[]; oneOf?: unknown[]; properties: Record<string, { description?: string }> };
  assert.equal(parameters.required, undefined, "get_goal_todos must not require any parameter");
  // Provider compatibility (xAI/OpenAI-compatible): the parameter root must
  // stay a plain object schema — never an anyOf/oneOf union with non-object
  // branches (400 "tool parameter root must be an object type").
  assert.equal(parameters.type, "object", "get_goal_todos parameter root must be a plain object schema");
  assert.equal(parameters.anyOf, undefined, "get_goal_todos must not use a root anyOf union");
  assert.equal(parameters.oneOf, undefined, "get_goal_todos must not use a root oneOf union");
  assert.match(parameters.properties.todo_id!.description ?? "", /full tree/i);
  assert.match(parameters.properties.todo_path!.description ?? "", /full tree/i);
  // actual behavior: bare call renders the full tree
  await callTool(h, "create_goal", { objective: "tree", cas: { mutation_id: "b2-c2" } });
  await callTool(h, "add_goal_todos", { todos: [{ title: "one" }, { title: "two" }], cas: { mutation_id: "b2-a1" } });
  const tree = await callTool(h, "get_goal_todos", {});
  assert.match(textOf(tree), /1\s+one/);
  assert.match(textOf(tree), /2\s+two/);
});

test("FIX-C render: skipped gets a distinct icon (⤫) — blocked keeps ⊘ (CLI tree AND /todo renderer)", () => {
  const base: GoalTodoNode = {
    id: "todo_000000000001",
    path: "1",
    title: "blocked work",
    status: "blocked",
    owner: "agent",
    priority: "normal",
    required: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const nodes: GoalTodoNode[] = [
    base,
    { ...base, id: "todo_000000000002", path: "2", title: "skipped work", status: "skipped" },
    { ...base, id: "todo_000000000003", path: "3", title: "done work", status: "done" },
  ];
  const lines = renderGoalTodoTree(summarizeGoalTodos(nodes), nodes);
  const blockedLine = lines.find((line) => line.includes("blocked work"))!;
  const skippedLine = lines.find((line) => line.includes("skipped work"))!;
  assert.ok(blockedLine.includes("⊘"), `blocked keeps ⊘: ${blockedLine}`);
  assert.ok(skippedLine.includes("⤫"), `skipped renders the distinct ⤫ icon: ${skippedLine}`);
  assert.ok(!skippedLine.includes("⊘"), `skipped must NOT share the blocked icon: ${skippedLine}`);
});
