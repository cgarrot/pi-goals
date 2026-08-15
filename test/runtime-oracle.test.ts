// test/runtime-oracle.test.ts — Phase 3a oracle decision binding + freshness
// (TDD, red first).
//
// Under test: src/runtime/oracle.ts (+ type-only src/runtime/ports.ts):
// OracleDecision canonical hashing, buildOracleDecision requiring an
// already-VALIDATED proposal, validateOracleDecision recompute, the zob
// freshness code inventory WITHOUT legacy codes (proposal side and oracle
// side), the zob-parity root revision rule including the complete+1 rule,
// idempotent exact replay, and the strict-PASS composition with the 2d
// isStrictPassAutoAccept claim rule.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildGoalCompletionProposal,
  validateGoalCompletionProposal,
} from "../src/core/proposal.js";
import type { GoalCompletionProposal, GoalCompletionProposalInput, ValidatedGoalCompletionProposal } from "../src/core/proposal.js";
import { evaluateGoalTodoCompletion } from "../src/core/completion.js";
import type { GoalTodoCompletionDiagnostics } from "../src/core/completion.js";
import type { GoalTodoClaimValidationLike } from "../src/core/claims.js";
import {
  buildOracleDecision,
  composeOracleClaimAutoAccept,
  evaluateOracleFreshness,
  evaluateProposalFreshness,
  hashOracleDecision,
  isStrictPassOracleDecision,
  validateOracleDecision,
} from "../src/runtime/oracle.js";
import type { OracleDecision, OracleGoalSnapshot, OracleReviewInput } from "../src/runtime/oracle.js";
import type { OracleVerdictProvider } from "../src/runtime/ports.js";
import type { GoalTodoNode } from "../src/core/types.js";

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const OTHER_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const INPUT: GoalCompletionProposalInput = {
  goalId: "goal-1",
  goalRevision: 5,
  todoGraphRevision: 7,
  requirementsChecked: ["req-a"],
  evidenceRefs: ["evidence-1", "evidence-2"],
  validationCommands: ["npm test"],
  knownRisks: ["risk one"],
  completionSummary: "all done",
  noShip: false,
  proposedAt: "2024-01-02T03:04:05.000Z",
};
const PROPOSAL: GoalCompletionProposal = buildGoalCompletionProposal(INPUT);

function validated(): ValidatedGoalCompletionProposal {
  const result = validateGoalCompletionProposal(PROPOSAL);
  if (!result.valid) throw new Error(`fixture proposal invalid: ${result.code}`);
  return result.proposal;
}
const VALIDATED = validated();

const REVIEW: OracleReviewInput = {
  goalRevision: 5,
  verdict: "PASS",
  noShip: false,
  evidenceSummary: "oracle evidence summary",
  evidenceRefs: ["report-1", "report-2"],
  reviewedAt: "2024-01-03T04:05:06.000Z",
};
const DECISION = buildOracleDecision(VALIDATED, REVIEW);

function diagnostics(overrides: Partial<GoalTodoCompletionDiagnostics> = {}): GoalTodoCompletionDiagnostics {
  return {
    total: 2,
    requiredOpen: 0,
    completionReady: true,
    hardNoShip: false,
    reviewNoShip: false,
    effectiveNoShip: false,
    blockers: [],
    ...overrides,
  };
}

function goalSnapshot(overrides: Partial<OracleGoalSnapshot> = {}): OracleGoalSnapshot {
  return { goalId: "goal-1", revision: 5, status: "ready_for_oracle", completionProposal: PROPOSAL, ...overrides };
}

/** Rebuild a structurally valid decision with drifted fields (hash recomputed). */
function driftDecision(overrides: Partial<OracleDecision>): OracleDecision {
  const candidate = { ...DECISION, ...overrides } as OracleDecision;
  const { oracleDecisionHash: _hash, reviewedAt: _at, ...bodyFree } = candidate;
  return Object.freeze({ ...candidate, oracleDecisionHash: hashOracleDecision(bodyFree) });
}

test("decision binding requires a valid proposal: exact hashes + recompute-verify", () => {
  const tampered = { ...PROPOSAL, goalRevision: PROPOSAL.goalRevision + 1 } as unknown as ValidatedGoalCompletionProposal;
  assert.throws(() => buildOracleDecision(tampered, REVIEW), TypeError);
  const hashSwapped = { ...PROPOSAL, proposalHash: OTHER_HASH } as unknown as ValidatedGoalCompletionProposal;
  assert.throws(() => buildOracleDecision(hashSwapped, REVIEW), TypeError);
  assert.equal(DECISION.proposalHash, PROPOSAL.proposalHash);
  assert.equal(DECISION.proposalGoalRevision, PROPOSAL.goalRevision);
  assert.equal(DECISION.todoGraphRevision, PROPOSAL.todoGraphRevision);
  assert.equal(DECISION.goalRevision, REVIEW.goalRevision);
});

