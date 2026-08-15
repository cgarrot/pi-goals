// src/core/transition.ts — Phase 2b pure, declarative TODO state machine.
//
// Distilled (read-only) from zob-harness:
//   - .pi/extensions/zob-harness/src/domains/goal/goal-todos/transition-engine.ts
//     (declarative status × action table + first-failed-guard semantics)
//   - .pi/extensions/zob-harness/src/domains/goal/goal-todos/operations.ts
//     (resolveGoalTodo call sites for the 7 public actions and their guards)
//
// Rework decisions ("en mieux", deliberate deviations documented for review):
//   D1 reopen domain tightened to {done, skipped, blocked}. zob's table also
//      allowed reopen from needs_user (its resolve_goal_todo surface never
//      offered it there); the rework keeps reopen terminal-or-blocked only,
//      so claim_returned exits are accept/reject.
//   D2 reject_claim from claim_returned returns the node to delegated (a
//      recoverable state) instead of zob's blocked, so a rejected claim can
//      be re-delegated without unblocking first.
//   D3 block from claim_returned WITH a bound claim is rejected
//      (claim_resolution_required): a returned claim must be accepted or
//      rejected, never buried. claim_returned states created WITHOUT a
//      binding (synthetic add_goal_todo status) block freely, and
//      needs_review/needs_oracle/needs_user always keep the block escape
//      (BUG-3 fix: no claim-bearing creation state may deadlock).
//   D4 zob's operations-layer idempotent early-return for complete-on-done is
//      dropped; the table stays strict (terminal_status). Idempotency of
//      re-application belongs to the store layer (Phase 2c+).
//   D5 Evidence, CAS, revision, and delegation-liveness guards need store and
//      claim side tables and therefore stay out of Phase 2b; they land with
//      the claims side-table phase (2d). Required semantics flow through
//      effects (requiredCompleted / requiredSkipped) so the tree gate (2c)
//      can consume them without re-reading node state.
//   D6 claimHash must be an exact full 64-char LOWERCASE hex sha256 (zob
//      accepted uppercase via /i; the distilled contract is stricter and
//      matches canonical sha256 hex output).
//   D7 auto is deliberately narrower than zob: it only resolves plain work
//      nodes (planned/ready/in_progress). zob could ride userResolved or
//      expectedAutoResolution=accept_claim through auto; here those require
//      the explicit complete / accept_claim actions.
//
// Purity contract: no filesystem, OS, or environment access, no clocks, no
// side effects. TRANSITIONS is the single source of truth; engine functions
// only read it, and effects are plain data.

import { GOAL_TODO_STATUSES } from "./types.js";
import type { GoalTodoStatus } from "./types.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Launch-fixed claim validation policy (zob GoalTodoClaimValidationPolicy). */
export type GoalTodoClaimValidationPolicy = "parent_review" | "oracle_required";

/** The 7 public resolve_goal_todo actions (zob ResolveGoalTodoAction). */
export type GoalTodoAction =
  | "auto"
  | "complete"
  | "accept_claim"
  | "reject_claim"
  | "block"
  | "skip"
  | "reopen";

export const GOAL_TODO_ACTIONS: readonly GoalTodoAction[] = Object.freeze([
  "auto",
  "complete",
  "accept_claim",
  "reject_claim",
  "block",
  "skip",
  "reopen",
]);

/** Canonical claim binding the state carries (claims side-table lands in 2d). */
export interface GoalTodoClaimBinding {
  /** Exact full 64-char lowercase hex sha256 of the returned claim. */
  claimHash: string;
  /** Delegation attempt id the claim is bound to. */
  attemptId: string;
  /** Launch-fixed validation policy fixed when the attempt was queued. */
  validationPolicy: GoalTodoClaimValidationPolicy;
}

/** Minimal node state the pure transition engine operates over. */
export interface GoalTodoTransitionState {
  status: GoalTodoStatus;
  /** Required semantics for later tree gating; defaults to false. */
  required?: boolean;
  /** Bound claim; claim-shaped statuses without it fail the claim_present guard. */
  claim?: GoalTodoClaimBinding;
}

