// test/store-snapshot.test.ts — Phase 3b TDD (red first): atomic snapshots,
// strict snapshot reads, compaction, and divergent-lineage quarantine.
//
// Under test: src/store/snapshot.ts (+ restore interplay) — atomic
// tmp+rename snapshot writes carrying goal + todos + claims + revisions +
// formatVersion, strict read validation, compaction after a configurable
// number of appends past the last snapshot (default 200) rewriting the logs
// to a single snapshot-restored baseline marker, the round-trip property
// (compacted restore === full replay), and the divergent-lineage rule
// (a snapshot never silently merges with divergent logs: mismatched
// baseline/snapshot revisions quarantine, a missing snapshot with a baseline
// blocks, a snapshot ahead of a non-baseline log blocks).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { compactGoalStore, readSnapshotMarker } from "../src/store/snapshot.js";
import { restoreGoalStore } from "../src/store/restore.js";
import type { RestoreGoalStoreResult } from "../src/store/restore.js";
import { GoalsFileLock, appendClaimEvent, appendGoalEvent, appendTodoGraphEvent, goalStorePaths } from "../src/store/log.js";
import { GOAL_STREAM_SCHEMA, serializeStreamEvent } from "../src/store/events.js";
import type { ClaimReturnedEvent, GoalSetEvent, TodoAddedEvent } from "../src/store/events.js";

const GOAL_ID = "goal_ff0000000006";
const AT = 1_700_002_000_000;
const HASH_A = "a".repeat(64);

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "pi-goals-snapshot-"));
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function goalSetEvent(revision: number): GoalSetEvent {
  return {
    schema: GOAL_STREAM_SCHEMA,
    kind: "goal_set",
    revision,
    at: AT + revision,
    data: {
      goal: {
        goalId: GOAL_ID,
        objective: `Objective ${revision}`,
        status: revision >= 2 ? "ready_for_oracle" : "active",
        revision,
        createdAt: AT,
        updatedAt: AT + revision,
      },
    },
  };
}

