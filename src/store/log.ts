// src/store/log.ts — Phase 3b file lock, atomic JSONL appends, byte-capped
// readers, and the per-stream write-side append APIs.
//
// Lock: single-writer discipline via a mkdir/O_EXCL lockfile DIRECTORY in
// the runtime dir (default <runtimeDir>/goals.lock) holding holder.json
// with {pid, acquiredAt}. A second live acquirer gets blocked_with_holder
// with the holder's pid+timestamp; a stale lock (dead pid or holder mtime
// older than staleAfterMs) is removed and retried once. Release removes the
// exact lock directory only.
//
// Appends: single O_APPEND write of the full line + "\n" followed by fsync,
// so a crashed writer leaves either nothing or a whole line. Readers are
// byte-capped. Write-side revision gates enforce revision = head + 1 (and
// embedded goal revision agreement) BEFORE anything hits disk, and refuse
// to append onto a poisoned stream (unreadable head / truncated tail).
//
// Purity contract: node:fs/node:path only plus core/events/snapshot imports.
// All paths arrive as parameters (stateDir / runtimeDir); nothing here
// resolves .goals on its own. Compaction bookkeeping lives in snapshot.ts
// (noteGoalAppendAndMaybeCompact); the log<->snapshot<->restore import
// cycle is function-level only (safe under Node ESM).

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  CLAIMS_STREAM_SCHEMA,
  GOAL_STREAM_SCHEMA,
  RECEIPT_STREAM_SCHEMA,
  TODOS_STREAM_SCHEMA,
  isCanonicalGoalId,
  parseStreamLine,
  serializeStreamEvent,
} from "./events.js";
import type {
  ClaimsStreamAppendEvent,
  GoalStreamAppendEvent,
  ReceiptStreamEvent,
  TodosStreamAppendEvent,
} from "./events.js";
import {
  createGoalMutationReceiptState,
  evaluateMutationReplay,
  recordMutationReceipt,
} from "../core/cas.js";
import type { GoalMutationReceiptState } from "../core/cas.js";
import { noteGoalAppendAndMaybeCompact } from "./snapshot.js";

// ---------------------------------------------------------------------------
// GoalsFileLock
// ---------------------------------------------------------------------------

export const LOCK_HOLDER_FILE = "holder.json";

export interface LockHolderInfo {
  readonly pid: number;
  readonly acquiredAt: number;
}

export interface GoalsFileLockOptions {
  /** Holder mtime age after which a lock is considered stale (default 60s). */
  readonly staleAfterMs?: number;
}

export const DEFAULT_LOCK_STALE_AFTER_MS = 60_000;

export type GoalsLockAcquireResult =
  | { ok: true; lock: GoalsFileLock }
  | { ok: false; code: "blocked_with_holder" | "lock_error"; message: string; holder?: LockHolderInfo };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrnoException(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as NodeJS.ErrnoException).code === code;
}

function pidIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // ESRCH: no such process. Anything else (EPERM/EINVAL) means "exists but
    // not ours to signal" → treat as alive.
    return isErrnoException(error, "ESRCH");
  }
}

function readHolder(lockPath: string): LockHolderInfo | undefined {
  try {
    const raw = readFileSync(path.join(lockPath, LOCK_HOLDER_FILE), "utf8");
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    const pid = record.pid;
    const acquiredAt = record.acquiredAt;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
    if (typeof acquiredAt !== "number" || !Number.isSafeInteger(acquiredAt) || acquiredAt < 0) return undefined;
    return { pid, acquiredAt };
  } catch {
    return undefined;
  }
}

function holderAgeMs(lockPath: string): number {
  try {
    const stats = statSync(path.join(lockPath, LOCK_HOLDER_FILE));
    return Math.max(0, Date.now() - stats.mtimeMs);
  } catch {
    try {
      return Math.max(0, Date.now() - statSync(lockPath).mtimeMs);
    } catch {
      return 0;
    }
  }
}

