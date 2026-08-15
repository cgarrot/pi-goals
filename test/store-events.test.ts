// test/store-events.test.ts — Phase 3b TDD (red first): strict stream event
// envelopes + parsers for the pi-goals file store.
//
// Under test: src/store/events.ts — the four canonical stream schemas
// (pi-goals.goal.v1 / pi-goals.todos.v1 / pi-goals.claims.v1 /
// pi-goals.receipt.v1), strict structural parsing with unknown-schema
// quarantine diagnostics (R1: an unknown future schema is NEVER silently
// skipped), and deterministic single-line serialization.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CLAIMS_STREAM_SCHEMA,
  GOAL_STREAM_SCHEMA,
  RECEIPT_STREAM_SCHEMA,
  TODOS_STREAM_SCHEMA,
  parseStreamLine,
  serializeStreamEvent,
} from "../src/store/events.js";
import type {
  ClaimAcceptedEvent,
  ClaimRejectedEvent,
  ClaimReturnedEvent,
  ClaimValidatedEvent,
  ClaimsDelegationAttemptLaunchedEvent,
  GoalBaselineEvent,
  GoalClearEvent,
  GoalSetEvent,
  ReceiptStreamEvent,
  TodoAddedEvent,
  TodoRemovedEvent,
  TodosClearedEvent,
  TodosSnapshotEvent,
} from "../src/store/events.js";
import { buildMutationGuard, buildMutationReceipt, hashGoalMutationRequest } from "../src/core/cas.js";
import type { GoalMutationReceipt } from "../src/core/cas.js";

const AT = 1_700_000_012_345;
const GOAL_ID = "goal_aa0000000001";
const HASH_A = "a".repeat(64);

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function goalSetEvent(revision: number, embeddedRevision = revision): GoalSetEvent {
  return {
    schema: GOAL_STREAM_SCHEMA,
    kind: "goal_set",
    revision,
    at: AT,
    data: {
      goal: {
        goalId: GOAL_ID,
        objective: "Ship the file store",
        status: "active",
        revision: embeddedRevision,
        createdAt: AT,
        updatedAt: AT,
      },
    },
  };
}

function goalClearEvent(revision: number): GoalClearEvent {
  return { schema: GOAL_STREAM_SCHEMA, kind: "goal_clear", revision, at: AT, data: { goalId: GOAL_ID } };
}

function goalBaselineEvent(revision: number): GoalBaselineEvent {
  return { schema: GOAL_STREAM_SCHEMA, kind: "baseline", revision, at: AT, data: { snapshotFile: "snapshot.json" } };
}

function todosSnapshotEvent(revision: number): TodosSnapshotEvent {
  return {
    schema: TODOS_STREAM_SCHEMA,
    kind: "todos_snapshot",
    revision,
    at: AT,
    data: {
      goalId: GOAL_ID,
      nodes: [
        {
          id: "todo_000000000001",
          path: "1",
          title: "Root todo",
          status: "planned",
          owner: "agent",
          priority: "normal",
          required: true,
          createdAt: AT,
          updatedAt: AT,
        },
      ],
      policy: { maxDepth: 6, maxFanout: 8, maxBatch: 80 },
    },
  };
}

function todoAddedEvent(revision: number): TodoAddedEvent {
  return {
    schema: TODOS_STREAM_SCHEMA,
    kind: "todo_added",
    revision,
    at: AT,
    data: {
      goalId: GOAL_ID,
      node: {
        id: "todo_000000000002",
        path: "1.1",
        title: "Child todo",
        status: "planned",
        owner: "subagent",
        priority: "high",
        required: false,
        parentId: "todo_000000000001",
        acceptanceCriteria: ["must pass"],
        createdAt: AT,
        updatedAt: AT,
      },
    },
  };
}

function claimLaunchedEvent(): ClaimsDelegationAttemptLaunchedEvent {
  return {
    schema: CLAIMS_STREAM_SCHEMA,
    kind: "delegation_attempt_launched",
    at: AT,
    data: {
      goalId: GOAL_ID,
      attempt: { attemptId: "attempt-1", status: "queued", validationPolicy: "parent_review", launchedAt: AT },
    },
  };
}

