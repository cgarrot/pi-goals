// src/store/snapshot.ts — Phase 3b atomic snapshots, strict snapshot reads,
// and log compaction.
//
// Snapshot = the FULL live state of one goal at the snapshot revisions:
// goal record + todo graph + claims side table + last revisions +
// formatVersion. Written atomically (tmp + fsync + rename + dir fsync) to
// goals/<goalId>/snapshot.json with an advisory companion marker
// (snapshot.marker.json) tracking appendsSinceSnapshot for compaction.
//
// Compaction (after N appends past the last snapshot, default 200):
//   1. restore the goal (must be ok — a blocked goal never compacts),
//   2. write snapshot.json atomically,
//   3. rewrite goal/todos/claims logs to ONE snapshot-restored baseline
//      marker line each (atomic replaces; crash between rewrites is safe:
//      the un-compacted log replays to the same heads the snapshot holds),
//   4. reset the marker counter.
// Round-trip property: restore after compaction === full replay before it.
//
// Divergent lineage (restore-side rule, enforced in restore.ts): a baseline
// must agree with the snapshot revisions (else snapshot_lineage_mismatch →
// the snapshot is quarantined); a baseline without a snapshot blocks
// (snapshot_missing); a snapshot ahead of a non-baseline log blocks
// (log_behind_snapshot). A snapshot NEVER silently merges with divergent logs.

import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CLAIMS_STREAM_SCHEMA,
  GOAL_STREAM_SCHEMA,
  TODOS_STREAM_SCHEMA,
  isCanonicalGoalId,
  parseClaimSettlementRecord,
  parseClaimValidationRecord,
  parseDelegationAttemptRecord,
  parseGoalRecord,
  parseGoalTodoNodeRecord,
  parseReturnedClaimRecord,
  parseTodoTreePolicyRecord,
  serializeStreamEvent,
} from "./events.js";
import type { GoalRecord, TodoTreePolicyRecord } from "./events.js";
import { goalStorePaths, writeFileAtomic } from "./log.js";
import type { StreamReadOptions, StoreWriteOptions } from "./log.js";
import { restoreGoalStore } from "./restore.js";
import type { GoalClaimsSideTable, RestoredGoalStore, RestoreDiagnostic } from "./restore.js";
import type { GoalTodoClaimSettlementRecord, GoalTodoClaimValidationRecord, GoalTodoDelegationAttemptRecord, GoalTodoReturnedClaim } from "../core/claims.js";
import type { GoalTodoNode } from "../core/types.js";

export const SNAPSHOT_FORMAT_VERSION = 1;
export const SNAPSHOT_FILE_NAME = "snapshot.json";
export const SNAPSHOT_MARKER_FILE_NAME = "snapshot.marker.json";
export const SNAPSHOT_MARKER_SCHEMA = "pi-goals.snapshot-marker.v1";
export const DEFAULT_COMPACTION_THRESHOLD = 200;

const MAX_SNAPSHOT_NODES = 10_000;
const MAX_SNAPSHOT_RECORDS = 10_000;
const METADATA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export interface GoalStoreSnapshot {
  formatVersion: typeof SNAPSHOT_FORMAT_VERSION;
  goalId: string;
  writtenAt: number;
  revisions: { goal: number; todos: number };
  goal?: GoalRecord;
  todoGraph: {
    goalId: string;
    revision: number;
    nodes: GoalTodoNode[];
    policy?: TodoTreePolicyRecord;
  };
  claims: GoalClaimsSideTable;
}

export interface SnapshotMarker {
  schema: typeof SNAPSHOT_MARKER_SCHEMA;
  goalId: string;
  snapshotWrittenAt: number;
  appendsSinceSnapshot: number;
  revisions: { goal: number; todos: number };
}

export type ReadSnapshotResult =
  | { ok: true; snapshot: GoalStoreSnapshot }
  | { ok: false; code: "snapshot_missing" | "snapshot_invalid"; message: string };

