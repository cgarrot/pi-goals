// src/store/events.ts — Phase 3b strict stream event envelopes + parsers.
//
// Layering: imports core only (types/ids/claims/cas vocabulary); no fs, os,
// clock, or env access — parse/serialize are pure so log, restore, and
// snapshot share ONE strict vocabulary.
//
// R1 (fail-closed): an unknown future schema is an `unknown_schema` parse
// failure — a quarantine diagnostic at restore time, never a silent skip.
// R2 (one revision counter per stream): only the goal and todos envelopes
// carry `revision`; claims/receipts are append-only and reject the key.
//
// Envelope shapes (exact key sets, unknown keys rejected):
//   goal/todos: { schema, kind, revision, at, data }
//   claims/receipts: { schema, kind, at, data }
// `at` is an epoch-milliseconds safe integer. Revision lineage (expected =
// last + 1, embedded-vs-envelope conflicts) is evaluated at RESTORE time,
// so parsers stay structural and the corruption matrix can distinguish
// revision_gap / revision_conflict from malformed_event.

import { GOAL_TODO_OWNERS, GOAL_TODO_PRIORITIES, GOAL_TODO_STATUSES } from "../core/types.js";
import type { GoalTodoNode, GoalTodoOwner, GoalTodoPriority, GoalTodoStatus } from "../core/types.js";
import { GOAL_TODO_CLAIM_HASH_PATTERN, GOAL_TODO_DELEGATION_ATTEMPT_STATUSES, buildGoalTodoBlockingIssuesHash } from "../core/claims.js";
import type {
  GoalTodoClaimSettlementRecord,
  GoalTodoClaimValidationRecord,
  GoalTodoClaimValidationPolicy,
  GoalTodoDelegationAttemptRecord,
  GoalTodoDelegationAttemptStatus,
  GoalTodoReturnedClaim,
} from "../core/claims.js";
import {
  MUTATION_ID_PATTERN,
  isCanonicalMutationId,
  isCanonicalMutationRequestHash,
  isGoalMutationToolName,
} from "../core/cas.js";
import type { GoalMutationReceipt, GoalMutationToolName } from "../core/cas.js";
import { isCanonicalGoalTodoId, isVisibleGoalTodoPath } from "../core/ids.js";

// ---------------------------------------------------------------------------
// Schemas and ids
// ---------------------------------------------------------------------------

export const GOAL_STREAM_SCHEMA = "pi-goals.goal.v1";
export const TODOS_STREAM_SCHEMA = "pi-goals.todos.v1";
export const CLAIMS_STREAM_SCHEMA = "pi-goals.claims.v1";
export const RECEIPT_STREAM_SCHEMA = "pi-goals.receipt.v1";

export const PI_GOAL_STREAM_SCHEMAS: readonly string[] = Object.freeze([
  GOAL_STREAM_SCHEMA,
  TODOS_STREAM_SCHEMA,
  CLAIMS_STREAM_SCHEMA,
  RECEIPT_STREAM_SCHEMA,
]);

export const GOAL_ID_PATTERN = /^goal_[a-f0-9]{12}$/;

export function isCanonicalGoalId(value: unknown): value is string {
  return typeof value === "string" && GOAL_ID_PATTERN.test(value);
}

const METADATA_ID_PATTERN = MUTATION_ID_PATTERN;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SAFE_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const MAX_OBJECTIVE_CHARS = 8192;
const MAX_TITLE_CHARS = 2048;
const MAX_TEXT_CHARS = 4096;
const MAX_ARRAY_ITEMS = 512;

// ---------------------------------------------------------------------------
// Goal vocabulary
// ---------------------------------------------------------------------------

export type PiGoalStatus =
  | "active"
  | "ready_for_oracle"
  | "oracle_failed"
  | "paused"
  | "blocked"
  | "budget_limited"
  | "complete";

const PI_GOAL_STATUS_SET = new Set<string>([
  "active",
  "ready_for_oracle",
  "oracle_failed",
  "paused",
  "blocked",
  "budget_limited",
  "complete",
]);

export const PI_GOAL_STATUSES: readonly PiGoalStatus[] = Object.freeze([...PI_GOAL_STATUS_SET] as PiGoalStatus[]);

