// src/runtime/oracle.ts — Phase 3a oracle decision binding + freshness.
//
// Distilled (read-only) from zob-harness:
//   - .pi/extensions/zob-harness/src/runtime/goal-runtime/state.ts
//     (hashRuntimeGoalOracleEvidence / canonicalOracleDecisionHashFields /
//      hashRuntimeGoalOracleDecision / buildRuntimeGoalOracleBinding /
//      isRuntimeGoalOracleBindingV2 / evaluateRuntimeGoalCompletionProposalFreshness /
//      evaluateRuntimeGoalOracleFreshness — with every legacyUnbound /
//      malformed / compatibility branch stripped).
//   - .pi/extensions/zob-harness/src/domains/goal/goal-todos.ts for the
//     completion diagnostics shape mirrored in Phase 2c.
//
// Rework decisions ("en mieux", deliberate deviations documented for review):
//   D-O1 single strict v1 schema: zob's oracleVersion 2 becomes 1 here; the
//      required/status compat fields and the non-enumerable evidenceRefs
//      array are gone (passed/failed is derived: verdict === "PASS" &&
//      noShip === false); blocker summaries are Phase 4 side state, not
//      decision fields.
//   D-O2 the decision is standalone plain data: zob bound it inside
//      goal.oracle state; evaluateOracleFreshness takes the decision
//      explicitly so the store (3b) and runtime goal (Phase 4) inject it.
//   D-O3 freshness code inventory = zob MINUS legacy (no legacy_unbound) and
//      minus the zob store restore codes (goal_restore_blocked /
//      todo_restore_blocked — restore quarantine is a store concern, not an
//      oracle-freshness concern). oracle_binding_missing (missing decision)
//      and malformed_snapshot (decision/proposal failing strict validation)
//      are kept: both are non-legacy zob codes.
//   D-O4 root revision rule is zob parity exactly: expected current root
//      revision = goal.status === "complete" ? decision.goalRevision + 1 :
//      decision.goalRevision (the complete+1 rule).
//   D-O5 strict-PASS composition: a decision only counts as a strict oracle
//      PASS when it strictly validates AND is verdict PASS with noShip false;
//      composeOracleClaimAutoAccept ANDs that gate with the 2d
//      isStrictPassAutoAccept claim rule for auto-accept routing.
//   D-O6 hash tampering is its own exact code: zob folded canonical-field
//      tamper into malformed_snapshot via its isV2 gate (the explicit
//      *_hash_mismatch branches were unreachable there); the strict
//      validators recompute last, so oracle_decision_hash_mismatch and
//      proposal_hash_mismatch are live, precise codes and malformed_snapshot
//      stays reserved for structural junk.
//   D-O7 reviewedAt is a required injected ISO timestamp (zob defaulted to
//      the wall clock; purity contract forbids clock access).
//
// Purity contract: no node imports at all (hashing comes from
// src/core/proposal.js, which uses node:crypto createHash only); no
// fs/os/env/clock/random — reviewedAt arrives as an injected parameter and
// every function returns new frozen data without mutating its input.

import { goalCompletionProposalHash, isIsoTimestamp, isRecordValue, isSafeIntegerAtLeast, isSha256Hex, sha256Hex, validateGoalCompletionProposal } from "../core/proposal.js";
import type { GoalCompletionProposal, ValidatedGoalCompletionProposal } from "../core/proposal.js";
import type { GoalTodoCompletionDiagnostics } from "../core/completion.js";
import { isStrictPassAutoAccept } from "../core/claims.js";
import type { GoalTodoAutoAcceptDimension, GoalTodoClaimValidationLike } from "../core/claims.js";

export const ORACLE_VERSION = 1;

export type OracleVerdict = "PASS" | "WARN" | "FAIL";
const ORACLE_VERDICTS = new Set<unknown>(["PASS", "WARN", "FAIL"]);

