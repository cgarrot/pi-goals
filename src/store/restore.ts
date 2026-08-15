// src/store/restore.ts — Phase 3b stream replay with the corruption →
// quarantine matrix.
//
// restoreGoalStore(stateDir, goalId) replays the goal's three streams plus
// the global CAS receipt stream with exact revision lineage: expected
// revision = last + 1 per revisioned stream (R2), goal_set events must agree
// with their embedded goal revision, and a compacted stream's baseline
// marker must agree with the snapshot's revisions.
//
// Corruption matrix (all rows → RestoreBlocked, NEVER a partial apply — the
// blocked result carries diagnostics only, no half-replayed state):
//   revision_gap          envelope revision ≠ expected        → quarantine the stream file
//   revision_conflict     embedded goal revision ≠ envelope   → quarantine the stream file
//   malformed_line        bad JSON / bad shape / blank line /
//                         baseline not first / cross-goal     → quarantine the stream file
//   truncated_tail        last line missing its newline       → quarantine the stream file
//   unknown_schema        parseable JSON, unknown schema (R1) → quarantine the stream file
//   stream_too_large      stream exceeds the byte cap         → quarantine the stream file
//   receipt_conflict      same mutationId, different hash     → quarantine cas-receipts.jsonl
//   snapshot_invalid      snapshot fails strict validation    → quarantine the snapshot file
//   snapshot_lineage_mismatch baseline ≠ snapshot revisions   → quarantine the snapshot file
//   snapshot_missing      baseline present, snapshot absent   → blocked, files left in place
//   log_behind_snapshot   snapshot ahead of an uncompacted log→ blocked, files left in place
// Quarantine moves the offending file to
// <stateDir>/quarantine/<goalId>/<file>.<timestamp>.<ext> plus a
// <file>.<ts>.<ext>.diagnostic.json (receipts use quarantine/_cas).
//
// Purity: no clocks beyond quarantine timestamps (Date.now for unique
// names), no writes outside stateDir/quarantine, no network. Nothing
// imports this module except snapshot compaction and future Phase 4/5.

import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  GOAL_STREAM_SCHEMA,
  isCanonicalGoalId,
  parseStreamLine,
} from "./events.js";
import type { GoalRecord, TodoTreePolicyRecord } from "./events.js";
import { casReceiptsPath, fileExists, goalStorePaths, readStreamText } from "./log.js";
import type { StreamReadOptions } from "./log.js";
import { SNAPSHOT_FILE_NAME, readSnapshotFile } from "./snapshot.js";
import type { GoalStoreSnapshot } from "./snapshot.js";
import { createGoalMutationReceiptState, recordMutationReceipt } from "../core/cas.js";
import type { GoalMutationReceiptState } from "../core/cas.js";
import type {
  GoalTodoClaimSettlementRecord,
  GoalTodoClaimValidationRecord,
  GoalTodoDelegationAttemptRecord,
  GoalTodoReturnedClaim,
} from "../core/claims.js";
import type { GoalTodoNode } from "../core/types.js";

// ---------------------------------------------------------------------------
// Public result shapes
// ---------------------------------------------------------------------------

export interface GoalStoreRevisions {
  readonly goal: number;
  readonly todos: number;
}

/** Claims/delegation side table keyed by attemptId (settlement: last wins). */
export interface GoalClaimsSideTable {
  readonly attempts: Readonly<Record<string, GoalTodoDelegationAttemptRecord>>;
  readonly claims: Readonly<Record<string, GoalTodoReturnedClaim>>;
  readonly validations: Readonly<Record<string, GoalTodoClaimValidationRecord>>;
  readonly settlements: Readonly<Record<string, GoalTodoClaimSettlementRecord>>;
}

export function createEmptyClaimsSideTable(): GoalClaimsSideTable {
  return { attempts: {}, claims: {}, validations: {}, settlements: {} };
}