/** Persisted goal record (Phase 4 runtime owns transitions; the store owns shape). */
export interface GoalRecord {
  goalId: string;
  objective: string;
  status: PiGoalStatus;
  /** Embedded stream revision; must equal the envelope revision (restore-checked). */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/** Tree policy mirrored from core (pure data; core stays unimported for policy logic). */
export interface TodoTreePolicyRecord {
  maxDepth: number;
  maxFanout: number;
  maxBatch: number;
}

// ---------------------------------------------------------------------------
// Event envelopes
// ---------------------------------------------------------------------------

export interface GoalSetEventData {
  goal: GoalRecord;
}
export interface GoalClearEventData {
  goalId: string;
}
export interface StreamBaselineEventData {
  snapshotFile: string;
}

export interface GoalSetEvent {
  schema: typeof GOAL_STREAM_SCHEMA;
  kind: "goal_set";
  revision: number;
  at: number;
  data: GoalSetEventData;
}
export interface GoalClearEvent {
  schema: typeof GOAL_STREAM_SCHEMA;
  kind: "goal_clear";
  revision: number;
  at: number;
  data: GoalClearEventData;
}
export interface GoalBaselineEvent {
  schema: typeof GOAL_STREAM_SCHEMA;
  kind: "baseline";
  revision: number;
  at: number;
  data: StreamBaselineEventData;
}
export type GoalStreamEvent = GoalSetEvent | GoalClearEvent | GoalBaselineEvent;
/** Write-side appends never emit baseline markers; compaction owns those. */
export type GoalStreamAppendEvent = GoalSetEvent | GoalClearEvent;

export interface TodosSnapshotEventData {
  goalId: string;
  nodes: GoalTodoNode[];
  policy?: TodoTreePolicyRecord;
}
export interface TodoNodeEventData {
  goalId: string;
  node: GoalTodoNode;
}
export interface TodoRemovedEventData {
  goalId: string;
  todoId: string;
}
export interface TodosClearedEventData {
  goalId: string;
}

export interface TodosSnapshotEvent {
  schema: typeof TODOS_STREAM_SCHEMA;
  kind: "todos_snapshot";
  revision: number;
  at: number;
  data: TodosSnapshotEventData;
}
export interface TodoAddedEvent {
  schema: typeof TODOS_STREAM_SCHEMA;
  kind: "todo_added";
  revision: number;
  at: number;
  data: TodoNodeEventData;
}
export interface TodoUpdatedEvent {
  schema: typeof TODOS_STREAM_SCHEMA;
  kind: "todo_updated";
  revision: number;
  at: number;
  data: TodoNodeEventData;
}
export interface TodoRemovedEvent {
  schema: typeof TODOS_STREAM_SCHEMA;
  kind: "todo_removed";
  revision: number;
  at: number;
  data: TodoRemovedEventData;
}
export interface TodosClearedEvent {
  schema: typeof TODOS_STREAM_SCHEMA;
  kind: "todos_cleared";
  revision: number;
  at: number;
  data: TodosClearedEventData;
}
export interface TodosBaselineEvent {
  schema: typeof TODOS_STREAM_SCHEMA;
  kind: "baseline";
  revision: number;
  at: number;
  data: StreamBaselineEventData;
}
export type TodosStreamEvent =
  | TodosSnapshotEvent
  | TodoAddedEvent
  | TodoUpdatedEvent
  | TodoRemovedEvent
  | TodosClearedEvent
  | TodosBaselineEvent;
export type TodosStreamAppendEvent = Exclude<TodosStreamEvent, TodosBaselineEvent>;

export interface ClaimsAttemptEventData {
  goalId: string;
  attempt: GoalTodoDelegationAttemptRecord;
}
export interface ClaimReturnedEventData {
  goalId: string;
  claim: GoalTodoReturnedClaim;
}
export interface ClaimValidatedEventData {
  goalId: string;
  validation: GoalTodoClaimValidationRecord;
}
export interface ClaimSettlementEventData {
  goalId: string;
  settlement: GoalTodoClaimSettlementRecord;
}

export interface ClaimsDelegationAttemptLaunchedEvent {
  schema: typeof CLAIMS_STREAM_SCHEMA;
  kind: "delegation_attempt_launched";
  at: number;
  data: ClaimsAttemptEventData;
}
export interface ClaimReturnedEvent {
  schema: typeof CLAIMS_STREAM_SCHEMA;
  kind: "claim_returned";
  at: number;
  data: ClaimReturnedEventData;
}
export interface ClaimValidatedEvent {
  schema: typeof CLAIMS_STREAM_SCHEMA;
  kind: "claim_validated";
  at: number;
  data: ClaimValidatedEventData;
}
export interface ClaimAcceptedEvent {
  schema: typeof CLAIMS_STREAM_SCHEMA;
  kind: "claim_accepted";
  at: number;
  data: ClaimSettlementEventData;
}
export interface ClaimRejectedEvent {
  schema: typeof CLAIMS_STREAM_SCHEMA;
  kind: "claim_rejected";
  at: number;
  data: ClaimSettlementEventData;
}
export interface ClaimsBaselineEvent {
  schema: typeof CLAIMS_STREAM_SCHEMA;
  kind: "baseline";
  at: number;
  data: StreamBaselineEventData;
}
export type ClaimsStreamEvent =
  | ClaimsDelegationAttemptLaunchedEvent
  | ClaimReturnedEvent
  | ClaimValidatedEvent
  | ClaimAcceptedEvent
  | ClaimRejectedEvent
  | ClaimsBaselineEvent;
export type ClaimsStreamAppendEvent = Exclude<ClaimsStreamEvent, ClaimsBaselineEvent>;

export interface MutationReceiptEventData {
  receipt: GoalMutationReceipt;
}
export interface MutationReceiptEvent {
  schema: typeof RECEIPT_STREAM_SCHEMA;
  kind: "mutation_receipt";
  at: number;
  data: MutationReceiptEventData;
}
export type ReceiptStreamEvent = MutationReceiptEvent;

// ---------------------------------------------------------------------------
// Parse plumbing
// ---------------------------------------------------------------------------

export type StreamEventParseCode = "unknown_schema" | "malformed_event";

export interface StreamEventParseFailure {
  ok: false;
  code: StreamEventParseCode;
  message: string;
}

export type ParsedStreamEvent =
  | { stream: "goal"; event: GoalStreamEvent }
  | { stream: "todos"; event: TodosStreamEvent }
  | { stream: "claims"; event: ClaimsStreamEvent }
  | { stream: "receipts"; event: ReceiptStreamEvent };

export type StreamEventParseResult = { ok: true; parsed: ParsedStreamEvent } | StreamEventParseFailure;

function parseFailure(code: StreamEventParseCode, message: string): StreamEventParseFailure {
  return { ok: false, code, message };
}

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

function nonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function stringArray(value: unknown, label: string): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_ARRAY_ITEMS) return undefined;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length > MAX_TEXT_CHARS) return undefined;
    items.push(item);
  }
  return items;
}