/** zob runtime goal status vocabulary the freshness gates operate over. */
export type OracleGoalStatus =
  | "active"
  | "ready_for_oracle"
  | "oracle_failed"
  | "paused"
  | "blocked"
  | "budget_limited"
  | "complete";

/**
 * Minimal goal snapshot freshness needs: identity (goalId), lineage root
 * (revision), lifecycle (status), and the stored completion proposal. The
 * Phase 4 runtime goal satisfies this structurally.
 */
export interface OracleGoalSnapshot {
  readonly goalId: string;
  readonly revision: number;
  readonly status: OracleGoalStatus;
  readonly completionProposal?: GoalCompletionProposal;
}

/** Oracle review result injected into buildOracleDecision (reviewedAt injected, D-O7). */
export interface OracleReviewInput {
  readonly goalRevision: number;
  readonly verdict: OracleVerdict;
  readonly noShip: boolean;
  readonly evidenceSummary: string;
  readonly evidenceRefs: readonly string[];
  readonly reviewedAt: string;
}

export interface OracleDecision {
  readonly oracleVersion: 1;
  readonly oracleDecisionHash: string;
  readonly proposalHash: string;
  readonly proposalGoalRevision: number;
  readonly todoGraphRevision: number;
  readonly goalRevision: number;
  readonly verdict: OracleVerdict;
  readonly noShip: boolean;
  readonly evidenceHash: string;
  readonly evidenceCount: number;
  readonly reviewedAt: string;
  readonly bodyStored: false;
}

/** Body-free decision shape the canonical hash runs over. */
export type OracleDecisionHashBody = Omit<OracleDecision, "oracleDecisionHash" | "reviewedAt">;

/** zob parity: sha256 over JSON [evidenceSummary, ...evidenceRefs]. */
export function hashOracleEvidence(evidenceSummary: string, evidenceRefs: readonly string[]): string {
  return sha256Hex(JSON.stringify([evidenceSummary, ...evidenceRefs]));
}

/**
 * Canonical decisionHash preimage: EXACTLY the 10 body-free fields —
 * oracleVersion, proposalHash, proposalGoalRevision, todoGraphRevision,
 * goalRevision, verdict, noShip, evidenceHash, evidenceCount, bodyStored —
 * serialized as a fixed-order JSON literal. reviewedAt is intentionally NOT
 * hashed.
 */
function canonicalOracleDecisionHashFields(decision: OracleDecisionHashBody): Record<string, unknown> {
  return {
    oracleVersion: ORACLE_VERSION,
    proposalHash: decision.proposalHash,
    proposalGoalRevision: decision.proposalGoalRevision,
    todoGraphRevision: decision.todoGraphRevision,
    goalRevision: decision.goalRevision,
    verdict: decision.verdict,
    noShip: decision.noShip,
    evidenceHash: decision.evidenceHash,
    evidenceCount: decision.evidenceCount,
    bodyStored: false as const,
  };
}

export function hashOracleDecision(decision: OracleDecisionHashBody): string {
  return sha256Hex(JSON.stringify(canonicalOracleDecisionHashFields(decision)));
}

const DECISION_KEYS: readonly string[] = Object.freeze([
  "oracleVersion",
  "oracleDecisionHash",
  "proposalHash",
  "proposalGoalRevision",
  "todoGraphRevision",
  "goalRevision",
  "verdict",
  "noShip",
  "evidenceHash",
  "evidenceCount",
  "reviewedAt",
  "bodyStored",
]);
const DECISION_KEY_SET = new Set<string>(DECISION_KEYS);

export type OracleDecisionValidationCode =
  | "not_a_record"
  | "missing_fields"
  | "unexpected_fields"
  | "invalid_oracle_version"
  | "invalid_decision_hash"
  | "invalid_proposal_hash"
  | "invalid_evidence_hash"
  | "invalid_revision"
  | "invalid_evidence_count"
  | "invalid_verdict"
  | "invalid_no_ship"
  | "invalid_reviewed_at"
  | "invalid_body_stored"
  | "decision_hash_mismatch";

