// src/core/claims.ts — Phase 2d delegated-claim lifecycle as pure logic.
//
// Distilled (read-only) from zob-harness:
//   - .pi/extensions/zob-harness/src/domains/goal/goal-todos/operations.ts
//     (linkGoalTodoDelegation / returnGoalTodoClaim /
//      recordGoalTodoClaimValidationResult / acceptGoalTodoClaim /
//      rejectGoalTodoClaim: launch-fixed validation policy, exact claim-hash
//      + attempt bindings, single-settlement oracle validation, reasonHash)
//   - zob's GoalTodoDelegationLivenessProof shape (active|inactive|unknown).
//
// Rework decisions ("en mieux", deliberate deviations documented for review):
//   D-C1 claim hashes are exact full 64-char LOWERCASE hex sha256 (zob
//      accepted uppercase via /i; canonical hex is stricter — matches the
//      Phase 2b D6 claim-hash contract).
//   D-C2 state is three plain-data records keyed by attemptId (attempts /
//      claims / validations). zob's revision bindings live in cas.ts and the
//      store (3b); this module owns only claim DATA and settlement logic.
//   D-C3 settlement does NOT itself require an oracle validation record:
//      accept/reject are binding-exact (hash + attempt + policy echo). The
//      oracle binding (3a) composes isStrictPassAutoAccept for auto-accept.
//   D-C4 strict auto-accept is narrower than zob: confidence must be HIGH
//      (zob also allowed MEDIUM) and exactly the four documented dimensions
//      count; any weakening routes to parent review (needs_review).
//   D-C5 validation recording is the oracle channel and requires the frozen
//      policy oracle_required (zob parity). Validations may be RE-RECORDED
//      while the attempt stays claim_returned (zob parity, batch-#2 fix:
//      zob's recordGoalTodoClaimValidationResult only requires the latest
//      attempt to be claim_returned): each new validation SUPERSEDES the
//      previous one and the LATEST drives the accept gate; settlement
//      (accept/reject) is the single final step per attempt.
//   D-C6 evidenceRefs/validationCommands are trimmed + deduplicated at the
//      claim boundary (zob deduplicated later at node merge).
//
// Purity contract: node:crypto createHash is the ONLY node import (hashing
// is intrinsic to claim bindings); no fs/os/env/clock/random — timestamps
// arrive as injected now parameters and every operation returns new state
// without mutating its input.

import { createHash } from "node:crypto";
import type { GoalTodoClaimValidationPolicy } from "./transition.js";

export type { GoalTodoClaimValidationPolicy };

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const GOAL_TODO_CLAIM_HASH_PATTERN = /^[a-f0-9]{64}$/;

const SAFE_METADATA_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const NONE_LIKE = /^(none|no|n\/a|null)$/i;

export type GoalTodoDelegationAttemptStatus =
  | "queued"
  | "running"
  | "claim_returned"
  | "accepted"
  | "rejected"
  | "failed"
  | "unknown";

export const GOAL_TODO_DELEGATION_ATTEMPT_STATUSES: readonly GoalTodoDelegationAttemptStatus[] = Object.freeze([
  "queued",
  "running",
  "claim_returned",
  "accepted",
  "rejected",
  "failed",
  "unknown",
]);

export type GoalTodoClaimVerdict = "PASS" | "WARN" | "FAIL";
export type GoalTodoClaimRecommendedAction = "accept_claim" | "needs_review" | "reject_claim" | "block";
export type GoalTodoClaimConfidence = "LOW" | "MEDIUM" | "HIGH";
export type GoalTodoClaimValidationStatus = "passed" | "warn" | "failed" | "blocked";
export type GoalTodoDelegationLivenessStatus = "active" | "inactive" | "unknown";

/** One delegation attempt; validationPolicy is FROZEN at launch. */
export interface GoalTodoDelegationAttemptRecord {
  readonly attemptId: string;
  readonly runId?: string;
  readonly agent?: string;
  /** Parent-owned delegation depth metadata (integer >= 1, zob parity). */
  readonly delegationDepth?: number;
  readonly status: GoalTodoDelegationAttemptStatus;
  readonly validationPolicy: GoalTodoClaimValidationPolicy;
  readonly launchedAt: number;
  readonly returnedAt?: number;
  readonly settledAt?: number;
}