function claimReturnedEvent(): ClaimReturnedEvent {
  return {
    schema: CLAIMS_STREAM_SCHEMA,
    kind: "claim_returned",
    at: AT,
    data: {
      goalId: GOAL_ID,
      claim: {
        claimVersion: 1,
        attemptId: "attempt-1",
        claimHash: HASH_A,
        validationPolicy: "parent_review",
        evidenceRefs: ["reports/x.md"],
        validationCommands: ["npm test"],
        returnedAt: AT,
      },
    },
  };
}

function claimValidatedEvent(): ClaimValidatedEvent {
  return {
    schema: CLAIMS_STREAM_SCHEMA,
    kind: "claim_validated",
    at: AT,
    data: {
      goalId: GOAL_ID,
      validation: {
        validationVersion: 1,
        attemptId: "attempt-1",
        claimHash: HASH_A,
        validationPolicy: "parent_review",
        status: "passed",
        verdict: "PASS",
        recommendedAction: "accept_claim",
        noShip: false,
        confidence: "HIGH",
        blockingIssuesHash: sha256('["none"]'),
        blockingIssuesCount: 1,
        outputHash: HASH_A,
        evidenceRefs: [],
        validationCommands: [],
        validatedAt: AT,
      },
    },
  };
}

function claimSettledEvent(): ClaimAcceptedEvent {
  return {
    schema: CLAIMS_STREAM_SCHEMA,
    kind: "claim_accepted",
    at: AT,
    data: {
      goalId: GOAL_ID,
      settlement: { settlement: "accepted", attemptId: "attempt-1", claimHash: HASH_A, validationPolicy: "parent_review" },
    },
  };
}

function receiptEvent(): ReceiptStreamEvent {
  const guard = buildMutationGuard("add_goal_todo", { mutationId: "mut-1" });
  if (!guard.ok) throw new Error("guard fixture failed");
  const receipt = buildMutationReceipt(guard.guard, sha256("request"), AT);
  if (!receipt.ok) throw new Error("receipt fixture failed");
  return { schema: RECEIPT_STREAM_SCHEMA, kind: "mutation_receipt", at: AT, data: { receipt: receipt.receipt } };
}

function parseOk(value: unknown) {
  const parsed = parseStreamLine(value);
  if (!parsed.ok) assert.fail(`expected parse success, got ${parsed.code}: ${parsed.message}`);
  return parsed.parsed;
}

function parseFail(value: unknown) {
  const parsed = parseStreamLine(value);
  if (parsed.ok) assert.fail("expected parse failure");
  return parsed;
}

function lineOf(event: GoalSetEvent | GoalClearEvent | GoalBaselineEvent | TodosSnapshotEvent | TodoAddedEvent | TodoRemovedEvent | TodosClearedEvent | ClaimsDelegationAttemptLaunchedEvent | ClaimReturnedEvent | ClaimValidatedEvent | ClaimAcceptedEvent | ClaimRejectedEvent | ReceiptStreamEvent): unknown {
  return JSON.parse(serializeStreamEvent(event));
}

test("parses the goal stream schema: goal_set, goal_clear, baseline", () => {
  const set = parseOk(lineOf(goalSetEvent(1)));
  assert.equal(set.stream, "goal");
  if (set.stream !== "goal") return;
  assert.equal(set.event.kind, "goal_set");
  assert.equal(set.event.revision, 1);
  assert.equal(set.event.at, AT);
  assert.equal(set.event.data.goal.goalId, GOAL_ID);
  assert.equal(set.event.data.goal.status, "active");

  const clear = parseOk(lineOf(goalClearEvent(2)));
  if (clear.stream !== "goal") return assert.fail("wrong stream");
  assert.equal(clear.event.kind, "goal_clear");
  assert.equal(clear.event.data.goalId, GOAL_ID);

  const baseline = parseOk(lineOf(goalBaselineEvent(3)));
  if (baseline.stream !== "goal") return assert.fail("wrong stream");
  assert.equal(baseline.event.kind, "baseline");
  assert.equal(baseline.event.data.snapshotFile, "snapshot.json");
});

