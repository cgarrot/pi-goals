// test/core-types.test.ts — Phase 2a core type vocabulary checks (TDD, red first).
// R3: all 11 statuses, 6 owners, 4 priorities verbatim from zob goal-todo-types.ts.
// R1: strict single schema — zob couplings must be rejected at compile time.
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  GoalTodoNode,
  GoalTodoOwner,
  GoalTodoPriority,
  GoalTodoReferenceCode,
  GoalTodoReferenceField,
  GoalTodoReferenceRetryPolicy,
  GoalTodoStatus,
  Result,
} from "../src/core/types.js";
import { GOAL_TODO_OWNERS, GOAL_TODO_PRIORITIES, GOAL_TODO_STATUSES } from "../src/core/types.js";

const EXPECTED_STATUSES: readonly GoalTodoStatus[] = [
  "planned",
  "ready",
  "in_progress",
  "delegated",
  "claim_returned",
  "needs_review",
  "needs_oracle",
  "needs_user",
  "blocked",
  "done",
  "skipped",
];

const EXPECTED_OWNERS: readonly GoalTodoOwner[] = ["agent", "user", "oracle", "subagent", "factory", "orchestration"];
const EXPECTED_PRIORITIES: readonly GoalTodoPriority[] = ["low", "normal", "high", "critical"];

test("GoalTodoStatus keeps all 11 zob statuses verbatim", () => {
  assert.equal(EXPECTED_STATUSES.length, 11);
  assert.deepEqual([...GOAL_TODO_STATUSES], EXPECTED_STATUSES);
  assert.equal(Object.isFrozen(GOAL_TODO_STATUSES), true);
});

test("GoalTodoStatus rejects unknown values at compile time", () => {
  // @ts-expect-error "finished" is not a zob status
  const invalid: GoalTodoStatus = "finished";
  assert.equal(invalid, "finished");
});

test("GoalTodoOwner keeps all 6 zob owners verbatim", () => {
  assert.equal(EXPECTED_OWNERS.length, 6);
  assert.deepEqual([...GOAL_TODO_OWNERS], EXPECTED_OWNERS);
  assert.equal(Object.isFrozen(GOAL_TODO_OWNERS), true);
});

test("GoalTodoOwner rejects unknown values at compile time", () => {
  // @ts-expect-error "worker" is not a zob owner
  const invalid: GoalTodoOwner = "worker";
  assert.equal(invalid, "worker");
});

test("GoalTodoPriority keeps all 4 zob priorities verbatim", () => {
  assert.equal(EXPECTED_PRIORITIES.length, 4);
  assert.deepEqual([...GOAL_TODO_PRIORITIES], EXPECTED_PRIORITIES);
  assert.equal(Object.isFrozen(GOAL_TODO_PRIORITIES), true);
});

test("GoalTodoPriority rejects unknown values at compile time", () => {
  // @ts-expect-error "urgent" is not a zob priority
  const invalid: GoalTodoPriority = "urgent";
  assert.equal(invalid, "urgent");
});

function baseNode(): GoalTodoNode {
  return {
    id: "todo_000000000001",
    path: "1",
    title: "Implement core types",
    status: "planned",
    owner: "agent",
    priority: "normal",
    required: true,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

test("GoalTodoNode accepts the clean canonical shape with optionals", () => {
  const node: GoalTodoNode = {
    ...baseNode(),
    parentId: "todo_000000000000",
    acceptanceCriteria: ["tests green"],
    evidenceRefs: ["reports/build.md"],
    validationCommands: ["npm test"],
  };
  assert.equal(node.id, "todo_000000000001");
  assert.equal(node.path, "1");
  assert.equal(node.parentId, "todo_000000000000");
  assert.deepEqual(node.acceptanceCriteria, ["tests green"]);
  assert.deepEqual(node.evidenceRefs, ["reports/build.md"]);
  assert.deepEqual(node.validationCommands, ["npm test"]);
  assert.equal(node.required, true);
  assert.equal(node.createdAt, 1_000);
  assert.equal(node.updatedAt, 1_000);
});

test("GoalTodoNode rejects zob couplings at compile time", () => {
  // TypeScript reports excess-property errors once per literal, so each zob
  // coupling gets its own single-property literal and directive.
  // @ts-expect-error goalId lives in the injected index, not on the node
  const withGoalId: GoalTodoNode = { ...baseNode(), goalId: "goal_1" };
  // @ts-expect-error depth derives from the visible path
  const withDepth: GoalTodoNode = { ...baseNode(), depth: 1 };
  // @ts-expect-error delegationAttempts become a side table in a later phase
  const withAttempts: GoalTodoNode = { ...baseNode(), delegationAttempts: [] };
  // @ts-expect-error delegation projection is a zob coupling
  const withDelegation: GoalTodoNode = { ...baseNode(), delegation: { delegationDepth: 0, status: "queued" } };
  // @ts-expect-error claims become a side table in a later phase
  const withClaim: GoalTodoNode = { ...baseNode(), claim: { claimHash: "x", acceptanceBlockers: [], returnedAt: 0 } };
  // @ts-expect-error validation refs are a zob coupling
  const withValidation: GoalTodoNode = { ...baseNode(), validation: undefined };
  // @ts-expect-error descriptionHash is a zob coupling
  const withDescriptionHash: GoalTodoNode = { ...baseNode(), descriptionHash: "deadbeef" };
  assert.equal(withGoalId.path, "1");
  assert.equal(withDepth.path, "1");
  assert.equal(withAttempts.path, "1");
  assert.equal(withDelegation.path, "1");
  assert.equal(withClaim.path, "1");
  assert.equal(withValidation.path, "1");
  assert.equal(withDescriptionHash.path, "1");
});

test("Result<T, E> discriminates ok and err branches", () => {
  const ok: Result<number, string> = { ok: true, value: 42 };
  const err: Result<number, string> = { ok: false, error: "boom" };
  if (ok.ok) {
    assert.equal(ok.value, 42);
  } else {
    assert.fail("ok branch must discriminate");
  }
  if (!err.ok) {
    assert.equal(err.error, "boom");
  } else {
    assert.fail("err branch must discriminate");
  }
});

test("GoalTodoReferenceCode covers the 12 zob resolution codes", () => {
  const codes: readonly GoalTodoReferenceCode[] = [
    "resolved",
    "missing_goal_id",
    "missing_reference",
    "invalid_todo_id",
    "invalid_todo_path",
    "todo_id_not_found",
    "todo_id_cross_goal",
    "todo_id_ambiguous",
    "todo_path_not_found",
    "todo_path_ambiguous",
    "reference_mismatch",
    "batch_resolution_failed",
  ];
  assert.equal(codes.length, 12);
  assert.equal(new Set(codes).size, 12);
});

test("GoalTodoReferenceCode rejects unknown codes at compile time", () => {
  // @ts-expect-error "not_a_code" is not a zob resolution code
  const invalid: GoalTodoReferenceCode = "not_a_code";
  assert.equal(invalid, "not_a_code");
});

test("GoalTodoReferenceField and retry policy unions match zob", () => {
  const fields: readonly GoalTodoReferenceField[] = ["goal_id", "todo_id", "todo_path", "references", "batch"];
  assert.equal(fields.length, 5);
  const policies: readonly GoalTodoReferenceRetryPolicy[] = ["none", "fix_input", "refresh_goal_todos", "select_canonical_id"];
  assert.equal(policies.length, 4);
});
