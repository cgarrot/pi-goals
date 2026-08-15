// test/core-claims.test.ts — Phase 2d delegated-claim lifecycle (TDD, red first).
//
// Under test: src/core/claims.ts — the delegated-claim side table as pure
// logic: launch (policy frozen at launch) → return (claim_returned record
// binding attempt + sha256(claimText) + policy) → oracle validation
// (PASS/WARN/FAIL verdicts, single settlement, strict auto-accept rule) →
// settlement (accept/reject with exact hash/attempt/policy echo bindings).
// The independent intent statement below doubles as the contract for the
// later store (3b) and oracle binding (3a). node:crypto is used ONLY as an
// independent sha256 oracle for the expected hashes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  GOAL_TODO_CLAIM_HASH_PATTERN,
  GOAL_TODO_DELEGATION_ATTEMPT_STATUSES,
  buildGoalTodoClaimHash,
  createGoalTodoClaimLifecycleState,
  hasOnlyNoneLike,
  isCanonicalGoalTodoClaimHash,
  isCanonicalGoalTodoLivenessProof,
  isStrictPassAutoAccept,
  launchDelegationAttempt,
  recordClaimValidation,
  returnGoalTodoClaim,
  settleAcceptClaim,
  settleRejectClaim,
} from "../src/core/claims.js";
import type {
  GoalTodoClaimLifecycleState,
  GoalTodoClaimOperationResult,
  GoalTodoClaimValidationLike,
  GoalTodoDelegationLivenessProof,
  LaunchGoalTodoDelegationAttemptInput,
  RecordGoalTodoClaimValidationInput,
  SettleGoalTodoClaimInput,
} from "../src/core/claims.js";

const NOW = 1_700_000_000;
const ATTEMPT = "attempt_0001";
const CLAIM_TEXT = "implemented src/core/claims.ts; npm run build && npm test exit 0";
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const CLAIM_HASH = sha256(CLAIM_TEXT);
const OTHER_HASH = sha256("a different claim");