/** The claim_returned record binding attempt + exact claim hash + policy. */
export interface GoalTodoReturnedClaim {
  readonly claimVersion: 1;
  readonly attemptId: string;
  readonly claimHash: string;
  readonly validationPolicy: GoalTodoClaimValidationPolicy;
  readonly evidenceRefs: readonly string[];
  readonly validationCommands: readonly string[];
  readonly noShip?: boolean;
  readonly returnedAt: number;
}

/** One oracle validation result; re-validations supersede until settlement
 * (the latest record per attempt is the effective one).
 * BUG-4 fix: blocking issues persist HASH-ONLY — blockingIssuesHash is the
 * sha256 of the JSON array in the caller's order (zob ordered-array parity)
 * and blockingIssuesCount carries the size; the cleartext lines never reach
 * the store (legacy v0.1.x lines still parse via the store adapter). */
export interface GoalTodoClaimValidationRecord {
  readonly validationVersion: 1;
  readonly attemptId: string;
  readonly claimHash: string;
  readonly validationPolicy: GoalTodoClaimValidationPolicy;
  readonly status: GoalTodoClaimValidationStatus;
  readonly verdict: GoalTodoClaimVerdict;
  readonly recommendedAction: GoalTodoClaimRecommendedAction;
  readonly noShip: boolean;
  readonly confidence: GoalTodoClaimConfidence;
  readonly blockingIssuesHash: string;
  readonly blockingIssuesCount: number;
  readonly outputHash: string;
  readonly evidenceRefs: readonly string[];
  readonly validationCommands: readonly string[];
  /** BUG-1 fix: optional canonical provenance (length-capped, strict-validated). */
  readonly agent?: string;
  readonly runId?: string;
  readonly validatedAt: number;
}

/** sha256 over the JSON array of blocking issues in the caller's order. */
export function buildGoalTodoBlockingIssuesHash(blockingIssues: readonly string[]): string {
  return sha256Hex(JSON.stringify([...blockingIssues]));
}

/** Settlement proof produced by accept/reject (plain data; store stamps it). */
export interface GoalTodoClaimSettlementRecord {
  readonly settlement: "accepted" | "rejected";
  readonly attemptId: string;
  readonly claimHash: string;
  readonly validationPolicy: GoalTodoClaimValidationPolicy;
  readonly reasonHash?: string;
}

/** Liveness proof shape for the later side table (plain data only). */
export interface GoalTodoDelegationLivenessProof {
  readonly schema: "pi-goals.delegation-liveness-proof.v1";
  readonly status: GoalTodoDelegationLivenessStatus;
  readonly attemptId: string;
  readonly runId?: string;
  readonly source: string;
  readonly code: string;
  readonly proofAt: number;
  readonly bodyStored: false;
}

/** Pure claim side-table state: plain records keyed by attemptId. */
export interface GoalTodoClaimLifecycleState {
  readonly attempts: Readonly<Record<string, GoalTodoDelegationAttemptRecord>>;
  readonly claims: Readonly<Record<string, GoalTodoReturnedClaim>>;
  readonly validations: Readonly<Record<string, GoalTodoClaimValidationRecord>>;
}

