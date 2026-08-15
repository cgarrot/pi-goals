// src/core/cas.ts — Phase 2d GoalMutationGuard canonical model (pure).
//
// Distilled (read-only) from zob-harness:
//   - .pi/extensions/zob-harness/src/domains/goal/mutation-cas.ts
//     (canonicalGoalMutationJson / hashGoalMutationRequest /
//      GOAL_MUTATION_ID_PATTERN / revision guards / receipt replay semantics)
//   - .pi/extensions/zob-harness/src/runtime/goal-runtime/mutation-tools.ts
//     (GOAL_MUTATION_TOOL_NAMES inventory)
//
// Rework decisions ("en mieux", deliberate deviations documented for review):
//   D-M1 the core scope is 16 tools: zob's 20-tool inventory minus the three
//      import_* tools (out of core scope per plan) and handoff_goal_todo.
//   D-M2 guard and receipt are plain data; persistence, event emission, and
//      the prepared/in-doubt phase protocol stay in the store (3b). The
//      requestHash preimage is canonical {"payload":<payload minus the
//      top-level cas field>,"tool":<toolName>} so a guard never hashes
//      itself and key order can never change the hash.
//   D-M3 canonical JSON is zob's exact algorithm (recursively sorted keys,
//      plain objects only, finite numbers, sparse arrays / cycles / symbol
//      keys rejected) — deterministic preimages across processes.
//   D-M4 optimistic concurrency: each expected revision present on the
//      guard must equal the current value (a missing current value counts
//      as stale); mismatches produce the exact stale_* codes, and malformed
//      current revisions produce invalid_current_revision.
//   D-M5 replay is evaluated over a plain receipt record keyed by
//      mutationId: same mutationId + same requestHash = idempotent replay
//      success; same mutationId + different hash = conflict; no entry =
//      new. Exact-duplicate receipt indexing is idempotent.
//
// Purity contract: node:crypto createHash is the ONLY node import (hashing
// is intrinsic to request binding); no fs/os/env/clock/random — timestamps
// arrive as injected parameters and receipt state is plain data (no storage).

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const MUTATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_HASH_PATTERN = /^[a-f0-9]{64}$/;
const DANGEROUS_MUTATION_IDS = new Set(["__proto__", "prototype", "constructor"]);

/** Canonical inventory of the 16 core Goal/TODO mutation tools (D-M1). */
export const GOAL_MUTATION_TOOL_NAMES = Object.freeze([
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
] as const);

export type GoalMutationToolName = (typeof GOAL_MUTATION_TOOL_NAMES)[number];

const goalMutationToolNames = new Set<string>(GOAL_MUTATION_TOOL_NAMES);

export function isGoalMutationToolName(value: string): value is GoalMutationToolName {
  return goalMutationToolNames.has(value);
}

export function isCanonicalMutationId(value: unknown): value is string {
  return typeof value === "string" && MUTATION_ID_PATTERN.test(value);
}