export type OracleDecisionValidation =
  | { readonly valid: true; readonly decision: OracleDecision }
  | { readonly valid: false; readonly code: OracleDecisionValidationCode; readonly message: string };

function decisionInvalid(code: OracleDecisionValidationCode, message: string): OracleDecisionValidation {
  return { valid: false, code, message };
}

/**
 * Strict single-schema validator: exact 12-key record, oracleVersion 1,
 * bodyStored false, exact full sha256 hashes, safe-integer revisions
 * (proposalGoalRevision >= 1, todoGraphRevision >= 0, goalRevision >= 1,
 * evidenceCount >= 1), verdict enum, boolean noShip, parseable ISO
 * reviewedAt, and a decisionHash recompute as the final gate (D-O6).
 */
export function validateOracleDecision(value: unknown): OracleDecisionValidation {
  if (!isRecordValue(value)) return decisionInvalid("not_a_record", "oracle decision must be a plain object");
  const missing = DECISION_KEYS.filter((key) => !(key in value));
  if (missing.length > 0) return decisionInvalid("missing_fields", `missing fields: ${missing.join(", ")}`);
  const unexpected = Object.keys(value).filter((key) => !DECISION_KEY_SET.has(key));
  if (unexpected.length > 0) return decisionInvalid("unexpected_fields", `unexpected fields: ${unexpected.join(", ")}`);
  if (value.oracleVersion !== ORACLE_VERSION) return decisionInvalid("invalid_oracle_version", "oracleVersion must be exactly 1");
  if (!isSha256Hex(value.oracleDecisionHash)) return decisionInvalid("invalid_decision_hash", "oracleDecisionHash must be an exact full 64-character lowercase hex sha256");
  if (!isSha256Hex(value.proposalHash)) return decisionInvalid("invalid_proposal_hash", "proposalHash must be an exact full 64-character lowercase hex sha256");
  if (!isSha256Hex(value.evidenceHash)) return decisionInvalid("invalid_evidence_hash", "evidenceHash must be an exact full 64-character lowercase hex sha256");
  if (!isSafeIntegerAtLeast(value.proposalGoalRevision, 1)) return decisionInvalid("invalid_revision", "proposalGoalRevision must be a safe integer >= 1");
  if (!isSafeIntegerAtLeast(value.todoGraphRevision, 0)) return decisionInvalid("invalid_revision", "todoGraphRevision must be a safe integer >= 0");
  if (!isSafeIntegerAtLeast(value.goalRevision, 1)) return decisionInvalid("invalid_revision", "goalRevision must be a safe integer >= 1");
  if (!isSafeIntegerAtLeast(value.evidenceCount, 1)) return decisionInvalid("invalid_evidence_count", "evidenceCount must be a safe integer >= 1");
  if (!ORACLE_VERDICTS.has(value.verdict)) return decisionInvalid("invalid_verdict", "verdict must be PASS, WARN, or FAIL");
  if (typeof value.noShip !== "boolean") return decisionInvalid("invalid_no_ship", "noShip must be a boolean");
  if (!isIsoTimestamp(value.reviewedAt)) return decisionInvalid("invalid_reviewed_at", "reviewedAt must be a parseable ISO timestamp");
  if (value.bodyStored !== false) return decisionInvalid("invalid_body_stored", "bodyStored must be exactly false");
  const canonical: OracleDecisionHashBody = {
    oracleVersion: ORACLE_VERSION,
    proposalHash: value.proposalHash,
    proposalGoalRevision: value.proposalGoalRevision,
    todoGraphRevision: value.todoGraphRevision,
    goalRevision: value.goalRevision,
    verdict: value.verdict as OracleVerdict,
    noShip: value.noShip,
    evidenceHash: value.evidenceHash,
    evidenceCount: value.evidenceCount,
    bodyStored: false,
  };
  const expected = hashOracleDecision(canonical);
  if (value.oracleDecisionHash !== expected) {
    return decisionInvalid("decision_hash_mismatch", "oracleDecisionHash does not match the canonical recompute over the 10 body-free fields");
  }
  const decision = Object.freeze({ ...canonical, oracleDecisionHash: expected, reviewedAt: value.reviewedAt });
  return { valid: true, decision };
}