export type CompactGoalStoreResult =
  | { ok: true; snapshot: GoalStoreSnapshot }
  | { ok: false; code: "restore_blocked" | "write_error"; message: string; diagnostics?: readonly RestoreDiagnostic[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set<string>([...required, ...optional]);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key))) return false;
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function safeIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function safeRecordKey(value: string): boolean {
  return METADATA_ID_PATTERN.test(value) && !DANGEROUS_KEYS.has(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseClaimRecordMap<T>(
  value: unknown,
  parseRecord: (item: unknown) => T | undefined,
): Record<string, T> | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (keys.length > MAX_SNAPSHOT_RECORDS) return undefined;
  const parsed: Record<string, T> = {};
  for (const key of keys) {
    if (!safeRecordKey(key)) return undefined;
    const record = parseRecord(value[key]);
    if (!record) return undefined;
    parsed[key] = record;
  }
  return parsed;
}

function parseClaimsSideTable(value: unknown): GoalClaimsSideTable | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["attempts", "claims", "validations", "settlements"])) return undefined;
  const attempts = parseClaimRecordMap<GoalTodoDelegationAttemptRecord>(value.attempts, parseDelegationAttemptRecord);
  const claims = parseClaimRecordMap<GoalTodoReturnedClaim>(value.claims, parseReturnedClaimRecord);
  const validations = parseClaimRecordMap<GoalTodoClaimValidationRecord>(value.validations, parseClaimValidationRecord);
  const settlements = parseClaimRecordMap<GoalTodoClaimSettlementRecord>(value.settlements, parseClaimSettlementRecord);
  if (!attempts || !claims || !validations || !settlements) return undefined;
  return { attempts, claims, validations, settlements };
}

function parseSnapshotRecord(value: unknown, goalId: string): GoalStoreSnapshot | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["formatVersion", "goalId", "writtenAt", "revisions", "todoGraph", "claims"], ["goal"])) return undefined;
  if (value.formatVersion !== SNAPSHOT_FORMAT_VERSION) return undefined;
  if (!isCanonicalGoalId(value.goalId) || value.goalId !== goalId) return undefined;
  if (!safeIntegerAtLeast(value.writtenAt, 0)) return undefined;
  const revisions = value.revisions;
  if (!isRecord(revisions) || !hasExactKeys(revisions, ["goal", "todos"])) return undefined;
  if (!safeIntegerAtLeast(revisions.goal, 0) || !safeIntegerAtLeast(revisions.todos, 0)) return undefined;
  let goal: GoalRecord | undefined;
  if (value.goal !== undefined) {
    goal = parseGoalRecord(value.goal);
    if (!goal) return undefined;
  }
  const todoGraph = value.todoGraph;
  if (!isRecord(todoGraph) || !hasExactKeys(todoGraph, ["goalId", "revision", "nodes"], ["policy"])) return undefined;
  if (todoGraph.goalId !== goalId || !safeIntegerAtLeast(todoGraph.revision, 0) || !Array.isArray(todoGraph.nodes) || todoGraph.nodes.length > MAX_SNAPSHOT_NODES) return undefined;
  const nodes: GoalTodoNode[] = [];
  for (const node of todoGraph.nodes) {
    const parsed = parseGoalTodoNodeRecord(node);
    if (!parsed) return undefined;
    nodes.push(parsed);
  }
  let policy: TodoTreePolicyRecord | undefined;
  if (todoGraph.policy !== undefined) {
    policy = parseTodoTreePolicyRecord(todoGraph.policy);
    if (!policy) return undefined;
  }
  const claims = parseClaimsSideTable(value.claims);
  if (!claims) return undefined;
  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    goalId: value.goalId,
    writtenAt: value.writtenAt,
    revisions: { goal: revisions.goal, todos: revisions.todos },
    ...(goal ? { goal } : {}),
    todoGraph: { goalId: todoGraph.goalId, revision: todoGraph.revision, nodes, ...(policy ? { policy } : {}) },
    claims,
  };
}