function todoAddedEvent(revision: number): TodoAddedEvent {
  return {
    schema: "pi-goals.todos.v1",
    kind: "todo_added",
    revision,
    at: AT + revision,
    data: {
      goalId: GOAL_ID,
      node: {
        id: `todo_${String(revision).padStart(12, "0")}`,
        path: String(revision),
        title: `Todo ${revision}`,
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

function claimReturnedEvent(attemptId: string): ClaimReturnedEvent {
  return {
    schema: "pi-goals.claims.v1",
    kind: "claim_returned",
    at: AT,
    data: {
      goalId: GOAL_ID,
      claim: {
        claimVersion: 1,
        attemptId,
        claimHash: sha256(attemptId),
        validationPolicy: "parent_review",
        evidenceRefs: ["reports/claim.md"],
        validationCommands: ["npm test"],
        returnedAt: AT,
      },
    },
  };
}

function seedStore(stateDir: string, runtimeDir: string): void {
  const lock = GoalsFileLock.acquire(path.join(runtimeDir, "goals.lock"));
  assert.equal(lock.ok, true);
  if (!lock.ok) return;
  try {
    appendGoalEvent(lock.lock, stateDir, GOAL_ID, goalSetEvent(1), { compaction: "off" });
    appendGoalEvent(lock.lock, stateDir, GOAL_ID, goalSetEvent(2), { compaction: "off" });
    appendTodoGraphEvent(lock.lock, stateDir, GOAL_ID, todoAddedEvent(1), { compaction: "off" });
    appendTodoGraphEvent(lock.lock, stateDir, GOAL_ID, todoAddedEvent(2), { compaction: "off" });
    appendClaimEvent(lock.lock, stateDir, GOAL_ID, claimReturnedEvent("attempt-1"), { compaction: "off" });
    appendClaimEvent(lock.lock, stateDir, GOAL_ID, claimReturnedEvent("attempt-2"), { compaction: "off" });
  } finally {
    lock.lock.release();
  }
}

function okRestore(stateDir: string): RestoreGoalStoreResult {
  const result = restoreGoalStore(stateDir, GOAL_ID);
  assert.equal(result.status, "ok", JSON.stringify(result));
  return result;
}

function readSnapshotJson(stateDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(goalStorePaths(stateDir, GOAL_ID).snapshot, "utf8")) as Record<string, unknown>;
}

function writeSnapshotJson(stateDir: string, value: unknown): void {
  writeFileSync(goalStorePaths(stateDir, GOAL_ID).snapshot, JSON.stringify(value, null, 2));
}

test("round-trip property: restore after compaction equals full replay before compaction", () => {
  const stateDir = tempDir();
  const runtimeDir = tempDir();
  try {
    seedStore(stateDir, runtimeDir);
    const before = okRestore(stateDir);
    const compacted = compactGoalStore(stateDir, GOAL_ID);
    assert.equal(compacted.ok, true, JSON.stringify(compacted));
    const after = okRestore(stateDir);
    assert.deepEqual(after, before);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("compaction rewrites logs to a single baseline marker and resets the append counter", () => {
  const stateDir = tempDir();
  const runtimeDir = tempDir();
  try {
    seedStore(stateDir, runtimeDir);
    const compacted = compactGoalStore(stateDir, GOAL_ID);
    assert.equal(compacted.ok, true);
    const paths = goalStorePaths(stateDir, GOAL_ID);
    assert.equal(existsSync(paths.snapshot), true);
    for (const logPath of [paths.goalLog, paths.todosLog, paths.claimsLog]) {
      const text = readFileSync(logPath, "utf8");
      const lines = text.split("\n").filter((line) => line.length > 0);
      assert.equal(lines.length, 1, `${logPath} should hold exactly the baseline marker`);
      const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
      assert.equal(parsed.kind, "baseline");
      assert.equal(parsed.data && (parsed.data as Record<string, unknown>).snapshotFile, "snapshot.json");
    }
    const baseline = JSON.parse(readFileSync(paths.goalLog, "utf8").split("\n")[0]!) as Record<string, unknown>;
    assert.equal(baseline.revision, 2);
    const marker = readSnapshotMarker(stateDir, GOAL_ID);
    assert.equal(marker?.appendsSinceSnapshot, 0);
    assert.equal(marker?.revisions.goal, 2);
    assert.equal(marker?.revisions.todos, 2);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("auto-compaction triggers after the configured append count and keeps lineage contiguous", () => {
  const stateDir = tempDir();
  const runtimeDir = tempDir();
  const lock = GoalsFileLock.acquire(path.join(runtimeDir, "goals.lock"));
  assert.equal(lock.ok, true);
  if (!lock.ok) return;
  try {
    for (let revision = 1; revision <= 3; revision += 1) {
      appendGoalEvent(lock.lock, stateDir, GOAL_ID, goalSetEvent(revision), { compactionThreshold: 3 });
    }
    const paths = goalStorePaths(stateDir, GOAL_ID);
    const goalLines = readFileSync(paths.goalLog, "utf8").split("\n").filter((line) => line.length > 0);
    assert.equal(goalLines.length, 1, "compaction rewrote the goal log to a baseline marker");
    assert.equal(existsSync(paths.snapshot), true);
    assert.equal(readSnapshotMarker(stateDir, GOAL_ID)?.appendsSinceSnapshot, 0);

    // the 4th append continues the lineage from the baseline
    appendGoalEvent(lock.lock, stateDir, GOAL_ID, goalSetEvent(4), { compactionThreshold: 3 });
    const afterFourthLines = readFileSync(paths.goalLog, "utf8").split("\n").filter((line) => line.length > 0);
    assert.equal(afterFourthLines.length, 2);
    assert.equal((JSON.parse(afterFourthLines[0]!) as Record<string, unknown>).kind, "baseline");
    assert.equal((JSON.parse(afterFourthLines[1]!) as Record<string, unknown>).revision, 4);
    const restored = okRestore(stateDir);
    assert.equal(restored.status, "ok");
    if (restored.status !== "ok") return;
    assert.equal(restored.goal?.revision, 4);
    assert.equal(restored.goal?.objective, "Objective 4");
    assert.equal(readSnapshotMarker(stateDir, GOAL_ID)?.appendsSinceSnapshot, 1);
  } finally {
    lock.lock.release();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("tampered snapshot (bad formatVersion) → blocked snapshot_invalid + snapshot quarantined", () => {
  const stateDir = tempDir();
  const runtimeDir = tempDir();
  try {
    seedStore(stateDir, runtimeDir);
    assert.equal(compactGoalStore(stateDir, GOAL_ID).ok, true);
    const snapshot = readSnapshotJson(stateDir);
    snapshot.formatVersion = 99;
    writeSnapshotJson(stateDir, snapshot);
    const result = restoreGoalStore(stateDir, GOAL_ID);
    assert.equal(result.status, "blocked");
    if (result.status !== "blocked") return;
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "snapshot_invalid"));
    assert.equal(existsSync(goalStorePaths(stateDir, GOAL_ID).snapshot), false, "tampered snapshot moved to quarantine");
    const quarantined = readdirSync(path.join(stateDir, "quarantine", GOAL_ID));
    assert.ok(quarantined.some((name) => name.startsWith("snapshot.json.")));
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("divergent head: snapshot revision ≠ baseline revision → blocked snapshot_lineage_mismatch + quarantine", () => {
  const stateDir = tempDir();
  const runtimeDir = tempDir();
  try {
    seedStore(stateDir, runtimeDir);
    assert.equal(compactGoalStore(stateDir, GOAL_ID).ok, true);
    const snapshot = readSnapshotJson(stateDir);
    (snapshot.revisions as Record<string, unknown>).goal = 99;
    writeSnapshotJson(stateDir, snapshot);
    const result = restoreGoalStore(stateDir, GOAL_ID);
    assert.equal(result.status, "blocked");
    if (result.status !== "blocked") return;
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "snapshot_lineage_mismatch"));
    assert.equal(existsSync(goalStorePaths(stateDir, GOAL_ID).snapshot), false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("missing snapshot with a baseline present → blocked snapshot_missing, logs left in place", () => {
  const stateDir = tempDir();
  const runtimeDir = tempDir();
  try {
    seedStore(stateDir, runtimeDir);
    assert.equal(compactGoalStore(stateDir, GOAL_ID).ok, true);
    rmSync(goalStorePaths(stateDir, GOAL_ID).snapshot);
    const result = restoreGoalStore(stateDir, GOAL_ID);
    assert.equal(result.status, "blocked");
    if (result.status !== "blocked") return;
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "snapshot_missing"));
    const paths = goalStorePaths(stateDir, GOAL_ID);
    assert.equal(existsSync(paths.goalLog), true, "logs are NOT quarantined for a missing snapshot");
    assert.equal(existsSync(paths.todosLog), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("snapshot ahead of a non-baseline log → blocked log_behind_snapshot, no files moved", () => {
  const stateDir = tempDir();
  const runtimeDir = tempDir();
  const lock = GoalsFileLock.acquire(path.join(runtimeDir, "goals.lock"));
  assert.equal(lock.ok, true);
  if (!lock.ok) return;
  try {
    appendGoalEvent(lock.lock, stateDir, GOAL_ID, goalSetEvent(1), { compaction: "off" });
    lock.lock.release();
    // a valid snapshot claiming a goal revision the never-compacted log never reached
    writeSnapshotJson(stateDir, {
      formatVersion: 1,
      goalId: GOAL_ID,
      writtenAt: AT,
      revisions: { goal: 5, todos: 0 },
      goal: { goalId: GOAL_ID, objective: "phantom", status: "active", revision: 5, createdAt: AT, updatedAt: AT },
      todoGraph: { goalId: GOAL_ID, revision: 0, nodes: [] },
      claims: { attempts: {}, claims: {}, validations: {}, settlements: {} },
    });
    const result = restoreGoalStore(stateDir, GOAL_ID);
    assert.equal(result.status, "blocked");
    if (result.status !== "blocked") return;
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "log_behind_snapshot"));
    const paths = goalStorePaths(stateDir, GOAL_ID);
    assert.equal(existsSync(paths.goalLog), true, "no files moved for log_behind_snapshot");
    assert.equal(existsSync(paths.snapshot), true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("claims baseline: compaction snapshots claims and later appends continue after it", () => {
  const stateDir = tempDir();
  const runtimeDir = tempDir();
  const lock = GoalsFileLock.acquire(path.join(runtimeDir, "goals.lock"));
  assert.equal(lock.ok, true);
  if (!lock.ok) return;
  try {
    appendClaimEvent(lock.lock, stateDir, GOAL_ID, claimReturnedEvent("attempt-1"), { compaction: "off" });
    appendClaimEvent(lock.lock, stateDir, GOAL_ID, claimReturnedEvent("attempt-2"), { compaction: "off" });
    assert.equal(compactGoalStore(stateDir, GOAL_ID).ok, true);
    appendClaimEvent(lock.lock, stateDir, GOAL_ID, claimReturnedEvent("attempt-3"), { compaction: "off" });
    const restored = okRestore(stateDir);
    if (restored.status !== "ok") return;
    assert.equal(Object.keys(restored.claims.claims).length, 3);
    assert.equal(restored.claims.claims["attempt-3"]?.claimHash, sha256("attempt-3"));
    const claimsLines = readFileSync(goalStorePaths(stateDir, GOAL_ID).claimsLog, "utf8").split("\n").filter((line) => line.length > 0);
    assert.equal(claimsLines.length, 2);
    assert.equal((JSON.parse(claimsLines[0]!) as Record<string, unknown>).kind, "baseline");
  } finally {
    lock.lock.release();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test("compaction refuses to run on a restore-blocked goal", () => {
  const stateDir = tempDir();
  try {
    // hand-poison the goal stream: revision gap
    const dir = goalStorePaths(stateDir, GOAL_ID).dir;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const first = serializeStreamEvent(goalSetEvent(1));
    const third = serializeStreamEvent(goalSetEvent(3));
    writeFileSync(path.join(dir, "goal.log.jsonl"), `${first}\n${third}\n`);
    const result = compactGoalStore(stateDir, GOAL_ID);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "restore_blocked");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});