/** Per-action input; guards read only what their action needs. */
export interface GoalTodoTransitionInput {
  /** Required by block, skip, and reopen. */
  reason?: string;
  /** Required by complete/skip from needs_user (user resolution recorded). */
  userResolved?: boolean;
  /** Exact full 64-char lowercase hex claim hash (accept_claim/reject_claim). */
  claimHash?: string;
  /** Exact delegation attempt id binding the claim resolution. */
  attemptId?: string;
  /** Must echo the launch-fixed claim policy. */
  validationPolicy?: GoalTodoClaimValidationPolicy;
}

// ---------------------------------------------------------------------------
// Table rule shapes
// ---------------------------------------------------------------------------

/** Declarative guards, evaluated in table order; first failure wins. */
export type GoalTodoGuard =
  | "claim_present"
  | "claim_not_bound"
  | "claim_hash_valid"
  | "claim_hash_matches"
  | "claim_attempt_present"
  | "claim_attempt_matches"
  | "validation_policy_present"
  | "validation_policy_matches"
  | "reason_present"
  | "user_resolved";

export type GoalTodoTableRejectionCode =
  | "terminal_status"
  | "invalid_transition"
  | "active_delegation"
  | "explicit_accept_claim_required"
  | "claim_resolution_required"
  | "user_resolution_required";

export type GoalTodoGuardRejectionCode =
  | "claim_resolution_required"
  | "reason_required"
  | "user_resolution_required"
  | "claim_required"
  | "claim_hash_invalid"
  | "claim_hash_mismatch"
  | "claim_attempt_required"
  | "claim_attempt_mismatch"
  | "validation_policy_required"
  | "claim_policy_mismatch";

export type GoalTodoRejectionCode =
  | GoalTodoTableRejectionCode
  | GoalTodoGuardRejectionCode
  | "unknown_status"
  | "unknown_action";

export type GoalTodoRetryPolicy = "never" | "fix_input" | "after_context_change";

export interface GoalTodoAllowedRule {
  readonly allowed: true;
  readonly nextStatus: GoalTodoStatus;
  readonly code: "transition_allowed";
  readonly requiredGuards: readonly GoalTodoGuard[];
}

export interface GoalTodoRejectedRule {
  readonly allowed: false;
  readonly code: GoalTodoTableRejectionCode;
  readonly message: string;
  readonly retryPolicy: "never";
}

export type GoalTodoTransitionRule = GoalTodoAllowedRule | GoalTodoRejectedRule;

export type GoalTodoTransitionTable = Readonly<
  Record<GoalTodoStatus, Readonly<Record<GoalTodoAction, GoalTodoTransitionRule>>>
>;

// ---------------------------------------------------------------------------
// THE table — single source of truth (11 zob statuses × 7 resolve actions)
// ---------------------------------------------------------------------------

const CLAIM_HASH_PATTERN = /^[a-f0-9]{64}$/;

/** Claim-resolution binding guards shared by accept_claim / reject_claim. */
const CLAIM_RESOLUTION_GUARDS: readonly GoalTodoGuard[] = [
  "claim_present",
  "claim_hash_valid",
  "claim_hash_matches",
  "claim_attempt_present",
  "claim_attempt_matches",
  "validation_policy_present",
  "validation_policy_matches",
];

function allow(nextStatus: GoalTodoStatus, ...requiredGuards: GoalTodoGuard[]): GoalTodoAllowedRule {
  return { allowed: true, nextStatus, code: "transition_allowed", requiredGuards };
}

function denied(code: GoalTodoTableRejectionCode, message: string): GoalTodoRejectedRule {
  return { allowed: false, code, message, retryPolicy: "never" };
}