function parseMarkerRecord(value: unknown): SnapshotMarker | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["schema", "goalId", "snapshotWrittenAt", "appendsSinceSnapshot", "revisions"])) return undefined;
  if (value.schema !== SNAPSHOT_MARKER_SCHEMA) return undefined;
  if (!isCanonicalGoalId(value.goalId)) return undefined;
  if (!safeIntegerAtLeast(value.snapshotWrittenAt, 0) || !safeIntegerAtLeast(value.appendsSinceSnapshot, 0)) return undefined;
  const revisions = value.revisions;
  if (!isRecord(revisions) || !hasExactKeys(revisions, ["goal", "todos"])) return undefined;
  if (!safeIntegerAtLeast(revisions.goal, 0) || !safeIntegerAtLeast(revisions.todos, 0)) return undefined;
  return {
    schema: SNAPSHOT_MARKER_SCHEMA,
    goalId: value.goalId,
    snapshotWrittenAt: value.snapshotWrittenAt,
    appendsSinceSnapshot: value.appendsSinceSnapshot,
    revisions: { goal: revisions.goal, todos: revisions.todos },
  };
}

/** Atomically write the snapshot; refuses to write anything non-canonical. */
export function writeSnapshotFile(stateDir: string, goalId: string, snapshot: GoalStoreSnapshot): { ok: true } | { ok: false; code: "write_error"; message: string } {
  const validated = parseSnapshotRecord(cloneJson(snapshot), goalId);
  if (!validated) return { ok: false, code: "write_error", message: "refusing to write a non-canonical snapshot" };
  try {
    writeFileAtomic(goalStorePaths(stateDir, goalId).snapshot, JSON.stringify(validated, null, 2) + "\n");
    return { ok: true };
  } catch (error) {
    return { ok: false, code: "write_error", message: error instanceof Error ? error.message : String(error) };
  }
}