/**
 * Bind an oracle decision to an ALREADY-VALIDATED proposal. The proposal is
 * re-validated at runtime (exact hashes + recompute-verify) so even JS
 * callers cannot smuggle a tampered proposal past the type brand. Gates:
 * safe-integer goalRevision >= 1, verdict enum, boolean noShip, string
 * evidence summary + refs, injected ISO reviewedAt (D-O7). The decision
 * inherits proposalHash / proposalGoalRevision / todoGraphRevision from the
 * proposal exactly; evidenceCount = evidenceRefs.length + 1 (the summary
 * counts, zob parity).
 */
export function buildOracleDecision(proposal: ValidatedGoalCompletionProposal, review: OracleReviewInput): OracleDecision {
  const validated = validateGoalCompletionProposal(proposal);
  if (!validated.valid) {
    throw new TypeError("oracle decision requires an exact validated proposal (strict validation or proposalHash recompute failed)");
  }
  if (!isSafeIntegerAtLeast(review.goalRevision, 1)) {
    throw new TypeError("oracle decision goalRevision must be a safe integer >= 1");
  }
  if (!ORACLE_VERDICTS.has(review.verdict)) {
    throw new TypeError("oracle decision verdict must be PASS, WARN, or FAIL");
  }
  if (typeof review.noShip !== "boolean") {
    throw new TypeError("oracle decision noShip must be a boolean");
  }
  if (typeof review.evidenceSummary !== "string") {
    throw new TypeError("oracle decision evidenceSummary must be a string");
  }
  if (!Array.isArray(review.evidenceRefs) || review.evidenceRefs.some((ref) => typeof ref !== "string")) {
    throw new TypeError("oracle decision evidenceRefs must be an array of strings");
  }
  if (!isIsoTimestamp(review.reviewedAt)) {
    throw new TypeError("oracle decision reviewedAt must be an injected ISO timestamp");
  }
  const bodyFree: OracleDecisionHashBody = {
    oracleVersion: ORACLE_VERSION,
    proposalHash: validated.proposal.proposalHash,
    proposalGoalRevision: validated.proposal.goalRevision,
    todoGraphRevision: validated.proposal.todoGraphRevision,
    goalRevision: review.goalRevision,
    verdict: review.verdict,
    noShip: review.noShip,
    evidenceHash: hashOracleEvidence(review.evidenceSummary, review.evidenceRefs),
    evidenceCount: review.evidenceRefs.length + 1,
    bodyStored: false,
  };
  return Object.freeze({ ...bodyFree, oracleDecisionHash: hashOracleDecision(bodyFree), reviewedAt: review.reviewedAt });
}

// ---------------------------------------------------------------------------
// Freshness — zob code inventory minus legacy (D-O3)
// ---------------------------------------------------------------------------

export type SafeReproposeAction =
  | "resolve_goal_todos_then_propose_goal_completion"
  | "propose_goal_completion"
  | "resume_goal_then_propose_goal_completion";

export type SafeOracleNextAction =
  | "none"
  | "resolve_goal_todos_then_propose_goal_completion"
  | "record_goal_oracle"
  | "propose_goal_completion_then_record_goal_oracle"
  | "resume_goal_then_propose_goal_completion";

/**
 * Proposal freshness codes (zob inventory minus legacy/restore):
 * proposal_missing, malformed_snapshot, goal_identity_mismatch,
 * proposal_hash_mismatch, proposal_goal_revision_not_in_lineage,
 * todo_graph_revision_mismatch, completion_diagnostics_no_ship,
 * completion_diagnostics_not_ready, goal_status_not_oracle_ready, fresh.
 */