function oneOf<T extends string>(value: unknown, set: ReadonlySet<string>): T | undefined {
  return typeof value === "string" && set.has(value) ? (value as T) : undefined;
}

function safeMetadataId(value: unknown): value is string {
  return typeof value === "string" && METADATA_ID_PATTERN.test(value) && !DANGEROUS_KEYS.has(value);
}

function isCanonicalTodoIdValue(value: unknown): value is string {
  return typeof value === "string" && isCanonicalGoalTodoId(value);
}

function isVisibleTodoPathValue(value: unknown): value is string {
  return typeof value === "string" && isVisibleGoalTodoPath(value);
}

function safeSnapshotFileName(value: unknown): value is string {
  return typeof value === "string" && SAFE_FILE_NAME_PATTERN.test(value) && !DANGEROUS_KEYS.has(value);
}

// ---------------------------------------------------------------------------
// Record validators (shared with snapshot validation)
// ---------------------------------------------------------------------------

export function parseGoalRecord(value: unknown): GoalRecord | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["goalId", "objective", "status", "revision", "createdAt", "updatedAt"])) return undefined;
  if (!isCanonicalGoalId(value.goalId)) return undefined;
  if (!nonEmptyString(value.objective, MAX_OBJECTIVE_CHARS)) return undefined;
  const status = oneOf<PiGoalStatus>(value.status, PI_GOAL_STATUS_SET);
  if (!status) return undefined;
  if (!safeIntegerAtLeast(value.revision, 0) || !safeIntegerAtLeast(value.createdAt, 0) || !safeIntegerAtLeast(value.updatedAt, 0)) return undefined;
  return { goalId: value.goalId, objective: value.objective, status, revision: value.revision, createdAt: value.createdAt, updatedAt: value.updatedAt };
}

const TODO_STATUS_SET = new Set<string>(GOAL_TODO_STATUSES);
const TODO_OWNER_SET = new Set<string>(GOAL_TODO_OWNERS);
const TODO_PRIORITY_SET = new Set<string>(GOAL_TODO_PRIORITIES);

export function parseGoalTodoNodeRecord(value: unknown): GoalTodoNode | undefined {
  if (!isRecord(value)) return undefined;
  const required = ["id", "path", "title", "status", "owner", "priority", "required", "createdAt", "updatedAt"];
  const optional = ["parentId", "acceptanceCriteria", "evidenceRefs", "validationCommands"];
  if (!hasExactKeys(value, required, optional)) return undefined;
  if (!isCanonicalTodoIdValue(value.id) || !isVisibleTodoPathValue(value.path)) return undefined;
  if (!nonEmptyString(value.title, MAX_TITLE_CHARS)) return undefined;
  const status = oneOf<GoalTodoStatus>(value.status, TODO_STATUS_SET);
  const owner = oneOf<GoalTodoOwner>(value.owner, TODO_OWNER_SET);
  const priority = oneOf<GoalTodoPriority>(value.priority, TODO_PRIORITY_SET);
  if (!status || !owner || !priority) return undefined;
  if (typeof value.required !== "boolean") return undefined;
  if (value.parentId !== undefined && !isCanonicalTodoIdValue(value.parentId)) return undefined;
  const acceptanceCriteria = value.acceptanceCriteria === undefined ? undefined : stringArray(value.acceptanceCriteria, "acceptanceCriteria");
  const evidenceRefs = value.evidenceRefs === undefined ? undefined : stringArray(value.evidenceRefs, "evidenceRefs");
  const validationCommands = value.validationCommands === undefined ? undefined : stringArray(value.validationCommands, "validationCommands");
  if (acceptanceCriteria === undefined && value.acceptanceCriteria !== undefined) return undefined;
  if (evidenceRefs === undefined && value.evidenceRefs !== undefined) return undefined;
  if (validationCommands === undefined && value.validationCommands !== undefined) return undefined;
  if (!safeIntegerAtLeast(value.createdAt, 0) || !safeIntegerAtLeast(value.updatedAt, 0)) return undefined;
  return {
    id: value.id,
    path: value.path,
    title: value.title,
    status,
    owner,
    priority,
    required: value.required,
    ...(value.parentId !== undefined ? { parentId: value.parentId } : {}),
    ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
    ...(evidenceRefs !== undefined ? { evidenceRefs } : {}),
    ...(validationCommands !== undefined ? { validationCommands } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export function parseTodoTreePolicyRecord(value: unknown): TodoTreePolicyRecord | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["maxDepth", "maxFanout", "maxBatch"])) return undefined;
  if (!safeIntegerAtLeast(value.maxDepth, 1) || !safeIntegerAtLeast(value.maxFanout, 1) || !safeIntegerAtLeast(value.maxBatch, 1)) return undefined;
  if (value.maxDepth > 100_000 || value.maxFanout > 100_000 || value.maxBatch > 100_000) return undefined;
  return { maxDepth: value.maxDepth, maxFanout: value.maxFanout, maxBatch: value.maxBatch };
}