/** Strict snapshot read: missing file, bad JSON, or any invalid shape fails. */
export function readSnapshotFile(stateDir: string, goalId: string): ReadSnapshotResult {
  const snapshotPath = goalStorePaths(stateDir, goalId).snapshot;
  let raw: string;
  try {
    raw = readFileSync(snapshotPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, code: "snapshot_missing", message: `no snapshot at ${snapshotPath}` };
    return { ok: false, code: "snapshot_invalid", message: `cannot read snapshot ${snapshotPath}: ${error instanceof Error ? error.message : String(error)}` };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { ok: false, code: "snapshot_invalid", message: `snapshot ${snapshotPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = parseSnapshotRecord(value, goalId);
  if (!parsed) return { ok: false, code: "snapshot_invalid", message: `snapshot ${snapshotPath} failed strict validation` };
  return { ok: true, snapshot: parsed };
}

/**
 * Advisory marker read. The marker is compaction bookkeeping only (never
 * event lineage), so any read/parse failure resolves to undefined instead
 * of blocking the store.
 */
export function readSnapshotMarker(stateDir: string, goalId: string): SnapshotMarker | undefined {
  try {
    const raw = readFileSync(goalStorePaths(stateDir, goalId).snapshotMarker, "utf8");
    return parseMarkerRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function writeSnapshotMarker(stateDir: string, goalId: string, marker: SnapshotMarker): void {
  const validated = parseMarkerRecord(cloneJson(marker));
  if (!validated) throw new TypeError("writeSnapshotMarker: refusing to write a non-canonical snapshot marker");
  writeFileAtomic(goalStorePaths(stateDir, goalId).snapshotMarker, JSON.stringify(validated, null, 2) + "\n");
}

/** Build a snapshot payload from a successful restore (receipts excluded by design). */
export function buildSnapshotFromRestore(restored: RestoredGoalStore, writtenAt: number): GoalStoreSnapshot {
  return {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    goalId: restored.goalId,
    writtenAt,
    revisions: { goal: restored.revisions.goal, todos: restored.revisions.todos },
    ...(restored.goal ? { goal: cloneJson(restored.goal) } : {}),
    todoGraph: {
      goalId: restored.todoGraph.goalId,
      revision: restored.todoGraph.revision,
      nodes: restored.todoGraph.nodes.map((node) => cloneJson(node)),
      ...(restored.todoGraph.policy ? { policy: cloneJson(restored.todoGraph.policy) } : {}),
    },
    claims: cloneJson(restored.claims),
  };
}

/**
 * Compact one goal: restore → snapshot → rewrite the three logs to single
 * baseline markers → reset the marker counter. A restore-blocked goal is
 * never compacted (its counter stays bumped and the next append retries).
 */
export function compactGoalStore(stateDir: string, goalId: string, options: StreamReadOptions = {}): CompactGoalStoreResult {
  const restored = restoreGoalStore(stateDir, goalId, options);
  if (restored.status === "blocked") {
    return { ok: false, code: "restore_blocked", message: "cannot compact a restore-blocked goal", diagnostics: restored.diagnostics };
  }
  const writtenAt = Date.now();
  const snapshot = buildSnapshotFromRestore(restored, writtenAt);
  const written = writeSnapshotFile(stateDir, goalId, snapshot);
  if (!written.ok) return { ok: false, code: "write_error", message: written.message };
  const paths = goalStorePaths(stateDir, goalId);
  try {
    writeFileAtomic(paths.goalLog, serializeStreamEvent({
      schema: GOAL_STREAM_SCHEMA,
      kind: "baseline",
      revision: restored.revisions.goal,
      at: writtenAt,
      data: { snapshotFile: SNAPSHOT_FILE_NAME },
    }) + "\n");
    writeFileAtomic(paths.todosLog, serializeStreamEvent({
      schema: TODOS_STREAM_SCHEMA,
      kind: "baseline",
      revision: restored.revisions.todos,
      at: writtenAt,
      data: { snapshotFile: SNAPSHOT_FILE_NAME },
    }) + "\n");
    writeFileAtomic(paths.claimsLog, serializeStreamEvent({
      schema: CLAIMS_STREAM_SCHEMA,
      kind: "baseline",
      at: writtenAt,
      data: { snapshotFile: SNAPSHOT_FILE_NAME },
    }) + "\n");
  } catch (error) {
    return { ok: false, code: "write_error", message: error instanceof Error ? error.message : String(error) };
  }
  writeSnapshotMarker(stateDir, goalId, {
    schema: SNAPSHOT_MARKER_SCHEMA,
    goalId,
    snapshotWrittenAt: writtenAt,
    appendsSinceSnapshot: 0,
    revisions: { goal: restored.revisions.goal, todos: restored.revisions.todos },
  });
  return { ok: true, snapshot };
}

/**
 * Post-append bookkeeping for the goal's three streams: bump the advisory
 * marker counter, then compact once the threshold is reached (unless
 * compaction is off). Called by the log append APIs.
 */
export function noteGoalAppendAndMaybeCompact(stateDir: string, goalId: string, options: StoreWriteOptions = {}): void {
  if (options.compaction === "off") return;
  const threshold = options.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD;
  if (!Number.isSafeInteger(threshold) || threshold < 1) return;
  const marker = readSnapshotMarker(stateDir, goalId);
  const appends = (marker?.appendsSinceSnapshot ?? 0) + 1;
  writeSnapshotMarker(stateDir, goalId, {
    schema: SNAPSHOT_MARKER_SCHEMA,
    goalId,
    snapshotWrittenAt: marker?.snapshotWrittenAt ?? 0,
    appendsSinceSnapshot: appends,
    revisions: marker?.revisions ?? { goal: 0, todos: 0 },
  });
  if (appends >= threshold) {
    // best-effort: on failure the bumped counter retries on the next append
    compactGoalStore(stateDir, goalId, options);
  }
}