export interface RestoredTodoGraph {
  readonly goalId: string;
  readonly revision: number;
  readonly nodes: readonly GoalTodoNode[];
  readonly policy?: TodoTreePolicyRecord;
}

export interface RestoredGoalStore {
  readonly status: "ok";
  readonly goalId: string;
  readonly goal: GoalRecord | undefined;
  readonly todoGraph: RestoredTodoGraph;
  readonly claims: GoalClaimsSideTable;
  readonly receipts: GoalMutationReceiptState;
  readonly revisions: GoalStoreRevisions;
}

export type RestoreDiagnosticCode =
  | "revision_gap"
  | "revision_conflict"
  | "malformed_line"
  | "truncated_tail"
  | "unknown_schema"
  | "stream_too_large"
  | "receipt_conflict"
  | "snapshot_invalid"
  | "snapshot_missing"
  | "snapshot_lineage_mismatch"
  | "log_behind_snapshot"
  | "read_error";

export type RestoreStreamName = "goal" | "todos" | "claims" | "receipts" | "snapshot";

export interface RestoreDiagnostic {
  readonly code: RestoreDiagnosticCode;
  readonly stream: RestoreStreamName;
  readonly goalId: string;
  readonly line?: number;
  readonly expectedRevision?: number;
  readonly receivedRevision?: number;
  readonly message: string;
  readonly quarantinedTo?: string;
}

export interface RestoreBlockedResult {
  readonly status: "blocked";
  readonly diagnostics: readonly RestoreDiagnostic[];
}

export type RestoreGoalStoreResult = RestoredGoalStore | RestoreBlockedResult;