const VALIDATION_POLICY_SET = new Set<string>(["parent_review", "oracle_required"]);
const ATTEMPT_STATUS_SET = new Set<string>(GOAL_TODO_DELEGATION_ATTEMPT_STATUSES);
const VERDICT_SET = new Set<string>(["PASS", "WARN", "FAIL"]);
const RECOMMENDED_ACTION_SET = new Set<string>(["accept_claim", "needs_review", "reject_claim", "block"]);
const CONFIDENCE_SET = new Set<string>(["LOW", "MEDIUM", "HIGH"]);
const VALIDATION_STATUS_SET = new Set<string>(["passed", "warn", "failed", "blocked"]);

function parseValidationPolicy(value: unknown): GoalTodoClaimValidationPolicy | undefined {
  return oneOf<GoalTodoClaimValidationPolicy>(value, VALIDATION_POLICY_SET);
}

function parseClaimHash(value: unknown): string | undefined {
  return typeof value === "string" && GOAL_TODO_CLAIM_HASH_PATTERN.test(value) ? value : undefined;
}

export function parseDelegationAttemptRecord(value: unknown): GoalTodoDelegationAttemptRecord | undefined {
  if (!isRecord(value)) return undefined;
  const required = ["attemptId", "status", "validationPolicy", "launchedAt"];
  const optional = ["runId", "agent", "delegationDepth", "returnedAt", "settledAt"];
  if (!hasExactKeys(value, required, optional)) return undefined;
  if (!safeMetadataId(value.attemptId)) return undefined;
  if (value.runId !== undefined && !safeMetadataId(value.runId)) return undefined;
  if (value.agent !== undefined && !safeMetadataId(value.agent)) return undefined;
  if (value.delegationDepth !== undefined && !(typeof value.delegationDepth === "number" && Number.isSafeInteger(value.delegationDepth) && value.delegationDepth >= 1)) return undefined;
  const status = oneOf<GoalTodoDelegationAttemptStatus>(value.status, ATTEMPT_STATUS_SET);
  const validationPolicy = parseValidationPolicy(value.validationPolicy);
  if (!status || !validationPolicy) return undefined;
  if (!safeIntegerAtLeast(value.launchedAt, 0)) return undefined;
  if (value.returnedAt !== undefined && !safeIntegerAtLeast(value.returnedAt, 0)) return undefined;
  if (value.settledAt !== undefined && !safeIntegerAtLeast(value.settledAt, 0)) return undefined;
  return {
    attemptId: value.attemptId,
    ...(value.runId !== undefined ? { runId: value.runId } : {}),
    ...(value.agent !== undefined ? { agent: value.agent } : {}),
    ...(value.delegationDepth !== undefined ? { delegationDepth: value.delegationDepth } : {}),
    status,
    validationPolicy,
    launchedAt: value.launchedAt,
    ...(value.returnedAt !== undefined ? { returnedAt: value.returnedAt } : {}),
    ...(value.settledAt !== undefined ? { settledAt: value.settledAt } : {}),
  };
}

export function parseReturnedClaimRecord(value: unknown): GoalTodoReturnedClaim | undefined {
  if (!isRecord(value)) return undefined;
  const required = ["claimVersion", "attemptId", "claimHash", "validationPolicy", "evidenceRefs", "validationCommands", "returnedAt"];
  const optional = ["noShip"];
  if (!hasExactKeys(value, required, optional)) return undefined;
  if (value.claimVersion !== 1) return undefined;
  if (!safeMetadataId(value.attemptId)) return undefined;
  const claimHash = parseClaimHash(value.claimHash);
  const validationPolicy = parseValidationPolicy(value.validationPolicy);
  if (!claimHash || !validationPolicy) return undefined;
  const evidenceRefs = stringArray(value.evidenceRefs, "evidenceRefs");
  const validationCommands = stringArray(value.validationCommands, "validationCommands");
  if (evidenceRefs === undefined || validationCommands === undefined) return undefined;
  if (value.noShip !== undefined && typeof value.noShip !== "boolean") return undefined;
  if (!safeIntegerAtLeast(value.returnedAt, 0)) return undefined;
  return {
    claimVersion: 1,
    attemptId: value.attemptId,
    claimHash,
    validationPolicy,
    evidenceRefs,
    validationCommands,
    ...(value.noShip !== undefined ? { noShip: value.noShip } : {}),
    returnedAt: value.returnedAt,
  };
}