export type GoalCompletionProposalFreshnessCode =
  | "fresh"
  | "proposal_missing"
  | "malformed_snapshot"
  | "goal_identity_mismatch"
  | "proposal_hash_mismatch"
  | "proposal_goal_revision_not_in_lineage"
  | "todo_graph_revision_mismatch"
  | "completion_diagnostics_no_ship"
  | "completion_diagnostics_not_ready"
  | "goal_status_not_oracle_ready";

export interface GoalCompletionProposalFreshness {
  readonly status: "fresh" | "stale";
  readonly code: GoalCompletionProposalFreshnessCode;
  readonly currentGoalRevision?: number;
  readonly currentTodoGraphRevision: number;
  readonly proposalHash?: string;
  readonly proposalGoalRevision?: number;
  readonly proposalTodoGraphRevision?: number;
  readonly safeReproposeAction: SafeReproposeAction;
}

/**
 * Oracle freshness codes (zob inventory minus legacy/restore):
 * oracle_binding_missing, malformed_snapshot, oracle_decision_hash_mismatch,
 * proposal_binding_mismatch, proposal_goal_revision_mismatch,
 * todo_graph_revision_mismatch, root_revision_mismatch,
 * oracle_verdict_not_pass, oracle_no_ship, completion_diagnostics_no_ship,
 * completion_diagnostics_not_ready, goal_status_not_oracle_ready, fresh.
 */
export type GoalOracleFreshnessCode =
  | "fresh"
  | "oracle_binding_missing"
  | "malformed_snapshot"
  | "oracle_decision_hash_mismatch"
  | "proposal_binding_mismatch"
  | "proposal_goal_revision_mismatch"
  | "todo_graph_revision_mismatch"
  | "root_revision_mismatch"
  | "oracle_verdict_not_pass"
  | "oracle_no_ship"
  | "completion_diagnostics_no_ship"
  | "completion_diagnostics_not_ready"
  | "goal_status_not_oracle_ready";

export interface GoalOracleFreshness {
  readonly status: "fresh" | "stale" | "missing";
  readonly code: GoalOracleFreshnessCode;
  readonly currentGoalRevision?: number;
  readonly currentTodoGraphRevision: number;
  readonly oracleDecisionHash?: string;
  readonly proposalHash?: string;
  readonly proposalGoalRevision?: number;
  readonly decisionTodoGraphRevision?: number;
  readonly oracleGoalRevision?: number;
  readonly safeNextAction: SafeOracleNextAction;
}

function safeReproposeActionFor(goal: OracleGoalSnapshot | undefined, diagnostics: GoalTodoCompletionDiagnostics): SafeReproposeAction {
  if (diagnostics.effectiveNoShip || !diagnostics.completionReady) return "resolve_goal_todos_then_propose_goal_completion";
  return goal?.status === "active" || goal?.status === "ready_for_oracle"
    ? "propose_goal_completion"
    : "resume_goal_then_propose_goal_completion";
}

function safeOracleNextActionFor(
  goal: OracleGoalSnapshot | undefined,
  decision: OracleDecision | undefined,
  diagnostics: GoalTodoCompletionDiagnostics,
): SafeOracleNextAction {
  if (diagnostics.effectiveNoShip || !diagnostics.completionReady) return "resolve_goal_todos_then_propose_goal_completion";
  if (goal?.status === "oracle_failed" || goal?.status === "blocked" || goal?.status === "paused") {
    return "resume_goal_then_propose_goal_completion";
  }
  if (!decision) return goal?.completionProposal ? "record_goal_oracle" : "propose_goal_completion_then_record_goal_oracle";
  return "propose_goal_completion_then_record_goal_oracle";
}