interface ReceiptsOutcome {
  state: GoalMutationReceiptState;
  diagnostics: RestoreDiagnostic[];
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface DiagnosticFields {
  line?: number;
  expectedRevision?: number;
  receivedRevision?: number;
  message: string;
}

function diag(code: RestoreDiagnosticCode, stream: RestoreStreamName, goalId: string, fields: DiagnosticFields): RestoreDiagnostic {
  return {
    code,
    stream,
    goalId,
    ...(fields.line !== undefined ? { line: fields.line } : {}),
    ...(fields.expectedRevision !== undefined ? { expectedRevision: fields.expectedRevision } : {}),
    ...(fields.receivedRevision !== undefined ? { receivedRevision: fields.receivedRevision } : {}),
    message: fields.message,
  };
}

function quarantineFile(sourceFile: string, quarantineDirectory: string, fileName: string): string | undefined {
  try {
    if (!existsSync(sourceFile)) return undefined;
    mkdirSync(quarantineDirectory, { recursive: true });
    const extension = path.extname(fileName);
    const timestamp = Date.now();
    let target = path.join(quarantineDirectory, `${fileName}.${timestamp}${extension}`);
    let counter = 1;
    while (existsSync(target)) {
      target = path.join(quarantineDirectory, `${fileName}.${timestamp}-${counter}${extension}`);
      counter += 1;
    }
    renameSync(sourceFile, target);
    return target;
  } catch {
    return undefined;
  }
}

function quarantineAndDiagnose(
  sourceFile: string,
  quarantineDirectory: string,
  fileName: string,
  diagnostic: RestoreDiagnostic,
): RestoreDiagnostic {
  const quarantinedTo = quarantineFile(sourceFile, quarantineDirectory, fileName);
  const full: RestoreDiagnostic = { ...diagnostic, ...(quarantinedTo ? { quarantinedTo } : {}) };
  if (quarantinedTo) {
    try {
      writeFileSync(`${quarantinedTo}.diagnostic.json`, JSON.stringify(full, null, 2) + "\n");
    } catch {
      // the diagnostic file is best-effort metadata next to the evidence
    }
  }
  return full;
}

// ---------------------------------------------------------------------------
// Stream replayers
// ---------------------------------------------------------------------------

interface GoalStreamReplay {
  goal: GoalRecord | undefined;
  head: number;
  baselineRevision?: number;
  diagnostic?: RestoreDiagnostic;
}

function replayGoalStream(goalId: string, text: string, snapshot: GoalStoreSnapshot | undefined): GoalStreamReplay {
  if (text === "") return { goal: undefined, head: 0 };
  if (!text.endsWith("\n")) {
    return { goal: undefined, head: 0, diagnostic: diag("truncated_tail", "goal", goalId, { message: "goal stream ends without a trailing newline (truncated write)" }) };
  }
  const lines = text.split("\n").slice(0, -1);
  let goal: GoalRecord | undefined;
  let head = 0;
  let baselineRevision: number | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index]!;
    if (raw.trim() === "") {
      return { goal: undefined, head, diagnostic: diag("malformed_line", "goal", goalId, { line: lineNumber, message: `blank line at goal stream line ${lineNumber}` }) };
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return { goal: undefined, head, diagnostic: diag("malformed_line", "goal", goalId, { line: lineNumber, message: `malformed JSON at goal stream line ${lineNumber}: ${errorMessage(error)}` }) };
    }
    const parsed = parseStreamLine(value);
    if (!parsed.ok) {
      const code = parsed.code === "unknown_schema" ? "unknown_schema" : "malformed_line";
      return { goal: undefined, head, diagnostic: diag(code, "goal", goalId, { line: lineNumber, message: parsed.message }) };
    }
    if (parsed.parsed.stream !== "goal") {
      return { goal: undefined, head, diagnostic: diag("malformed_line", "goal", goalId, { line: lineNumber, message: `expected a ${GOAL_STREAM_SCHEMA} event at line ${lineNumber} but found schema ${parsed.parsed.event.schema}` }) };
    }
    const event = parsed.parsed.event;
    if (event.kind === "baseline") {
      if (lineNumber !== 1) {
        return { goal: undefined, head, diagnostic: diag("malformed_line", "goal", goalId, { line: lineNumber, message: "baseline marker must be the first line of a compacted goal stream" }) };
      }
      baselineRevision = event.revision;
      head = event.revision;
      goal = snapshot?.goal ? cloneJson(snapshot.goal) : undefined;
      continue;
    }
    const expected = head + 1;
    if (event.revision !== expected) {
      return { goal: undefined, head, diagnostic: diag("revision_gap", "goal", goalId, { line: lineNumber, expectedRevision: expected, receivedRevision: event.revision, message: `goal revision gap at line ${lineNumber}: expected ${expected}, received ${event.revision}` }) };
    }
    if (event.kind === "goal_set") {
      if (event.data.goal.revision !== event.revision) {
        return { goal: undefined, head, diagnostic: diag("revision_conflict", "goal", goalId, { line: lineNumber, expectedRevision: event.revision, receivedRevision: event.data.goal.revision, message: `goal revision conflict at line ${lineNumber}: envelope ${event.revision} vs embedded ${event.data.goal.revision}` }) };
      }
      if (event.data.goal.goalId !== goalId) {
        return { goal: undefined, head, diagnostic: diag("malformed_line", "goal", goalId, { line: lineNumber, message: `cross-goal event in the stream for ${goalId}: ${event.data.goal.goalId}` }) };
      }
      goal = cloneJson(event.data.goal);
    } else {
      if (event.data.goalId !== goalId) {
        return { goal: undefined, head, diagnostic: diag("malformed_line", "goal", goalId, { line: lineNumber, message: `cross-goal clear in the stream for ${goalId}: ${event.data.goalId}` }) };
      }
      goal = undefined;
    }
    head = event.revision;
  }
  return { goal, head, ...(baselineRevision !== undefined ? { baselineRevision } : {}) };
}

interface TodosStreamReplay {
  nodes: GoalTodoNode[];
  policy: TodoTreePolicyRecord | undefined;
  head: number;
  baselineRevision?: number;
  diagnostic?: RestoreDiagnostic;
}