test("builder review gates: verdict enum, noShip boolean, evidence shape, injected ISO reviewedAt", () => {
  assert.throws(() => buildOracleDecision(VALIDATED, { ...REVIEW, verdict: "MAYBE" as never }), TypeError);
  assert.throws(() => buildOracleDecision(VALIDATED, { ...REVIEW, noShip: "no" as unknown as boolean }), TypeError);
  assert.throws(() => buildOracleDecision(VALIDATED, { ...REVIEW, goalRevision: 0 }), TypeError);
  assert.throws(() => buildOracleDecision(VALIDATED, { ...REVIEW, goalRevision: 2.5 }), TypeError);
  assert.throws(() => buildOracleDecision(VALIDATED, { ...REVIEW, evidenceSummary: 7 as unknown as string }), TypeError);
  assert.throws(() => buildOracleDecision(VALIDATED, { ...REVIEW, evidenceRefs: ["ok", 3] as unknown as readonly string[] }), TypeError);
  assert.throws(() => buildOracleDecision(VALIDATED, { ...REVIEW, reviewedAt: undefined as unknown as string }), TypeError);
  assert.throws(() => buildOracleDecision(VALIDATED, { ...REVIEW, reviewedAt: "later" }), TypeError);
});

test("decision hash: exact canonical 10-field preimage with zob-parity evidence hashing", () => {
  const preimage = JSON.stringify({
    oracleVersion: 1,
    proposalHash: PROPOSAL.proposalHash,
    proposalGoalRevision: 5,
    todoGraphRevision: 7,
    goalRevision: 5,
    verdict: "PASS",
    noShip: false,
    evidenceHash: sha256(JSON.stringify(["oracle evidence summary", "report-1", "report-2"])),
    evidenceCount: 3,
    bodyStored: false,
  });
  assert.equal(DECISION.oracleVersion, 1);
  assert.equal(DECISION.evidenceCount, REVIEW.evidenceRefs.length + 1);
  assert.equal(DECISION.bodyStored, false);
  assert.equal(DECISION.reviewedAt, REVIEW.reviewedAt);
  assert.equal(DECISION.oracleDecisionHash, sha256(preimage));
  assert.ok(Object.isFrozen(DECISION));
});

test("decision hash recompute: validateOracleDecision round-trips and rejects tamper", () => {
  const ok = validateOracleDecision(DECISION);
  assert.equal(ok.valid, true);
  if (ok.valid) assert.deepEqual(ok.decision, DECISION);

  const tampered = { ...DECISION, verdict: "WARN" as OracleDecision["verdict"] };
  const rejected = validateOracleDecision(tampered);
  assert.equal(rejected.valid, false);
  if (!rejected.valid) assert.equal(rejected.code, "decision_hash_mismatch");

  const hashSwapped = { ...DECISION, oracleDecisionHash: OTHER_HASH };
  const swapped = validateOracleDecision(hashSwapped);
  assert.equal(swapped.valid, false);
  if (!swapped.valid) assert.equal(swapped.code, "decision_hash_mismatch");

  const structural = validateOracleDecision({ ...DECISION, evidenceCount: -1 });
  assert.equal(structural.valid, false);
  if (!structural.valid) assert.equal(structural.code, "invalid_evidence_count");

  const extra = validateOracleDecision({ ...DECISION, extraField: true });
  assert.equal(extra.valid, false);
  const missing = validateOracleDecision({ goalRevision: 5 } as unknown as OracleDecision);
  assert.equal(missing.valid, false);
});

test("exact replay no-op: same inputs produce the identical decision (idempotent)", () => {
  const replay = buildOracleDecision(validated(), { ...REVIEW });
  assert.deepEqual(replay, DECISION);
  assert.equal(replay.oracleDecisionHash, DECISION.oracleDecisionHash);
  const freshnessFirst = evaluateOracleFreshness(goalSnapshot(), DECISION, 7, diagnostics());
  const freshnessReplay = evaluateOracleFreshness(goalSnapshot(), replay, 7, diagnostics());
  assert.deepEqual(freshnessFirst, freshnessReplay);
});

// ---------------------------------------------------------------------------
// evaluateProposalFreshness — zob code inventory minus legacy
// ---------------------------------------------------------------------------