export function isCanonicalMutationRequestHash(value: unknown): value is string {
  return typeof value === "string" && REQUEST_HASH_PATTERN.test(value);
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validOptionalRevision(value: unknown): value is number | undefined {
  return value === undefined || validRevision(value);
}

// ---------------------------------------------------------------------------
// Canonical JSON (zob's exact algorithm — D-M3)
// ---------------------------------------------------------------------------

function canonicalJsonValue(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON requires a finite JSON number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("value is not valid canonical JSON");
  if (seen.has(value as object)) throw new TypeError("cyclic value is not valid canonical JSON");

  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new TypeError("sparse arrays are not valid canonical JSON");
      }
      return `[${value.map((item) => canonicalJsonValue(item, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("value is not a plain canonical JSON object");
    if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError("symbol keys are not valid canonical JSON");
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(record[key], seen)}`).join(",")}}`;
  } finally {
    seen.delete(value as object);
  }
}

/** Deterministic JSON: object keys are sorted recursively; array order and scalar values are preserved. */
export function canonicalGoalMutationJson(value: unknown): string {
  return canonicalJsonValue(value, new Set());
}

/** Strip the top-level cas field from a plain-object payload (D-M2). */
function stripCasField(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) return payload;
  if (!Object.prototype.hasOwnProperty.call(payload, "cas")) return payload;
  const { cas: _stripped, ...rest } = payload as Record<string, unknown>;
  return rest;
}

/**
 * Canonical request hash: sha256 over canonicalGoalMutationJson(
 *   { payload: <payload minus the top-level cas field>, tool: toolName }).
 * Key order of the payload can never change the hash; unknown tools throw.
 */
export function hashGoalMutationRequest(toolName: string, payload: unknown): string {
  if (typeof toolName !== "string" || !isGoalMutationToolName(toolName)) {
    throw new TypeError(`hashGoalMutationRequest: unknown Goal mutation tool name: ${String(toolName)}`);
  }
  return sha256Hex(canonicalGoalMutationJson({ payload: stripCasField(payload), tool: toolName }));
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

export interface GoalMutationGuardInput {
  readonly mutationId: string;
  readonly expectedGoalRevision?: number;
  readonly expectedGraphRevision?: number;
  readonly expectedTodoRevision?: number;
}

export interface GoalMutationGuard {
  readonly toolName: GoalMutationToolName;
  readonly mutationId: string;
  readonly expectedGoalRevision?: number;
  readonly expectedGraphRevision?: number;
  readonly expectedTodoRevision?: number;
}

export type GoalMutationGuardFailureCode = "unknown_tool" | "invalid_mutation_id" | "invalid_revision";

export type BuildGoalMutationGuardResult =
  | { readonly ok: true; readonly guard: GoalMutationGuard }
  | { readonly ok: false; readonly code: GoalMutationGuardFailureCode; readonly message: string };

function guardError(code: GoalMutationGuardFailureCode, message: string): BuildGoalMutationGuardResult {
  return Object.freeze({ ok: false, code, message });
}

function isCanonicalMutationIdKey(value: unknown): value is string {
  return isCanonicalMutationId(value) && !DANGEROUS_MUTATION_IDS.has(value as string);
}

/** Build one validated mutation guard: known tool, canonical mutationId, safe revisions. */
export function buildMutationGuard(toolName: string, input: GoalMutationGuardInput): BuildGoalMutationGuardResult {
  if (typeof toolName !== "string" || !isGoalMutationToolName(toolName)) {
    return guardError("unknown_tool", `unknown Goal mutation tool name: ${String(toolName)}`);
  }
  if (!isCanonicalMutationIdKey(input?.mutationId)) {
    return guardError("invalid_mutation_id", "mutationId must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$ and not be a dangerous record key");
  }
  if (!validOptionalRevision(input?.expectedGoalRevision) || !validOptionalRevision(input?.expectedGraphRevision) || !validOptionalRevision(input?.expectedTodoRevision)) {
    return guardError("invalid_revision", "expected revisions must be safe non-negative integers when present");
  }
  const guard: GoalMutationGuard = Object.freeze({
    toolName,
    mutationId: input.mutationId,
    ...(input.expectedGoalRevision !== undefined ? { expectedGoalRevision: input.expectedGoalRevision } : {}),
    ...(input.expectedGraphRevision !== undefined ? { expectedGraphRevision: input.expectedGraphRevision } : {}),
    ...(input.expectedTodoRevision !== undefined ? { expectedTodoRevision: input.expectedTodoRevision } : {}),
  });
  return Object.freeze({ ok: true, guard });
}

// ---------------------------------------------------------------------------
// Optimistic revision evaluation (D-M4)
// ---------------------------------------------------------------------------

export interface GoalMutationCurrentRevisions {
  readonly goalRevision?: number;
  readonly graphRevision?: number;
  readonly todoRevision?: number;
}

export type GoalMutationStaleCode = "stale_goal_revision" | "stale_graph_revision" | "stale_todo_revision";

export type ApplyGoalMutationGuardResult =
  | { readonly ok: true; readonly status: "ok" }
  | { readonly ok: false; readonly status: "stale"; readonly codes: readonly GoalMutationStaleCode[] }
  | { readonly ok: false; readonly status: "invalid"; readonly code: "invalid_current_revision" };

/** Compare expected guard revisions against current revisions; exact stale codes on mismatch. */
export function applyMutationGuard(currentRevisions: GoalMutationCurrentRevisions, guard: GoalMutationGuard): ApplyGoalMutationGuardResult {
  const checks: ReadonlyArray<{ expected: number | undefined; current: number | undefined; code: GoalMutationStaleCode }> = [
    { expected: guard?.expectedGoalRevision, current: currentRevisions?.goalRevision, code: "stale_goal_revision" },
    { expected: guard?.expectedGraphRevision, current: currentRevisions?.graphRevision, code: "stale_graph_revision" },
    { expected: guard?.expectedTodoRevision, current: currentRevisions?.todoRevision, code: "stale_todo_revision" },
  ];
  const stale: GoalMutationStaleCode[] = [];
  for (const check of checks) {
    if (check.expected === undefined) continue;
    if (check.current !== undefined && !validRevision(check.current)) {
      return { ok: false, status: "invalid", code: "invalid_current_revision" };
    }
    if (check.current !== check.expected) stale.push(check.code);
  }
  return stale.length > 0 ? { ok: false, status: "stale", codes: Object.freeze(stale) } : { ok: true, status: "ok" };
}

// ---------------------------------------------------------------------------
// Receipts and replay (D-M5)
// ---------------------------------------------------------------------------

export interface GoalMutationReceipt {
  readonly schema: "pi-goals.goal-mutation-receipt.v1";
  readonly toolName: GoalMutationToolName;
  readonly mutationId: string;
  readonly requestHash: string;
  readonly expectedGoalRevision?: number;
  readonly expectedGraphRevision?: number;
  readonly expectedTodoRevision?: number;
  readonly appliedAt: number;
  readonly bodyStored: false;
}

export type GoalMutationReceiptFailureCode = "invalid_guard" | "invalid_request_hash" | "invalid_applied_at";

export type BuildGoalMutationReceiptResult =
  | { readonly ok: true; readonly receipt: GoalMutationReceipt }
  | { readonly ok: false; readonly code: GoalMutationReceiptFailureCode; readonly message: string };

function receiptError(code: GoalMutationReceiptFailureCode, message: string): BuildGoalMutationReceiptResult {
  return Object.freeze({ ok: false, code, message });
}

function guardIsCanonical(guard: GoalMutationGuard): boolean {
  return typeof guard?.toolName === "string"
    && isGoalMutationToolName(guard.toolName)
    && isCanonicalMutationIdKey(guard.mutationId)
    && validOptionalRevision(guard.expectedGoalRevision)
    && validOptionalRevision(guard.expectedGraphRevision)
    && validOptionalRevision(guard.expectedTodoRevision);
}

/** Build one applied-mutation receipt echoing the guard; hash and timestamp are validated. */
export function buildMutationReceipt(guard: GoalMutationGuard, requestHash: string, now: number): BuildGoalMutationReceiptResult {
  if (!guardIsCanonical(guard)) {
    return receiptError("invalid_guard", "guard must be a canonical GoalMutationGuard");
  }
  if (!isCanonicalMutationRequestHash(requestHash)) {
    return receiptError("invalid_request_hash", "requestHash must be an exact full 64-character lowercase hex sha256");
  }
  if (!validRevision(now)) {
    return receiptError("invalid_applied_at", "appliedAt must be a safe non-negative integer timestamp");
  }
  const receipt: GoalMutationReceipt = Object.freeze({
    schema: "pi-goals.goal-mutation-receipt.v1",
    toolName: guard.toolName,
    mutationId: guard.mutationId,
    requestHash,
    ...(guard.expectedGoalRevision !== undefined ? { expectedGoalRevision: guard.expectedGoalRevision } : {}),
    ...(guard.expectedGraphRevision !== undefined ? { expectedGraphRevision: guard.expectedGraphRevision } : {}),
    ...(guard.expectedTodoRevision !== undefined ? { expectedTodoRevision: guard.expectedTodoRevision } : {}),
    appliedAt: now,
    bodyStored: false,
  });
  return Object.freeze({ ok: true, receipt });
}

/** Plain receipt state keyed by mutationId; the store persists it (3b). */
export interface GoalMutationReceiptState {
  readonly receipts: Readonly<Record<string, GoalMutationReceipt>>;
}

export function createGoalMutationReceiptState(): GoalMutationReceiptState {
  return { receipts: {} };
}

export type GoalMutationReplayOutcome =
  | { readonly ok: true; readonly status: "new" }
  | { readonly ok: true; readonly status: "replayed"; readonly receipt: GoalMutationReceipt }
  | { readonly ok: false; readonly status: "conflict"; readonly existingRequestHash: string }
  | { readonly ok: false; readonly status: "invalid"; readonly code: "invalid_mutation_id" | "invalid_request_hash" };

/**
 * Replay evaluation: same mutationId + same requestHash = idempotent replay
 * success (no re-apply); same mutationId + different hash = conflict;
 * unknown mutationId = new. Malformed ids/hashes are rejected as invalid.
 */
export function evaluateMutationReplay(
  state: GoalMutationReceiptState,
  request: { mutationId: string; requestHash: string },
): GoalMutationReplayOutcome {
  if (!isCanonicalMutationIdKey(request?.mutationId)) return { ok: false, status: "invalid", code: "invalid_mutation_id" };
  if (!isCanonicalMutationRequestHash(request?.requestHash)) return { ok: false, status: "invalid", code: "invalid_request_hash" };
  const receipts = state?.receipts ?? {};
  const existing = Object.prototype.hasOwnProperty.call(receipts, request.mutationId) ? receipts[request.mutationId] : undefined;
  if (!existing) return { ok: true, status: "new" };
  if (existing.requestHash === request.requestHash) return { ok: true, status: "replayed", receipt: { ...existing } };
  return { ok: false, status: "conflict", existingRequestHash: existing.requestHash };
}

export type RecordGoalMutationReceiptResult =
  | { readonly ok: true; readonly state: GoalMutationReceiptState }
  | { readonly ok: false; readonly code: "mutation_id_conflict"; readonly message: string };

/**
 * Index one receipt. Re-indexing the exact same receipt is idempotent (same
 * state returned); the same mutationId bound to a different request hash is
 * a conflict and never overwrites the existing receipt.
 */
export function recordMutationReceipt(state: GoalMutationReceiptState, receipt: GoalMutationReceipt): RecordGoalMutationReceiptResult {
  const receipts = state?.receipts ?? {};
  const existing = Object.prototype.hasOwnProperty.call(receipts, receipt.mutationId) ? receipts[receipt.mutationId] : undefined;
  if (existing) {
    if (canonicalGoalMutationJson(existing) === canonicalGoalMutationJson(receipt)) return { ok: true, state };
    return { ok: false, code: "mutation_id_conflict", message: `mutationId ${receipt.mutationId} is already bound to a different request hash` };
  }
  return { ok: true, state: { receipts: { ...receipts, [receipt.mutationId]: receipt } } };
}
