// test/core-transition.test.ts — Phase 2b pure TODO state machine (TDD, red first).
//
// Under test: src/core/transition.ts — ONE frozen TRANSITIONS table (11 zob
// statuses × 7 resolve_goal_todo actions) + authorize/apply engine functions,
// distilled from zob transition-engine.ts and operations.ts. The EXPECTED
// matrix below is the independent intent statement: every (status × action)
// cell must be allowed, allowed-with-guard, or rejected with an exact code.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GOAL_TODO_ACTIONS,
  TRANSITIONS,
  applyGoalTodoTransition,
  authorizeGoalTodoTransition,
  describeGoalTodoTransitions,
} from "../src/core/transition.js";
import type {
  GoalTodoAction,
  GoalTodoClaimBinding,
  GoalTodoRejectionCode,
  GoalTodoTransitionDecision,
  GoalTodoTransitionInput,
  GoalTodoTransitionResult,
  GoalTodoTransitionState,
} from "../src/core/transition.js";
import { GOAL_TODO_STATUSES } from "../src/core/types.js";
import type { GoalTodoStatus } from "../src/core/types.js";

const CLAIM_HASH = "a".repeat(64);
const OTHER_CLAIM_HASH = "b".repeat(64);
const ATTEMPT_ID = "attempt_0001";
const CLAIM: GoalTodoClaimBinding = { claimHash: CLAIM_HASH, attemptId: ATTEMPT_ID, validationPolicy: "parent_review" };
const BINDING: GoalTodoTransitionInput = { claimHash: CLAIM_HASH, attemptId: ATTEMPT_ID, validationPolicy: "parent_review" };
const CLAIM_STATUSES: ReadonlySet<GoalTodoStatus> = new Set(["claim_returned", "needs_review", "needs_oracle"]);

function stateFor(status: GoalTodoStatus, extra: Partial<GoalTodoTransitionState> = {}): GoalTodoTransitionState {
  return { status, claim: CLAIM_STATUSES.has(status) ? CLAIM : undefined, ...extra };
}

function satisfyingInputFor(status: GoalTodoStatus, action: GoalTodoAction): GoalTodoTransitionInput {
  const input: GoalTodoTransitionInput = {};
  if (action === "block" || action === "skip" || action === "reopen" || action === "reject_claim") input.reason = "recorded reason";
  if (action === "accept_claim" || action === "reject_claim") {
    input.claimHash = CLAIM_HASH;
    input.attemptId = ATTEMPT_ID;
    input.validationPolicy = "parent_review";
  }
  if (status === "needs_user" && (action === "complete" || action === "skip")) input.userResolved = true;
  return input;
}