test("proposal freshness: fresh on a matching ready goal (composed with 2c diagnostics)", () => {
  const node: GoalTodoNode = {
    id: "t1",
    path: "goal-1/t1",
    title: "T1",
    status: "done",
    owner: "agent",
    priority: "normal",
    required: true,
    createdAt: 1,
    updatedAt: 1,
    evidenceRefs: ["ev-1"],
  };
  const ready = evaluateGoalTodoCompletion([node]);
  assert.equal(ready.completionReady, true);
  const result = evaluateProposalFreshness(goalSnapshot(), 7, ready);
  assert.deepEqual({ status: result.status, code: result.code }, { status: "fresh", code: "fresh" });
  assert.equal(result.currentGoalRevision, 5);
  assert.equal(result.currentTodoGraphRevision, 7);
  assert.equal(result.proposalHash, PROPOSAL.proposalHash);
});

test("proposal freshness: fresh also for a completed goal whose lineage still holds", () => {
  const result = evaluateProposalFreshness(goalSnapshot({ status: "complete", revision: 6 }), 7, diagnostics());
  assert.deepEqual({ status: result.status, code: result.code }, { status: "fresh", code: "fresh" });
});

test("proposal freshness: proposal_missing when the goal carries no proposal", () => {
  const result = evaluateProposalFreshness(goalSnapshot({ completionProposal: undefined }), 7, diagnostics());
  assert.equal(result.status, "stale");
  assert.equal(result.code, "proposal_missing");
});

test("proposal freshness: malformed_snapshot for structural junk", () => {
  const malformed = { ...PROPOSAL, goalRevision: "five" as unknown as number };
  const result = evaluateProposalFreshness(goalSnapshot({ completionProposal: malformed }), 7, diagnostics());
  assert.equal(result.status, "stale");
  assert.equal(result.code, "malformed_snapshot");
});

test("proposal freshness: proposal_hash_mismatch for canonical tamper without rehash", () => {
  const tampered = { ...PROPOSAL, requirementsCount: 99 };
  const result = evaluateProposalFreshness(goalSnapshot({ completionProposal: tampered }), 7, diagnostics());
  assert.equal(result.status, "stale");
  assert.equal(result.code, "proposal_hash_mismatch");
});

test("proposal freshness: goal_identity_mismatch for a valid proposal bound to another goal", () => {
  const foreign = buildGoalCompletionProposal({ ...INPUT, goalId: "goal-other" });
  const result = evaluateProposalFreshness(goalSnapshot({ completionProposal: foreign }), 7, diagnostics());
  assert.equal(result.status, "stale");
  assert.equal(result.code, "goal_identity_mismatch");
});

test("proposal freshness: proposal_goal_revision_not_in_lineage when ahead of the root lineage", () => {
  const behind = evaluateProposalFreshness(goalSnapshot({ revision: 4 }), 7, diagnostics());
  assert.equal(behind.status, "stale");
  assert.equal(behind.code, "proposal_goal_revision_not_in_lineage");
  // zob parity: a proposal lives on the goal snapshot, so a missing goal
  // surfaces as proposal_missing (the !goal lineage branch is defensive).
  const noGoal = evaluateProposalFreshness(undefined, 7, diagnostics());
  assert.equal(noGoal.status, "stale");
  assert.equal(noGoal.code, "proposal_missing");
});

test("proposal freshness: todo_graph_revision_mismatch when the graph moved on", () => {
  const result = evaluateProposalFreshness(goalSnapshot(), 8, diagnostics());
  assert.equal(result.status, "stale");
  assert.equal(result.code, "todo_graph_revision_mismatch");
});

test("proposal freshness: completion diagnostics gates", () => {
  const noShip = evaluateProposalFreshness(goalSnapshot(), 7, diagnostics({ effectiveNoShip: true }));
  assert.deepEqual({ status: noShip.status, code: noShip.code }, { status: "stale", code: "completion_diagnostics_no_ship" });
  const notReady = evaluateProposalFreshness(goalSnapshot(), 7, diagnostics({ completionReady: false, effectiveNoShip: false }));
  assert.deepEqual({ status: notReady.status, code: notReady.code }, { status: "stale", code: "completion_diagnostics_not_ready" });
});