test("parses the todos stream schema: snapshot, added, removed, cleared, baseline", () => {
  const snapshot = parseOk(lineOf(todosSnapshotEvent(1)));
  assert.equal(snapshot.stream, "todos");
  if (snapshot.stream !== "todos") return;
  assert.equal(snapshot.event.kind, "todos_snapshot");
  assert.equal(snapshot.event.data.nodes.length, 1);
  assert.deepEqual(snapshot.event.data.policy, { maxDepth: 6, maxFanout: 8, maxBatch: 80 });

  const added = parseOk(lineOf(todoAddedEvent(2)));
  if (added.stream !== "todos") return assert.fail("wrong stream");
  if (added.event.kind !== "todo_added") return assert.fail("wrong kind");
  assert.equal(added.event.data.node.parentId, "todo_000000000001");
  assert.deepEqual(added.event.data.node.acceptanceCriteria, ["must pass"]);

  const removed = parseOk(lineOf({ schema: TODOS_STREAM_SCHEMA, kind: "todo_removed", revision: 3, at: AT, data: { goalId: GOAL_ID, todoId: "todo_000000000002" } }));
  if (removed.stream !== "todos") return assert.fail("wrong stream");
  assert.equal(removed.event.kind, "todo_removed");

  const cleared = parseOk(lineOf({ schema: TODOS_STREAM_SCHEMA, kind: "todos_cleared", revision: 4, at: AT, data: { goalId: GOAL_ID } }));
  if (cleared.stream !== "todos") return assert.fail("wrong stream");
  assert.equal(cleared.event.kind, "todos_cleared");
});

test("parses the claims stream schema: launched, returned, validated, accepted, rejected", () => {
  const launched = parseOk(lineOf(claimLaunchedEvent()));
  assert.equal(launched.stream, "claims");
  if (launched.stream !== "claims") return;
  assert.equal(launched.event.kind, "delegation_attempt_launched");
  assert.equal(launched.event.data.attempt.attemptId, "attempt-1");

  const returned = parseOk(lineOf(claimReturnedEvent()));
  if (returned.stream !== "claims") return assert.fail("wrong stream");
  if (returned.event.kind !== "claim_returned") return assert.fail("wrong kind");
  assert.equal(returned.event.data.claim.claimHash, HASH_A);

  const validated = parseOk(lineOf(claimValidatedEvent()));
  if (validated.stream !== "claims") return assert.fail("wrong stream");
  if (validated.event.kind !== "claim_validated") return assert.fail("wrong kind");
  assert.equal(validated.event.data.validation.verdict, "PASS");

  const settled = parseOk(lineOf(claimSettledEvent()));
  if (settled.stream !== "claims") return assert.fail("wrong stream");
  if (settled.event.kind !== "claim_accepted") return assert.fail("wrong kind");

  const rejected = parseOk(lineOf({ schema: CLAIMS_STREAM_SCHEMA, kind: "claim_rejected", at: AT, data: { goalId: GOAL_ID, settlement: { settlement: "rejected", attemptId: "attempt-1", claimHash: HASH_A, validationPolicy: "oracle_required" } } }));
  if (rejected.stream !== "claims") return assert.fail("wrong stream");
  if (rejected.event.kind !== "claim_rejected") return assert.fail("wrong kind");
});

test("parses the receipt stream schema with the embedded CAS receipt", () => {
  const parsed = parseOk(lineOf(receiptEvent()));
  assert.equal(parsed.stream, "receipts");
  if (parsed.stream !== "receipts") return;
  assert.equal(parsed.event.kind, "mutation_receipt");
  const receipt: GoalMutationReceipt = parsed.event.data.receipt;
  assert.equal(receipt.schema, "pi-goals.goal-mutation-receipt.v1");
  assert.equal(receipt.mutationId, "mut-1");
  assert.equal(receipt.bodyStored, false);
});

test("rejects unknown future schemas with unknown_schema (R1, never a silent skip)", () => {
  const future = parseFail({ schema: "pi-goals.goal.v2", kind: "goal_set", revision: 1, at: AT, data: {} });
  assert.equal(future.code, "unknown_schema");

  const foreign = parseFail({ schema: "zob.goal.v1", kind: "goal_set", revision: 1, at: AT, data: {} });
  assert.equal(foreign.code, "unknown_schema");

  const missing = parseFail({ kind: "goal_set", revision: 1, at: AT, data: {} });
  assert.equal(missing.code, "malformed_event");
});