function replayTodosStream(goalId: string, text: string, snapshot: GoalStoreSnapshot | undefined): TodosStreamReplay {
  if (text === "") return { nodes: [], policy: undefined, head: 0 };
  if (!text.endsWith("\n")) {
    return { nodes: [], policy: undefined, head: 0, diagnostic: diag("truncated_tail", "todos", goalId, { message: "todos stream ends without a trailing newline (truncated write)" }) };
  }
  const lines = text.split("\n").slice(0, -1);
  let nodes: GoalTodoNode[] = [];
  let policy: TodoTreePolicyRecord | undefined;
  let head = 0;
  let baselineRevision: number | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index]!;
    if (raw.trim() === "") {
      return { nodes: [], policy: undefined, head, diagnostic: diag("malformed_line", "todos", goalId, { line: lineNumber, message: `blank line at todos stream line ${lineNumber}` }) };
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return { nodes: [], policy: undefined, head, diagnostic: diag("malformed_line", "todos", goalId, { line: lineNumber, message: `malformed JSON at todos stream line ${lineNumber}: ${errorMessage(error)}` }) };
    }
    const parsed = parseStreamLine(value);
    if (!parsed.ok) {
      const code = parsed.code === "unknown_schema" ? "unknown_schema" : "malformed_line";
      return { nodes: [], policy: undefined, head, diagnostic: diag(code, "todos", goalId, { line: lineNumber, message: parsed.message }) };
    }
    if (parsed.parsed.stream !== "todos") {
      return { nodes: [], policy: undefined, head, diagnostic: diag("malformed_line", "todos", goalId, { line: lineNumber, message: `expected a pi-goals.todos.v1 event at line ${lineNumber} but found schema ${parsed.parsed.event.schema}` }) };
    }
    const event = parsed.parsed.event;
    if (event.kind === "baseline") {
      if (lineNumber !== 1) {
        return { nodes: [], policy: undefined, head, diagnostic: diag("malformed_line", "todos", goalId, { line: lineNumber, message: "baseline marker must be the first line of a compacted todos stream" }) };
      }
      baselineRevision = event.revision;
      head = event.revision;
      nodes = snapshot ? snapshot.todoGraph.nodes.map((node) => cloneJson(node)) : [];
      policy = snapshot?.todoGraph.policy ? cloneJson(snapshot.todoGraph.policy) : undefined;
      continue;
    }
    const expected = head + 1;
    if (event.revision !== expected) {
      return { nodes: [], policy: undefined, head, diagnostic: diag("revision_gap", "todos", goalId, { line: lineNumber, expectedRevision: expected, receivedRevision: event.revision, message: `todos revision gap at line ${lineNumber}: expected ${expected}, received ${event.revision}` }) };
    }
    if (event.kind === "todos_snapshot") {
      if (event.data.goalId !== goalId) {
        return { nodes: [], policy: undefined, head, diagnostic: diag("malformed_line", "todos", goalId, { line: lineNumber, message: `cross-goal snapshot in the stream for ${goalId}` }) };
      }
      nodes = event.data.nodes.map((node) => cloneJson(node));
      if (event.data.policy) policy = cloneJson(event.data.policy);
    } else if (event.kind === "todo_added" || event.kind === "todo_updated") {
      if (event.data.goalId !== goalId) {
        return { nodes: [], policy: undefined, head, diagnostic: diag("malformed_line", "todos", goalId, { line: lineNumber, message: `cross-goal event in the stream for ${goalId}` }) };
      }
      const node = cloneJson(event.data.node);
      const existing = nodes.findIndex((candidate) => candidate.id === node.id);
      if (event.kind === "todo_added" || existing >= 0) {
        if (existing >= 0) nodes[existing] = node;
        else nodes.push(node);
      }
      // todo_updated for an unknown id is skipped (zob patch semantics)
    } else if (event.kind === "todo_removed") {
      if (event.data.goalId !== goalId) {
        return { nodes: [], policy: undefined, head, diagnostic: diag("malformed_line", "todos", goalId, { line: lineNumber, message: `cross-goal event in the stream for ${goalId}` }) };
      }
      nodes = nodes.filter((candidate) => candidate.id !== event.data.todoId);
    } else {
      if (event.data.goalId !== goalId) {
        return { nodes: [], policy: undefined, head, diagnostic: diag("malformed_line", "todos", goalId, { line: lineNumber, message: `cross-goal event in the stream for ${goalId}` }) };
      }
      nodes = [];
    }
    head = event.revision;
  }
  return { nodes, policy, head, ...(baselineRevision !== undefined ? { baselineRevision } : {}) };
}