test("proposal freshness: goal_status_not_oracle_ready and safe repropose actions", () => {
  const active = evaluateProposalFreshness(goalSnapshot({ status: "active" }), 7, diagnostics());
  assert.deepEqual({ status: active.status, code: active.code }, { status: "stale", code: "goal_status_not_oracle_ready" });
  assert.equal(active.safeReproposeAction, "propose_goal_completion");
  const paused = evaluateProposalFreshness(goalSnapshot({ status: "paused" }), 7, diagnostics());
  assert.equal(paused.safeReproposeAction, "resume_goal_then_propose_goal_completion");
  const blockedTodos = evaluateProposalFreshness(goalSnapshot({ status: "active" }), 7, diagnostics({ effectiveNoShip: true }));
  assert.equal(blockedTodos.safeReproposeAction, "resolve_goal_todos_then_propose_goal_completion");
});

// ---------------------------------------------------------------------------
// evaluateOracleFreshness — binding mismatch matrix + zob parity rules
// ---------------------------------------------------------------------------

test("oracle freshness: fresh with safeNextAction none", () => {
  const result = evaluateOracleFreshness(goalSnapshot(), DECISION, 7, diagnostics());
  assert.deepEqual({ status: result.status, code: result.code }, { status: "fresh", code: "fresh" });
  assert.equal(result.safeNextAction, "none");
  assert.equal(result.oracleDecisionHash, DECISION.oracleDecisionHash);
  assert.equal(result.currentGoalRevision, 5);
  assert.equal(result.oracleGoalRevision, 5);
});

test("oracle freshness: oracle_binding_missing when no decision exists", () => {
  const result = evaluateOracleFreshness(goalSnapshot(), undefined, 7, diagnostics());
  assert.equal(result.status, "missing");
  assert.equal(result.code, "oracle_binding_missing");
  assert.equal(result.safeNextAction, "record_goal_oracle");
});

test("oracle freshness: malformed_snapshot for structural junk", () => {
  const malformed = { ...DECISION, verdict: "MAYBE" as OracleDecision["verdict"] };
  const result = evaluateOracleFreshness(goalSnapshot(), malformed, 7, diagnostics());
  assert.equal(result.status, "stale");
  assert.equal(result.code, "malformed_snapshot");
});

test("oracle freshness: oracle_decision_hash_mismatch for decision tamper without rehash", () => {
  const tampered = { ...DECISION, evidenceCount: 99 };
  const result = evaluateOracleFreshness(goalSnapshot(), tampered, 7, diagnostics());
  assert.equal(result.status, "stale");
  assert.equal(result.code, "oracle_decision_hash_mismatch");
});

test("oracle freshness: proposal_binding_mismatch on proposalHash drift or missing proposal", () => {
  const otherProposal = buildGoalCompletionProposal({ ...INPUT, evidenceRefs: ["different-evidence"] });
  const drifted = evaluateOracleFreshness(goalSnapshot({ completionProposal: otherProposal }), DECISION, 7, diagnostics());
  assert.deepEqual({ status: drifted.status, code: drifted.code }, { status: "stale", code: "proposal_binding_mismatch" });
  const absent = evaluateOracleFreshness(goalSnapshot({ completionProposal: undefined }), DECISION, 7, diagnostics());
  assert.deepEqual({ status: absent.status, code: absent.code }, { status: "stale", code: "proposal_binding_mismatch" });
});

test("oracle freshness: proposal_goal_revision_mismatch on binding drift", () => {
  const result = evaluateOracleFreshness(goalSnapshot(), driftDecision({ proposalGoalRevision: 4 }), 7, diagnostics());
  assert.equal(result.status, "stale");
  assert.equal(result.code, "proposal_goal_revision_mismatch");
});

test("oracle freshness: todo_graph_revision_mismatch on drift vs proposal and vs current graph", () => {
  const vsProposal = evaluateOracleFreshness(goalSnapshot(), driftDecision({ todoGraphRevision: 6 }), 7, diagnostics());
  assert.deepEqual({ status: vsProposal.status, code: vsProposal.code }, { status: "stale", code: "todo_graph_revision_mismatch" });
  const vsCurrent = evaluateOracleFreshness(goalSnapshot(), DECISION, 8, diagnostics());
  assert.deepEqual({ status: vsCurrent.status, code: vsCurrent.code }, { status: "stale", code: "todo_graph_revision_mismatch" });
});