test("rejects non-object and structurally malformed envelopes", () => {
  assert.equal(parseFail(null).code, "malformed_event");
  assert.equal(parseFail(42).code, "malformed_event");
  assert.equal(parseFail("goal_set").code, "malformed_event");
  assert.equal(parseFail([]).code, "malformed_event");

  // missing revision on a revisioned stream
  assert.equal(parseFail({ schema: GOAL_STREAM_SCHEMA, kind: "goal_set", at: AT, data: goalSetEvent(1).data }).code, "malformed_event");
  // revision on a non-revisioned stream (claims) is an unknown key
  assert.equal(parseFail({ schema: CLAIMS_STREAM_SCHEMA, kind: "claim_returned", revision: 1, at: AT, data: claimReturnedEvent().data }).code, "malformed_event");
  // extra unknown top-level key
  assert.equal(parseFail({ ...goalSetEvent(1), extra: true }).code, "malformed_event");
  // bad at
  assert.equal(parseFail({ ...goalSetEvent(1), at: "yesterday" }).code, "malformed_event");
  // bad revision (zero / float)
  assert.equal(parseFail({ ...goalSetEvent(1), revision: 0 }).code, "malformed_event");
  assert.equal(parseFail({ ...goalSetEvent(1), revision: 1.5 }).code, "malformed_event");
  // unknown kind
  assert.equal(parseFail({ ...goalSetEvent(1), kind: "goal_bump" }).code, "malformed_event");
});

test("rejects invalid payloads: bad goal ids, statuses, claim hashes, node shapes", () => {
  const badGoalId = goalSetEvent(1);
  badGoalId.data = { goal: { ...goalSetEvent(1).data.goal, goalId: "not-a-goal-id" } };
  assert.equal(parseFail(lineOf(badGoalId)).code, "malformed_event");

  const badStatus = goalSetEvent(1);
  badStatus.data = { goal: { ...goalSetEvent(1).data.goal, status: "excited" as unknown as GoalSetEvent["data"]["goal"]["status"] } };
  assert.equal(parseFail(lineOf(badStatus)).code, "malformed_event");

  const badHash = claimReturnedEvent();
  badHash.data = { ...claimReturnedEvent().data, claim: { ...claimReturnedEvent().data.claim, claimHash: "XYZ" } };
  assert.equal(parseFail(lineOf(badHash)).code, "malformed_event");

  const badNode = todoAddedEvent(1);
  badNode.data = { ...todoAddedEvent(1).data, node: { ...todoAddedEvent(1).data.node, id: "todo_1" } };
  assert.equal(parseFail(lineOf(badNode)).code, "malformed_event");

  const badPath = todoAddedEvent(1);
  badPath.data = { ...todoAddedEvent(1).data, node: { ...todoAddedEvent(1).data.node, path: "01.1" } };
  assert.equal(parseFail(lineOf(badPath)).code, "malformed_event");

  const badStatusEnum = todoAddedEvent(1);
  badStatusEnum.data = { ...todoAddedEvent(1).data, node: { ...todoAddedEvent(1).data.node, status: "finished" as unknown as TodoAddedEvent["data"]["node"]["status"] } };
  assert.equal(parseFail(lineOf(badStatusEnum)).code, "malformed_event");
});

test("goal_set with an embedded revision mismatch still parses (conflict is restore-level lineage)", () => {
  const conflict = goalSetEvent(2, 3);
  const parsed = parseOk(lineOf(conflict));
  if (parsed.stream !== "goal") return assert.fail("wrong stream");
  if (parsed.event.kind !== "goal_set") return assert.fail("wrong kind");
  assert.equal(parsed.event.revision, 2);
  assert.equal(parsed.event.data.goal.revision, 3);
});

test("serialize → parse round-trips every event kind deterministically", () => {
  const events = [
    goalSetEvent(1),
    goalClearEvent(2),
    goalBaselineEvent(2),
    todosSnapshotEvent(1),
    todoAddedEvent(2),
    claimLaunchedEvent(),
    claimReturnedEvent(),
    claimValidatedEvent(),
    claimSettledEvent(),
    receiptEvent(),
  ];
  for (const event of events) {
    const line = serializeStreamEvent(event);
    assert.equal(line.includes("\n"), false, "serialized events are single lines");
    const again = parseOk(JSON.parse(line));
    assert.equal(again.event.kind, event.kind);
    assert.deepEqual(again.event.data, event.data);
    assert.equal(serializeStreamEvent(again.event as typeof event), line, "serialization is deterministic");
  }
});