/**
 * Is the goal's stored completion proposal still fresh? zob gate order:
 * presence → strict validation (structural junk → malformed_snapshot, hash
 * tamper → proposal_hash_mismatch) → identity → lineage → todo graph →
 * completion diagnostics → goal status.
 */
export function evaluateProposalFreshness(
  goal: OracleGoalSnapshot | undefined,
  todoGraphRevision: number,
  completionDiagnostics: GoalTodoCompletionDiagnostics,
): GoalCompletionProposalFreshness {
  const base = {
    currentGoalRevision: goal?.revision,
    currentTodoGraphRevision: todoGraphRevision,
    safeReproposeAction: safeReproposeActionFor(goal, completionDiagnostics),
  };
  const raw = goal?.completionProposal;
  if (raw === undefined) return { ...base, status: "stale", code: "proposal_missing" };
  const binding = {
    proposalHash: (raw as GoalCompletionProposal).proposalHash,
    proposalGoalRevision: (raw as GoalCompletionProposal).goalRevision,
    proposalTodoGraphRevision: (raw as GoalCompletionProposal).todoGraphRevision,
  };
  const validated = validateGoalCompletionProposal(raw);
  if (!validated.valid) {
    return {
      ...base,
      ...binding,
      status: "stale",
      code: validated.code === "proposal_hash_mismatch" ? "proposal_hash_mismatch" : "malformed_snapshot",
    };
  }
  if (validated.proposal.goalId !== goal?.goalId) return { ...base, ...binding, status: "stale", code: "goal_identity_mismatch" };
  if (!goal || validated.proposal.goalRevision < 1 || validated.proposal.goalRevision > goal.revision) {
    return { ...base, ...binding, status: "stale", code: "proposal_goal_revision_not_in_lineage" };
  }
  if (validated.proposal.todoGraphRevision !== todoGraphRevision) {
    return { ...base, ...binding, status: "stale", code: "todo_graph_revision_mismatch" };
  }
  if (completionDiagnostics.effectiveNoShip) return { ...base, ...binding, status: "stale", code: "completion_diagnostics_no_ship" };
  if (!completionDiagnostics.completionReady) return { ...base, ...binding, status: "stale", code: "completion_diagnostics_not_ready" };
  if (goal.status !== "ready_for_oracle" && goal.status !== "complete") {
    return { ...base, ...binding, status: "stale", code: "goal_status_not_oracle_ready" };
  }
  return { ...base, ...binding, status: "fresh", code: "fresh" };
}

/**
 * Is the oracle decision still fresh against the goal, its stored proposal,
 * the current todo graph, and the completion diagnostics? zob gate order:
 * presence → strict validation → decision hash recompute → proposal binding
 * → revision bindings → root revision (complete+1 rule, D-O4) → verdict →
 * noShip → diagnostics → goal status.
 */