/** Single-writer lock over the goals store (one lock covers all streams). */
export class GoalsFileLock {
  private heldState: boolean;
  private constructor(private readonly lockPath: string, readonly holder: LockHolderInfo) {
    this.heldState = true;
  }

  get path(): string {
    return this.lockPath;
  }

  get isHeld(): boolean {
    return this.heldState;
  }

  release(): void {
    if (!this.heldState) return;
    this.heldState = false;
    try {
      rmSync(this.lockPath, { recursive: true, force: true });
    } catch {
      // best-effort cleanup; a leaked lock dir is detected as stale later
    }
  }

  static acquire(lockPath: string, options: GoalsFileLockOptions = {}): GoalsLockAcquireResult {
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_LOCK_STALE_AFTER_MS;
    try {
      mkdirSync(path.dirname(lockPath), { recursive: true });
    } catch (error) {
      return { ok: false, code: "lock_error", message: `cannot create lock parent directory: ${errorMessage(error)}` };
    }
    const holder: LockHolderInfo = { pid: process.pid, acquiredAt: Date.now() };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        mkdirSync(lockPath); // exclusive directory creation (O_EXCL semantics)
        try {
          writeFileSync(path.join(lockPath, LOCK_HOLDER_FILE), JSON.stringify(holder), { flag: "wx" });
        } catch {
          // holder info is best-effort metadata for blocked acquirers
        }
        return { ok: true, lock: new GoalsFileLock(lockPath, holder) };
      } catch (error) {
        if (!isErrnoException(error, "EEXIST")) {
          return { ok: false, code: "lock_error", message: `unexpected lock acquisition error: ${errorMessage(error)}` };
        }
      }
      const existing = readHolder(lockPath);
      // Stale rules: another live process's lock is stale only by holder
      // mtime age; a dead process's lock is always stale; OUR OWN pid (a
      // second acquisition in this process) blocks while fresh — only mtime
      // age may stale it (crashed holder write in the same pid is unlikely
      // but the mtime ladder still recovers it).
      let stale: boolean;
      if (existing === undefined) {
        stale = holderAgeMs(lockPath) > staleAfterMs;
      } else if (existing.pid === process.pid) {
        stale = holderAgeMs(lockPath) > staleAfterMs;
      } else if (pidIsDead(existing.pid)) {
        stale = true;
      } else {
        stale = holderAgeMs(lockPath) > staleAfterMs;
      }
      if (!stale) {
        return {
          ok: false,
          code: "blocked_with_holder",
          message: `goals lock is held by pid ${existing?.pid ?? "unknown"}`,
          ...(existing ? { holder: existing } : {}),
        };
      }
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch (error) {
        return { ok: false, code: "lock_error", message: `cannot clear stale lock: ${errorMessage(error)}` };
      }
    }
    return { ok: false, code: "lock_error", message: "goals lock is still occupied after stale cleanup" };
  }
}

/** Acquire → run → always release. The fn result is propagated on success. */
export function withGoalsLock<T>(
  lockPath: string,
  fn: (lock: GoalsFileLock) => T,
  options?: GoalsFileLockOptions,
): { ok: true; result: T } | Extract<GoalsLockAcquireResult, { ok: false }> {
  const acquired = GoalsFileLock.acquire(lockPath, options);
  if (!acquired.ok) return acquired;
  try {
    return { ok: true, result: fn(acquired.lock) };
  } finally {
    acquired.lock.release();
  }
}

// ---------------------------------------------------------------------------
// Store layout (everything under the injected stateDir)
// ---------------------------------------------------------------------------

export interface GoalStorePaths {
  readonly dir: string;
  readonly goalLog: string;
  readonly todosLog: string;
  readonly claimsLog: string;
  readonly snapshot: string;
  readonly snapshotMarker: string;
}