interface ClaimsStreamReplay {
  claims: GoalClaimsSideTable;
  baseline: boolean;
  diagnostic?: RestoreDiagnostic;
}

function replayClaimsStream(goalId: string, text: string, snapshot: GoalStoreSnapshot | undefined): ClaimsStreamReplay {
  if (text === "") return { claims: createEmptyClaimsSideTable(), baseline: false };
  if (!text.endsWith("\n")) {
    return { claims: createEmptyClaimsSideTable(), baseline: false, diagnostic: diag("truncated_tail", "claims", goalId, { message: "claims stream ends without a trailing newline (truncated write)" }) };
  }
  const lines = text.split("\n").slice(0, -1);
  let attempts: Record<string, GoalTodoDelegationAttemptRecord> = {};
  let claims: Record<string, GoalTodoReturnedClaim> = {};
  let validations: Record<string, GoalTodoClaimValidationRecord> = {};
  let settlements: Record<string, GoalTodoClaimSettlementRecord> = {};
  let baseline = false;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index]!;
    if (raw.trim() === "") {
      return { claims: createEmptyClaimsSideTable(), baseline: false, diagnostic: diag("malformed_line", "claims", goalId, { line: lineNumber, message: `blank line at claims stream line ${lineNumber}` }) };
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return { claims: createEmptyClaimsSideTable(), baseline: false, diagnostic: diag("malformed_line", "claims", goalId, { line: lineNumber, message: `malformed JSON at claims stream line ${lineNumber}: ${errorMessage(error)}` }) };
    }
    const parsed = parseStreamLine(value);
    if (!parsed.ok) {
      const code = parsed.code === "unknown_schema" ? "unknown_schema" : "malformed_line";
      return { claims: createEmptyClaimsSideTable(), baseline: false, diagnostic: diag(code, "claims", goalId, { line: lineNumber, message: parsed.message }) };
    }
    if (parsed.parsed.stream !== "claims") {
      return { claims: createEmptyClaimsSideTable(), baseline: false, diagnostic: diag("malformed_line", "claims", goalId, { line: lineNumber, message: `expected a pi-goals.claims.v1 event at line ${lineNumber} but found schema ${parsed.parsed.event.schema}` }) };
    }
    const event = parsed.parsed.event;
    if (event.kind === "baseline") {
      if (lineNumber !== 1) {
        return { claims: createEmptyClaimsSideTable(), baseline: false, diagnostic: diag("malformed_line", "claims", goalId, { line: lineNumber, message: "baseline marker must be the first line of a compacted claims stream" }) };
      }
      baseline = true;
      if (snapshot) {
        attempts = { ...snapshot.claims.attempts };
        claims = { ...snapshot.claims.claims };
        validations = { ...snapshot.claims.validations };
        settlements = { ...snapshot.claims.settlements };
      }
      continue;
    }
    if (event.data.goalId !== goalId) {
      return { claims: createEmptyClaimsSideTable(), baseline: false, diagnostic: diag("malformed_line", "claims", goalId, { line: lineNumber, message: `cross-goal event in the stream for ${goalId}` }) };
    }
    if (event.kind === "delegation_attempt_launched") {
      attempts[event.data.attempt.attemptId] = cloneJson(event.data.attempt);
    } else if (event.kind === "claim_returned") {
      claims[event.data.claim.attemptId] = cloneJson(event.data.claim);
    } else if (event.kind === "claim_validated") {
      validations[event.data.validation.attemptId] = cloneJson(event.data.validation);
    } else {
      settlements[event.data.settlement.attemptId] = cloneJson(event.data.settlement);
    }
  }
  return { claims: { attempts, claims, validations, settlements }, baseline };
}