export function evaluateOracleFreshness(
  goal: OracleGoalSnapshot | undefined,
  decision: OracleDecision | undefined,
  todoGraphRevision: number,
  completionDiagnostics: GoalTodoCompletionDiagnostics,
): GoalOracleFreshness {
  const base = {
    currentGoalRevision: goal?.revision,
    currentTodoGraphRevision: todoGraphRevision,
    safeNextAction: safeOracleNextActionFor(goal, decision, completionDiagnostics),
  };
  if (!decision) return { ...base, status: "missing", code: "oracle_binding_missing" };
  const binding = {
    oracleDecisionHash: decision.oracleDecisionHash,
    proposalHash: decision.proposalHash,
    proposalGoalRevision: decision.proposalGoalRevision,
    decisionTodoGraphRevision: decision.todoGraphRevision,
    oracleGoalRevision: decision.goalRevision,
  };
  const validatedDecision = validateOracleDecision(decision);
  if (!validatedDecision.valid) {
    return {
      ...base,
      ...binding,
      status: "stale",
      code: validatedDecision.code === "decision_hash_mismatch" ? "oracle_decision_hash_mismatch" : "malformed_snapshot",
    };
  }
  const storedProposal = goal?.completionProposal;
  const validatedProposal = storedProposal === undefined ? undefined : validateGoalCompletionProposal(storedProposal);
  if (!validatedProposal?.valid || decision.proposalHash !== validatedProposal.proposal.proposalHash) {
    return { ...base, ...binding, status: "stale", code: "proposal_binding_mismatch" };
  }
  if (decision.proposalGoalRevision !== validatedProposal.proposal.goalRevision) {
    return { ...base, ...binding, status: "stale", code: "proposal_goal_revision_mismatch" };
  }
  if (decision.todoGraphRevision !== validatedProposal.proposal.todoGraphRevision || decision.todoGraphRevision !== todoGraphRevision) {
    return { ...base, ...binding, status: "stale", code: "todo_graph_revision_mismatch" };
  }
  const expectedCurrentRevision = goal?.status === "complete" ? decision.goalRevision + 1 : decision.goalRevision;
  if (!goal || goal.revision !== expectedCurrentRevision) {
    return { ...base, ...binding, status: "stale", code: "root_revision_mismatch" };
  }
  if (decision.verdict !== "PASS") return { ...base, ...binding, status: "stale", code: "oracle_verdict_not_pass" };
  if (decision.noShip !== false) return { ...base, ...binding, status: "stale", code: "oracle_no_ship" };
  if (completionDiagnostics.effectiveNoShip) return { ...base, ...binding, status: "stale", code: "completion_diagnostics_no_ship" };
  if (!completionDiagnostics.completionReady) return { ...base, ...binding, status: "stale", code: "completion_diagnostics_not_ready" };
  if (goal.status !== "ready_for_oracle" && goal.status !== "complete") {
    return { ...base, ...binding, status: "stale", code: "goal_status_not_oracle_ready" };
  }
  return { ...base, ...binding, status: "fresh", code: "fresh", safeNextAction: "none" };
}

// ---------------------------------------------------------------------------
// Strict-PASS composition with the 2d claim rule (D-O5)
// ---------------------------------------------------------------------------

/**
 * Strict oracle PASS gate: the decision strictly validates (schema + hash
 * recompute) AND is verdict PASS with noShip false. WARN/FAIL/noShip/invalid
 * decisions all return false.
 */
export function isStrictPassOracleDecision(value: unknown): boolean {
  const validated = validateOracleDecision(value);
  return validated.valid && validated.decision.verdict === "PASS" && validated.decision.noShip === false;
}

export interface OracleClaimAutoAcceptComposition {
  readonly autoAccept: boolean;
  readonly outcome: "accept" | "needs_review";
  /** Failing 2d claim dimensions (empty when the claim rule accepts). */
  readonly failures: readonly GoalTodoAutoAcceptDimension[];
  /** Whether the oracle side of the composition is a strict PASS. */
  readonly oracleStrictPass: boolean;
}

/**
 * Auto-accept routing for delegated claims behind an oracle decision: the
 * 2d isStrictPassAutoAccept claim rule AND the strict oracle PASS gate must
 * BOTH accept. Either side weakening routes to parent review
 * (needs_review); the claim failures explain the claim-side downgrade and
 * oracleStrictPass explains the oracle-side one.
 */
export function composeOracleClaimAutoAccept(
  decision: unknown,
  claimValidation: GoalTodoClaimValidationLike,
): OracleClaimAutoAcceptComposition {
  const claimRule = isStrictPassAutoAccept(claimValidation);
  const oracleStrictPass = isStrictPassOracleDecision(decision);
  const autoAccept = claimRule.autoAccept && oracleStrictPass;
  return Object.freeze({
    autoAccept,
    outcome: autoAccept ? ("accept" as const) : ("needs_review" as const),
    failures: claimRule.failures,
    oracleStrictPass,
  });
}