const CLAIM_VALIDATION_REQUIRED_BASE = [
  "validationVersion", "attemptId", "claimHash", "validationPolicy", "status", "verdict",
  "recommendedAction", "noShip", "confidence", "outputHash", "evidenceRefs",
  "validationCommands", "validatedAt",
] as const;

/**
 * Canonical claim-validation record parser.
 *
 * BUG-1 fix: optional provenance keys `agent`/`runId` (metadata-safe,
 * length-capped) are accepted — v0.1.x lines without them keep parsing.
 * BUG-4 fix: the canonical shape persists blocking issues HASH-ONLY
 * (blockingIssuesHash + blockingIssuesCount); legacy v0.1.x cleartext
 * `blockingIssues` lines still parse and convert to the hash+count form.
 */
export function parseClaimValidationRecord(value: unknown): GoalTodoClaimValidationRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (value.validationVersion !== 1) return undefined;
  if (!safeMetadataId(value.attemptId)) return undefined;
  const claimHash = parseClaimHash(value.claimHash);
  const outputHash = parseClaimHash(value.outputHash);
  const validationPolicy = parseValidationPolicy(value.validationPolicy);
  const status = oneOf<GoalTodoClaimValidationRecord["status"]>(value.status, VALIDATION_STATUS_SET);
  const verdict = oneOf<GoalTodoClaimValidationRecord["verdict"]>(value.verdict, VERDICT_SET);
  const recommendedAction = oneOf<GoalTodoClaimValidationRecord["recommendedAction"]>(value.recommendedAction, RECOMMENDED_ACTION_SET);
  const confidence = oneOf<GoalTodoClaimValidationRecord["confidence"]>(value.confidence, CONFIDENCE_SET);
  if (!claimHash || !outputHash || !validationPolicy || !status || !verdict || !recommendedAction || !confidence) return undefined;
  if (typeof value.noShip !== "boolean") return undefined;
  const evidenceRefs = stringArray(value.evidenceRefs, "evidenceRefs");
  const validationCommands = stringArray(value.validationCommands, "validationCommands");
  if (evidenceRefs === undefined || validationCommands === undefined) return undefined;
  if (!safeIntegerAtLeast(value.validatedAt, 0)) return undefined;
  if (value.agent !== undefined && !safeMetadataId(value.agent)) return undefined;
  if (value.runId !== undefined && !safeMetadataId(value.runId)) return undefined;

  const canonicalKeys = [...CLAIM_VALIDATION_REQUIRED_BASE, "blockingIssuesHash", "blockingIssuesCount"];
  const legacyKeys = [...CLAIM_VALIDATION_REQUIRED_BASE, "blockingIssues"];
  const hasCanonicalShape = hasExactKeys(value, canonicalKeys, ["agent", "runId"]);
  const hasLegacyShape = hasExactKeys(value, legacyKeys, ["agent", "runId"]);
  if (!hasCanonicalShape && !hasLegacyShape) return undefined;
  let blockingIssuesHash: string | undefined;
  let blockingIssuesCount: number | undefined;
  if (hasCanonicalShape) {
    blockingIssuesHash = parseClaimHash(value.blockingIssuesHash);
    if (!blockingIssuesHash) return undefined;
    if (!safeIntegerAtLeast(value.blockingIssuesCount, 0) || value.blockingIssuesCount > MAX_ARRAY_ITEMS) return undefined;
    blockingIssuesCount = value.blockingIssuesCount;
  } else {
    const legacy = stringArray(value.blockingIssues, "blockingIssues");
    if (legacy === undefined) return undefined;
    blockingIssuesHash = buildGoalTodoBlockingIssuesHash(legacy);
    blockingIssuesCount = legacy.length;
  }

  return {
    validationVersion: 1,
    attemptId: value.attemptId,
    claimHash,
    validationPolicy,
    status,
    verdict,
    recommendedAction,
    noShip: value.noShip,
    confidence,
    blockingIssuesHash,
    blockingIssuesCount,
    outputHash,
    evidenceRefs,
    validationCommands,
    ...(value.agent !== undefined ? { agent: value.agent } : {}),
    ...(value.runId !== undefined ? { runId: value.runId } : {}),
    validatedAt: value.validatedAt,
  };
}

export function parseClaimSettlementRecord(value: unknown): GoalTodoClaimSettlementRecord | undefined {
  if (!isRecord(value)) return undefined;
  const required = ["settlement", "attemptId", "claimHash", "validationPolicy"];
  const optional = ["reasonHash"];
  if (!hasExactKeys(value, required, optional)) return undefined;
  if (value.settlement !== "accepted" && value.settlement !== "rejected") return undefined;
  if (!safeMetadataId(value.attemptId)) return undefined;
  const claimHash = parseClaimHash(value.claimHash);
  const validationPolicy = parseValidationPolicy(value.validationPolicy);
  if (!claimHash || !validationPolicy) return undefined;
  if (value.reasonHash !== undefined) {
    const reasonHash = parseClaimHash(value.reasonHash);
    if (!reasonHash) return undefined;
  }
  return {
    settlement: value.settlement,
    attemptId: value.attemptId,
    claimHash,
    validationPolicy,
    ...(value.reasonHash !== undefined ? { reasonHash: value.reasonHash as string } : {}),
  };
}