function okOf<T>(result: GoalTodoClaimOperationResult<T>): Extract<GoalTodoClaimOperationResult<T>, { ok: true }> {
  assert.equal(result.ok, true, `expected ok: ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error("unreachable");
  return result;
}

function errOf<T>(result: GoalTodoClaimOperationResult<T>): Extract<GoalTodoClaimOperationResult<T>, { ok: false }> {
  assert.equal(result.ok, false, `expected error: ${JSON.stringify(result)}`);
  if (result.ok) throw new Error("unreachable");
  return result;
}

function launchAttempt(
  state: GoalTodoClaimLifecycleState = createGoalTodoClaimLifecycleState(),
  overrides: Partial<LaunchGoalTodoDelegationAttemptInput> = {},
) {
  return launchDelegationAttempt(state, { attemptId: ATTEMPT, now: NOW, ...overrides });
}

function acceptInput(overrides: Partial<SettleGoalTodoClaimInput> = {}): SettleGoalTodoClaimInput {
  return { claimHash: CLAIM_HASH, attemptId: ATTEMPT, validationPolicy: "oracle_required", ...overrides };
}

const STRICT_PASS: RecordGoalTodoClaimValidationInput = {
  attemptId: ATTEMPT,
  verdict: "PASS",
  recommendedAction: "accept_claim",
  noShip: false,
  confidence: "HIGH",
  blockingIssues: [],
  outputHash: "c".repeat(64),
  now: NOW + 20,
};

function launchedState(policy?: LaunchGoalTodoDelegationAttemptInput["validationPolicy"]): GoalTodoClaimLifecycleState {
  return okOf(launchAttempt(createGoalTodoClaimLifecycleState(), policy ? { validationPolicy: policy } : {})).state;
}

function returnedState(policy?: LaunchGoalTodoDelegationAttemptInput["validationPolicy"]): GoalTodoClaimLifecycleState {
  return okOf(returnGoalTodoClaim(launchedState(policy), { attemptId: ATTEMPT, claimText: CLAIM_TEXT, now: NOW + 10 })).state;
}

// ---------------------------------------------------------------------------
// Hash format matrix
// ---------------------------------------------------------------------------

test("buildGoalTodoClaimHash returns the exact full lowercase sha256 hex", () => {
  assert.equal(buildGoalTodoClaimHash("hello"), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assert.equal(buildGoalTodoClaimHash(""), sha256(""));
  assert.equal(buildGoalTodoClaimHash(CLAIM_TEXT), CLAIM_HASH);
  const unicode = buildGoalTodoClaimHash("unicode: héllo → ✓");
  assert.match(unicode, GOAL_TODO_CLAIM_HASH_PATTERN);
  assert.equal(unicode, sha256("unicode: héllo → ✓"));
  assert.equal(buildGoalTodoClaimHash(CLAIM_TEXT).length, 64);
  assert.throws(() => buildGoalTodoClaimHash(42 as unknown as string), TypeError);
});

test("isCanonicalGoalTodoClaimHash rejects truncated, padded, uppercase, and non-hex hashes", () => {
  assert.equal(isCanonicalGoalTodoClaimHash(CLAIM_HASH), true);
  assert.equal(isCanonicalGoalTodoClaimHash(CLAIM_HASH.slice(0, 63)), false);
  assert.equal(isCanonicalGoalTodoClaimHash(`${CLAIM_HASH}a`), false);
  assert.equal(isCanonicalGoalTodoClaimHash(CLAIM_HASH.toUpperCase()), false);
  assert.equal(isCanonicalGoalTodoClaimHash("z".repeat(64)), false);
  assert.equal(isCanonicalGoalTodoClaimHash(""), false);
  assert.equal(isCanonicalGoalTodoClaimHash(42), false);
  assert.equal(isCanonicalGoalTodoClaimHash(undefined), false);
});

test("GOAL_TODO_DELEGATION_ATTEMPT_STATUSES is the frozen 7-status lifecycle", () => {
  assert.deepEqual([...GOAL_TODO_DELEGATION_ATTEMPT_STATUSES], [
    "queued",
    "running",
    "claim_returned",
    "accepted",
    "rejected",
    "failed",
    "unknown",
  ]);
  assert.equal(Object.isFrozen(GOAL_TODO_DELEGATION_ATTEMPT_STATUSES), true);
});

// ---------------------------------------------------------------------------
// Launch: policy freeze
// ---------------------------------------------------------------------------

test("launchDelegationAttempt freezes the validation policy at launch", () => {
  const defaulted = okOf(launchAttempt());
  assert.deepEqual(defaulted.record, {
    attemptId: ATTEMPT,
    status: "running",
    validationPolicy: "parent_review",
    launchedAt: NOW,
  });
  const oracle = okOf(launchAttempt(undefined, { validationPolicy: "oracle_required", runId: "run_1", agent: "coder", status: "queued" }));
  assert.deepEqual(oracle.record, {
    attemptId: ATTEMPT,
    runId: "run_1",
    agent: "coder",
    status: "queued",
    validationPolicy: "oracle_required",
    launchedAt: NOW,
  });
  assert.deepEqual(oracle.state.attempts[ATTEMPT], oracle.record);
});

test("launchDelegationAttempt validates attempt id, ids, policy, status, and now", () => {
  for (const attemptId of ["", "   ", "bad id", ".leading", "constructor", 42 as unknown as string]) {
    assert.equal(errOf(launchAttempt(createGoalTodoClaimLifecycleState(), { attemptId: attemptId as string })).code, "invalid_attempt_id", String(attemptId));
  }
  assert.equal(errOf(launchAttempt(createGoalTodoClaimLifecycleState(), { attemptId: "a".repeat(161) })).code, "invalid_attempt_id");
  assert.equal(okOf(launchAttempt(createGoalTodoClaimLifecycleState(), { attemptId: "a".repeat(160) })).record.attemptId, "a".repeat(160));
  const launchedOnce = okOf(launchAttempt());
  assert.equal(errOf(launchAttempt(launchedOnce.state)).code, "attempt_already_launched");
  assert.equal(
    errOf(launchAttempt(createGoalTodoClaimLifecycleState(), { validationPolicy: "sometimes" as LaunchGoalTodoDelegationAttemptInput["validationPolicy"] })).code,
    "invalid_validation_policy",
  );
  assert.equal(errOf(launchAttempt(createGoalTodoClaimLifecycleState(), { runId: "bad run" })).code, "invalid_run_id");
  assert.equal(errOf(launchAttempt(createGoalTodoClaimLifecycleState(), { agent: "no agent!" })).code, "invalid_agent");
  assert.equal(errOf(launchAttempt(createGoalTodoClaimLifecycleState(), { status: "bogus" as LaunchGoalTodoDelegationAttemptInput["status"] })).code, "invalid_status");
  for (const now of [-1, 1.5, Number.NaN]) {
    assert.equal(errOf(launchAttempt(createGoalTodoClaimLifecycleState(), { now })).code, "invalid_now");
  }
});

// ---------------------------------------------------------------------------
// Return: claim_returned binding
// ---------------------------------------------------------------------------

test("returnGoalTodoClaim binds attempt + exact claim hash + frozen policy", () => {
  const launched = okOf(launchAttempt(undefined, { validationPolicy: "oracle_required" }));
  const returned = okOf(returnGoalTodoClaim(launched.state, {
    attemptId: ATTEMPT,
    claimText: CLAIM_TEXT,
    evidenceRefs: [" reports/run.txt ", "reports/run.txt", ""],
    validationCommands: ["npm test", "npm test"],
    noShip: false,
    now: NOW + 10,
  }));
  assert.deepEqual(returned.record, {
    claimVersion: 1,
    attemptId: ATTEMPT,
    claimHash: CLAIM_HASH,
    validationPolicy: "oracle_required",
    evidenceRefs: ["reports/run.txt"],
    validationCommands: ["npm test"],
    noShip: false,
    returnedAt: NOW + 10,
  });
  assert.equal(returned.state.attempts[ATTEMPT]!.status, "claim_returned");
  assert.equal(returned.state.attempts[ATTEMPT]!.returnedAt, NOW + 10);
  assert.deepEqual(returned.state.claims[ATTEMPT], returned.record);
});

test("returnGoalTodoClaim accepts a supplied canonical hash and detects text/hash conflicts", () => {
  const launched = okOf(launchAttempt());
  const byHash = okOf(returnGoalTodoClaim(launched.state, { attemptId: ATTEMPT, claimHash: CLAIM_HASH, now: NOW + 10 }));
  assert.equal(byHash.record.claimHash, CLAIM_HASH);
  const agreeing = okOf(returnGoalTodoClaim(launched.state, { attemptId: ATTEMPT, claimHash: CLAIM_HASH, claimText: CLAIM_TEXT, now: NOW + 10 }));
  assert.equal(agreeing.record.claimHash, CLAIM_HASH);
  const conflict = errOf(returnGoalTodoClaim(launched.state, { attemptId: ATTEMPT, claimHash: OTHER_HASH, claimText: CLAIM_TEXT, now: NOW + 10 }));
  assert.equal(conflict.code, "claim_hash_conflict");
  assert.equal(conflict.retryPolicy, "fix_input");
});

test("returnGoalTodoClaim rejects malformed hashes and missing claim text", () => {
  const launched = okOf(launchAttempt());
  for (const claimHash of [CLAIM_HASH.slice(0, 63), `${CLAIM_HASH}0`, CLAIM_HASH.toUpperCase(), "z".repeat(64), ""]) {
    const rejected = errOf(returnGoalTodoClaim(launched.state, { attemptId: ATTEMPT, claimHash, now: NOW + 10 }));
    assert.equal(rejected.code, "claim_hash_invalid", claimHash);
    assert.equal(rejected.retryPolicy, "fix_input");
  }
  for (const claimText of [undefined, "", "   \t"]) {
    const rejected = errOf(returnGoalTodoClaim(launched.state, { attemptId: ATTEMPT, claimText, now: NOW + 10 }));
    assert.equal(rejected.code, "claim_text_required", JSON.stringify(claimText));
  }
});

test("returnGoalTodoClaim requires an exact queued/running attempt", () => {
  const missing = errOf(returnGoalTodoClaim(createGoalTodoClaimLifecycleState(), { attemptId: ATTEMPT, claimText: CLAIM_TEXT, now: NOW + 10 }));
  assert.equal(missing.code, "attempt_not_found");
  assert.equal(missing.retryPolicy, "after_context_change");
  const returned = returnedState("oracle_required");
  const reReturned = errOf(returnGoalTodoClaim(returned, { attemptId: ATTEMPT, claimText: CLAIM_TEXT, now: NOW + 20 }));
  assert.equal(reReturned.code, "attempt_not_returnable");
  assert.equal(reReturned.retryPolicy, "never");
  const settled = okOf(settleAcceptClaim(okOf(recordClaimValidation(returned, STRICT_PASS)).state, acceptInput()));
  const afterSettle = errOf(returnGoalTodoClaim(settled.state, { attemptId: ATTEMPT, claimText: CLAIM_TEXT, now: NOW + 30 }));
  assert.equal(afterSettle.code, "attempt_already_settled");
  const failedState: GoalTodoClaimLifecycleState = {
    attempts: { [ATTEMPT]: { attemptId: ATTEMPT, status: "failed", validationPolicy: "parent_review", launchedAt: NOW } },
    claims: {},
    validations: {},
  };
  const failed = errOf(returnGoalTodoClaim(failedState, { attemptId: ATTEMPT, claimText: CLAIM_TEXT, now: NOW + 10 }));
  assert.equal(failed.code, "attempt_not_returnable");
  const badNow = errOf(returnGoalTodoClaim(launchedState(), { attemptId: ATTEMPT, claimText: CLAIM_TEXT, now: -1 }));
  assert.equal(badNow.code, "invalid_now");
  const badAttempt = errOf(returnGoalTodoClaim(createGoalTodoClaimLifecycleState(), { attemptId: "nope!", claimText: CLAIM_TEXT, now: NOW + 10 }));
  assert.equal(badAttempt.code, "invalid_attempt_id");
});

// ---------------------------------------------------------------------------
// Oracle validation
// ---------------------------------------------------------------------------

test("recordClaimValidation derives the validation status from the oracle verdict", () => {
  const cases: Array<{ overrides: Partial<RecordGoalTodoClaimValidationInput>; status: string }> = [
    { overrides: {}, status: "passed" },
    { overrides: { verdict: "WARN" }, status: "warn" },
    { overrides: { verdict: "FAIL" }, status: "failed" },
    { overrides: { noShip: true }, status: "blocked" },
    { overrides: { blockingIssues: ["tests failing"] }, status: "blocked" },
    { overrides: { blockingIssues: ["none"] }, status: "passed" },
  ];
  for (const testCase of cases) {
    const recorded = okOf(recordClaimValidation(returnedState("oracle_required"), { ...STRICT_PASS, ...testCase.overrides }));
    assert.equal(recorded.record.status, testCase.status, JSON.stringify(testCase.overrides));
  }
  const base = okOf(recordClaimValidation(returnedState("oracle_required"), { ...STRICT_PASS, evidenceRefs: ["a", "a"], validationCommands: ["npm test"] }));
  assert.deepEqual(base.record, {
    validationVersion: 1,
    attemptId: ATTEMPT,
    claimHash: CLAIM_HASH,
    validationPolicy: "oracle_required",
    status: "passed",
    verdict: "PASS",
    recommendedAction: "accept_claim",
    noShip: false,
    confidence: "HIGH",
    blockingIssuesHash: sha256("[]"),
    blockingIssuesCount: 0,
    outputHash: "c".repeat(64),
    evidenceRefs: ["a"],
    validationCommands: ["npm test"],
    validatedAt: NOW + 20,
  });
});

test("recordClaimValidation enforces claim, policy, output hash, and settlement preconditions", () => {
  const missingAttempt = errOf(recordClaimValidation(createGoalTodoClaimLifecycleState(), STRICT_PASS));
  assert.equal(missingAttempt.code, "attempt_not_found");
  const noClaim = errOf(recordClaimValidation(launchedState(), STRICT_PASS));
  assert.equal(noClaim.code, "claim_not_returned");
  const wrongPolicy = errOf(recordClaimValidation(returnedState(), STRICT_PASS));
  assert.equal(wrongPolicy.code, "claim_validation_policy_mismatch");
  assert.equal(wrongPolicy.retryPolicy, "fix_input");
  const truncated = errOf(recordClaimValidation(returnedState("oracle_required"), { ...STRICT_PASS, outputHash: "c".repeat(63) }));
  assert.equal(truncated.code, "validation_output_hash_invalid");
  const upper = errOf(recordClaimValidation(returnedState("oracle_required"), { ...STRICT_PASS, outputHash: "C".repeat(64) }));
  assert.equal(upper.code, "validation_output_hash_invalid");
  const validatedState = okOf(recordClaimValidation(returnedState("oracle_required"), STRICT_PASS)).state;
  const settledClaim = okOf(settleAcceptClaim(validatedState, acceptInput()));
  const afterSettle = errOf(recordClaimValidation(settledClaim.state, STRICT_PASS));
  assert.equal(afterSettle.code, "attempt_already_settled");
  // FIX-A (zob parity): while the attempt stays claim_returned, a second
  // validation SUPERSEDES the first (re-validation allowed); only
  // accept/reject settlement makes the attempt final.
  const once = okOf(recordClaimValidation(returnedState("oracle_required"), STRICT_PASS));
  const twice = okOf(recordClaimValidation(once.state, { ...STRICT_PASS, verdict: "WARN", recommendedAction: "needs_review", confidence: "MEDIUM", now: NOW + 30 }));
  assert.equal(twice.state.validations[ATTEMPT]!.verdict, "WARN");
  assert.equal(twice.state.validations[ATTEMPT]!.validatedAt, NOW + 30);
  assert.equal(errOf(recordClaimValidation(returnedState("oracle_required"), { ...STRICT_PASS, verdict: "SHIP" as RecordGoalTodoClaimValidationInput["verdict"] })).code, "invalid_verdict");
  assert.equal(errOf(recordClaimValidation(returnedState("oracle_required"), { ...STRICT_PASS, recommendedAction: "ship_it" as RecordGoalTodoClaimValidationInput["recommendedAction"] })).code, "invalid_recommended_action");
  assert.equal(errOf(recordClaimValidation(returnedState("oracle_required"), { ...STRICT_PASS, confidence: "ULTRA" as RecordGoalTodoClaimValidationInput["confidence"] })).code, "invalid_confidence");
  assert.equal(errOf(recordClaimValidation(returnedState("oracle_required"), { ...STRICT_PASS, noShip: "yes" as unknown as boolean })).code, "invalid_no_ship");
});

// ---------------------------------------------------------------------------
// Re-validation until settlement (FIX-A, session 2026-08-14T21-02-40)
// ---------------------------------------------------------------------------

test("recordClaimValidation allows re-validation until settlement; the LATEST validation drives the accept gate", () => {
  // session evidence: WARN on the attempt → fix the findings → re-validate
  // PASS on the SAME attempt → accept must now succeed (zob parity: zob's
  // recordGoalTodoClaimValidationResult only requires the latest attempt to
  // stay claim_returned; the validation record is updated in place).
  const warned = okOf(recordClaimValidation(returnedState("oracle_required"), { ...STRICT_PASS, verdict: "WARN", recommendedAction: "needs_review", confidence: "MEDIUM", now: NOW + 20 }));

  const refusedAfterWarn = errOf(settleAcceptClaim(warned.state, acceptInput()));
  assert.equal(refusedAfterWarn.code, "claim_validation_not_pass");
  const passed = okOf(recordClaimValidation(warned.state, { ...STRICT_PASS, now: NOW + 30 }));
  assert.equal(passed.state.validations[ATTEMPT]!.verdict, "PASS");
  assert.equal(passed.state.validations[ATTEMPT]!.validatedAt, NOW + 30);
  const accepted = okOf(settleAcceptClaim(passed.state, acceptInput()));
  assert.equal(accepted.state.attempts[ATTEMPT]!.status, "accepted");
  // settlement is the only final step: post-accept validation is refused
  const afterSettle = errOf(recordClaimValidation(accepted.state, STRICT_PASS));
  assert.equal(afterSettle.code, "attempt_already_settled");
});

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

test("settleAcceptClaim settles an exactly-bound claim and flips the attempt to accepted", () => {
  // FIX-2: oracle_required acceptance requires a recorded strict-PASS validation first
  const state = okOf(recordClaimValidation(returnedState("oracle_required"), STRICT_PASS)).state;
  const settled = okOf(settleAcceptClaim(state, acceptInput()));
  assert.deepEqual(settled.record, {
    settlement: "accepted",
    attemptId: ATTEMPT,
    claimHash: CLAIM_HASH,
    validationPolicy: "oracle_required",
  });
  assert.equal(settled.state.attempts[ATTEMPT]!.status, "accepted");
  assert.deepEqual(settled.state.claims[ATTEMPT], state.claims[ATTEMPT]);
});

test("settleAcceptClaim rejects truncated hashes, wrong hashes, and policy echo mismatches", () => {
  const state = returnedState("oracle_required");
  const truncated = errOf(settleAcceptClaim(state, acceptInput({ claimHash: CLAIM_HASH.slice(0, 63) })));
  assert.equal(truncated.code, "claim_hash_invalid");
  const padded = errOf(settleAcceptClaim(state, acceptInput({ claimHash: `${CLAIM_HASH}f` })));
  assert.equal(padded.code, "claim_hash_invalid");
  const uppercased = errOf(settleAcceptClaim(state, acceptInput({ claimHash: CLAIM_HASH.toUpperCase() })));
  assert.equal(uppercased.code, "claim_hash_invalid");
  const wrongHash = errOf(settleAcceptClaim(state, acceptInput({ claimHash: OTHER_HASH })));
  assert.equal(wrongHash.code, "claim_hash_mismatch");
  assert.equal(wrongHash.retryPolicy, "fix_input");
  const wrongAttempt = errOf(settleAcceptClaim(state, acceptInput({ attemptId: "attempt_0002" })));
  assert.equal(wrongAttempt.code, "attempt_not_found");
  const echoMismatch = errOf(settleAcceptClaim(state, acceptInput({ validationPolicy: "parent_review" })));
  assert.equal(echoMismatch.code, "claim_policy_mismatch");
  const bogusPolicy = errOf(settleAcceptClaim(state, acceptInput({ validationPolicy: "sometimes" as SettleGoalTodoClaimInput["validationPolicy"] })));
  assert.equal(bogusPolicy.code, "invalid_validation_policy");
  const parentEcho = errOf(settleAcceptClaim(returnedState(), acceptInput()));
  assert.equal(parentEcho.code, "claim_policy_mismatch");
});

test("settleAcceptClaim rejects a stored claim whose attempt binding disagrees", () => {
  const tampered = structuredClone(returnedState("oracle_required"));
  const claim = tampered.claims[ATTEMPT]!;
  (claim as { attemptId: string }).attemptId = "attempt_9999";
  const rejected = errOf(settleAcceptClaim(tampered, acceptInput()));
  assert.equal(rejected.code, "claim_attempt_mismatch");
  assert.equal(rejected.retryPolicy, "fix_input");
});

test("settleAcceptClaim requires the claim to be present and the attempt unsettled", () => {
  const noClaim = errOf(settleAcceptClaim(launchedState(), acceptInput({ validationPolicy: "parent_review" })));
  assert.equal(noClaim.code, "claim_not_returned");
  assert.equal(noClaim.retryPolicy, "after_context_change");
  const missingClaimRecord: GoalTodoClaimLifecycleState = {
    attempts: { [ATTEMPT]: { attemptId: ATTEMPT, status: "claim_returned", validationPolicy: "parent_review", launchedAt: NOW } },
    claims: {},
    validations: {},
  };
  const absent = errOf(settleAcceptClaim(missingClaimRecord, acceptInput({ validationPolicy: "parent_review" })));
  assert.equal(absent.code, "claim_required");
  const unknown = errOf(settleAcceptClaim(createGoalTodoClaimLifecycleState(), acceptInput()));
  assert.equal(unknown.code, "attempt_not_found");
  const accepted = okOf(settleAcceptClaim(okOf(recordClaimValidation(returnedState("oracle_required"), STRICT_PASS)).state, acceptInput()));
  const again = errOf(settleAcceptClaim(accepted.state, acceptInput()));
  assert.equal(again.code, "claim_already_settled");
  assert.equal(again.retryPolicy, "never");
});

test("settleRejectClaim requires a reason and records its hash", () => {
  for (const reason of [undefined, "", "   "] as (string | undefined)[]) {
    const rejected = errOf(settleRejectClaim(returnedState("oracle_required"), { ...acceptInput(), reason: reason as string }));
    assert.equal(rejected.code, "reason_required");
    assert.equal(rejected.retryPolicy, "fix_input");
  }
  const state = returnedState("oracle_required");
  const rejected = okOf(settleRejectClaim(state, { ...acceptInput(), reason: "  claim did not verify  " }));
  assert.deepEqual(rejected.record, {
    settlement: "rejected",
    attemptId: ATTEMPT,
    claimHash: CLAIM_HASH,
    validationPolicy: "oracle_required",
    reasonHash: sha256("claim did not verify"),
  });
  assert.equal(rejected.state.attempts[ATTEMPT]!.status, "rejected");
  const reRejected = errOf(settleRejectClaim(rejected.state, { ...acceptInput(), reason: "again" }));
  assert.equal(reRejected.code, "claim_already_settled");
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

test("claim operations never mutate their input state", () => {
  const empty = createGoalTodoClaimLifecycleState();
  const emptySnapshot = structuredClone(empty);
  const launched = okOf(launchAttempt(empty, { validationPolicy: "oracle_required" }));
  const launchedSnapshot = structuredClone(launched.state);
  const returned = okOf(returnGoalTodoClaim(launched.state, { attemptId: ATTEMPT, claimText: CLAIM_TEXT, now: NOW + 10 }));
  const returnedSnapshot = structuredClone(returned.state);
  const validated = okOf(recordClaimValidation(returned.state, STRICT_PASS));
  const validatedSnapshot = structuredClone(validated.state);
  const settled = okOf(settleAcceptClaim(validated.state, acceptInput()));
  assert.deepEqual(empty, emptySnapshot);
  assert.deepEqual(launched.state, launchedSnapshot);
  assert.deepEqual(returned.state, returnedSnapshot);
  assert.deepEqual(validated.state, validatedSnapshot);
  assert.equal(settled.state.attempts[ATTEMPT]!.status, "accepted");
  assert.notEqual(settled.state, validated.state);
});

// ---------------------------------------------------------------------------
// Strict-PASS auto-accept matrix
// ---------------------------------------------------------------------------

test("isStrictPassAutoAccept: every weakening dimension flips accept to needs_review", () => {
  const strict: GoalTodoClaimValidationLike = { verdict: "PASS", recommendedAction: "accept_claim", noShip: false, confidence: "HIGH" };
  const accepted = isStrictPassAutoAccept(strict);
  assert.equal(accepted.autoAccept, true);
  assert.equal(accepted.outcome, "accept");
  assert.deepEqual([...accepted.failures], []);
  const weakenings: Array<Partial<GoalTodoClaimValidationLike> & { dimension: string }> = [
    { dimension: "verdict", verdict: "WARN" },
    { dimension: "verdict", verdict: "FAIL" },
    { dimension: "noShip", noShip: true },
    { dimension: "recommendedAction", recommendedAction: "needs_review" },
    { dimension: "recommendedAction", recommendedAction: "reject_claim" },
    { dimension: "recommendedAction", recommendedAction: "block" },
    { dimension: "confidence", confidence: "MEDIUM" },
    { dimension: "confidence", confidence: "LOW" },
  ];
  for (const weakening of weakenings) {
    const decision = isStrictPassAutoAccept({ ...strict, ...weakening });
    assert.equal(decision.autoAccept, false, weakening.dimension);
    assert.equal(decision.outcome, "needs_review", weakening.dimension);
    assert.deepEqual([...decision.failures], [weakening.dimension], weakening.dimension);
  }
});

test("hasOnlyNoneLike treats only none-like strings as absent blockers", () => {
  assert.equal(hasOnlyNoneLike([]), true);
  assert.equal(hasOnlyNoneLike(["none"]), true);
  assert.equal(hasOnlyNoneLike(["NO", "N/A", "null", "None"]), true);
  assert.equal(hasOnlyNoneLike(["tests failing"]), false);
  assert.equal(hasOnlyNoneLike([""]), false);
  assert.equal(hasOnlyNoneLike(["none", "late evidence"]), false);
});

// ---------------------------------------------------------------------------
// Liveness proof shape (plain data for the later side table)
// ---------------------------------------------------------------------------

test("liveness proofs are plain data with status active|inactive|unknown", () => {
  for (const status of ["active", "inactive", "unknown"] as const) {
    const proof: GoalTodoDelegationLivenessProof = {
      schema: "pi-goals.delegation-liveness-proof.v1",
      status,
      attemptId: ATTEMPT,
      runId: "run_1",
      source: "monitor",
      code: "monitor_terminal_exact",
      proofAt: NOW,
      bodyStored: false,
    };
    assert.equal(isCanonicalGoalTodoLivenessProof(proof), true, status);
    type MutableProof = { -readonly [K in keyof GoalTodoDelegationLivenessProof]: GoalTodoDelegationLivenessProof[K] };
    for (const mutate of [
      (p: MutableProof) => { p.schema = "wrong" as unknown as MutableProof["schema"]; },
      (p: MutableProof) => { p.status = "zombie" as unknown as MutableProof["status"]; },
      (p: MutableProof) => { p.attemptId = "bad id"; },
      (p: MutableProof) => { p.bodyStored = true as unknown as false; },
      (p: MutableProof) => { p.proofAt = -1; },
      (p: MutableProof) => { p.source = "  "; },
    ]) {
      const tampered = structuredClone(proof) as MutableProof;
      mutate(tampered);
      assert.equal(isCanonicalGoalTodoLivenessProof(tampered), false, status);
    }
  }
  assert.equal(isCanonicalGoalTodoLivenessProof(null), false);
  assert.equal(isCanonicalGoalTodoLivenessProof("inactive"), false);
});