export function createGoalTodoClaimLifecycleState(): GoalTodoClaimLifecycleState {
  return { attempts: {}, claims: {}, validations: {} };
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type GoalTodoClaimRetryPolicy = "fix_input" | "after_context_change" | "never";

export type GoalTodoClaimFailureCode =
  | "invalid_attempt_id"
  | "invalid_run_id"
  | "invalid_agent"
  | "invalid_delegation_depth"
  | "invalid_status"
  | "invalid_now"
  | "invalid_validation_policy"
  | "attempt_already_launched"
  | "attempt_not_found"
  | "attempt_not_returnable"
  | "attempt_already_settled"
  | "claim_already_settled"
  | "claim_hash_invalid"
  | "claim_hash_conflict"
  | "claim_text_required"
  | "claim_not_returned"
  | "claim_required"
  | "claim_hash_mismatch"
  | "claim_attempt_mismatch"
  | "claim_policy_mismatch"
  | "claim_validation_policy_mismatch"
  | "invalid_verdict"
  | "invalid_recommended_action"
  | "invalid_no_ship"
  | "invalid_confidence"
  | "validation_output_hash_invalid"
  | "claim_validation_not_pass"
  | "reason_required";

export interface GoalTodoClaimOperationOk<T> {
  readonly ok: true;
  readonly state: GoalTodoClaimLifecycleState;
  readonly record: T;
}

export interface GoalTodoClaimOperationErr {
  readonly ok: false;
  readonly code: GoalTodoClaimFailureCode;
  readonly message: string;
  readonly retryPolicy: GoalTodoClaimRetryPolicy;
}

export type GoalTodoClaimOperationResult<T> = GoalTodoClaimOperationOk<T> | GoalTodoClaimOperationErr;

function claimError(code: GoalTodoClaimFailureCode, message: string, retryPolicy: GoalTodoClaimRetryPolicy): GoalTodoClaimOperationErr {
  return Object.freeze({ ok: false, code, message, retryPolicy });
}

// ---------------------------------------------------------------------------
// Shared validation helpers
// ---------------------------------------------------------------------------

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSafeMetadataId(value: unknown): value is string {
  return typeof value === "string" && SAFE_METADATA_ID.test(value) && !DANGEROUS_KEYS.has(value);
}

function isValidationPolicy(value: unknown): value is GoalTodoClaimValidationPolicy {
  return value === "parent_review" || value === "oracle_required";
}

function isVerdict(value: unknown): value is GoalTodoClaimVerdict {
  return value === "PASS" || value === "WARN" || value === "FAIL";
}

function isRecommendedAction(value: unknown): value is GoalTodoClaimRecommendedAction {
  return value === "accept_claim" || value === "needs_review" || value === "reject_claim" || value === "block";
}

function isConfidence(value: unknown): value is GoalTodoClaimConfidence {
  return value === "LOW" || value === "MEDIUM" || value === "HIGH";
}

function cleanRefList(values: readonly string[] | undefined): readonly string[] {
  const cleaned = [...new Set((values ?? []).map((value) => (typeof value === "string" ? value.trim() : "")).filter((value) => value.length > 0))];
  return Object.freeze(cleaned);
}

function lookup<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  if (!record || !Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  return record[key];
}

function nextStateWith<T>(
  state: GoalTodoClaimLifecycleState,
  table: "attempts" | "claims" | "validations",
  key: string,
  record: T,
): GoalTodoClaimLifecycleState {
  return {
    attempts: { ...(state?.attempts ?? {}) },
    claims: { ...(state?.claims ?? {}) },
    validations: { ...(state?.validations ?? {}) },
    [table]: { ...(state?.[table] ?? {}), [key]: record },
  } as GoalTodoClaimLifecycleState;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** Exact sha256 hex of the claim text (full 64 lowercase characters). */
export function buildGoalTodoClaimHash(claimText: string): string {
  if (typeof claimText !== "string") throw new TypeError("buildGoalTodoClaimHash: claimText must be a string");
  return sha256Hex(claimText);
}

export function isCanonicalGoalTodoClaimHash(value: unknown): value is string {
  return typeof value === "string" && GOAL_TODO_CLAIM_HASH_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Launch (policy frozen at launch)
// ---------------------------------------------------------------------------

export interface LaunchGoalTodoDelegationAttemptInput {
  readonly attemptId: string;
  readonly runId?: string;
  readonly agent?: string;
  readonly status?: "queued" | "running";
  readonly validationPolicy?: GoalTodoClaimValidationPolicy;
  readonly delegationDepth?: number;
  readonly now: number;
}

/**
 * Launch one delegation attempt. The validation policy is resolved exactly
 * once here (default parent_review, zob parity) and every later step —
 * return, validation, settlement — must echo the frozen value.
 */
export function launchDelegationAttempt(
  state: GoalTodoClaimLifecycleState,
  input: LaunchGoalTodoDelegationAttemptInput,
): GoalTodoClaimOperationResult<GoalTodoDelegationAttemptRecord> {
  if (!isSafeMetadataId(input?.attemptId)) {
    return claimError("invalid_attempt_id", "attemptId must be a metadata-safe id matching /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/", "fix_input");
  }
  if (lookup(state?.attempts, input.attemptId)) {
    return claimError("attempt_already_launched", `delegation attempt ${input.attemptId} already exists`, "fix_input");
  }
  const validationPolicy = input.validationPolicy ?? "parent_review";
  if (!isValidationPolicy(validationPolicy)) {
    return claimError("invalid_validation_policy", "validationPolicy must be parent_review or oracle_required", "fix_input");
  }
  const status = input.status ?? "running";
  if (status !== "queued" && status !== "running") {
    return claimError("invalid_status", "status must be queued or running at launch", "fix_input");
  }
  if (input.runId !== undefined && !isSafeMetadataId(input.runId)) {
    return claimError("invalid_run_id", "runId must be a metadata-safe id when present", "fix_input");
  }
  if (input.agent !== undefined && !isSafeMetadataId(input.agent)) {
    return claimError("invalid_agent", "agent must be a metadata-safe id when present", "fix_input");
  }
  if (input.delegationDepth !== undefined && !(Number.isSafeInteger(input.delegationDepth) && input.delegationDepth >= 1)) {
    return claimError("invalid_delegation_depth", "delegationDepth must be a safe integer >= 1 when present", "fix_input");
  }
  if (!isTimestamp(input?.now)) {
    return claimError("invalid_now", "now must be a safe non-negative integer timestamp", "fix_input");
  }
  const record: GoalTodoDelegationAttemptRecord = Object.freeze({
    attemptId: input.attemptId,
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.delegationDepth !== undefined ? { delegationDepth: input.delegationDepth } : {}),
    status,
    validationPolicy,
    launchedAt: input.now,
  });
  return Object.freeze({ ok: true, state: nextStateWith(state, "attempts", input.attemptId, record), record });
}

// ---------------------------------------------------------------------------
// Return (claim_returned)
// ---------------------------------------------------------------------------

export interface ReturnGoalTodoClaimInput {
  readonly attemptId: string;
  readonly claimHash?: string;
  readonly claimText?: string;
  readonly evidenceRefs?: readonly string[];
  readonly validationCommands?: readonly string[];
  readonly noShip?: boolean;
  readonly now: number;
}

/**
 * Return one claim for an exact queued/running attempt. The produced
 * claim_returned record binds attemptId + exact full claim hash + the
 * launch-frozen validation policy, and carries the evidence/noShip metadata.
 */
export function returnGoalTodoClaim(
  state: GoalTodoClaimLifecycleState,
  input: ReturnGoalTodoClaimInput,
): GoalTodoClaimOperationResult<GoalTodoReturnedClaim> {
  if (!isSafeMetadataId(input?.attemptId)) {
    return claimError("invalid_attempt_id", "attemptId must be a metadata-safe delegation attempt id", "fix_input");
  }
  if (!isTimestamp(input?.now)) {
    return claimError("invalid_now", "now must be a safe non-negative integer timestamp", "fix_input");
  }
  const attempt = lookup(state?.attempts, input.attemptId);
  if (!attempt) {
    return claimError("attempt_not_found", `delegation attempt ${input.attemptId} not found`, "after_context_change");
  }
  if (attempt.status === "accepted" || attempt.status === "rejected") {
    return claimError("attempt_already_settled", `delegation attempt ${input.attemptId} is already ${attempt.status}`, "never");
  }
  if (attempt.status !== "queued" && attempt.status !== "running") {
    return claimError("attempt_not_returnable", `delegation attempt ${input.attemptId} is ${attempt.status}; only queued/running attempts can return a claim`, "never");
  }

  const text = typeof input.claimText === "string" ? input.claimText : undefined;
  let claimHash: string;
  if (input.claimHash !== undefined) {
    if (!isCanonicalGoalTodoClaimHash(input.claimHash)) {
      return claimError("claim_hash_invalid", "claimHash must be an exact full 64-character lowercase hex sha256; truncated, padded, uppercase, or non-hex hashes are rejected", "fix_input");
    }
    if (text !== undefined && text.trim().length > 0 && sha256Hex(text) !== input.claimHash) {
      return claimError("claim_hash_conflict", "claimText hashes to a different value than the supplied claimHash", "fix_input");
    }
    claimHash = input.claimHash;
  } else if (text !== undefined && text.trim().length > 0) {
    claimHash = sha256Hex(text);
  } else {
    return claimError("claim_text_required", "a non-empty claimText (or an exact canonical claimHash) is required to return a claim", "fix_input");
  }

  const claim: GoalTodoReturnedClaim = Object.freeze({
    claimVersion: 1,
    attemptId: input.attemptId,
    claimHash,
    validationPolicy: attempt.validationPolicy,
    evidenceRefs: cleanRefList(input.evidenceRefs),
    validationCommands: cleanRefList(input.validationCommands),
    ...(input.noShip !== undefined ? { noShip: input.noShip } : {}),
    returnedAt: input.now,
  });
  let nextState = nextStateWith(state, "claims", input.attemptId, claim);
  nextState = nextStateWith(nextState, "attempts", input.attemptId, Object.freeze({ ...attempt, status: "claim_returned", returnedAt: input.now }));
  return Object.freeze({ ok: true, state: nextState, record: claim });
}

// ---------------------------------------------------------------------------
// Oracle validation
// ---------------------------------------------------------------------------

export interface RecordGoalTodoClaimValidationInput {
  readonly attemptId: string;
  readonly runId?: string;
  readonly verdict: GoalTodoClaimVerdict;
  readonly recommendedAction: GoalTodoClaimRecommendedAction;
  readonly noShip: boolean;
  readonly confidence: GoalTodoClaimConfidence;
  readonly blockingIssues?: readonly string[];
  readonly outputHash: string;
  readonly evidenceRefs?: readonly string[];
  readonly validationCommands?: readonly string[];
  readonly agent?: string;
  readonly now: number;
}

function validationStatusFrom(verdict: GoalTodoClaimVerdict, noShip: boolean, blockingIssues: readonly string[]): GoalTodoClaimValidationStatus {
  if (noShip === true || !hasOnlyNoneLike(blockingIssues)) return "blocked";
  if (verdict === "PASS") return "passed";
  if (verdict === "WARN") return "warn";
  return "failed";
}

/**
 * Record one oracle validation result for a returned oracle_required claim.
 * While the attempt stays claim_returned the validation may be RE-RECORDED:
 * each call appends a superseding validation and the LATEST one is the
 * effective record the accept gate consults (zob parity — batch-#2 fix);
 * only accept/reject settlement is final (attempt_already_settled). The
 * binding echoes the claim's hash and launch-frozen policy (zob parity:
 * parent_review claims are reviewed directly by the parent and never enter
 * the oracle channel).
 */
export function recordClaimValidation(
  state: GoalTodoClaimLifecycleState,
  input: RecordGoalTodoClaimValidationInput,
): GoalTodoClaimOperationResult<GoalTodoClaimValidationRecord> {
  if (!isSafeMetadataId(input?.attemptId)) {
    return claimError("invalid_attempt_id", "attemptId must be a metadata-safe delegation attempt id", "fix_input");
  }
  const attempt = lookup(state?.attempts, input.attemptId);
  if (!attempt) {
    return claimError("attempt_not_found", `delegation attempt ${input.attemptId} not found`, "after_context_change");
  }
  const claim = lookup(state?.claims, input.attemptId);
  if (!claim) {
    return claimError("claim_not_returned", `no claim returned for attempt ${input.attemptId}`, "after_context_change");
  }
  if (attempt.status === "accepted" || attempt.status === "rejected") {
    return claimError("attempt_already_settled", `delegation attempt ${input.attemptId} is already ${attempt.status}`, "never");
  }
  if (attempt.status !== "claim_returned") {
    return claimError("claim_not_returned", `delegation attempt ${input.attemptId} is ${attempt.status}; claims are validated only after claim_returned`, "after_context_change");
  }
  // FIX-A (zob parity): no one-shot guard here — while the attempt stays
  // claim_returned a new validation SUPERSEDES the stored one (the store
  // keeps the full event history; the side-table view keeps the latest).
  if (claim.validationPolicy !== "oracle_required") {
    return claimError("claim_validation_policy_mismatch", `claim validation requires the oracle_required policy; attempt ${input.attemptId} is ${claim.validationPolicy}`, "fix_input");
  }
  if (!isVerdict(input?.verdict)) {
    return claimError("invalid_verdict", "verdict must be PASS, WARN, or FAIL", "fix_input");
  }
  if (!isRecommendedAction(input?.recommendedAction)) {
    return claimError("invalid_recommended_action", "recommendedAction must be accept_claim, needs_review, reject_claim, or block", "fix_input");
  }
  if (typeof input?.noShip !== "boolean") {
    return claimError("invalid_no_ship", "noShip must be an explicit boolean", "fix_input");
  }
  if (!isConfidence(input?.confidence)) {
    return claimError("invalid_confidence", "confidence must be LOW, MEDIUM, or HIGH", "fix_input");
  }
  if (input.agent !== undefined && !isSafeMetadataId(input.agent)) {
    return claimError("invalid_agent", "agent must be a metadata-safe id when present", "fix_input");
  }
  if (input.runId !== undefined && !isSafeMetadataId(input.runId)) {
    return claimError("invalid_run_id", "runId must be a metadata-safe id when present", "fix_input");
  }
  if (!isCanonicalGoalTodoClaimHash(input?.outputHash)) {
    return claimError("validation_output_hash_invalid", "outputHash must be an exact full 64-character lowercase hex sha256", "fix_input");
  }
  if (!isTimestamp(input?.now)) {
    return claimError("invalid_now", "now must be a safe non-negative integer timestamp", "fix_input");
  }

  const blockingIssues = Object.freeze([...(input.blockingIssues ?? [])]);
  const record: GoalTodoClaimValidationRecord = Object.freeze({
    validationVersion: 1,
    attemptId: input.attemptId,
    claimHash: claim.claimHash,
    validationPolicy: claim.validationPolicy,
    status: validationStatusFrom(input.verdict, input.noShip, blockingIssues),
    verdict: input.verdict,
    recommendedAction: input.recommendedAction,
    noShip: input.noShip,
    confidence: input.confidence,
    blockingIssuesHash: buildGoalTodoBlockingIssuesHash(blockingIssues),
    blockingIssuesCount: blockingIssues.length,
    outputHash: input.outputHash,
    evidenceRefs: cleanRefList(input.evidenceRefs),
    validationCommands: cleanRefList(input.validationCommands),
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.runId !== undefined ? { runId: input.runId } : {}),
    validatedAt: input.now,
  });
  return Object.freeze({ ok: true, state: nextStateWith(state, "validations", input.attemptId, record), record });
}

// ---------------------------------------------------------------------------
// Settlement (accept / reject)
// ---------------------------------------------------------------------------

export interface SettleGoalTodoClaimInput {
  readonly claimHash: string;
  readonly attemptId: string;
  readonly validationPolicy: GoalTodoClaimValidationPolicy;
}

export interface RejectGoalTodoClaimInput extends SettleGoalTodoClaimInput {
  readonly reason: string;
}

type ClaimSettlementBinding =
  | { readonly ok: true; readonly attempt: GoalTodoDelegationAttemptRecord; readonly claim: GoalTodoReturnedClaim }
  | { readonly ok: false; readonly error: GoalTodoClaimOperationErr };

/**
 * Exact settlement preconditions: canonical hash shape, exact attempt match,
 * policy echo of the launch-frozen value, claim present, and the attempt
 * still claim_returned (single settlement).
 */
function resolveSettlementBinding(state: GoalTodoClaimLifecycleState, input: SettleGoalTodoClaimInput): ClaimSettlementBinding {
  if (!isCanonicalGoalTodoClaimHash(input?.claimHash)) {
    return { ok: false, error: claimError("claim_hash_invalid", "claimHash must be an exact full 64-character lowercase hex sha256; truncated, padded, uppercase, or non-hex hashes are rejected", "fix_input") };
  }
  if (!isSafeMetadataId(input?.attemptId)) {
    return { ok: false, error: claimError("invalid_attempt_id", "attemptId must be a metadata-safe delegation attempt id", "fix_input") };
  }
  if (!isValidationPolicy(input?.validationPolicy)) {
    return { ok: false, error: claimError("invalid_validation_policy", "validationPolicy must be parent_review or oracle_required", "fix_input") };
  }
  const attempt = lookup(state?.attempts, input.attemptId);
  if (!attempt) {
    return { ok: false, error: claimError("attempt_not_found", `delegation attempt ${input.attemptId} not found`, "after_context_change") };
  }
  if (attempt.status === "accepted" || attempt.status === "rejected") {
    return { ok: false, error: claimError("claim_already_settled", `claim for attempt ${input.attemptId} is already ${attempt.status}`, "never") };
  }
  if (attempt.status !== "claim_returned") {
    return { ok: false, error: claimError("claim_not_returned", `delegation attempt ${input.attemptId} is ${attempt.status}; a claim must be returned before settlement`, "after_context_change") };
  }
  const claim = lookup(state?.claims, input.attemptId);
  if (!claim) {
    return { ok: false, error: claimError("claim_required", `no returned claim bound to attempt ${input.attemptId}`, "after_context_change") };
  }
  if (claim.claimHash !== input.claimHash) {
    return { ok: false, error: claimError("claim_hash_mismatch", `claimHash does not match the claim returned by attempt ${input.attemptId}`, "fix_input") };
  }
  if (claim.attemptId !== input.attemptId) {
    return { ok: false, error: claimError("claim_attempt_mismatch", `stored claim is bound to attempt ${claim.attemptId}, not ${input.attemptId}`, "fix_input") };
  }
  if (claim.validationPolicy !== input.validationPolicy) {
    return { ok: false, error: claimError("claim_policy_mismatch", "validationPolicy does not echo the launch-fixed claim validation policy", "fix_input") };
  }
  return { ok: true, attempt, claim };
}

function applySettlement(
  state: GoalTodoClaimLifecycleState,
  binding: Extract<ClaimSettlementBinding, { ok: true }>,
  settlement: GoalTodoClaimSettlementRecord,
  status: "accepted" | "rejected",
): GoalTodoClaimOperationResult<GoalTodoClaimSettlementRecord> {
  const attempt: GoalTodoDelegationAttemptRecord = Object.freeze({ ...binding.attempt, status });
  return Object.freeze({ ok: true, state: nextStateWith(state, "attempts", binding.claim.attemptId, attempt), record: settlement });
}

/** Accept one returned claim with exact hash/attempt/policy echo bindings.
 * BUG-2 fix (zob parity, enforced — not just exposed): when the bound claim's
 * launch-frozen policy is oracle_required, acceptance REQUIRES an existing
 * validation record for that exact claim hash with verdict PASS and noShip
 * false; otherwise the settlement is rejected with claim_validation_not_pass
 * (retry after_context_change — validate first or reject the claim).
 * parent_review claims keep manual parent acceptance. */
export function settleAcceptClaim(
  state: GoalTodoClaimLifecycleState,
  input: SettleGoalTodoClaimInput,
): GoalTodoClaimOperationResult<GoalTodoClaimSettlementRecord> {
  const binding = resolveSettlementBinding(state, input);
  if (!binding.ok) return binding.error;
  if (binding.claim.validationPolicy === "oracle_required") {
    const validation = lookup(state?.validations, binding.claim.attemptId);
    const strictPass = Boolean(
      validation
        && validation.attemptId === binding.claim.attemptId
        && validation.claimHash === binding.claim.claimHash
        && validation.validationPolicy === "oracle_required"
        && validation.verdict === "PASS"
        && validation.noShip === false,
    );
    if (!strictPass) {
      return claimError(
        "claim_validation_not_pass",
        `oracle_required claims settle only with a recorded strict-PASS validation (verdict PASS, noShip false) for attempt ${binding.claim.attemptId}; record validate_goal_todo_claim first or reject the claim`,
        "after_context_change",
      );
    }
  }
  const settlement: GoalTodoClaimSettlementRecord = Object.freeze({
    settlement: "accepted",
    attemptId: binding.claim.attemptId,
    claimHash: binding.claim.claimHash,
    validationPolicy: binding.claim.validationPolicy,
  });
  return applySettlement(state, binding, settlement, "accepted");
}

/** Reject one returned claim; a non-empty reason is required and hashed. */
export function settleRejectClaim(
  state: GoalTodoClaimLifecycleState,
  input: RejectGoalTodoClaimInput,
): GoalTodoClaimOperationResult<GoalTodoClaimSettlementRecord> {
  const binding = resolveSettlementBinding(state, input);
  if (!binding.ok) return binding.error;
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length === 0) {
    return claimError("reason_required", "rejecting a claim requires a non-empty reason", "fix_input");
  }
  const settlement: GoalTodoClaimSettlementRecord = Object.freeze({
    settlement: "rejected",
    attemptId: binding.claim.attemptId,
    claimHash: binding.claim.claimHash,
    validationPolicy: binding.claim.validationPolicy,
    reasonHash: sha256Hex(reason),
  });
  return applySettlement(state, binding, settlement, "rejected");
}