function replayReceiptsOutcome(stateDir: string, goalId: string, options: StreamReadOptions): ReceiptsOutcome {
  const empty = createGoalMutationReceiptState();
  const receiptPath = casReceiptsPath(stateDir);
  const quarantineDirectory = path.join(stateDir, "quarantine", "_cas");
  const text = readStreamText(receiptPath, options);
  if (!text.ok) {
    if (text.code === "stream_too_large") {
      return { state: empty, diagnostics: [quarantineAndDiagnose(receiptPath, quarantineDirectory, "cas-receipts.jsonl", diag("stream_too_large", "receipts", goalId, { message: text.message }))] };
    }
    return { state: empty, diagnostics: [diag("read_error", "receipts", goalId, { message: text.message })] };
  }
  if (text.text === "") return { state: empty, diagnostics: [] };
  if (!text.text.endsWith("\n")) {
    return { state: empty, diagnostics: [quarantineAndDiagnose(receiptPath, quarantineDirectory, "cas-receipts.jsonl", diag("truncated_tail", "receipts", goalId, { message: "cas receipt stream ends without a trailing newline (truncated write)" }))] };
  }
  const lines = text.text.split("\n").slice(0, -1);
  let state = createGoalMutationReceiptState();
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index]!;
    const fail = (code: RestoreDiagnosticCode, message: string): ReceiptsOutcome => ({
      state: empty,
      diagnostics: [quarantineAndDiagnose(receiptPath, quarantineDirectory, "cas-receipts.jsonl", diag(code, "receipts", goalId, { line: lineNumber, message }))],
    });
    if (raw.trim() === "") return fail("malformed_line", `blank line at cas receipt stream line ${lineNumber}`);
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      return fail("malformed_line", `malformed JSON at cas receipt stream line ${lineNumber}: ${errorMessage(error)}`);
    }
    const parsed = parseStreamLine(value);
    if (!parsed.ok) {
      return fail(parsed.code === "unknown_schema" ? "unknown_schema" : "malformed_line", parsed.message);
    }
    if (parsed.parsed.stream !== "receipts") {
      return fail("malformed_line", `expected a pi-goals.receipt.v1 event at line ${lineNumber} but found schema ${parsed.parsed.event.schema}`);
    }
    const recorded = recordMutationReceipt(state, parsed.parsed.event.data.receipt);
    if (!recorded.ok) {
      return fail("receipt_conflict", `cas receipt conflict at line ${lineNumber}: ${recorded.message}`);
    }
    state = recorded.state;
  }
  return { state, diagnostics: [] };
}

// ---------------------------------------------------------------------------
// restoreGoalStore / restoreAllGoals
// ---------------------------------------------------------------------------