/** goals/<goalId>/{goal,todos,claims}.log.jsonl + snapshot files. goalId is validated (no traversal). */
export function goalStorePaths(stateDir: string, goalId: string): GoalStorePaths {
  if (!isCanonicalGoalId(goalId)) {
    throw new TypeError(`goalStorePaths: goalId must be canonical (goal_ + 12 lowercase hex): ${goalId}`);
  }
  const dir = path.join(stateDir, "goals", goalId);
  return {
    dir,
    goalLog: path.join(dir, "goal.log.jsonl"),
    todosLog: path.join(dir, "todos.log.jsonl"),
    claimsLog: path.join(dir, "claims.log.jsonl"),
    snapshot: path.join(dir, "snapshot.json"),
    snapshotMarker: path.join(dir, "snapshot.marker.json"),
  };
}

/** Global CAS receipts stream (append-only, idempotent, never compacted). */
export function casReceiptsPath(stateDir: string): string {
  return path.join(stateDir, "cas-receipts.jsonl");
}

// ---------------------------------------------------------------------------
// Byte-capped readers + atomic writers
// ---------------------------------------------------------------------------

export const DEFAULT_MAX_STREAM_BYTES = 32 * 1024 * 1024;

export interface StreamReadOptions {
  readonly maxStreamBytes?: number;
}

export type StreamTextResult =
  | { ok: true; text: string }
  | { ok: false; code: "stream_too_large" | "read_error"; message: string; size?: number };

/** Read a whole stream with a byte cap; missing files read as empty text. */
export function readStreamText(filePath: string, options: StreamReadOptions = {}): StreamTextResult {
  const maxBytes = options.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES;
  let size = 0;
  try {
    size = statSync(filePath).size;
  } catch (error) {
    if (isErrnoException(error, "ENOENT")) return { ok: true, text: "" };
    return { ok: false, code: "read_error", message: `cannot stat ${filePath}: ${errorMessage(error)}` };
  }
  if (size > maxBytes) {
    return { ok: false, code: "stream_too_large", message: `stream ${filePath} is ${size} bytes (cap ${maxBytes})`, size };
  }
  try {
    return { ok: true, text: readFileSync(filePath, "utf8") };
  } catch (error) {
    return { ok: false, code: "read_error", message: `cannot read ${filePath}: ${errorMessage(error)}` };
  }
}