// ---------------------------------------------------------------------------
// Strict auto-accept rule
// ---------------------------------------------------------------------------

/** The four validation dimensions the strict rule evaluates. */
export interface GoalTodoClaimValidationLike {
  readonly verdict: GoalTodoClaimVerdict;
  readonly recommendedAction: GoalTodoClaimRecommendedAction;
  readonly noShip: boolean;
  readonly confidence: GoalTodoClaimConfidence;
}

export type GoalTodoAutoAcceptDimension = "verdict" | "noShip" | "recommendedAction" | "confidence";

export interface GoalTodoAutoAcceptDecision {
  readonly autoAccept: boolean;
  readonly outcome: "accept" | "needs_review";
  readonly failures: readonly GoalTodoAutoAcceptDimension[];
}

/**
 * Strict rule: verdict = PASS AND noShip = false AND recommendedAction =
 * accept_claim AND confidence = HIGH. Anything less requires parent review;
 * each failing dimension is reported so callers can explain the downgrade.
 */
export function isStrictPassAutoAccept(validation: GoalTodoClaimValidationLike): GoalTodoAutoAcceptDecision {
  const failures: GoalTodoAutoAcceptDimension[] = [];
  if (validation?.verdict !== "PASS") failures.push("verdict");
  if (validation?.noShip !== false) failures.push("noShip");
  if (validation?.recommendedAction !== "accept_claim") failures.push("recommendedAction");
  if (validation?.confidence !== "HIGH") failures.push("confidence");
  const frozen = Object.freeze(failures);
  return Object.freeze(
    failures.length === 0
      ? { autoAccept: true, outcome: "accept", failures: frozen }
      : { autoAccept: false, outcome: "needs_review", failures: frozen },
  );
}

// ---------------------------------------------------------------------------
// None-like blockers (zob parity)
// ---------------------------------------------------------------------------

export function hasOnlyNoneLike(items: readonly string[]): boolean {
  return items.length === 0 || items.every((item) => NONE_LIKE.test(item.trim()));
}

// ---------------------------------------------------------------------------
// Liveness proof guard (plain data for the later side table)
// ---------------------------------------------------------------------------

export function isCanonicalGoalTodoLivenessProof(value: unknown): value is GoalTodoDelegationLivenessProof {
  if (typeof value !== "object" || value === null) return false;
  const proof = value as Record<string, unknown>;
  if (proof.schema !== "pi-goals.delegation-liveness-proof.v1") return false;
  if (proof.status !== "active" && proof.status !== "inactive" && proof.status !== "unknown") return false;
  if (!isSafeMetadataId(proof.attemptId)) return false;
  if (proof.runId !== undefined && !isSafeMetadataId(proof.runId)) return false;
  if (typeof proof.source !== "string" || proof.source.trim().length === 0) return false;
  if (typeof proof.code !== "string" || proof.code.trim().length === 0) return false;
  if (!isTimestamp(proof.proofAt)) return false;
  return proof.bodyStored === false;
}
