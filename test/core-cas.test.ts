// test/core-cas.test.ts — Phase 2d GoalMutationGuard CAS receipts (TDD, red first).
//
// Under test: src/core/cas.ts — the canonical Goal mutation guard model:
// MUTATION_ID_PATTERN, the frozen 16-tool core scope, canonical request
// hashing (top-level cas field stripped, stable-key JSON), optimistic
// revision guards with exact stale codes, receipt building, and replay
// semantics (exact replay = idempotent success, conflicting replay =
// rejected). Receipt state is plain data; no storage lives here.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  GOAL_MUTATION_TOOL_NAMES,
  MUTATION_ID_PATTERN,
  applyMutationGuard,
  buildMutationGuard,
  buildMutationReceipt,
  canonicalGoalMutationJson,
  createGoalMutationReceiptState,
  evaluateMutationReplay,
  hashGoalMutationRequest,
  isCanonicalMutationId,
  isCanonicalMutationRequestHash,
  isGoalMutationToolName,
  recordMutationReceipt,
} from "../src/core/cas.js";
import type {
  BuildGoalMutationGuardResult,
  BuildGoalMutationReceiptResult,
  GoalMutationGuard,
  RecordGoalMutationReceiptResult,
} from "../src/core/cas.js";

const NOW = 1_700_000_000;
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function guardOk(result: BuildGoalMutationGuardResult): Extract<BuildGoalMutationGuardResult, { ok: true }> {
  assert.equal(result.ok, true, `expected guard: ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error("unreachable");
  return result;
}

function guardErr(result: BuildGoalMutationGuardResult): Extract<BuildGoalMutationGuardResult, { ok: false }> {
  assert.equal(result.ok, false, `expected rejection: ${JSON.stringify(result)}`);
  if (result.ok) throw new Error("unreachable");
  return result;
}

function receiptOk(result: BuildGoalMutationReceiptResult): Extract<BuildGoalMutationReceiptResult, { ok: true }> {
  assert.equal(result.ok, true, `expected receipt: ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error("unreachable");
  return result;
}

function receiptErr(result: BuildGoalMutationReceiptResult): Extract<BuildGoalMutationReceiptResult, { ok: false }> {
  assert.equal(result.ok, false, `expected rejection: ${JSON.stringify(result)}`);
  if (result.ok) throw new Error("unreachable");
  return result;
}

function recordOk(result: RecordGoalMutationReceiptResult): Extract<RecordGoalMutationReceiptResult, { ok: true }> {
  assert.equal(result.ok, true, `expected record: ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error("unreachable");
  return result;
}

function recordErr(result: RecordGoalMutationReceiptResult): Extract<RecordGoalMutationReceiptResult, { ok: false }> {
  assert.equal(result.ok, false, `expected rejection: ${JSON.stringify(result)}`);
  if (result.ok) throw new Error("unreachable");
  return result;
}

// ---------------------------------------------------------------------------
// Tool scope and mutation id pattern
// ---------------------------------------------------------------------------

test("GOAL_MUTATION_TOOL_NAMES is the frozen 16-tool core mutation scope", () => {
  assert.deepEqual([...GOAL_MUTATION_TOOL_NAMES], [
    "create_goal",
    "resume_goal",
    "propose_goal_completion",
    "record_goal_oracle",
    "update_goal",
    "add_goal_todo",
    "add_goal_todos",
    "update_goal_todo",
    "resolve_goal_todo",
    "complete_goal_todo",
    "block_goal_todo",
    "split_goal_todo",
    "validate_goal_todo_claim",
    "accept_goal_todo_claim",
    "reject_goal_todo_claim",
    "recover_goal_todo_delegation",
  ]);
  assert.equal(GOAL_MUTATION_TOOL_NAMES.length, 16);
  assert.equal(Object.isFrozen(GOAL_MUTATION_TOOL_NAMES), true);
  for (const tool of GOAL_MUTATION_TOOL_NAMES) {
    assert.equal(isGoalMutationToolName(tool), true, tool);
  }
  for (const excluded of ["import_factory_todos", "import_orchestration_todos", "import_chain_todos", "handoff_goal_todo", "bogus_tool"]) {
    assert.equal(isGoalMutationToolName(excluded), false, excluded);
  }
});

test("MUTATION_ID_PATTERN validates canonical mutation ids", () => {
  assert.equal(MUTATION_ID_PATTERN.source, "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");
  for (const id of ["m1", "a".repeat(128), "goal.9:update-1_0", "todo-2.3:patch"]) {
    assert.equal(isCanonicalMutationId(id), true, id);
  }
  for (const id of ["", ".lead", "-lead", ":lead", "_lead", "a".repeat(129), "has space", "élan"]) {
    assert.equal(isCanonicalMutationId(id), false, id);
  }
  assert.equal(isCanonicalMutationId(42), false);
  assert.equal(isCanonicalMutationId(undefined), false);
});

test("isCanonicalMutationRequestHash accepts only full lowercase sha256 hex", () => {
  assert.equal(isCanonicalMutationRequestHash(HASH_A), true);
  assert.equal(isCanonicalMutationRequestHash(HASH_A.slice(0, 63)), false);
  assert.equal(isCanonicalMutationRequestHash(`${HASH_A}a`), false);
  assert.equal(isCanonicalMutationRequestHash(HASH_A.toUpperCase()), false);
  assert.equal(isCanonicalMutationRequestHash(""), false);
  assert.equal(isCanonicalMutationRequestHash(42), false);
});

// ---------------------------------------------------------------------------
// Guard building
// ---------------------------------------------------------------------------

test("buildMutationGuard accepts every core tool and rejects unknown tools", () => {
  for (const tool of GOAL_MUTATION_TOOL_NAMES) {
    const built = guardOk(buildMutationGuard(tool, { mutationId: "m1" }));
    assert.equal(built.guard.toolName, tool);
    assert.equal(built.guard.mutationId, "m1");
  }
  for (const tool of ["import_factory_todos", "handoff_goal_todo", "made_up_tool"]) {
    assert.equal(guardErr(buildMutationGuard(tool, { mutationId: "m1" })).code, "unknown_tool", tool);
  }
  assert.equal(guardErr(buildMutationGuard(42 as unknown as string, { mutationId: "m1" })).code, "unknown_tool");
});

test("buildMutationGuard validates mutation ids and revisions", () => {
  for (const mutationId of ["", ".lead", "a".repeat(129), "has space", "constructor", "__proto__"]) {
    assert.equal(guardErr(buildMutationGuard("update_goal", { mutationId })).code, "invalid_mutation_id", JSON.stringify(mutationId));
  }
  for (const revisions of [{ expectedGoalRevision: -1 }, { expectedGraphRevision: 1.5 }, { expectedTodoRevision: Number.NaN }]) {
    assert.equal(guardErr(buildMutationGuard("update_goal", { mutationId: "m1", ...revisions })).code, "invalid_revision", JSON.stringify(revisions));
  }
  const full = guardOk(buildMutationGuard("update_goal", { mutationId: "m1", expectedGoalRevision: 3, expectedGraphRevision: 7, expectedTodoRevision: 2 }));
  assert.deepEqual(full.guard, { toolName: "update_goal", mutationId: "m1", expectedGoalRevision: 3, expectedGraphRevision: 7, expectedTodoRevision: 2 });
  const bare = guardOk(buildMutationGuard("add_goal_todo", { mutationId: "m2" }));
  assert.deepEqual(bare.guard, { toolName: "add_goal_todo", mutationId: "m2" });
});

// ---------------------------------------------------------------------------
// Canonical hashing
// ---------------------------------------------------------------------------

test("canonicalGoalMutationJson sorts keys recursively and rejects non-canonical values", () => {
  assert.equal(canonicalGoalMutationJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
  assert.equal(canonicalGoalMutationJson({ x: { z: 1, y: [3, 2] } }), '{"x":{"y":[3,2],"z":1}}');
  assert.equal(canonicalGoalMutationJson(null), "null");
  assert.equal(canonicalGoalMutationJson(true), "true");
  assert.equal(canonicalGoalMutationJson("s"), '"s"');
  assert.equal(canonicalGoalMutationJson(42), "42");
  assert.equal(canonicalGoalMutationJson([]), "[]");
  assert.equal(canonicalGoalMutationJson({}), "{}");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalGoalMutationJson(cyclic), TypeError);
  assert.throws(() => canonicalGoalMutationJson([1, , 3]), TypeError);
  assert.throws(() => canonicalGoalMutationJson(new Date(0)), TypeError);
  assert.throws(() => canonicalGoalMutationJson(undefined), TypeError);
  assert.throws(() => canonicalGoalMutationJson(Number.NaN), TypeError);
  assert.throws(() => canonicalGoalMutationJson(1n), TypeError);
});

test("hashGoalMutationRequest strips the top-level cas field and hashes canonical tool+payload", () => {
  const expected = sha256('{"payload":{"title":"x"},"tool":"update_goal"}');
  assert.equal(hashGoalMutationRequest("update_goal", { title: "x" }), expected);
  assert.equal(hashGoalMutationRequest("update_goal", { cas: { mutationId: "m1", expectedGoalRevision: 3 }, title: "x" }), expected);
  assert.equal(hashGoalMutationRequest("update_goal", { title: "x", cas: undefined }), expected);
  assert.equal(hashGoalMutationRequest("update_goal", { b: 2, a: 1 }), hashGoalMutationRequest("update_goal", { a: 1, b: 2 }));
  assert.equal(
    hashGoalMutationRequest("resolve_goal_todo", { todoId: "todo_1", action: "complete" }),
    hashGoalMutationRequest("resolve_goal_todo", { action: "complete", todoId: "todo_1" }),
  );
  assert.notEqual(hashGoalMutationRequest("update_goal", { title: "x" }), hashGoalMutationRequest("update_goal", { title: "y" }));
  assert.notEqual(hashGoalMutationRequest("update_goal", { title: "x" }), hashGoalMutationRequest("add_goal_todo", { title: "x" }));
  assert.notEqual(hashGoalMutationRequest("update_goal", { nested: { cas: 1 } }), hashGoalMutationRequest("update_goal", { nested: {} }));
  assert.throws(() => hashGoalMutationRequest("import_factory_todos", {}), TypeError);
  assert.throws(() => hashGoalMutationRequest("not_a_tool", {}), TypeError);
  assert.throws(() => hashGoalMutationRequest("update_goal", undefined), TypeError);
  assert.throws(() => hashGoalMutationRequest("update_goal", () => 1), TypeError);
});

// ---------------------------------------------------------------------------
// Optimistic revision guard
// ---------------------------------------------------------------------------

test("applyMutationGuard returns ok or exact stale revision codes", () => {
  const guard = guardOk(buildMutationGuard("update_goal", { mutationId: "m1", expectedGoalRevision: 3, expectedGraphRevision: 7, expectedTodoRevision: 2 })).guard;
  assert.deepEqual(applyMutationGuard({ goalRevision: 3, graphRevision: 7, todoRevision: 2 }, guard), { ok: true, status: "ok" });
  assert.deepEqual(applyMutationGuard({ goalRevision: 4, graphRevision: 7, todoRevision: 2 }, guard), { ok: false, status: "stale", codes: ["stale_goal_revision"] });
  assert.deepEqual(applyMutationGuard({ goalRevision: 3, graphRevision: 8, todoRevision: 2 }, guard), { ok: false, status: "stale", codes: ["stale_graph_revision"] });
  assert.deepEqual(applyMutationGuard({ goalRevision: 3, graphRevision: 7, todoRevision: 3 }, guard), { ok: false, status: "stale", codes: ["stale_todo_revision"] });
  assert.deepEqual(applyMutationGuard({ goalRevision: 0, graphRevision: 0, todoRevision: 0 }, guard), {
    ok: false,
    status: "stale",
    codes: ["stale_goal_revision", "stale_graph_revision", "stale_todo_revision"],
  });
  assert.deepEqual(applyMutationGuard({}, guard), {
    ok: false,
    status: "stale",
    codes: ["stale_goal_revision", "stale_graph_revision", "stale_todo_revision"],
  });
  const bare = guardOk(buildMutationGuard("add_goal_todo", { mutationId: "m2" })).guard;
  assert.deepEqual(applyMutationGuard({}, bare), { ok: true, status: "ok" });
  assert.deepEqual(applyMutationGuard({ goalRevision: -1, graphRevision: 7, todoRevision: 2 }, guard), { ok: false, status: "invalid", code: "invalid_current_revision" });
  assert.deepEqual(applyMutationGuard({ goalRevision: 1.5, graphRevision: 7, todoRevision: 2 }, guard), { ok: false, status: "invalid", code: "invalid_current_revision" });
});

// ---------------------------------------------------------------------------
// Receipts and replay
// ---------------------------------------------------------------------------

test("buildMutationReceipt echoes the guard and validates hash and timestamp", () => {
  const guard = guardOk(buildMutationGuard("update_goal", { mutationId: "m1", expectedGoalRevision: 3, expectedGraphRevision: 7, expectedTodoRevision: 2 })).guard;
  const built = receiptOk(buildMutationReceipt(guard, HASH_A, NOW));
  assert.deepEqual(built.receipt, {
    schema: "pi-goals.goal-mutation-receipt.v1",
    toolName: "update_goal",
    mutationId: "m1",
    requestHash: HASH_A,
    expectedGoalRevision: 3,
    expectedGraphRevision: 7,
    expectedTodoRevision: 2,
    appliedAt: NOW,
    bodyStored: false,
  });
  for (const requestHash of [HASH_A.slice(0, 63), `${HASH_A}a`, HASH_A.toUpperCase(), ""]) {
    assert.equal(receiptErr(buildMutationReceipt(guard, requestHash, NOW)).code, "invalid_request_hash", requestHash);
  }
  for (const now of [-1, 1.5, Number.NaN]) {
    assert.equal(receiptErr(buildMutationReceipt(guard, HASH_A, now)).code, "invalid_applied_at");
  }
  const badId = { ...guard, mutationId: ".bad" } as GoalMutationGuard;
  assert.equal(receiptErr(buildMutationReceipt(badId, HASH_A, NOW)).code, "invalid_guard");
  const badTool = { ...guard, toolName: "bogus" as unknown as GoalMutationGuard["toolName"] };
  assert.equal(receiptErr(buildMutationReceipt(badTool, HASH_A, NOW)).code, "invalid_guard");
});

test("exact replay is idempotent success; conflicting replay is rejected", () => {
  const guard1 = guardOk(buildMutationGuard("update_goal", { mutationId: "m1" })).guard;
  const guard2 = guardOk(buildMutationGuard("update_goal", { mutationId: "m2" })).guard;
  const receipt1 = receiptOk(buildMutationReceipt(guard1, HASH_A, NOW)).receipt;
  const receipt2 = receiptOk(buildMutationReceipt(guard2, HASH_A, NOW)).receipt;
  const conflicting = receiptOk(buildMutationReceipt(guard1, HASH_B, NOW)).receipt;

  const empty = createGoalMutationReceiptState();
  assert.deepEqual(empty, { receipts: {} });
  assert.deepEqual(evaluateMutationReplay(empty, { mutationId: "m1", requestHash: HASH_A }), { ok: true, status: "new" });

  const recorded = recordOk(recordMutationReceipt(empty, receipt1)).state;
  assert.deepEqual(evaluateMutationReplay(recorded, { mutationId: "m1", requestHash: HASH_A }), { ok: true, status: "replayed", receipt: receipt1 });
  assert.deepEqual(evaluateMutationReplay(recorded, { mutationId: "m1", requestHash: HASH_B }), { ok: false, status: "conflict", existingRequestHash: HASH_A });
  assert.deepEqual(evaluateMutationReplay(recorded, { mutationId: "m2", requestHash: HASH_A }), { ok: true, status: "new" });
  assert.deepEqual(evaluateMutationReplay(recorded, { mutationId: "bad id", requestHash: HASH_A }), { ok: false, status: "invalid", code: "invalid_mutation_id" });
  assert.deepEqual(evaluateMutationReplay(recorded, { mutationId: "m1", requestHash: "XYZ" }), { ok: false, status: "invalid", code: "invalid_request_hash" });

  const withBoth = recordOk(recordMutationReceipt(recorded, receipt2)).state;
  assert.equal(Object.keys(withBoth.receipts).length, 2);
  const idempotent = recordOk(recordMutationReceipt(withBoth, receipt1));
  assert.deepEqual(idempotent.state, withBoth);
  const conflict = recordErr(recordMutationReceipt(withBoth, conflicting));
  assert.equal(conflict.code, "mutation_id_conflict");
});

test("recordMutationReceipt never mutates the input receipt state", () => {
  const guard = guardOk(buildMutationGuard("update_goal", { mutationId: "m1" })).guard;
  const receipt = receiptOk(buildMutationReceipt(guard, HASH_A, NOW)).receipt;
  const empty = createGoalMutationReceiptState();
  const snapshot = structuredClone(empty);
  recordOk(recordMutationReceipt(empty, receipt));
  assert.deepEqual(empty, snapshot);
});
