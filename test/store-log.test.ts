// test/store-log.test.ts — Phase 3b TDD (red first): the goals file lock and
// the per-stream append APIs.
//
// Under test: src/store/log.ts — GoalsFileLock (mkdir/O_EXCL lockfile in the
// runtime dir with pid+timestamp holder, stale detection by dead pid or
// holder mtime age, blocked_with_holder for a live second acquirer),
// atomic newline-terminated JSONL appends with fsync, byte-capped stream
// readers, and write-side revision gates (revision = head + 1, embedded
// goal revision must match, CAS receipt appends idempotent / conflicting
// hash rejected).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  GoalsFileLock,
  appendClaimEvent,
  appendGoalEvent,
  appendReceipt,
  appendTodoGraphEvent,
  casReceiptsPath,
  goalStorePaths,
  readStreamText,
} from "../src/store/log.js";
import {
  CLAIMS_STREAM_SCHEMA,
  GOAL_STREAM_SCHEMA,
  RECEIPT_STREAM_SCHEMA,
  TODOS_STREAM_SCHEMA,
} from "../src/store/events.js";
import type {
  ClaimsDelegationAttemptLaunchedEvent,
  GoalClearEvent,
  GoalSetEvent,
  ReceiptStreamEvent,
  TodoAddedEvent,
} from "../src/store/events.js";
import { buildMutationGuard, buildMutationReceipt, hashGoalMutationRequest } from "../src/core/cas.js";

const GOAL_ID = "goal_bb0000000002";
const AT = 1_700_000_999_000;

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "pi-goals-log-"));
}

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
        objective: "Store slice",
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

function todoAddedEvent(revision: number): TodoAddedEvent {
  return {
    schema: TODOS_STREAM_SCHEMA,
    kind: "todo_added",
    revision,
    at: AT,
    data: {
      goalId: GOAL_ID,
      node: {
        id: "todo_000000000001",
        path: "1",
        title: "T",
        status: "planned",
        owner: "agent",
        priority: "normal",
        required: true,
        createdAt: AT,
        updatedAt: AT,
      },
    },
  };
}

function claimLaunchedEvent(attemptId: string): ClaimsDelegationAttemptLaunchedEvent {
  return {
    schema: CLAIMS_STREAM_SCHEMA,
    kind: "delegation_attempt_launched",
    at: AT,
    data: {
      goalId: GOAL_ID,
      attempt: { attemptId, status: "queued", validationPolicy: "parent_review", launchedAt: AT },
    },
  };
}

function receiptEvent(mutationId: string, payload: unknown): ReceiptStreamEvent {
  const guard = buildMutationGuard("add_goal_todo", { mutationId });
  if (!guard.ok) throw new Error("guard fixture failed");
  const receipt = buildMutationReceipt(guard.guard, hashGoalMutationRequest("add_goal_todo", payload), AT);
  if (!receipt.ok) throw new Error("receipt fixture failed");
  return { schema: RECEIPT_STREAM_SCHEMA, kind: "mutation_receipt", at: AT, data: { receipt: receipt.receipt } };
}

function lockPathFor(runtimeDir: string): string {
  return path.join(runtimeDir, "goals.lock");
}