function row(cells: Record<GoalTodoAction, GoalTodoTransitionRule>): Readonly<Record<GoalTodoAction, GoalTodoTransitionRule>> {
  return cells;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

const WORK_ROW = (): Readonly<Record<GoalTodoAction, GoalTodoTransitionRule>> =>
  row({
    auto: allow("done"),
    complete: allow("done"),
    accept_claim: denied("invalid_transition", "plain work nodes carry no claim; there is nothing to accept"),
    reject_claim: denied("invalid_transition", "plain work nodes carry no claim; there is nothing to reject"),
    block: allow("blocked", "reason_present"),
    skip: allow("skipped", "reason_present"),
    reopen: denied("invalid_transition", "reopen only applies to terminal (done/skipped) or blocked nodes"),
  });

const TERMINAL_ROW = (status: "done" | "skipped"): Readonly<Record<GoalTodoAction, GoalTodoTransitionRule>> =>
  row({
    auto: denied("terminal_status", `${status} is terminal; only reopen can leave it`),
    complete: denied("terminal_status", `${status} is terminal; only reopen can leave it`),
    accept_claim: denied("terminal_status", `${status} is terminal; only reopen can leave it`),
    reject_claim: denied("terminal_status", `${status} is terminal; only reopen can leave it`),
    block: denied("terminal_status", `${status} is terminal; only reopen can leave it`),
    skip: denied("terminal_status", `${status} is terminal; only reopen can leave it`),
    reopen: allow("ready", "reason_present"),
  });

/**
 * Frozen declarative transition table: TRANSITIONS[status][action] is either
 * an allowed rule (nextStatus + ordered requiredGuards) or a rejection with
 * an exact reason code. The engine functions below only read this table.
 */
export const TRANSITIONS: GoalTodoTransitionTable = deepFreeze({
  planned: WORK_ROW(),
  ready: WORK_ROW(),
  in_progress: WORK_ROW(),
  delegated: row({
    auto: denied("active_delegation", "auto cannot resolve delegated nodes; wait for the returned claim or use block"),
    complete: denied("active_delegation", "delegated nodes are not directly completable; wait for the returned claim (accept_claim/reject_claim) or block"),
    accept_claim: denied("invalid_transition", "no claim has returned yet; wait for the delegation to return a claim"),
    reject_claim: denied("invalid_transition", "no claim has returned yet; wait for the delegation to return a claim"),
    block: allow("blocked", "reason_present"),
    skip: denied("invalid_transition", "delegated nodes cannot be skipped; block or resolve the delegation first"),
    reopen: denied("invalid_transition", "delegated nodes cannot be reopened; block or resolve the delegation first"),
  }),
  claim_returned: row({
    auto: denied("explicit_accept_claim_required", "claim_returned nodes require an explicit accept_claim (or reject_claim); auto never accepts claims"),
    complete: denied("explicit_accept_claim_required", "claim_returned nodes require an explicit accept_claim (or reject_claim); complete cannot accept a claim"),
    accept_claim: allow("done", ...CLAIM_RESOLUTION_GUARDS),
    reject_claim: allow("delegated", ...CLAIM_RESOLUTION_GUARDS, "reason_present"),
    block: allow("blocked", "claim_not_bound", "reason_present"),
    skip: denied("invalid_transition", "claim_returned nodes cannot be skipped; resolve the claim first"),
    reopen: denied("invalid_transition", "reopen only applies to terminal (done/skipped) or blocked nodes; resolve the claim with accept_claim or reject_claim"),
  }),
  needs_review: row({
    auto: denied("invalid_transition", "needs_review nodes require review resolution (reject_claim or block); auto cannot resolve them"),
    complete: denied("invalid_transition", "needs_review nodes cannot be completed directly; resolve the review (reject_claim or block) first"),
    accept_claim: denied("invalid_transition", "needs_review nodes resolve through reject_claim or block, not accept_claim"),
    reject_claim: allow("blocked", ...CLAIM_RESOLUTION_GUARDS, "reason_present"),
    block: allow("blocked", "reason_present"),
    skip: denied("invalid_transition", "needs_review nodes cannot be skipped; resolve the review (reject_claim or block) first"),
    reopen: denied("invalid_transition", "reopen only applies to terminal (done/skipped) or blocked nodes"),
  }),
  needs_oracle: row({
    auto: denied("explicit_accept_claim_required", "needs_oracle nodes require an explicit accept_claim or reject_claim; auto cannot resolve them"),
    complete: denied("explicit_accept_claim_required", "needs_oracle nodes require an explicit accept_claim or reject_claim; complete cannot resolve them"),
    accept_claim: allow("done", ...CLAIM_RESOLUTION_GUARDS),
    reject_claim: allow("blocked", ...CLAIM_RESOLUTION_GUARDS, "reason_present"),
    block: allow("blocked", "reason_present"),
    skip: denied("invalid_transition", "needs_oracle nodes cannot be skipped; resolve the oracle review first"),
    reopen: denied("invalid_transition", "reopen only applies to terminal (done/skipped) or blocked nodes"),
  }),
  needs_user: row({
    auto: denied("user_resolution_required", "auto cannot resolve needs_user nodes; record the user decision and use explicit complete, block, or skip"),
    complete: allow("done", "user_resolved"),
    accept_claim: denied("invalid_transition", "needs_user nodes carry no claim; there is nothing to accept"),
    reject_claim: denied("invalid_transition", "needs_user nodes carry no claim; there is nothing to reject"),
    block: allow("blocked", "reason_present"),
    skip: allow("skipped", "reason_present", "user_resolved"),
    reopen: denied("invalid_transition", "reopen only applies to terminal (done/skipped) or blocked nodes"),
  }),
  blocked: row({
    auto: denied("invalid_transition", "blocked nodes must be reopened (or skipped); auto cannot resolve them"),
    complete: denied("invalid_transition", "blocked nodes must be reopened before work can complete"),
    accept_claim: denied("invalid_transition", "blocked nodes carry no claim; there is nothing to accept"),
    reject_claim: denied("invalid_transition", "blocked nodes carry no claim; there is nothing to reject"),
    block: denied("invalid_transition", "node is already blocked; update the blocker through the patch layer or reopen/skip"),
    skip: allow("skipped", "reason_present"),
    reopen: allow("ready", "reason_present"),
  }),
  done: TERMINAL_ROW("done"),
  skipped: TERMINAL_ROW("skipped"),
});

// ---------------------------------------------------------------------------
// Guard evaluation (zob first-failed-guard semantics)
// ---------------------------------------------------------------------------

function guardPasses(state: GoalTodoTransitionState, input: GoalTodoTransitionInput, guard: GoalTodoGuard): boolean {
  const claim = state.claim;
  switch (guard) {
    case "claim_present":
      return Boolean(
        claim
          && typeof claim.claimHash === "string"
          && CLAIM_HASH_PATTERN.test(claim.claimHash)
          && typeof claim.attemptId === "string"
          && claim.attemptId.trim().length > 0
          && (claim.validationPolicy === "parent_review" || claim.validationPolicy === "oracle_required"),
      );
    case "claim_not_bound":
      // passes ONLY when the state carries NO canonical claim binding: a
      // bound returned claim must be accepted/rejected (D3), while synthetic
      // claim_returned states created without a binding block freely.
      return claim === undefined;
    case "claim_hash_valid":
      return typeof input.claimHash === "string" && CLAIM_HASH_PATTERN.test(input.claimHash);
    case "claim_hash_matches":
      return Boolean(claim) && input.claimHash === claim!.claimHash;
    case "claim_attempt_present":
      return typeof input.attemptId === "string" && input.attemptId.trim().length > 0;
    case "claim_attempt_matches":
      return Boolean(claim) && input.attemptId === claim!.attemptId;
    case "validation_policy_present":
      return input.validationPolicy === "parent_review" || input.validationPolicy === "oracle_required";
    case "validation_policy_matches":
      return Boolean(claim) && input.validationPolicy === claim!.validationPolicy;
    case "reason_present":
      return typeof input.reason === "string" && input.reason.trim().length > 0;
    case "user_resolved":
      return input.userResolved === true;
  }
}

interface GuardFailure {
  readonly code: GoalTodoGuardRejectionCode;
  readonly retryPolicy: GoalTodoRetryPolicy;
  readonly message: string;
}

const GUARD_FAILURES: Readonly<Record<GoalTodoGuard, GuardFailure>> = Object.freeze({
  claim_not_bound: {
    code: "claim_resolution_required",
    retryPolicy: "never",
    message: "claim_returned nodes with a bound claim must be resolved with accept_claim or reject_claim before blocking; rejecting returns the node to delegated (a claim_returned node created WITHOUT a bound claim blocks freely)",
  },
  claim_present: {
    code: "claim_required",
    retryPolicy: "after_context_change",
    message: "state carries no canonical claim binding; a returned claim (claimHash, attemptId, validationPolicy) must exist before it can be accepted or rejected",
  },
  claim_hash_valid: {
    code: "claim_hash_invalid",
    retryPolicy: "fix_input",
    message: "claimHash must be an exact full 64-character lowercase hex sha256; truncated, padded, uppercase, or non-hex hashes are rejected",
  },
  claim_hash_matches: {
    code: "claim_hash_mismatch",
    retryPolicy: "fix_input",
    message: "claimHash does not match the bound claim hash",
  },
  claim_attempt_present: {
    code: "claim_attempt_required",
    retryPolicy: "fix_input",
    message: "attemptId is required so the claim resolution binds the exact delegation attempt",
  },
  claim_attempt_matches: {
    code: "claim_attempt_mismatch",
    retryPolicy: "fix_input",
    message: "attemptId does not match the bound claim attempt",
  },
  validation_policy_present: {
    code: "validation_policy_required",
    retryPolicy: "fix_input",
    message: "validationPolicy must be parent_review or oracle_required",
  },
  validation_policy_matches: {
    code: "claim_policy_mismatch",
    retryPolicy: "fix_input",
    message: "validationPolicy does not echo the launch-fixed claim validation policy",
  },
  reason_present: {
    code: "reason_required",
    retryPolicy: "fix_input",
    message: "a non-empty reason string is required for block, skip, and reopen",
  },
  user_resolved: {
    code: "user_resolution_required",
    retryPolicy: "fix_input",
    message: "needs_user nodes require userResolved=true before they can be completed or skipped",
  },
});

// ---------------------------------------------------------------------------
// Engine functions
// ---------------------------------------------------------------------------

export interface GoalTodoTransitionAuthorization {
  readonly allowed: true;
  readonly fromStatus: GoalTodoStatus;
  readonly action: GoalTodoAction;
  readonly nextStatus: GoalTodoStatus;
  readonly code: "transition_allowed";
  readonly requiredGuards: readonly GoalTodoGuard[];
}

export interface GoalTodoTransitionRejection {
  readonly allowed: false;
  readonly fromStatus: GoalTodoStatus;
  readonly action: GoalTodoAction;
  readonly code: GoalTodoRejectionCode;
  readonly message: string;
  readonly retryPolicy: GoalTodoRetryPolicy;
}

export type GoalTodoTransitionDecision = GoalTodoTransitionAuthorization | GoalTodoTransitionRejection;

function isGoalTodoStatus(value: unknown): value is GoalTodoStatus {
  return (GOAL_TODO_STATUSES as readonly string[]).includes(value as string);
}

function isGoalTodoAction(value: unknown): value is GoalTodoAction {
  return (GOAL_TODO_ACTIONS as readonly string[]).includes(value as string);
}

/**
 * Pure authorization: reads TRANSITIONS, then evaluates the rule's ordered
 * guards and returns the first failure as an exact rejection code. Never
 * mutates anything and never performs I/O.
 */
export function authorizeGoalTodoTransition(
  state: GoalTodoTransitionState,
  action: GoalTodoAction,
  input: GoalTodoTransitionInput = {},
): GoalTodoTransitionDecision {
  const fromStatus = state.status;
  if (!isGoalTodoStatus(fromStatus)) {
    return {
      allowed: false,
      fromStatus,
      action,
      code: "unknown_status",
      message: `unknown GoalTodoStatus: ${String(fromStatus)}`,
      retryPolicy: "never",
    };
  }
  if (!isGoalTodoAction(action)) {
    return {
      allowed: false,
      fromStatus,
      action,
      code: "unknown_action",
      message: `unknown GoalTodoAction: ${String(action)}`,
      retryPolicy: "never",
    };
  }

  const rule = TRANSITIONS[fromStatus][action];
  if (!rule.allowed) {
    return { allowed: false, fromStatus, action, code: rule.code, message: rule.message, retryPolicy: rule.retryPolicy };
  }

  const failedGuard = rule.requiredGuards.find((guard) => !guardPasses(state, input, guard));
  if (failedGuard) {
    const failure = GUARD_FAILURES[failedGuard];
    return { allowed: false, fromStatus, action, code: failure.code, message: failure.message, retryPolicy: failure.retryPolicy };
  }

  return {
    allowed: true,
    fromStatus,
    action,
    nextStatus: rule.nextStatus,
    code: "transition_allowed",
    requiredGuards: rule.requiredGuards,
  };
}

/** Effects are data describing what the applied transition means downstream. */
export interface GoalTodoTransitionEffects {
  readonly autoResolved?: "complete";
  readonly completed?: true;
  readonly requiredCompleted?: true;
  readonly claimAccepted?: true;
  readonly acceptedClaimHash?: string;
  readonly acceptedAttemptId?: string;
  readonly claimRejected?: true;
  readonly rejectedClaimHash?: string;
  readonly rejectedAttemptId?: string;
  readonly validationPolicy?: GoalTodoClaimValidationPolicy;
  readonly blocked?: true;
  readonly blockerReason?: string;
  readonly skipped?: true;
  readonly requiredSkipped?: true;
  readonly skipReason?: string;
  readonly reopened?: true;
  readonly reopenReason?: string;
  readonly reopenedFrom?: GoalTodoStatus;
}

export type GoalTodoTransitionResult =
  | {
    readonly ok: true;
    readonly fromStatus: GoalTodoStatus;
    readonly action: GoalTodoAction;
    readonly nextStatus: GoalTodoStatus;
    readonly code: "transition_allowed";
    readonly effects: GoalTodoTransitionEffects;
  }
  | {
    readonly ok: false;
    readonly fromStatus: GoalTodoStatus;
    readonly action: GoalTodoAction;
    readonly code: GoalTodoRejectionCode;
    readonly message: string;
    readonly retryPolicy: GoalTodoRetryPolicy;
  };

function buildEffects(
  state: GoalTodoTransitionState,
  action: GoalTodoAction,
  input: GoalTodoTransitionInput,
): GoalTodoTransitionEffects {
  const required = state.required === true;
  switch (action) {
    case "auto":
      return { autoResolved: "complete", completed: true, ...(required ? { requiredCompleted: true as const } : {}) };
    case "complete":
      return { completed: true, ...(required ? { requiredCompleted: true as const } : {}) };
    case "accept_claim":
      return {
        claimAccepted: true,
        acceptedClaimHash: input.claimHash,
        acceptedAttemptId: input.attemptId,
        validationPolicy: input.validationPolicy,
      };
    case "reject_claim":
      return {
        claimRejected: true,
        rejectedClaimHash: input.claimHash,
        rejectedAttemptId: input.attemptId,
        validationPolicy: input.validationPolicy,
      };
    case "block":
      return { blocked: true, blockerReason: input.reason };
    case "skip":
      return { skipped: true, skipReason: input.reason, ...(required ? { requiredSkipped: true as const } : {}) };
    case "reopen":
      return { reopened: true, reopenReason: input.reason, reopenedFrom: state.status };
  }
}

/**
 * Pure application: authorize, then describe the outcome as data —
 * { ok: true, nextStatus, effects } or { ok: false, code, message, retryPolicy }.
 * Applying the nextStatus to a stored node is the store layer's job (2c+).
 */
export function applyGoalTodoTransition(
  state: GoalTodoTransitionState,
  action: GoalTodoAction,
  input: GoalTodoTransitionInput = {},
): GoalTodoTransitionResult {
  const decision = authorizeGoalTodoTransition(state, action, input);
  if (!decision.allowed) {
    return {
      ok: false,
      fromStatus: decision.fromStatus,
      action: decision.action,
      code: decision.code,
      message: decision.message,
      retryPolicy: decision.retryPolicy,
    };
  }
  return Object.freeze({
    ok: true as const,
    fromStatus: decision.fromStatus,
    action: decision.action,
    nextStatus: decision.nextStatus,
    code: decision.code,
    effects: Object.freeze(buildEffects(state, decision.action, input)),
  });
}

// ---------------------------------------------------------------------------
// Introspection for docs and tests
// ---------------------------------------------------------------------------

export type GoalTodoTransitionOutcomeCode = "transition_allowed" | GoalTodoTableRejectionCode;

export interface GoalTodoTransitionDescriptor {
  readonly status: GoalTodoStatus;
  readonly action: GoalTodoAction;
  readonly allowed: boolean;
  readonly nextStatus?: GoalTodoStatus;
  readonly code: GoalTodoTransitionOutcomeCode;
  readonly requiredGuards: readonly GoalTodoGuard[];
  readonly message?: string;
  readonly retryPolicy?: GoalTodoRetryPolicy;
}

/** Full 11 × 7 = 77 entry matrix straight from TRANSITIONS, for docs/tests. */
export function describeGoalTodoTransitions(): readonly GoalTodoTransitionDescriptor[] {
  return GOAL_TODO_STATUSES.flatMap((status) =>
    GOAL_TODO_ACTIONS.map((action) => {
      const rule = TRANSITIONS[status][action];
      return rule.allowed
        ? Object.freeze({
          status,
          action,
          allowed: true,
          nextStatus: rule.nextStatus,
          code: rule.code,
          requiredGuards: Object.freeze([...rule.requiredGuards]),
        })
        : Object.freeze({
          status,
          action,
          allowed: false,
          code: rule.code,
          requiredGuards: Object.freeze([]),
          message: rule.message,
          retryPolicy: rule.retryPolicy,
        });
    }),
  );
}