export function parseMutationReceiptRecord(value: unknown): GoalMutationReceipt | undefined {
  if (!isRecord(value)) return undefined;
  const required = ["schema", "toolName", "mutationId", "requestHash", "appliedAt", "bodyStored"];
  const optional = ["expectedGoalRevision", "expectedGraphRevision", "expectedTodoRevision"];
  if (!hasExactKeys(value, required, optional)) return undefined;
  if (value.schema !== "pi-goals.goal-mutation-receipt.v1") return undefined;
  if (typeof value.toolName !== "string" || !isGoalMutationToolName(value.toolName)) return undefined;
  if (!safeMetadataId(value.mutationId)) return undefined;
  if (!isCanonicalMutationRequestHash(value.requestHash)) return undefined;
  if (!safeIntegerAtLeast(value.appliedAt, 0)) return undefined;
  if (value.bodyStored !== false) return undefined;
  for (const key of optional) {
    if (value[key] !== undefined && !safeIntegerAtLeast(value[key], 0)) return undefined;
  }
  return {
    schema: "pi-goals.goal-mutation-receipt.v1",
    toolName: value.toolName as GoalMutationToolName,
    mutationId: value.mutationId,
    requestHash: value.requestHash,
    ...(value.expectedGoalRevision !== undefined ? { expectedGoalRevision: value.expectedGoalRevision as number } : {}),
    ...(value.expectedGraphRevision !== undefined ? { expectedGraphRevision: value.expectedGraphRevision as number } : {}),
    ...(value.expectedTodoRevision !== undefined ? { expectedTodoRevision: value.expectedTodoRevision as number } : {}),
    appliedAt: value.appliedAt as number,
    bodyStored: false,
  };
}

// ---------------------------------------------------------------------------
// Envelope parsers
// ---------------------------------------------------------------------------

function parseRevisionedEnvelopeHead(value: Record<string, unknown>, expectedSchema: string): { revision: number; at: number; kind: string } | undefined {
  if (!hasExactKeys(value, ["schema", "kind", "revision", "at", "data"])) return undefined;
  if (value.schema !== expectedSchema || typeof value.kind !== "string") return undefined;
  if (!safeIntegerAtLeast(value.at, 0)) return undefined;
  // Live events number from 1; a baseline may snapshot an empty stream (0).
  const minimumRevision = value.kind === "baseline" ? 0 : 1;
  if (!safeIntegerAtLeast(value.revision, minimumRevision)) return undefined;
  return { revision: value.revision, at: value.at, kind: value.kind };
}

function parseUnrevisionedEnvelopeHead(value: Record<string, unknown>, expectedSchema: string): { at: number; kind: string } | undefined {
  if (!hasExactKeys(value, ["schema", "kind", "at", "data"])) return undefined;
  if (value.schema !== expectedSchema || typeof value.kind !== "string") return undefined;
  if (!safeIntegerAtLeast(value.at, 0)) return undefined;
  return { at: value.at, kind: value.kind };
}

function parseBaselineData(value: unknown): StreamBaselineEventData | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["snapshotFile"])) return undefined;
  return safeSnapshotFileName(value.snapshotFile) ? { snapshotFile: value.snapshotFile } : undefined;
}

export function parseGoalStreamEvent(value: unknown): StreamEventParseResult {
  if (!isRecord(value)) return parseFailure("malformed_event", "goal stream event must be a JSON object");
  const head = parseRevisionedEnvelopeHead(value, GOAL_STREAM_SCHEMA);
  if (!head) return parseFailure("malformed_event", `event is not a strict ${GOAL_STREAM_SCHEMA} envelope`);
  const { revision, at, kind } = head;
  const data = value.data;
  if (kind === "goal_set") {
    if (!isRecord(data) || !hasExactKeys(data, ["goal"])) return parseFailure("malformed_event", "goal_set data must carry exactly {goal}");
    const goal = parseGoalRecord(data.goal);
    if (!goal) return parseFailure("malformed_event", "goal_set data.goal is not a canonical GoalRecord");
    return { ok: true, parsed: { stream: "goal", event: { schema: GOAL_STREAM_SCHEMA, kind, revision, at, data: { goal } } } };
  }
  if (kind === "goal_clear") {
    if (!isRecord(data) || !hasExactKeys(data, ["goalId"]) || !isCanonicalGoalId(data.goalId)) {
      return parseFailure("malformed_event", "goal_clear data must carry exactly {goalId} with a canonical goal id");
    }
    return { ok: true, parsed: { stream: "goal", event: { schema: GOAL_STREAM_SCHEMA, kind, revision, at, data: { goalId: data.goalId } } } };
  }
  if (kind === "baseline") {
    const baseline = parseBaselineData(data);
    if (!baseline) return parseFailure("malformed_event", "baseline data must carry exactly {snapshotFile}");
    return { ok: true, parsed: { stream: "goal", event: { schema: GOAL_STREAM_SCHEMA, kind, revision, at, data: baseline } } };
  }
  return parseFailure("malformed_event", `unknown ${GOAL_STREAM_SCHEMA} kind: ${kind}`);
}