test("lock: a second acquirer is rejected with blocked_with_holder and holder info", () => {
  const runtimeDir = tempDir();
  const lockPath = lockPathFor(runtimeDir);
  const first = GoalsFileLock.acquire(lockPath);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  try {
    const second = GoalsFileLock.acquire(lockPath);
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.code, "blocked_with_holder");
    assert.equal(second.holder?.pid, process.pid);
    assert.equal(typeof second.holder?.acquiredAt, "number");
  } finally {
    first.lock.release();
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("lock: release allows reacquisition and is idempotent", () => {
  const runtimeDir = tempDir();
  const lockPath = lockPathFor(runtimeDir);
  try {
    const first = GoalsFileLock.acquire(lockPath);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.lock.isHeld, true);
    first.lock.release();
    assert.equal(first.lock.isHeld, false);
    first.lock.release(); // idempotent
    const second = GoalsFileLock.acquire(lockPath);
    assert.equal(second.ok, true);
    if (second.ok) second.lock.release();
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("lock: a stale lock held by a dead pid is stolen", () => {
  const runtimeDir = tempDir();
  const lockPath = lockPathFor(runtimeDir);
  try {
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = typeof child.pid === "number" ? child.pid : 999999999;
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(path.join(lockPath, "holder.json"), JSON.stringify({ pid: deadPid, acquiredAt: Date.now() }));
    const acquired = GoalsFileLock.acquire(lockPath);
    assert.equal(acquired.ok, true, `expected stale steal, got ${acquired.ok ? "" : acquired.code}`);
    if (acquired.ok) acquired.lock.release();
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("lock: a stale lock with a live pid but aged holder mtime is stolen", () => {
  const runtimeDir = tempDir();
  const lockPath = lockPathFor(runtimeDir);
  try {
    mkdirSync(lockPath, { recursive: true });
    const holderPath = path.join(lockPath, "holder.json");
    writeFileSync(holderPath, JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }));
    const aged = new Date(Date.now() - 20_000);
    utimesSync(holderPath, aged, aged);
    const acquired = GoalsFileLock.acquire(lockPath, { staleAfterMs: 5_000 });
    assert.equal(acquired.ok, true, `expected mtime steal, got ${acquired.ok ? "" : acquired.code}`);
    if (acquired.ok) acquired.lock.release();
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("appendGoalEvent enforces revision = head + 1 write-side and rejects embedded conflicts", () => {
  const runtimeDir = tempDir();
  const stateDir = tempDir();
  const lock = GoalsFileLock.acquire(lockPathFor(runtimeDir));
  assert.equal(lock.ok, true);
  if (!lock.ok) return;
  try {
    assert.throws(() => appendGoalEvent(lock.lock, stateDir, GOAL_ID, goalSetEvent(2)), /revision/i);
    appendGoalEvent(lock.lock, stateDir, GOAL_ID, goalSetEvent(1));
    appendGoalEvent(lock.lock, stateDir, GOAL_ID, goalClearEvent(2));
    assert.throws(() => appendGoalEvent(lock.lock, stateDir, GOAL_ID, goalSetEvent(2)), /revision/i);
    assert.throws(() => appendGoalEvent(lock.lock, stateDir, GOAL_ID, goalSetEvent(3, 4)), /conflict/i);
    appendGoalEvent(lock.lock, stateDir, GOAL_ID, goalSetEvent(3));
    const text = readFileSync(goalStorePaths(stateDir, GOAL_ID).goalLog, "utf8");
    assert.equal(text.endsWith("\n"), true);
    assert.equal(text.split("\n").filter((line) => line.length > 0).length, 3);
  } finally {
    lock.lock.release();
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("appendGoalEvent rejects cross-goal events and non-held locks", () => {
  const runtimeDir = tempDir();
  const stateDir = tempDir();
  const lock = GoalsFileLock.acquire(lockPathFor(runtimeDir));
  assert.equal(lock.ok, true);
  if (!lock.ok) return;
  try {
    const crossGoal = goalSetEvent(1);
    crossGoal.data = { goal: { ...goalSetEvent(1).data.goal, goalId: "goal_cc0000000003" } };
    assert.throws(() => appendGoalEvent(lock.lock, stateDir, GOAL_ID, crossGoal), /goalId/i);

    lock.lock.release();
    assert.throws(() => appendGoalEvent(lock.lock, stateDir, GOAL_ID, goalSetEvent(1)), /lock/i);
  } finally {
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("appendTodoGraphEvent enforces graph revision = head + 1 write-side", () => {
  const runtimeDir = tempDir();
  const stateDir = tempDir();
  const lock = GoalsFileLock.acquire(lockPathFor(runtimeDir));
  assert.equal(lock.ok, true);
  if (!lock.ok) return;
  try {
    assert.throws(() => appendTodoGraphEvent(lock.lock, stateDir, GOAL_ID, todoAddedEvent(2)), /revision/i);
    appendTodoGraphEvent(lock.lock, stateDir, GOAL_ID, todoAddedEvent(1));
    appendTodoGraphEvent(lock.lock, stateDir, GOAL_ID, todoAddedEvent(2));
    const text = readFileSync(goalStorePaths(stateDir, GOAL_ID).todosLog, "utf8");
    assert.equal(text.split("\n").filter((line) => line.length > 0).length, 2);
  } finally {
    lock.lock.release();
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("appendClaimEvent appends without revision gating", () => {
  const runtimeDir = tempDir();
  const stateDir = tempDir();
  const lock = GoalsFileLock.acquire(lockPathFor(runtimeDir));
  assert.equal(lock.ok, true);
  if (!lock.ok) return;
  try {
    appendClaimEvent(lock.lock, stateDir, GOAL_ID, claimLaunchedEvent("attempt-1"));
    appendClaimEvent(lock.lock, stateDir, GOAL_ID, claimLaunchedEvent("attempt-2"));
    const text = readFileSync(goalStorePaths(stateDir, GOAL_ID).claimsLog, "utf8");
    assert.equal(text.endsWith("\n"), true);
    assert.equal(text.split("\n").filter((line) => line.length > 0).length, 2);
  } finally {
    lock.lock.release();
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("appendReceipt is idempotent for exact duplicates and rejects hash conflicts", () => {
  const runtimeDir = tempDir();
  const stateDir = tempDir();
  const lock = GoalsFileLock.acquire(lockPathFor(runtimeDir));
  assert.equal(lock.ok, true);
  if (!lock.ok) return;
  try {
    const event = receiptEvent("mut-1", { x: 1 });
    assert.equal(appendReceipt(lock.lock, stateDir, event).status, "appended");
    assert.equal(appendReceipt(lock.lock, stateDir, event).status, "replayed");
    const text = readFileSync(casReceiptsPath(stateDir), "utf8");
    assert.equal(text.split("\n").filter((line) => line.length > 0).length, 1);
    const conflicting = receiptEvent("mut-1", { x: 2 });
    assert.throws(() => appendReceipt(lock.lock, stateDir, conflicting), /conflict/i);
  } finally {
    lock.lock.release();
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("readStreamText enforces the byte cap and treats missing files as empty", () => {
  const dir = tempDir();
  try {
    const missing = readStreamText(path.join(dir, "nope.jsonl"));
    assert.equal(missing.ok, true);
    if (missing.ok) assert.equal(missing.text, "");

    const bigPath = path.join(dir, "big.jsonl");
    writeFileSync(bigPath, "x".repeat(2048));
    const tooLarge = readStreamText(bigPath, { maxStreamBytes: 1024 });
    assert.equal(tooLarge.ok, false);
    if (!tooLarge.ok) assert.equal(tooLarge.code, "stream_too_large");

    const fits = readStreamText(bigPath, { maxStreamBytes: 4096 });
    assert.equal(fits.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
