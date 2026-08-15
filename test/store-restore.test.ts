// test/store-restore.test.ts — Phase 3b TDD (red first): stream replay with
// the full corruption → quarantine matrix.
//
// Under test: src/store/restore.ts — restoreGoalStore(stateDir, goalId)
// replays goal/todos/claims streams plus the global CAS receipt stream with
// exact revision lineage (expected = last + 1 per revisioned stream,
// baselines seed from the snapshot). Every corruption row — revision gap,
// revision conflict (embedded mismatch), malformed JSON line, truncated tail
// (interleaved crash simulation), unknown schema — produces a RestoreBlocked
// diagnostic AND moves the offending file to
// <stateDir>/quarantine/<goalId>/<file>.<timestamp>.jsonl with a diagnostic
// JSON. A poisoned stream NEVER partially applies: the blocked result
// carries diagnostics only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { restoreAllGoals, restoreGoalStore } from "../src/store/restore.js";
import type { RestoreDiagnostic, RestoreGoalStoreResult } from "../src/store/restore.js";
import {
  GoalsFileLock,
  appendClaimEvent,
  appendGoalEvent,
  appendReceipt,
  appendTodoGraphEvent,
  casReceiptsPath,
  goalStorePaths,
} from "../src/store/log.js";
import {
  CLAIMS_STREAM_SCHEMA,
  GOAL_STREAM_SCHEMA,
  RECEIPT_STREAM_SCHEMA,
  TODOS_STREAM_SCHEMA,
  serializeStreamEvent,
} from "../src/store/events.js";
import type { ClaimsDelegationAttemptLaunchedEvent, GoalSetEvent, PiGoalStatus, ReceiptStreamEvent, TodoAddedEvent } from "../src/store/events.js";
import { buildMutationGuard, buildMutationReceipt, hashGoalMutationRequest } from "../src/core/cas.js";

const GOAL_ID = "goal_dd0000000004";
const OTHER_GOAL_ID = "goal_ee0000000005";
const AT = 1_700_001_000_000;
const HASH_A = "a".repeat(64);

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "pi-goals-restore-"));
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function goalSetEvent(revision: number, goalId = GOAL_ID, status: PiGoalStatus = "active"): GoalSetEvent {
  return {
    schema: GOAL_STREAM_SCHEMA,
    kind: "goal_set",
    revision,
    at: AT + revision,
    data: {
      goal: {
        goalId,
        objective: `Objective at revision ${revision}`,
        status,
        revision,
        createdAt: AT,
        updatedAt: AT + revision,
      },
    },
  };
}