function assertOk(result: GoalTodoTransitionResult): Extract<GoalTodoTransitionResult, { ok: true }> {
  assert.equal(result.ok, true, `expected success: ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error("unreachable");
  return result;
}

function assertRejected(result: GoalTodoTransitionResult): Extract<GoalTodoTransitionResult, { ok: false }> {
  assert.equal(result.ok, false, `expected rejection: ${JSON.stringify(result)}`);
  if (result.ok) throw new Error("unreachable");
  return result;
}

type ExpectedOutcome =
  | { kind: "allowed"; next: GoalTodoStatus }
  | { kind: "guard"; next: GoalTodoStatus; minimalCode: GoalTodoRejectionCode }
  | { kind: "binding-guard"; next: GoalTodoStatus; minimalCode: GoalTodoRejectionCode }
  | { kind: "rejected"; code: GoalTodoRejectionCode };

const EXPECTED: Record<GoalTodoStatus, Record<GoalTodoAction, ExpectedOutcome>> = {
  planned: {
    auto: { kind: "allowed", next: "done" },
    complete: { kind: "allowed", next: "done" },
    accept_claim: { kind: "rejected", code: "invalid_transition" },
    reject_claim: { kind: "rejected", code: "invalid_transition" },
    block: { kind: "guard", next: "blocked", minimalCode: "reason_required" },
    skip: { kind: "guard", next: "skipped", minimalCode: "reason_required" },
    reopen: { kind: "rejected", code: "invalid_transition" },
  },
  ready: {
    auto: { kind: "allowed", next: "done" },
    complete: { kind: "allowed", next: "done" },
    accept_claim: { kind: "rejected", code: "invalid_transition" },
    reject_claim: { kind: "rejected", code: "invalid_transition" },
    block: { kind: "guard", next: "blocked", minimalCode: "reason_required" },
    skip: { kind: "guard", next: "skipped", minimalCode: "reason_required" },
    reopen: { kind: "rejected", code: "invalid_transition" },
  },
  in_progress: {
    auto: { kind: "allowed", next: "done" },
    complete: { kind: "allowed", next: "done" },
    accept_claim: { kind: "rejected", code: "invalid_transition" },
    reject_claim: { kind: "rejected", code: "invalid_transition" },
    block: { kind: "guard", next: "blocked", minimalCode: "reason_required" },
    skip: { kind: "guard", next: "skipped", minimalCode: "reason_required" },
    reopen: { kind: "rejected", code: "invalid_transition" },
  },
  delegated: {
    auto: { kind: "rejected", code: "active_delegation" },
    complete: { kind: "rejected", code: "active_delegation" },
    accept_claim: { kind: "rejected", code: "invalid_transition" },
    reject_claim: { kind: "rejected", code: "invalid_transition" },
    block: { kind: "guard", next: "blocked", minimalCode: "reason_required" },
    skip: { kind: "rejected", code: "invalid_transition" },
    reopen: { kind: "rejected", code: "invalid_transition" },
  },
  claim_returned: {
    auto: { kind: "rejected", code: "explicit_accept_claim_required" },
    complete: { kind: "rejected", code: "explicit_accept_claim_required" },
    accept_claim: { kind: "guard", next: "done", minimalCode: "claim_hash_invalid" },
    reject_claim: { kind: "guard", next: "delegated", minimalCode: "claim_hash_invalid" },
    block: { kind: "binding-guard", next: "blocked", minimalCode: "claim_resolution_required" },
    skip: { kind: "rejected", code: "invalid_transition" },
    reopen: { kind: "rejected", code: "invalid_transition" },
  },
  needs_review: {
    auto: { kind: "rejected", code: "invalid_transition" },
    complete: { kind: "rejected", code: "invalid_transition" },
    accept_claim: { kind: "rejected", code: "invalid_transition" },
    reject_claim: { kind: "guard", next: "blocked", minimalCode: "claim_hash_invalid" },
    block: { kind: "guard", next: "blocked", minimalCode: "reason_required" },
    skip: { kind: "rejected", code: "invalid_transition" },
    reopen: { kind: "rejected", code: "invalid_transition" },
  },
  needs_oracle: {
    auto: { kind: "rejected", code: "explicit_accept_claim_required" },
    complete: { kind: "rejected", code: "explicit_accept_claim_required" },
    accept_claim: { kind: "guard", next: "done", minimalCode: "claim_hash_invalid" },
    reject_claim: { kind: "guard", next: "blocked", minimalCode: "claim_hash_invalid" },
    block: { kind: "guard", next: "blocked", minimalCode: "reason_required" },
    skip: { kind: "rejected", code: "invalid_transition" },
    reopen: { kind: "rejected", code: "invalid_transition" },
  },
  needs_user: {
    auto: { kind: "rejected", code: "user_resolution_required" },
    complete: { kind: "guard", next: "done", minimalCode: "user_resolution_required" },
    accept_claim: { kind: "rejected", code: "invalid_transition" },
    reject_claim: { kind: "rejected", code: "invalid_transition" },
    block: { kind: "guard", next: "blocked", minimalCode: "reason_required" },
    skip: { kind: "guard", next: "skipped", minimalCode: "reason_required" },
    reopen: { kind: "rejected", code: "invalid_transition" },
  },
  blocked: {
    auto: { kind: "rejected", code: "invalid_transition" },
    complete: { kind: "rejected", code: "invalid_transition" },
    accept_claim: { kind: "rejected", code: "invalid_transition" },
    reject_claim: { kind: "rejected", code: "invalid_transition" },
    block: { kind: "rejected", code: "invalid_transition" },
    skip: { kind: "guard", next: "skipped", minimalCode: "reason_required" },
    reopen: { kind: "guard", next: "ready", minimalCode: "reason_required" },
  },
  done: {
    auto: { kind: "rejected", code: "terminal_status" },
    complete: { kind: "rejected", code: "terminal_status" },
    accept_claim: { kind: "rejected", code: "terminal_status" },
    reject_claim: { kind: "rejected", code: "terminal_status" },
    block: { kind: "rejected", code: "terminal_status" },
    skip: { kind: "rejected", code: "terminal_status" },
    reopen: { kind: "guard", next: "ready", minimalCode: "reason_required" },
  },
  skipped: {
    auto: { kind: "rejected", code: "terminal_status" },
    complete: { kind: "rejected", code: "terminal_status" },
    accept_claim: { kind: "rejected", code: "terminal_status" },
    reject_claim: { kind: "rejected", code: "terminal_status" },
    block: { kind: "rejected", code: "terminal_status" },
    skip: { kind: "rejected", code: "terminal_status" },
    reopen: { kind: "guard", next: "ready", minimalCode: "reason_required" },
  },
};

test("GOAL_TODO_ACTIONS exports exactly the 7 resolve_goal_todo actions", () => {
  assert.deepEqual([...GOAL_TODO_ACTIONS], ["auto", "complete", "accept_claim", "reject_claim", "block", "skip", "reopen"]);
  assert.equal(GOAL_TODO_ACTIONS.length, 7);
  assert.equal(Object.isFrozen(GOAL_TODO_ACTIONS), true);
});

test("TRANSITIONS is a frozen 11 × 7 table keyed by status then action", () => {
  assert.equal(Object.isFrozen(TRANSITIONS), true);
  assert.deepEqual(Object.keys(TRANSITIONS), [...GOAL_TODO_STATUSES]);
  for (const status of GOAL_TODO_STATUSES) {
    const row = TRANSITIONS[status];
    assert.equal(Object.isFrozen(row), true, status);
    assert.deepEqual(Object.keys(row), [...GOAL_TODO_ACTIONS], status);
    for (const action of GOAL_TODO_ACTIONS) {
      assert.equal(Object.isFrozen(row[action]), true, `${status} × ${action}`);
    }
  }
});

test("exhaustive matrix: every (status × action) cell matches the expected outcome", () => {
  let allowed = 0;
  let guarded = 0;
  let bindingGuarded = 0;
  let rejected = 0;
  for (const status of GOAL_TODO_STATUSES) {
    for (const action of GOAL_TODO_ACTIONS) {
      const expected = EXPECTED[status]![action]!;
      const state = stateFor(status);
      const label = `${status} × ${action}`;
      if (expected.kind === "rejected") {
        const withFullInput = assertRejected(applyGoalTodoTransition(state, action, satisfyingInputFor(status, action)));
        assert.equal(withFullInput.code, expected.code, label);
        assert.equal(withFullInput.retryPolicy, "never", label);
        assert.ok(withFullInput.message.length > 0, label);
        const withMinimalInput = assertRejected(applyGoalTodoTransition(state, action));
        assert.equal(withMinimalInput.code, expected.code, label);
        rejected += 1;
        continue;
      }
      if (expected.kind === "binding-guard") {
        // stateFor binds a claim for claim-shaped statuses: with the binding
        // the action rejects with the exact code (full AND minimal input);
        // WITHOUT the binding (deadlock-escape fix) it applies to `next`.
        const withClaimFull = assertRejected(applyGoalTodoTransition(state, action, satisfyingInputFor(status, action)));
        assert.equal(withClaimFull.code, expected.minimalCode, label);
        assert.equal(withClaimFull.retryPolicy, "never", label);
        const withClaimMinimal = assertRejected(applyGoalTodoTransition(state, action));
        assert.equal(withClaimMinimal.code, expected.minimalCode, label);
        const escaped = assertOk(applyGoalTodoTransition({ ...state, claim: undefined }, action, satisfyingInputFor(status, action)));
        assert.equal(escaped.nextStatus, expected.next, `${label} without bound claim`);
        bindingGuarded += 1;
        continue;
      }
      const applied = assertOk(applyGoalTodoTransition(state, action, satisfyingInputFor(status, action)));
      assert.equal(applied.nextStatus, expected.next, label);
      assert.equal(applied.fromStatus, status, label);
      assert.equal(applied.action, action, label);
      if (expected.kind === "guard") {
        const minimal = assertRejected(applyGoalTodoTransition(state, action));
        assert.equal(minimal.code, expected.minimalCode, `${label} minimal input`);
        assert.equal(minimal.retryPolicy, "fix_input", `${label} minimal input`);
        guarded += 1;
      } else {
        assert.equal(applyGoalTodoTransition(state, action).ok, true, `${label} minimal input`);
        allowed += 1;
      }
    }
  }
  assert.equal(allowed, 6);
  assert.equal(guarded, 21);
  assert.equal(bindingGuarded, 1);
  assert.equal(rejected, 49);
  assert.equal(allowed + guarded + bindingGuarded + rejected, 77);
});

test("describeGoalTodoTransitions returns the full 77-entry matrix consistent with TRANSITIONS", () => {
  const described = describeGoalTodoTransitions();
  assert.equal(described.length, 77);
  let index = 0;
  for (const status of GOAL_TODO_STATUSES) {
    for (const action of GOAL_TODO_ACTIONS) {
      const entry = described[index]!;
      const expected = EXPECTED[status]![action]!;
      assert.equal(entry.status, status, `entry ${index}`);
      assert.equal(entry.action, action, `entry ${index}`);
      assert.equal(entry.allowed, expected.kind !== "rejected", `entry ${index}`);
      if (expected.kind === "rejected") {
        assert.equal(entry.code, expected.code, `entry ${index}`);
        assert.equal(entry.retryPolicy, "never", `entry ${index}`);
        assert.ok((entry.message ?? "").length > 0, `entry ${index}`);
      } else {
        assert.equal(entry.nextStatus, expected.next, `entry ${index}`);
        assert.equal(entry.code, "transition_allowed", `entry ${index}`);
        assert.equal(entry.requiredGuards.length > 0, expected.kind === "guard" || expected.kind === "binding-guard", `entry ${index}`);
      }
      index += 1;
    }
  }
});

test("accept_claim rejects truncated, padded, uppercase, and non-hex claim hashes", () => {
  const badInputs: GoalTodoTransitionInput[] = [
    { ...BINDING, claimHash: CLAIM_HASH.slice(0, 63) },
    { ...BINDING, claimHash: `${CLAIM_HASH}a` },
    { ...BINDING, claimHash: CLAIM_HASH.toUpperCase() },
    { ...BINDING, claimHash: "z".repeat(64) },
    { ...BINDING, claimHash: "not-a-hash" },
    { ...BINDING, claimHash: "" },
    { ...BINDING, claimHash: undefined },
  ];
  for (const input of badInputs) {
    const rejected = assertRejected(applyGoalTodoTransition(stateFor("claim_returned"), "accept_claim", input));
    assert.equal(rejected.code, "claim_hash_invalid");
    assert.equal(rejected.retryPolicy, "fix_input");
  }
});

test("accept_claim rejects a claim hash that does not match the bound claim", () => {
  const rejected = assertRejected(applyGoalTodoTransition(stateFor("claim_returned"), "accept_claim", { ...BINDING, claimHash: OTHER_CLAIM_HASH }));
  assert.equal(rejected.code, "claim_hash_mismatch");
  assert.equal(rejected.retryPolicy, "fix_input");
});

test("accept_claim requires attempt binding presence and exact attempt match", () => {
  const missing = assertRejected(applyGoalTodoTransition(stateFor("claim_returned"), "accept_claim", { ...BINDING, attemptId: undefined }));
  assert.equal(missing.code, "claim_attempt_required");
  const blank = assertRejected(applyGoalTodoTransition(stateFor("claim_returned"), "accept_claim", { ...BINDING, attemptId: "   " }));
  assert.equal(blank.code, "claim_attempt_required");
  const wrong = assertRejected(applyGoalTodoTransition(stateFor("claim_returned"), "accept_claim", { ...BINDING, attemptId: "attempt_9999" }));
  assert.equal(wrong.code, "claim_attempt_mismatch");
  assert.equal(wrong.retryPolicy, "fix_input");
});

test("accept_claim validates the launch-fixed validation policy echo", () => {
  const missing = assertRejected(applyGoalTodoTransition(stateFor("claim_returned"), "accept_claim", { ...BINDING, validationPolicy: undefined }));
  assert.equal(missing.code, "validation_policy_required");
  const bogus = assertRejected(applyGoalTodoTransition(stateFor("claim_returned"), "accept_claim", { ...BINDING, validationPolicy: "sometimes" as unknown as GoalTodoTransitionInput["validationPolicy"] }));
  assert.equal(bogus.code, "validation_policy_required");
  const oracleClaim = stateFor("claim_returned", { claim: { ...CLAIM, validationPolicy: "oracle_required" } });
  const mismatched = assertRejected(applyGoalTodoTransition(oracleClaim, "accept_claim", BINDING));
  assert.equal(mismatched.code, "claim_policy_mismatch");
  assert.equal(mismatched.retryPolicy, "fix_input");
  const echoed = assertOk(applyGoalTodoTransition(oracleClaim, "accept_claim", { ...BINDING, validationPolicy: "oracle_required" }));
  assert.equal(echoed.effects.validationPolicy, "oracle_required");
});

test("accept_claim without a bound claim in state is rejected as claim_required", () => {
  const rejected = assertRejected(applyGoalTodoTransition({ status: "claim_returned" }, "accept_claim", BINDING));
  assert.equal(rejected.code, "claim_required");
  assert.equal(rejected.retryPolicy, "after_context_change");
  const malformedClaim = assertRejected(
    applyGoalTodoTransition({ status: "claim_returned", claim: { ...CLAIM, claimHash: "short" } }, "accept_claim", { ...BINDING, claimHash: "short" }),
  );
  assert.equal(malformedClaim.code, "claim_required");
});

test("accept_claim success echoes the binding in effects", () => {
  const ok = assertOk(applyGoalTodoTransition(stateFor("claim_returned"), "accept_claim", BINDING));
  assert.equal(ok.nextStatus, "done");
  assert.equal(ok.effects.claimAccepted, true);
  assert.equal(ok.effects.acceptedClaimHash, CLAIM_HASH);
  assert.equal(ok.effects.acceptedAttemptId, ATTEMPT_ID);
  assert.equal(ok.effects.validationPolicy, "parent_review");
});

test("reject_claim returns claim_returned to the recoverable delegated state", () => {
  const ok = assertOk(applyGoalTodoTransition(stateFor("claim_returned"), "reject_claim", { ...BINDING, reason: "claim did not verify" }));
  assert.equal(ok.nextStatus, "delegated");
  assert.equal(ok.effects.claimRejected, true);
  assert.equal(ok.effects.rejectedClaimHash, CLAIM_HASH);
  assert.equal(ok.effects.rejectedAttemptId, ATTEMPT_ID);
  assert.equal(ok.effects.validationPolicy, "parent_review");
});

test("reject_claim from needs_review and needs_oracle lands in blocked", () => {
  for (const status of ["needs_review", "needs_oracle"] as const) {
    const ok = assertOk(applyGoalTodoTransition(stateFor(status), "reject_claim", { ...BINDING, reason: "not acceptable" }));
    assert.equal(ok.nextStatus, "blocked", status);
  }
});

test("block, skip, and reopen require a non-empty reason", () => {
  for (const reason of [undefined, "", "   \t"] as GoalTodoTransitionInput["reason"][]) {
    const blocked = assertRejected(applyGoalTodoTransition(stateFor("in_progress"), "block", { reason }));
    assert.equal(blocked.code, "reason_required");
    const skipped = assertRejected(applyGoalTodoTransition(stateFor("planned"), "skip", { reason }));
    assert.equal(skipped.code, "reason_required");
    const reopened = assertRejected(applyGoalTodoTransition(stateFor("done"), "reopen", { reason }));
    assert.equal(reopened.code, "reason_required");
    assert.equal(reopened.retryPolicy, "fix_input");
  }
});

test("block from claim_returned is rejected: claims must be accepted or rejected", () => {
  const rejected = assertRejected(applyGoalTodoTransition(stateFor("claim_returned"), "block", { reason: "want to block" }));
  assert.equal(rejected.code, "claim_resolution_required");
  assert.equal(rejected.retryPolicy, "never");
});

test("FIX-1: needs_review/needs_oracle block without a bound claim (deadlock escape)", () => {
  for (const status of ["needs_review", "needs_oracle"] as const) {
    const withClaim = assertOk(applyGoalTodoTransition(stateFor(status), "block", { reason: "waiting" }));
    assert.equal(withClaim.nextStatus, "blocked", status);
    const withoutClaim = assertOk(applyGoalTodoTransition({ status }, "block", { reason: "no claim anywhere" }));
    assert.equal(withoutClaim.nextStatus, "blocked", `${status} without claim`);
  }
});

test("auto completes planned, ready, and in_progress nodes", () => {
  for (const status of ["planned", "ready", "in_progress"] as const) {
    const ok = assertOk(applyGoalTodoTransition(stateFor(status), "auto"));
    assert.equal(ok.nextStatus, "done", status);
    assert.equal(ok.effects.autoResolved, "complete");
    assert.equal(ok.effects.completed, true);
  }
});

test("auto and complete reject claim_returned and needs_oracle: explicit accept_claim required", () => {
  for (const status of ["claim_returned", "needs_oracle"] as const) {
    const autoRejected = assertRejected(applyGoalTodoTransition(stateFor(status), "auto"));
    assert.equal(autoRejected.code, "explicit_accept_claim_required", status);
    assert.equal(autoRejected.retryPolicy, "never", status);
    const completeRejected = assertRejected(applyGoalTodoTransition(stateFor(status), "complete"));
    assert.equal(completeRejected.code, "explicit_accept_claim_required", status);
  }
});

test("auto rejects delegated nodes, needs_user nodes, and terminal statuses", () => {
  const delegatedRejected = assertRejected(applyGoalTodoTransition(stateFor("delegated"), "auto"));
  assert.equal(delegatedRejected.code, "active_delegation");
  assert.equal(delegatedRejected.retryPolicy, "never");
  const needsUserRejected = assertRejected(applyGoalTodoTransition(stateFor("needs_user"), "auto"));
  assert.equal(needsUserRejected.code, "user_resolution_required");
  assert.equal(needsUserRejected.retryPolicy, "never");
  for (const terminal of ["done", "skipped"] as const) {
    const rejected = assertRejected(applyGoalTodoTransition(stateFor(terminal), "auto"));
    assert.equal(rejected.code, "terminal_status", terminal);
  }
});

test("complete is the explicit path for planned, ready, and in_progress", () => {
  for (const status of ["planned", "ready", "in_progress"] as const) {
    const ok = assertOk(applyGoalTodoTransition(stateFor(status), "complete"));
    assert.equal(ok.nextStatus, "done", status);
    assert.equal(ok.effects.completed, true);
    assert.equal(ok.effects.autoResolved, undefined);
  }
});

test("complete from needs_user requires explicit user resolution", () => {
  const rejected = assertRejected(applyGoalTodoTransition(stateFor("needs_user"), "complete"));
  assert.equal(rejected.code, "user_resolution_required");
  assert.equal(rejected.retryPolicy, "fix_input");
  const ok = assertOk(applyGoalTodoTransition(stateFor("needs_user"), "complete", { userResolved: true }));
  assert.equal(ok.nextStatus, "done");
});

test("complete from delegated is rejected: delegated nodes are not directly completable", () => {
  const rejected = assertRejected(applyGoalTodoTransition(stateFor("delegated"), "complete"));
  assert.equal(rejected.code, "active_delegation");
  assert.match(rejected.message, /not directly completable/);
});

test("reopen works only from done, skipped, and blocked", () => {
  for (const status of ["done", "skipped", "blocked"] as const) {
    const ok = assertOk(applyGoalTodoTransition(stateFor(status), "reopen", { reason: "back to work" }));
    assert.equal(ok.nextStatus, "ready", status);
    assert.equal(ok.effects.reopened, true, status);
    assert.equal(ok.effects.reopenedFrom, status, status);
    assert.equal(ok.effects.reopenReason, "back to work", status);
  }
  for (const status of ["planned", "ready", "in_progress", "delegated", "claim_returned", "needs_review", "needs_oracle", "needs_user"] as const) {
    const rejected = assertRejected(applyGoalTodoTransition(stateFor(status), "reopen", { reason: "back to work" }));
    assert.equal(rejected.code, "invalid_transition", status);
    assert.equal(rejected.retryPolicy, "never", status);
  }
});

test("required semantics flow into effects for later tree gating", () => {
  const requiredDone = assertOk(applyGoalTodoTransition(stateFor("in_progress", { required: true }), "complete"));
  assert.equal(requiredDone.effects.requiredCompleted, true);
  const optionalDone = assertOk(applyGoalTodoTransition(stateFor("in_progress", { required: false }), "complete"));
  assert.equal(optionalDone.effects.requiredCompleted, undefined);
  const autoRequired = assertOk(applyGoalTodoTransition(stateFor("ready", { required: true }), "auto"));
  assert.equal(autoRequired.effects.requiredCompleted, true);
  const skippedRequired = assertOk(applyGoalTodoTransition(stateFor("blocked", { required: true }), "skip", { reason: "obsolete" }));
  assert.equal(skippedRequired.effects.requiredSkipped, true);
  assert.equal(skippedRequired.effects.skipReason, "obsolete");
});

test("authorizeGoalTodoTransition mirrors applyGoalTodoTransition decisions", () => {
  const decisionOk: GoalTodoTransitionDecision = authorizeGoalTodoTransition(stateFor("in_progress"), "complete");
  assert.equal(decisionOk.allowed, true);
  if (decisionOk.allowed) {
    assert.equal(decisionOk.nextStatus, "done");
    assert.deepEqual([...decisionOk.requiredGuards], []);
  }
  const applied = assertOk(applyGoalTodoTransition(stateFor("in_progress"), "complete"));
  assert.equal(applied.nextStatus, decisionOk.allowed ? decisionOk.nextStatus : undefined);

  const decisionGuarded = authorizeGoalTodoTransition(stateFor("claim_returned"), "accept_claim", BINDING);
  assert.equal(decisionGuarded.allowed, true);
  if (decisionGuarded.allowed) {
    assert.ok(decisionGuarded.requiredGuards.includes("claim_hash_matches"));
    assert.ok(decisionGuarded.requiredGuards.includes("validation_policy_matches"));
  }

  const decisionRejected = authorizeGoalTodoTransition(stateFor("planned"), "reopen", { reason: "nope" });
  assert.equal(decisionRejected.allowed, false);
  if (!decisionRejected.allowed) {
    assert.equal(decisionRejected.code, "invalid_transition");
    const rejected = assertRejected(applyGoalTodoTransition(stateFor("planned"), "reopen", { reason: "nope" }));
    assert.equal(rejected.code, decisionRejected.code);
    assert.equal(rejected.message, decisionRejected.message);
    assert.equal(rejected.retryPolicy, decisionRejected.retryPolicy);
  }
});

test("unknown status or action is rejected at runtime", () => {
  const unknownStatus = authorizeGoalTodoTransition({ status: "finished" } as unknown as GoalTodoTransitionState, "auto");
  assert.equal(unknownStatus.allowed, false);
  if (!unknownStatus.allowed) {
    assert.equal(unknownStatus.code, "unknown_status");
    assert.equal(unknownStatus.retryPolicy, "never");
  }
  const unknownAction = authorizeGoalTodoTransition(stateFor("planned"), "explode" as unknown as GoalTodoAction);
  assert.equal(unknownAction.allowed, false);
  if (!unknownAction.allowed) {
    assert.equal(unknownAction.code, "unknown_action");
    assert.equal(unknownAction.retryPolicy, "never");
  }
});