function restoreGoalStoreInner(
  stateDir: string,
  goalId: string,
  options: StreamReadOptions,
  sharedReceipts?: ReceiptsOutcome,
): RestoreGoalStoreResult {
  if (!isCanonicalGoalId(goalId)) {
    throw new TypeError(`restoreGoalStore: goalId must be canonical (goal_ + 12 lowercase hex): ${goalId}`);
  }
  const diagnostics: RestoreDiagnostic[] = [];
  const paths = goalStorePaths(stateDir, goalId);
  const quarantineDirectory = path.join(stateDir, "quarantine", goalId);

  // snapshot (optional; invalid snapshots are quarantined and reported once)
  let snapshot: GoalStoreSnapshot | undefined;
  let snapshotReported = false;
  if (fileExists(paths.snapshot)) {
    const read = readSnapshotFile(stateDir, goalId);
    if (read.ok) {
      snapshot = read.snapshot;
    } else {
      diagnostics.push(quarantineAndDiagnose(paths.snapshot, quarantineDirectory, SNAPSHOT_FILE_NAME, diag("snapshot_invalid", "snapshot", goalId, { message: read.message })));
      snapshotReported = true;
    }
  }

  // goal stream
  let goal: GoalRecord | undefined;
  let goalHead = 0;
  const goalText = readStreamText(paths.goalLog, options);
  if (!goalText.ok) {
    if (goalText.code === "stream_too_large") {
      diagnostics.push(quarantineAndDiagnose(paths.goalLog, quarantineDirectory, "goal.log.jsonl", diag("stream_too_large", "goal", goalId, { message: goalText.message })));
    } else {
      diagnostics.push(diag("read_error", "goal", goalId, { message: goalText.message }));
    }
  } else {
    const replay = replayGoalStream(goalId, goalText.text, snapshot);
    if (replay.diagnostic) {
      diagnostics.push(quarantineAndDiagnose(paths.goalLog, quarantineDirectory, "goal.log.jsonl", replay.diagnostic));
    } else {
      goal = replay.goal;
      goalHead = replay.head;
      if (replay.baselineRevision !== undefined) {
        if (!snapshot) {
          if (!snapshotReported) {
            diagnostics.push(diag("snapshot_missing", "goal", goalId, { message: "compacted goal stream references a missing snapshot" }));
          }
        } else if (snapshot.revisions.goal !== replay.baselineRevision) {
          diagnostics.push(quarantineAndDiagnose(paths.snapshot, quarantineDirectory, SNAPSHOT_FILE_NAME, diag("snapshot_lineage_mismatch", "goal", goalId, {
            expectedRevision: replay.baselineRevision,
            receivedRevision: snapshot.revisions.goal,
            message: `goal baseline revision ${replay.baselineRevision} does not match snapshot revision ${snapshot.revisions.goal}`,
          })));
        }
      } else if (snapshot && snapshot.revisions.goal > goalHead) {
        diagnostics.push(diag("log_behind_snapshot", "goal", goalId, { expectedRevision: snapshot.revisions.goal, receivedRevision: goalHead, message: `snapshot witnessed goal revision ${snapshot.revisions.goal} but the uncompacted log head is ${goalHead}` }));
      }
    }
  }

  // todos stream
  let nodes: GoalTodoNode[] = [];
  let policy: TodoTreePolicyRecord | undefined;
  let todosHead = 0;
  const todosText = readStreamText(paths.todosLog, options);
  if (!todosText.ok) {
    if (todosText.code === "stream_too_large") {
      diagnostics.push(quarantineAndDiagnose(paths.todosLog, quarantineDirectory, "todos.log.jsonl", diag("stream_too_large", "todos", goalId, { message: todosText.message })));
    } else {
      diagnostics.push(diag("read_error", "todos", goalId, { message: todosText.message }));
    }
  } else {
    const replay = replayTodosStream(goalId, todosText.text, snapshot);
    if (replay.diagnostic) {
      diagnostics.push(quarantineAndDiagnose(paths.todosLog, quarantineDirectory, "todos.log.jsonl", replay.diagnostic));
    } else {
      nodes = replay.nodes;
      policy = replay.policy;
      todosHead = replay.head;
      if (replay.baselineRevision !== undefined) {
        if (!snapshot) {
          if (!snapshotReported) {
            diagnostics.push(diag("snapshot_missing", "todos", goalId, { message: "compacted todos stream references a missing snapshot" }));
          }
        } else if (snapshot.revisions.todos !== replay.baselineRevision) {
          diagnostics.push(quarantineAndDiagnose(paths.snapshot, quarantineDirectory, SNAPSHOT_FILE_NAME, diag("snapshot_lineage_mismatch", "todos", goalId, {
            expectedRevision: replay.baselineRevision,
            receivedRevision: snapshot.revisions.todos,
            message: `todos baseline revision ${replay.baselineRevision} does not match snapshot revision ${snapshot.revisions.todos}`,
          })));
        }
      } else if (snapshot && snapshot.revisions.todos > todosHead) {
        diagnostics.push(diag("log_behind_snapshot", "todos", goalId, { expectedRevision: snapshot.revisions.todos, receivedRevision: todosHead, message: `snapshot witnessed todos revision ${snapshot.revisions.todos} but the uncompacted log head is ${todosHead}` }));
      }
    }
  }

  // claims stream (append-only side table; no revision lineage)
  let claims = createEmptyClaimsSideTable();
  const claimsText = readStreamText(paths.claimsLog, options);
  if (!claimsText.ok) {
    if (claimsText.code === "stream_too_large") {
      diagnostics.push(quarantineAndDiagnose(paths.claimsLog, quarantineDirectory, "claims.log.jsonl", diag("stream_too_large", "claims", goalId, { message: claimsText.message })));
    } else {
      diagnostics.push(diag("read_error", "claims", goalId, { message: claimsText.message }));
    }
  } else {
    const replay = replayClaimsStream(goalId, claimsText.text, snapshot);
    if (replay.diagnostic) {
      diagnostics.push(quarantineAndDiagnose(paths.claimsLog, quarantineDirectory, "claims.log.jsonl", replay.diagnostic));
    } else {
      claims = replay.claims;
      if (replay.baseline && !snapshot && !snapshotReported) {
        diagnostics.push(diag("snapshot_missing", "claims", goalId, { message: "compacted claims stream references a missing snapshot" }));
      }
    }
  }

  // global CAS receipts (restored once per call, or shared by restoreAllGoals)
  const receiptsOutcome = sharedReceipts ?? replayReceiptsOutcome(stateDir, goalId, options);
  diagnostics.push(...receiptsOutcome.diagnostics);

  if (diagnostics.length > 0) {
    return { status: "blocked", diagnostics };
  }
  return {
    status: "ok",
    goalId,
    goal,
    todoGraph: { goalId, revision: todosHead, nodes, ...(policy ? { policy } : {}) },
    claims,
    receipts: receiptsOutcome.state,
    revisions: { goal: goalHead, todos: todosHead },
  };
}