function fsyncDirectory(dirPath: string): void {
  try {
    const fd = openSync(dirPath, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // directory fsync is best-effort (unsupported on some platforms)
  }
}

/** Atomic whole-file replace: tmp file + fsync + rename + directory fsync. */
export function writeFileAtomic(filePath: string, contents: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, "w");
  try {
    const bytes = Buffer.from(contents, "utf8");
    writeSync(fd, bytes, 0, bytes.length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
  fsyncDirectory(path.dirname(filePath));
}

/** Durably append ONE complete JSONL line: single O_APPEND write + fsync. */
export function appendJsonLine(filePath: string, line: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = openSync(filePath, "a");
  try {
    const payload = line.endsWith("\n") ? line : `${line}\n`;
    const bytes = Buffer.from(payload, "utf8");
    writeSync(fd, bytes, 0, bytes.length);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Write-side append APIs
// ---------------------------------------------------------------------------

export interface StoreWriteOptions extends StreamReadOptions {
  /** Compaction threshold: appends past the last snapshot before compaction. */
  readonly compactionThreshold?: number;
  /** "off" disables compaction bookkeeping (tests, explicit compaction). */
  readonly compaction?: "on" | "off";
  /** Optional caller view of the current head; mismatch → stale write error. */
  readonly expectedRevision?: number;
}

export interface AppendRevisionOutcome {
  readonly revision: number;
}

export type AppendReceiptOutcome = { status: "appended" } | { status: "replayed" };

type StreamName = "goal" | "todos" | "claims" | "receipts";

function assertHeldLock(lock: GoalsFileLock): void {
  if (!lock || !lock.isHeld) {
    throw new Error("goals store appends require a held GoalsFileLock (single-writer discipline)");
  }
}

function validateEventForAppend(
  event: GoalStreamAppendEvent | TodosStreamAppendEvent | ClaimsStreamAppendEvent | ReceiptStreamEvent,
  stream: StreamName,
): string {
  const line = serializeStreamEvent(event);
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("refusing to append an event that does not serialize to JSON");
  }
  const parsed = parseStreamLine(value);
  if (!parsed.ok) {
    throw new Error(`refusing to append a non-canonical stream event: ${parsed.message}`);
  }
  if (parsed.parsed.stream !== stream) {
    throw new Error(`event schema ${parsed.parsed.event.schema} does not belong to the ${stream} stream`);
  }
  if (parsed.parsed.event.kind === "baseline") {
    throw new Error("baseline markers are written only by compaction, never by append APIs");
  }
  return line;
}

function requireStreamText(filePath: string, options: StreamReadOptions): string {
  const result = readStreamText(filePath, options);
  if (!result.ok) throw new Error(`cannot read stream ${filePath}: ${result.message}`);
  if (result.text !== "" && !result.text.endsWith("\n")) {
    throw new Error(`stream ${filePath} has a truncated tail (no trailing newline); refusing to append onto a poisoned stream`);
  }
  return result.text;
}

function streamLines(text: string): string[] {
  return text === "" ? [] : text.split("\n").slice(0, -1);
}

function readHeadRevision(filePath: string, stream: "goal" | "todos", options: StreamReadOptions): number {
  const text = requireStreamText(filePath, options);
  const lines = streamLines(text);
  if (lines.length === 0) return 0;
  const last = lines[lines.length - 1]!;
  let value: unknown;
  try {
    value = JSON.parse(last);
  } catch {
    throw new Error(`stream head of ${filePath} is malformed JSON; refusing to append onto a poisoned stream`);
  }
  const parsed = parseStreamLine(value);
  if (!parsed.ok) {
    throw new Error(`stream head of ${filePath} failed strict parse (${parsed.code}: ${parsed.message}); refusing to append onto a poisoned stream`);
  }
  if (parsed.parsed.stream !== stream) {
    throw new Error(`stream head of ${filePath} carries schema ${parsed.parsed.event.schema}; expected the ${stream} stream`);
  }
  return parsed.parsed.event.revision;
}

function checkRevisionGate(event: { revision: number }, head: number, options: StoreWriteOptions, stream: StreamName): void {
  if (options.expectedRevision !== undefined && options.expectedRevision !== head) {
    throw new Error(`stale ${stream} write: caller expected head revision ${options.expectedRevision} but the stream head is ${head}`);
  }
  if (event.revision !== head + 1) {
    throw new Error(`write-side revision gate on the ${stream} stream: expected revision ${head + 1}, received ${event.revision}`);
  }
}

/** Append a runtime goal event; enforces revision = head + 1 write-side. */
export function appendGoalEvent(
  lock: GoalsFileLock,
  stateDir: string,
  goalId: string,
  event: GoalStreamAppendEvent,
  options: StoreWriteOptions = {},
): AppendRevisionOutcome {
  assertHeldLock(lock);
  const paths = goalStorePaths(stateDir, goalId);
  const line = validateEventForAppend(event, "goal");
  if (event.kind === "goal_set" && event.data.goal.goalId !== goalId) {
    throw new Error(`goal_set event carries goalId ${event.data.goal.goalId} but the stream belongs to ${goalId}`);
  }
  if (event.kind === "goal_clear" && event.data.goalId !== goalId) {
    throw new Error(`goal_clear event carries goalId ${event.data.goalId} but the stream belongs to ${goalId}`);
  }
  const head = readHeadRevision(paths.goalLog, "goal", options);
  checkRevisionGate(event, head, options, "goal");
  if (event.kind === "goal_set" && event.data.goal.revision !== event.revision) {
    throw new Error(`write-side revision conflict on the goal stream: envelope revision ${event.revision} but embedded goal revision ${event.data.goal.revision}`);
  }
  appendJsonLine(paths.goalLog, line);
  noteGoalAppendAndMaybeCompact(stateDir, goalId, options);
  return { revision: event.revision };
}

/** Append a todo graph event; enforces graph revision = head + 1 write-side. */
export function appendTodoGraphEvent(
  lock: GoalsFileLock,
  stateDir: string,
  goalId: string,
  event: TodosStreamAppendEvent,
  options: StoreWriteOptions = {},
): AppendRevisionOutcome {
  assertHeldLock(lock);
  const paths = goalStorePaths(stateDir, goalId);
  const line = validateEventForAppend(event, "todos");
  if (event.data.goalId !== goalId) {
    throw new Error(`todos event carries goalId ${event.data.goalId} but the stream belongs to ${goalId}`);
  }
  const head = readHeadRevision(paths.todosLog, "todos", options);
  checkRevisionGate(event, head, options, "todos");
  appendJsonLine(paths.todosLog, line);
  noteGoalAppendAndMaybeCompact(stateDir, goalId, options);
  return { revision: event.revision };
}

/** Append a claims/delegation side-table event (append-only, no revision gate). */
export function appendClaimEvent(
  lock: GoalsFileLock,
  stateDir: string,
  goalId: string,
  event: ClaimsStreamAppendEvent,
  options: StoreWriteOptions = {},
): void {
  assertHeldLock(lock);
  const paths = goalStorePaths(stateDir, goalId);
  const line = validateEventForAppend(event, "claims");
  if (event.data.goalId !== goalId) {
    throw new Error(`claims event carries goalId ${event.data.goalId} but the stream belongs to ${goalId}`);
  }
  appendJsonLine(paths.claimsLog, line);
  noteGoalAppendAndMaybeCompact(stateDir, goalId, options);
}

/**
 * Append a global CAS receipt. Exact duplicates are idempotent (nothing is
 * written, status "replayed"); a mutationId bound to a different request
 * hash throws; appending never happens onto an unreadable/poisoned stream.
 */
export function appendReceipt(
  lock: GoalsFileLock,
  stateDir: string,
  event: ReceiptStreamEvent,
  options: StoreWriteOptions = {},
): AppendReceiptOutcome {
  assertHeldLock(lock);
  const line = validateEventForAppend(event, "receipts");
  const receiptPath = casReceiptsPath(stateDir);
  const text = requireStreamText(receiptPath, options);
  let state: GoalMutationReceiptState = createGoalMutationReceiptState();
  for (const streamLine of streamLines(text)) {
    let value: unknown;
    try {
      value = JSON.parse(streamLine);
    } catch {
      throw new Error(`cas receipt stream ${receiptPath} has a malformed line; refusing to append onto a poisoned stream`);
    }
    const parsed = parseStreamLine(value);
    if (!parsed.ok || parsed.parsed.stream !== "receipts") {
      throw new Error(`cas receipt stream ${receiptPath} failed strict parse; refusing to append onto a poisoned stream`);
    }
    const recorded = recordMutationReceipt(state, parsed.parsed.event.data.receipt);
    if (!recorded.ok) {
      throw new Error(`cas receipt stream ${receiptPath} carries conflicting mutationId ${parsed.parsed.event.data.receipt.mutationId}; refusing to append onto a poisoned stream`);
    }
    state = recorded.state;
  }
  const replay = evaluateMutationReplay(state, { mutationId: event.data.receipt.mutationId, requestHash: event.data.receipt.requestHash });
  if (!replay.ok) {
    if (replay.status === "conflict") {
      throw new Error(`mutationId ${event.data.receipt.mutationId} conflicts: already bound to a different request hash`);
    }
    throw new Error(`invalid receipt (${replay.code}): ${event.data.receipt.mutationId}`);
  }
  if (replay.status === "replayed") return { status: "replayed" };
  appendJsonLine(receiptPath, line);
  return { status: "appended" };
}

/** Exposed for restore/quarantine flows: does the file exist right now? */
export function fileExists(filePath: string): boolean {
  return existsSync(filePath);
}