function todoAddedEvent(revision: number, id: string): TodoAddedEvent {
  return {
    schema: TODOS_STREAM_SCHEMA,
    kind: "todo_added",
    revision,
    at: AT + revision,
    data: {
      goalId: GOAL_ID,
      node: {
        id,
        path: String(revision),
        title: `Todo ${id}`,
        status: "planned",
        owner: "agent",
        priority: "normal",
        required: true,
        createdAt: AT,
        updatedAt: AT + revision,
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

function receiptEvent(mutationId: string): ReceiptStreamEvent {
  const guard = buildMutationGuard("add_goal_todo", { mutationId });
  if (!guard.ok) throw new Error("guard fixture failed");
  const receipt = buildMutationReceipt(guard.guard, sha256(mutationId), AT);
  if (!receipt.ok) throw new Error("receipt fixture failed");
  return { schema: RECEIPT_STREAM_SCHEMA, kind: "mutation_receipt", at: AT, data: { receipt: receipt.receipt } };
}

/** Write raw stream content (tests simulate corruption / crash states). */
function writeStream(stateDir: string, goalId: string, file: "goal.log.jsonl" | "todos.log.jsonl" | "claims.log.jsonl", content: string): void {
  const paths = goalStorePaths(stateDir, goalId);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(path.join(paths.dir, file), content);
}

function writeGoalLines(stateDir: string, goalId: string, lines: string[]): void {
  writeStream(stateDir, goalId, "goal.log.jsonl", lines.map((line) => line + "\n").join(""));
}

function quarantineDirFor(stateDir: string, goalId: string): string {
  return path.join(stateDir, "quarantine", goalId);
}

function blockedOf(result: RestoreGoalStoreResult): readonly RestoreDiagnostic[] {
  assert.equal(result.status, "blocked", `expected blocked, got ok for ${JSON.stringify(result).slice(0, 200)}`);
  if (result.status !== "blocked") throw new Error("unreachable");
  return result.diagnostics;
}

test("happy path: replays goal, todos, claims, and receipts with exact revisions", () => {
  const runtimeDir = tempDir();
  const stateDir = tempDir();
  const lock = GoalsFileLock.acquire(path.join(runtimeDir, "goals.lock"));
  assert.equal(lock.ok, true);
  if (!lock.ok) return;
  try {
    appendGoalEvent(lock.lock, stateDir, GOAL_ID, goalSetEvent(1));
    appendGoalEvent(lock.lock, stateDir, GOAL_ID, goalSetEvent(2, GOAL_ID, "ready_for_oracle"));
    appendTodoGraphEvent(lock.lock, stateDir, GOAL_ID, todoAddedEvent(1, "todo_000000000001"));
    appendTodoGraphEvent(lock.lock, stateDir, GOAL_ID, todoAddedEvent(2, "todo_000000000002"));
    appendClaimEvent(lock.lock, stateDir, GOAL_ID, claimLaunchedEvent());
    appendReceipt(lock.lock, stateDir, receiptEvent("mut-1"));
    const result = restoreGoalStore(stateDir, GOAL_ID);
    assert.equal(result.status, "ok", JSON.stringify(result));
    if (result.status !== "ok") return;
    assert.equal(result.goal?.revision, 2);
    assert.equal(result.goal?.status, "ready_for_oracle");
    assert.equal(result.goal?.objective, "Objective at revision 2");
    assert.equal(result.revisions.goal, 2);
    assert.equal(result.todoGraph.revision, 2);
    assert.equal(result.todoGraph.nodes.length, 2);
    assert.equal(result.todoGraph.nodes[1]?.id, "todo_000000000002");
    assert.equal(result.claims.attempts["attempt-1"]?.status, "queued");
    assert.equal(result.receipts.receipts["mut-1"]?.mutationId, "mut-1");
    assert.equal(result.revisions.todos, 2);
  } finally {
    lock.lock.release();
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("revision gap → RestoreBlocked with quarantine file + diagnostic json", () => {
  const stateDir = tempDir();
  try {
    writeGoalLines(stateDir, GOAL_ID, [serializeStreamEvent(goalSetEvent(1)), serializeStreamEvent(goalSetEvent(3))]);
    const diagnostics = blockedOf(restoreGoalStore(stateDir, GOAL_ID));
    const gap = diagnostics.find((diagnostic) => diagnostic.code === "revision_gap");
    assert.ok(gap, `expected revision_gap diagnostic in ${JSON.stringify(diagnostics)}`);
    assert.equal(gap?.stream, "goal");
    assert.equal(gap?.goalId, GOAL_ID);
    assert.equal(gap?.expectedRevision, 2);
    assert.equal(gap?.receivedRevision, 3);
    assert.ok(gap?.quarantinedTo?.includes("quarantine"));
    assert.equal(existsSync(gap!.quarantinedTo!), true, "quarantined copy exists");
    assert.equal(existsSync(goalStorePaths(stateDir, GOAL_ID).goalLog), false, "live stream removed");
    const diagnosticFiles = readdirSync(quarantineDirFor(stateDir, GOAL_ID)).filter((name) => name.endsWith(".diagnostic.json"));
    assert.equal(diagnosticFiles.length, 1);
    const diagnostic = JSON.parse(readFileSync(path.join(quarantineDirFor(stateDir, GOAL_ID), diagnosticFiles[0]!), "utf8")) as RestoreDiagnostic;
    assert.equal(diagnostic.code, "revision_gap");
    // after quarantine the next restore is clean (fail-closed, then empty)
    const after = restoreGoalStore(stateDir, GOAL_ID);
    assert.equal(after.status, "ok");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("revision conflict (embedded mismatch) → RestoreBlocked + quarantine", () => {
  const stateDir = tempDir();
  try {
    const conflict = goalSetEvent(2);
    conflict.data = { goal: { ...goalSetEvent(2).data.goal, revision: 3 } };
    writeGoalLines(stateDir, GOAL_ID, [serializeStreamEvent(goalSetEvent(1)), serializeStreamEvent(conflict)]);
    const diagnostics = blockedOf(restoreGoalStore(stateDir, GOAL_ID));
    const conflictDiagnostic = diagnostics.find((diagnostic) => diagnostic.code === "revision_conflict");
    assert.ok(conflictDiagnostic, JSON.stringify(diagnostics));
    assert.equal(conflictDiagnostic?.expectedRevision, 2);
    assert.equal(conflictDiagnostic?.receivedRevision, 3);
    assert.equal(existsSync(goalStorePaths(stateDir, GOAL_ID).goalLog), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("malformed JSON line → RestoreBlocked + quarantine", () => {
  const stateDir = tempDir();
  try {
    writeGoalLines(stateDir, GOAL_ID, [serializeStreamEvent(goalSetEvent(1)), "{not-json-at-all"]);
    const diagnostics = blockedOf(restoreGoalStore(stateDir, GOAL_ID));
    const malformed = diagnostics.find((diagnostic) => diagnostic.code === "malformed_line");
    assert.ok(malformed, JSON.stringify(diagnostics));
    assert.equal(malformed?.line, 2);
    assert.equal(existsSync(goalStorePaths(stateDir, GOAL_ID).goalLog), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("truncated tail (crash simulation, no trailing newline) → RestoreBlocked + quarantine", () => {
  const stateDir = tempDir();
  try {
    // crash mid-append: the last write never completed its newline
    const content = serializeStreamEvent(goalSetEvent(1)) + "\n" + serializeStreamEvent(goalSetEvent(2));
    assert.equal(content.endsWith("\n"), false);
    writeStream(stateDir, GOAL_ID, "goal.log.jsonl", content);
    const diagnostics = blockedOf(restoreGoalStore(stateDir, GOAL_ID));
    const truncated = diagnostics.find((diagnostic) => diagnostic.code === "truncated_tail");
    assert.ok(truncated, JSON.stringify(diagnostics));
    assert.equal(truncated?.stream, "goal");
    assert.equal(existsSync(goalStorePaths(stateDir, GOAL_ID).goalLog), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("unknown schema line → RestoreBlocked + quarantine (R1)", () => {
  const stateDir = tempDir();
  try {
    const future = JSON.stringify({ schema: "pi-goals.goal.v2", kind: "goal_set", revision: 2, at: AT, data: {} });
    writeGoalLines(stateDir, GOAL_ID, [serializeStreamEvent(goalSetEvent(1)), future]);
    const diagnostics = blockedOf(restoreGoalStore(stateDir, GOAL_ID));
    const unknown = diagnostics.find((diagnostic) => diagnostic.code === "unknown_schema");
    assert.ok(unknown, JSON.stringify(diagnostics));
    assert.equal(unknown?.line, 2);
    assert.equal(existsSync(goalStorePaths(stateDir, GOAL_ID).goalLog), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a poisoned todos stream never partially applies the healthy goal stream", () => {
  const stateDir = tempDir();
  try {
    writeGoalLines(stateDir, GOAL_ID, [serializeStreamEvent(goalSetEvent(1))]);
    writeStream(stateDir, GOAL_ID, "todos.log.jsonl", [
      serializeStreamEvent(todoAddedEvent(1, "todo_000000000001")),
      serializeStreamEvent(todoAddedEvent(3, "todo_000000000003")),
    ].map((line) => line + "\n").join(""));
    const result = restoreGoalStore(stateDir, GOAL_ID);
    assert.equal(result.status, "blocked");
    assert.equal("goal" in result, false, "blocked results never carry partial state");
    const diagnostics = blockedOf(result);
    assert.ok(diagnostics.some((diagnostic) => diagnostic.code === "revision_gap" && diagnostic.stream === "todos"));
    // only the offending stream is quarantined; the healthy goal stream stays
    assert.equal(existsSync(goalStorePaths(stateDir, GOAL_ID).goalLog), true);
    assert.equal(existsSync(goalStorePaths(stateDir, GOAL_ID).todosLog), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("CAS receipts: exact duplicate lines replay idempotently", () => {
  const stateDir = tempDir();
  try {
    const line = serializeStreamEvent(receiptEvent("mut-1")) + "\n";
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(casReceiptsPath(stateDir), line + line);
    const result = restoreGoalStore(stateDir, GOAL_ID);
    assert.equal(result.status, "ok", JSON.stringify(result));
    if (result.status !== "ok") return;
    assert.equal(Object.keys(result.receipts.receipts).length, 1);
    assert.equal(result.receipts.receipts["mut-1"]?.mutationId, "mut-1");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("missing streams restore to a clean empty state", () => {
  const stateDir = tempDir();
  try {
    const result = restoreGoalStore(stateDir, GOAL_ID);
    assert.equal(result.status, "ok");
    if (result.status !== "ok") return;
    assert.equal(result.goal, undefined);
    assert.equal(result.revisions.goal, 0);
    assert.equal(result.revisions.todos, 0);
    assert.deepEqual(result.todoGraph.nodes, []);
    assert.deepEqual(result.claims.attempts, {});
    assert.deepEqual(result.receipts.receipts, {});
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("restoreAllGoals indexes every goal directory and skips stray entries", () => {
  const runtimeDir = tempDir();
  const stateDir = tempDir();
  const lock = GoalsFileLock.acquire(path.join(runtimeDir, "goals.lock"));
  assert.equal(lock.ok, true);
  if (!lock.ok) return;
  try {
    appendGoalEvent(lock.lock, stateDir, GOAL_ID, goalSetEvent(1));
    appendGoalEvent(lock.lock, stateDir, OTHER_GOAL_ID, goalSetEvent(1, OTHER_GOAL_ID));
    mkdirSync(path.join(stateDir, "goals", "not-a-goal"), { recursive: true });
    writeFileSync(path.join(stateDir, "goals", "stray.txt"), "x");
    const index = restoreAllGoals(stateDir);
    assert.deepEqual(Object.keys(index.goals).sort(), [GOAL_ID, OTHER_GOAL_ID].sort());
    assert.equal(index.goals[GOAL_ID]?.status, "ok");
    assert.equal(index.goals[OTHER_GOAL_ID]?.status, "ok");
    assert.equal(Object.keys(index.receipts.state.receipts).length, 0);
  } finally {
    lock.lock.release();
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