/**
 * Replay one goal's streams (plus the global CAS receipts). Returns ok with
 * the full live state, or blocked with diagnostics — never a partial apply.
 * A goal with no files on disk restores to a clean empty state.
 */
export function restoreGoalStore(stateDir: string, goalId: string, options: StreamReadOptions = {}): RestoreGoalStoreResult {
  return restoreGoalStoreInner(stateDir, goalId, options);
}

export interface RestoreAllGoalsIndex {
  readonly goals: Readonly<Record<string, RestoreGoalStoreResult>>;
  readonly receipts: ReceiptsOutcome;
}

/**
 * Index every goals/<goalId> directory. Stray entries (non-directories or
 * non-canonical goal ids) are skipped; the receipts stream is restored once
 * and its diagnostics merged into each goal's result, so a poisoned CAS
 * stream blocks every goal exactly like restoreGoalStore would.
 */
export function restoreAllGoals(stateDir: string, options: StreamReadOptions = {}): RestoreAllGoalsIndex {
  const goalsDirectory = path.join(stateDir, "goals");
  let entries: string[] = [];
  try {
    entries = readdirSync(goalsDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isCanonicalGoalId(entry.name))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const receipts = replayReceiptsOutcome(stateDir, "_cas", options);
  const goals: Record<string, RestoreGoalStoreResult> = {};
  for (const goalId of [...entries].sort()) {
    goals[goalId] = restoreGoalStoreInner(stateDir, goalId, options, receipts);
  }
  return { goals, receipts };
}