export function parseTodosStreamEvent(value: unknown): StreamEventParseResult {
  if (!isRecord(value)) return parseFailure("malformed_event", "todos stream event must be a JSON object");
  const head = parseRevisionedEnvelopeHead(value, TODOS_STREAM_SCHEMA);
  if (!head) return parseFailure("malformed_event", `event is not a strict ${TODOS_STREAM_SCHEMA} envelope`);
  const { revision, at, kind } = head;
  const data = value.data;
  if (kind === "todos_snapshot") {
    if (!isRecord(data) || !hasExactKeys(data, ["goalId", "nodes"], ["policy"])) return parseFailure("malformed_event", "todos_snapshot data must carry {goalId, nodes, policy?}");
    if (!isCanonicalGoalId(data.goalId) || !Array.isArray(data.nodes) || data.nodes.length > 10_000) return parseFailure("malformed_event", "todos_snapshot data is malformed");
    const nodes: GoalTodoNode[] = [];
    for (const node of data.nodes) {
      const parsed = parseGoalTodoNodeRecord(node);
      if (!parsed) return parseFailure("malformed_event", "todos_snapshot contains a non-canonical node");
      nodes.push(parsed);
    }
    let policy: TodoTreePolicyRecord | undefined;
    if (data.policy !== undefined) {
      policy = parseTodoTreePolicyRecord(data.policy);
      if (!policy) return parseFailure("malformed_event", "todos_snapshot policy is malformed");
    }
    return { ok: true, parsed: { stream: "todos", event: { schema: TODOS_STREAM_SCHEMA, kind, revision, at, data: { goalId: data.goalId, nodes, ...(policy ? { policy } : {}) } } } };
  }
  if (kind === "todo_added" || kind === "todo_updated") {
    if (!isRecord(data) || !hasExactKeys(data, ["goalId", "node"]) || !isCanonicalGoalId(data.goalId)) return parseFailure("malformed_event", `${kind} data must carry {goalId, node}`);
    const node = parseGoalTodoNodeRecord(data.node);
    if (!node) return parseFailure("malformed_event", `${kind} node is not a canonical GoalTodoNode`);
    return { ok: true, parsed: { stream: "todos", event: { schema: TODOS_STREAM_SCHEMA, kind, revision, at, data: { goalId: data.goalId, node } } } };
  }
  if (kind === "todo_removed") {
    if (!isRecord(data) || !hasExactKeys(data, ["goalId", "todoId"]) || !isCanonicalGoalId(data.goalId) || !isCanonicalTodoIdValue(data.todoId)) {
      return parseFailure("malformed_event", "todo_removed data must carry {goalId, todoId}");
    }
    return { ok: true, parsed: { stream: "todos", event: { schema: TODOS_STREAM_SCHEMA, kind, revision, at, data: { goalId: data.goalId, todoId: data.todoId } } } };
  }
  if (kind === "todos_cleared") {
    if (!isRecord(data) || !hasExactKeys(data, ["goalId"]) || !isCanonicalGoalId(data.goalId)) return parseFailure("malformed_event", "todos_cleared data must carry {goalId}");
    return { ok: true, parsed: { stream: "todos", event: { schema: TODOS_STREAM_SCHEMA, kind, revision, at, data: { goalId: data.goalId } } } };
  }
  if (kind === "baseline") {
    const baseline = parseBaselineData(data);
    if (!baseline) return parseFailure("malformed_event", "baseline data must carry exactly {snapshotFile}");
    return { ok: true, parsed: { stream: "todos", event: { schema: TODOS_STREAM_SCHEMA, kind, revision, at, data: baseline } } };
  }
  return parseFailure("malformed_event", `unknown ${TODOS_STREAM_SCHEMA} kind: ${kind}`);
}