test("oracle freshness: root_revision_mismatch including the complete+1 rule", () => {
  const behind = evaluateOracleFreshness(goalSnapshot({ revision: 4 }), DECISION, 7, diagnostics());
  assert.deepEqual({ status: behind.status, code: behind.code }, { status: "stale", code: "root_revision_mismatch" });
  const completeWithoutBump = evaluateOracleFreshness(goalSnapshot({ status: "complete", revision: 5 }), DECISION, 7, diagnostics());
  assert.deepEqual(
    { status: completeWithoutBump.status, code: completeWithoutBump.code },
    { status: "stale", code: "root_revision_mismatch" },
  );
  const completeWithBump = evaluateOracleFreshness(goalSnapshot({ status: "complete", revision: 6 }), DECISION, 7, diagnostics());
  assert.deepEqual({ status: completeWithBump.status, code: completeWithBump.code }, { status: "fresh", code: "fresh" });
});

test("oracle freshness: oracle_verdict_not_pass and oracle_no_ship", () => {
  const warn = buildOracleDecision(VALIDATED, { ...REVIEW, verdict: "WARN" });
  const warned = evaluateOracleFreshness(goalSnapshot(), warn, 7, diagnostics());
  assert.deepEqual({ status: warned.status, code: warned.code }, { status: "stale", code: "oracle_verdict_not_pass" });
  const noShip = buildOracleDecision(VALIDATED, { ...REVIEW, noShip: true });
  const shipped = evaluateOracleFreshness(goalSnapshot(), noShip, 7, diagnostics());
  assert.deepEqual({ status: shipped.status, code: shipped.code }, { status: "stale", code: "oracle_no_ship" });
});

test("oracle freshness: completion diagnostics gates and goal status gate", () => {
  const noShip = evaluateOracleFreshness(goalSnapshot(), DECISION, 7, diagnostics({ effectiveNoShip: true }));
  assert.deepEqual({ status: noShip.status, code: noShip.code }, { status: "stale", code: "completion_diagnostics_no_ship" });
  const notReady = evaluateOracleFreshness(goalSnapshot(), DECISION, 7, diagnostics({ completionReady: false, effectiveNoShip: false }));
  assert.deepEqual({ status: notReady.status, code: notReady.code }, { status: "stale", code: "completion_diagnostics_not_ready" });
  const active = evaluateOracleFreshness(goalSnapshot({ status: "active" }), DECISION, 7, diagnostics());
  assert.deepEqual({ status: active.status, code: active.code }, { status: "stale", code: "goal_status_not_oracle_ready" });
  assert.equal(active.safeNextAction, "propose_goal_completion_then_record_goal_oracle");
});

// ---------------------------------------------------------------------------
// Strict-PASS composition with the 2d claim rule + injectable port
// ---------------------------------------------------------------------------

test("strict-PASS composition with 2d isStrictPassAutoAccept", () => {
  const strictClaim: GoalTodoClaimValidationLike = { verdict: "PASS", recommendedAction: "accept_claim", noShip: false, confidence: "HIGH" };
  const accepted = composeOracleClaimAutoAccept(DECISION, strictClaim);
  assert.equal(accepted.oracleStrictPass, true);
  assert.equal(accepted.autoAccept, true);
  assert.equal(accepted.outcome, "accept");
  assert.deepEqual([...accepted.failures], []);

  const failDecision = buildOracleDecision(VALIDATED, { ...REVIEW, verdict: "FAIL" });
  const blockedByOracle = composeOracleClaimAutoAccept(failDecision, strictClaim);
  assert.equal(blockedByOracle.oracleStrictPass, false);
  assert.equal(blockedByOracle.autoAccept, false);
  assert.equal(blockedByOracle.outcome, "needs_review");

  const weakClaim: GoalTodoClaimValidationLike = { verdict: "PASS", recommendedAction: "accept_claim", noShip: false, confidence: "LOW" };
  const blockedByClaim = composeOracleClaimAutoAccept(DECISION, weakClaim);
  assert.equal(blockedByClaim.oracleStrictPass, true);
  assert.equal(blockedByClaim.autoAccept, false);
  assert.deepEqual([...blockedByClaim.failures], ["confidence"]);

  const tamperedDecision = { ...DECISION, verdict: "FAIL" } as OracleDecision;
  assert.equal(isStrictPassOracleDecision(tamperedDecision), false);
  assert.equal(isStrictPassOracleDecision(DECISION), true);
  assert.equal(isStrictPassOracleDecision(undefined), false);
});

test("ports: OracleVerdictProvider is an injectable type-only port", () => {
  const stub: OracleVerdictProvider = {
    review: async (proposal, diag) => ({
      goalRevision: proposal.goalRevision,
      verdict: "PASS",
      noShip: false,
      evidenceSummary: `diagnostics total=${diag.total}`,
      evidenceRefs: [],
      reviewedAt: "2024-01-04T05:06:07.000Z",
    }),
  };
  assert.equal(typeof stub.review, "function");
});