export function parseClaimsStreamEvent(value: unknown): StreamEventParseResult {
  if (!isRecord(value)) return parseFailure("malformed_event", "claims stream event must be a JSON object");
  const head = parseUnrevisionedEnvelopeHead(value, CLAIMS_STREAM_SCHEMA);
  if (!head) return parseFailure("malformed_event", `event is not a strict ${CLAIMS_STREAM_SCHEMA} envelope`);
  const { at, kind } = head;
  const data = value.data;
  if (kind === "delegation_attempt_launched") {
    if (!isRecord(data) || !hasExactKeys(data, ["goalId", "attempt"]) || !isCanonicalGoalId(data.goalId)) return parseFailure("malformed_event", "delegation_attempt_launched data must carry {goalId, attempt}");
    const attempt = parseDelegationAttemptRecord(data.attempt);
    if (!attempt) return parseFailure("malformed_event", "delegation_attempt_launched attempt is malformed");
    return { ok: true, parsed: { stream: "claims", event: { schema: CLAIMS_STREAM_SCHEMA, kind, at, data: { goalId: data.goalId, attempt } } } };
  }
  if (kind === "claim_returned") {
    if (!isRecord(data) || !hasExactKeys(data, ["goalId", "claim"]) || !isCanonicalGoalId(data.goalId)) return parseFailure("malformed_event", "claim_returned data must carry {goalId, claim}");
    const claim = parseReturnedClaimRecord(data.claim);
    if (!claim) return parseFailure("malformed_event", "claim_returned claim is malformed");
    return { ok: true, parsed: { stream: "claims", event: { schema: CLAIMS_STREAM_SCHEMA, kind, at, data: { goalId: data.goalId, claim } } } };
  }
  if (kind === "claim_validated") {
    if (!isRecord(data) || !hasExactKeys(data, ["goalId", "validation"]) || !isCanonicalGoalId(data.goalId)) return parseFailure("malformed_event", "claim_validated data must carry {goalId, validation}");
    const validation = parseClaimValidationRecord(data.validation);
    if (!validation) return parseFailure("malformed_event", "claim_validated validation is malformed");
    return { ok: true, parsed: { stream: "claims", event: { schema: CLAIMS_STREAM_SCHEMA, kind, at, data: { goalId: data.goalId, validation } } } };
  }
  if (kind === "claim_accepted" || kind === "claim_rejected") {
    if (!isRecord(data) || !hasExactKeys(data, ["goalId", "settlement"]) || !isCanonicalGoalId(data.goalId)) return parseFailure("malformed_event", `${kind} data must carry {goalId, settlement}`);
    const settlement = parseClaimSettlementRecord(data.settlement);
    if (!settlement) return parseFailure("malformed_event", `${kind} settlement is malformed`);
    return { ok: true, parsed: { stream: "claims", event: { schema: CLAIMS_STREAM_SCHEMA, kind, at, data: { goalId: data.goalId, settlement } } } };
  }
  if (kind === "baseline") {
    const baseline = parseBaselineData(data);
    if (!baseline) return parseFailure("malformed_event", "baseline data must carry exactly {snapshotFile}");
    return { ok: true, parsed: { stream: "claims", event: { schema: CLAIMS_STREAM_SCHEMA, kind, at, data: baseline } } };
  }
  return parseFailure("malformed_event", `unknown ${CLAIMS_STREAM_SCHEMA} kind: ${kind}`);
}

export function parseReceiptStreamEvent(value: unknown): StreamEventParseResult {
  if (!isRecord(value)) return parseFailure("malformed_event", "receipt stream event must be a JSON object");
  const head = parseUnrevisionedEnvelopeHead(value, RECEIPT_STREAM_SCHEMA);
  if (!head) return parseFailure("malformed_event", `event is not a strict ${RECEIPT_STREAM_SCHEMA} envelope`);
  const { at, kind } = head;
  if (kind !== "mutation_receipt") return parseFailure("malformed_event", `unknown ${RECEIPT_STREAM_SCHEMA} kind: ${kind}`);
  const data = value.data;
  if (!isRecord(data) || !hasExactKeys(data, ["receipt"])) return parseFailure("malformed_event", "mutation_receipt data must carry exactly {receipt}");
  const receipt = parseMutationReceiptRecord(data.receipt);
  if (!receipt) return parseFailure("malformed_event", "mutation_receipt receipt is not a canonical GoalMutationReceipt");
  return { ok: true, parsed: { stream: "receipts", event: { schema: RECEIPT_STREAM_SCHEMA, kind, at, data: { receipt } } } };
}

/** Dispatch on the schema field: unknown schemas fail with `unknown_schema` (R1). */
export function parseStreamLine(value: unknown): StreamEventParseResult {
  if (!isRecord(value)) return parseFailure("malformed_event", "stream event line must be a JSON object");
  const schema = value.schema;
  if (typeof schema !== "string") return parseFailure("malformed_event", "stream event envelope requires a string schema");
  if (!PI_GOAL_STREAM_SCHEMAS.includes(schema)) return parseFailure("unknown_schema", `unknown stream event schema: ${schema}`);
  switch (schema) {
    case GOAL_STREAM_SCHEMA:
      return parseGoalStreamEvent(value);
    case TODOS_STREAM_SCHEMA:
      return parseTodosStreamEvent(value);
    case CLAIMS_STREAM_SCHEMA:
      return parseClaimsStreamEvent(value);
    default:
      return parseReceiptStreamEvent(value);
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/** Deterministic single-line JSON with a fixed canonical key order. */
export function serializeStreamEvent(
  event: GoalStreamEvent | TodosStreamEvent | ClaimsStreamEvent | ReceiptStreamEvent,
): string {
  const envelope: Record<string, unknown> = { schema: event.schema, kind: event.kind };
  if ("revision" in event) envelope.revision = (event as GoalStreamEvent | TodosStreamEvent).revision;
  envelope.at = event.at;
  envelope.data = event.data;
  return JSON.stringify(envelope);
}
