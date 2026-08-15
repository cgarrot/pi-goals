// test/runtime-goal.test.ts — Phase 4 TDD (red first): strict RuntimeGoal
// shape/normalize, status transition gates, pure usage accounting, defaults,
// and activation modes.
//
// Under test: src/runtime/goal.ts — the strict runtime goal vocabulary the
// Phase 4 engine composes with the 3b store. normalizeRuntimeGoal is STRICT:
// any deviation (missing/extra keys, non-canonical ids, enum drift, tampered
// 3a proposal/decision hashes) resolves to undefined. No legacy shapes are
// accepted or repaired.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GOAL_ACTIVATION_MODE,
  DEFAULT_GOAL_MAX_TURNS,
  DEFAULT_RESUME_TURN_EXTENSION,
  GOAL_ACTIVATION_MODES,
  MAX_RUNTIME_GOAL_OBJECTIVE_CHARS,
  RESUMABLE_GOAL_STATUSES,
  RUNTIME_GOAL_STATUSES,
  accountRuntimeGoalTurn,
  accountRuntimeGoalUsage,
  asGoalActivationMode,
  asRuntimeGoalStatus,
  canCreateRuntimeGoal,
  createRuntimeGoal,
  formatGoalActivationMode,
  normalizeRuntimeGoal,
  pauseRuntimeGoal,
  resumeRuntimeGoal,
  runtimeGoalToRecord,
} from "../src/runtime/goal.js";
import type { RuntimeGoal, RuntimeGoalStatus } from "../src/runtime/goal.js";
import { buildGoalCompletionProposal, validateGoalCompletionProposal } from "../src/core/proposal.js";
import { buildOracleDecision } from "../src/runtime/oracle.js";

const NOW = 1_700_000_000_000;
const GOAL_ID = "goal_ab0000000001";

function baseGoal(overrides: Partial<RuntimeGoal> = {}): RuntimeGoal {
  return {
    goalId: GOAL_ID,
    objective: "Ship the quarterly report",
    status: "active",
    usage: { tokensUsed: 0, activeSeconds: 0, turnsUsed: 0 },
    loop: { enabled: true, maxTurns: DEFAULT_GOAL_MAX_TURNS },
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const PROPOSAL = buildGoalCompletionProposal({
  goalId: GOAL_ID,
  goalRevision: 2,
  todoGraphRevision: 1,
  completionSummary: "everything shipped",
  requirementsChecked: ["engine done"],
  evidenceRefs: ["npm test"],
  validationCommands: ["npm test"],
  knownRisks: [],
  noShip: false,
  proposedAt: new Date(NOW).toISOString(),
});

const VALIDATED_PROPOSAL = validateGoalCompletionProposal(PROPOSAL);
assert.ok(VALIDATED_PROPOSAL.valid);

const DECISION = buildOracleDecision(VALIDATED_PROPOSAL.proposal, {
  goalRevision: 3,
  verdict: "PASS",
  noShip: false,
  evidenceSummary: "strict evidence",
  evidenceRefs: ["npm test"],
  reviewedAt: new Date(NOW).toISOString(),
});

const GATE = {
  originalUserAsk: "ship the report",
  activeGoal: "report shipped with evidence",
  constraints: "no scope creep",
  expectedOutput: "final report",
  validationEvidence: "npm test green",
  setAt: new Date(NOW).toISOString(),
};

function mutated(mutate: (goal: Record<string, unknown>) => void): RuntimeGoal | undefined {
  const value: Record<string, unknown> = { ...baseGoal() };
  mutate(value);
  return normalizeRuntimeGoal(value);
}

test("defaults and vocabularies: 80 max turns, +12 resume extension, 7 statuses, 3 activation modes", () => {
  assert.equal(DEFAULT_GOAL_MAX_TURNS, 80);
  assert.equal(DEFAULT_RESUME_TURN_EXTENSION, 12);
  assert.equal(MAX_RUNTIME_GOAL_OBJECTIVE_CHARS, 8192);
  assert.deepEqual(RUNTIME_GOAL_STATUSES, [
    "active",
    "ready_for_oracle",
    "oracle_failed",
    "paused",
    "blocked",
    "budget_limited",
    "complete",
  ]);
  assert.deepEqual([...RESUMABLE_GOAL_STATUSES].sort(), ["blocked", "budget_limited", "oracle_failed", "paused"]);
  assert.deepEqual(GOAL_ACTIVATION_MODES, ["manual", "validation", "auto"]);
  assert.equal(DEFAULT_GOAL_ACTIVATION_MODE, "auto");
});

test("normalizeRuntimeGoal accepts a canonical minimal goal and JSON round-trips", () => {
  const goal = baseGoal();
  const normalized = normalizeRuntimeGoal(goal);
  assert.ok(normalized);
  assert.deepEqual(normalized, goal);
  assert.deepEqual(normalizeRuntimeGoal(JSON.parse(JSON.stringify(goal))), goal);
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.usage));
  assert.ok(Object.isFrozen(normalized.loop));
  assert.equal(asRuntimeGoalStatus("paused"), "paused");
  assert.equal(asRuntimeGoalStatus("done"), undefined);
});

test("normalizeRuntimeGoal accepts optional gate, usage cost, custom turns flag, proposal, and decision", () => {
  const goal = baseGoal({
    gate: GATE,
    usage: { tokensUsed: 1200, activeSeconds: 90, turnsUsed: 4, costUsed: 0.25 },
    loop: { enabled: false, maxTurns: 12, customMaxTurns: true },
    revision: 3,
    completionProposal: PROPOSAL,
    oracleDecision: DECISION,
  });
  const normalized = normalizeRuntimeGoal(goal);
  assert.ok(normalized);
  assert.deepEqual(normalized.gate, GATE);
  assert.equal(normalized.usage.costUsed, 0.25);
  assert.equal(normalized.loop.customMaxTurns, true);
  assert.equal(normalized.completionProposal?.proposalHash, PROPOSAL.proposalHash);
  assert.equal(normalized.oracleDecision?.oracleDecisionHash, DECISION.oracleDecisionHash);
});

test("normalizeRuntimeGoal is strict: invalid shapes resolve to undefined", () => {
  assert.equal(mutated((goal) => { delete goal.usage; }), undefined);
  assert.equal(mutated((goal) => { goal.legacyZob = true; }), undefined);
  assert.equal(mutated((goal) => { goal.goalId = "todo_ab0000000001"; }), undefined);
  assert.equal(mutated((goal) => { goal.goalId = "goal_ABC"; }), undefined);
  assert.equal(mutated((goal) => { goal.objective = "   "; }), undefined);
  assert.equal(mutated((goal) => { goal.objective = "x".repeat(8193); }), undefined);
  assert.equal(mutated((goal) => { goal.status = "done" as RuntimeGoalStatus; }), undefined);
  assert.equal(mutated((goal) => { goal.revision = 0; }), undefined);
  assert.equal(mutated((goal) => { goal.revision = 1.5; }), undefined);
  assert.equal(mutated((goal) => { (goal.usage as Record<string, unknown>).tokensUsed = -1; }), undefined);
  assert.equal(mutated((goal) => { (goal.usage as Record<string, unknown>).turnsUsed = 1.5; }), undefined);
  assert.equal(mutated((goal) => { delete (goal.usage as Record<string, unknown>).activeSeconds; }), undefined);
  assert.equal(mutated((goal) => { (goal.usage as Record<string, unknown>).extra = 1; }), undefined);
  assert.equal(mutated((goal) => { (goal.usage as Record<string, unknown>).costUsed = "0.25"; }), undefined);
  assert.equal(mutated((goal) => { (goal.loop as Record<string, unknown>).maxTurns = 0; }), undefined);
  assert.equal(mutated((goal) => { (goal.loop as Record<string, unknown>).enabled = "yes"; }), undefined);
  assert.equal(mutated((goal) => { (goal.loop as Record<string, unknown>).customMaxTurns = "true"; }), undefined);
  assert.equal(mutated((goal) => { (goal.gate as unknown) = { ...GATE, setAt: "yesterday" }; }), undefined);
  assert.equal(mutated((goal) => { (goal.gate as unknown) = { ...GATE, originalUserAsk: " " }; }), undefined);
  assert.equal(mutated((goal) => { (goal.gate as unknown) = { ...GATE, extra: true }; }), undefined);
  assert.equal(mutated((goal) => { goal.completionProposal = { ...PROPOSAL, proposalHash: "0".repeat(64) }; }), undefined);
  assert.equal(mutated((goal) => { goal.oracleDecision = { ...DECISION, noShip: true }; }), undefined);
  assert.equal(normalizeRuntimeGoal("goal"), undefined);
  assert.equal(normalizeRuntimeGoal(null), undefined);
  assert.equal(normalizeRuntimeGoal([baseGoal()]), undefined);
});

test("createRuntimeGoal builds the canonical active goal with defaults or a custom turn window", () => {
  const goal = createRuntimeGoal("Ship it", { goalId: GOAL_ID, now: NOW });
  assert.equal(goal.status, "active");
  assert.equal(goal.revision, 1);
  assert.deepEqual(goal.usage, { tokensUsed: 0, activeSeconds: 0, turnsUsed: 0 });
  assert.deepEqual(goal.loop, { enabled: true, maxTurns: 80 });
  assert.equal("customMaxTurns" in goal.loop, false);
  assert.equal(goal.createdAt, NOW);
  assert.deepEqual(normalizeRuntimeGoal(goal), goal);

  const custom = createRuntimeGoal("Ship it", { goalId: GOAL_ID, now: NOW, maxTurns: 10, gate: GATE });
  assert.equal(custom.loop.maxTurns, 10);
  assert.equal(custom.loop.customMaxTurns, true);
  assert.deepEqual(custom.gate, GATE);

  assert.throws(() => createRuntimeGoal("  ", { goalId: GOAL_ID, now: NOW }), TypeError);
  assert.throws(() => createRuntimeGoal("x".repeat(8193), { goalId: GOAL_ID, now: NOW }), TypeError);
  assert.throws(() => createRuntimeGoal("ok", { goalId: "goal_X", now: NOW }), TypeError);
});

test("runtimeGoalToRecord projects the exact 6-key store record and back", () => {
  const goal = baseGoal({ status: "ready_for_oracle", revision: 2 });
  const record = runtimeGoalToRecord(goal);
  assert.deepEqual(Object.keys(record).sort(), ["createdAt", "goalId", "objective", "revision", "status", "updatedAt"]);
  assert.deepEqual(record, {
    goalId: GOAL_ID,
    objective: goal.objective,
    status: "ready_for_oracle",
    revision: 2,
    createdAt: NOW,
    updatedAt: NOW,
  });
});

test("create gate: creation is rejected while any non-complete goal exists", () => {
  assert.equal(canCreateRuntimeGoal(undefined), true);
  assert.equal(canCreateRuntimeGoal(baseGoal({ status: "complete" })), true);
  for (const status of ["active", "ready_for_oracle", "oracle_failed", "paused", "blocked", "budget_limited"] as RuntimeGoalStatus[]) {
    assert.equal(canCreateRuntimeGoal(baseGoal({ status })), false, status);
  }
});

test("pause gate: pause moves an active goal to paused with the loop off; other statuses are unchanged", () => {
  const paused = pauseRuntimeGoal(baseGoal(), NOW + 5);
  assert.equal(paused.status, "paused");
  assert.equal(paused.loop.enabled, false);
  assert.equal(paused.updatedAt, NOW + 5);
  const complete = baseGoal({ status: "complete" });
  assert.equal(pauseRuntimeGoal(complete, NOW + 5), complete);
});

test("resume gate matrix: only paused/blocked/oracle_failed/budget_limited resume, reason required", () => {
  for (const status of ["paused", "blocked", "oracle_failed", "budget_limited"] as RuntimeGoalStatus[]) {
    const resumed = resumeRuntimeGoal(baseGoal({ status }), "blocker resolved", { now: NOW + 9 });
    assert.ok(resumed, status);
    assert.equal(resumed.goal.status, "active");
    assert.equal(resumed.goal.loop.enabled, true);
    assert.equal(resumed.previousStatus, status);
  }
  for (const status of ["active", "ready_for_oracle", "complete"] as RuntimeGoalStatus[]) {
    assert.equal(resumeRuntimeGoal(baseGoal({ status }), "reason", { now: NOW + 9 }), undefined, status);
  }
  assert.equal(resumeRuntimeGoal(baseGoal({ status: "paused" }), "   ", { now: NOW + 9 }), undefined);
});

test("resume turn-window rule: +12 default when exhausted, explicit extension floored at maxTurns", () => {
  const exhausted = baseGoal({ status: "blocked", usage: { tokensUsed: 1, activeSeconds: 1, turnsUsed: 80 }, loop: { enabled: false, maxTurns: 80 } });
  const resumed = resumeRuntimeGoal(exhausted, "more turns", { now: NOW + 9 });
  assert.ok(resumed);
  assert.equal(resumed.additionalTurns, 12);
  assert.equal(resumed.goal.loop.maxTurns, 92);
  assert.equal(resumed.goal.loop.customMaxTurns, true);

  const fresh = baseGoal({ status: "paused", usage: { tokensUsed: 1, activeSeconds: 1, turnsUsed: 3 } });
  const explicit = resumeRuntimeGoal(fresh, "explicit window", { now: NOW + 9, extraTurns: 5 });
  assert.ok(explicit);
  assert.equal(explicit.additionalTurns, 5);
  assert.equal(explicit.goal.loop.maxTurns, 80); // floor: max(80, 3 + 5)
  assert.equal(explicit.goal.loop.customMaxTurns, true);

  const untouched = resumeRuntimeGoal(fresh, "no extension needed", { now: NOW + 9 });
  assert.ok(untouched);
  assert.equal(untouched.additionalTurns, undefined);
  assert.equal(untouched.goal.loop.maxTurns, 80);
  assert.equal("customMaxTurns" in untouched.goal.loop, false);

  const zero = resumeRuntimeGoal(fresh, "zero turns", { now: NOW + 9, extraTurns: 0 });
  assert.ok(zero);
  assert.equal(zero.additionalTurns, 1);
});

test("accountRuntimeGoalUsage adds clamped deltas with an injected now; non-active goals are untouched", () => {
  const active = baseGoal();
  const first = accountRuntimeGoalUsage(active, { tokensUsed: 1200, activeSeconds: 30, costUsed: 0.25 }, NOW + 1);
  assert.deepEqual(first.usage, { tokensUsed: 1200, activeSeconds: 30, turnsUsed: 0, costUsed: 0.25 });
  assert.equal(first.updatedAt, NOW + 1);
  const second = accountRuntimeGoalUsage(first, { tokensUsed: 300, activeSeconds: 5, costUsed: 0.25 }, NOW + 2);
  assert.equal(second.usage.tokensUsed, 1500);
  assert.equal(second.usage.activeSeconds, 35);
  assert.equal(second.usage.costUsed, 0.5);
  const clamped = accountRuntimeGoalUsage(second, { tokensUsed: -50, activeSeconds: -5 }, NOW + 3);
  assert.equal(clamped.usage.tokensUsed, 1500);
  assert.equal(clamped.usage.activeSeconds, 35);
  const complete = baseGoal({ status: "complete" });
  assert.equal(accountRuntimeGoalUsage(complete, { tokensUsed: 99 }, NOW + 4), complete);
});

test("accountRuntimeGoalTurn counts turns, accumulates usage, and applies stop gates purely", () => {
  const active = baseGoal();
  const counted = accountRuntimeGoalTurn(active, { tokensUsed: 500, costUsed: 0.1, countAutoTurn: true }, NOW + 1);
  assert.equal(counted.turnCounted, true);
  assert.equal(counted.turnLimitReached, false);
  assert.equal(counted.statusChangedTo, undefined);
  assert.equal(counted.goal.usage.turnsUsed, 1);
  assert.equal(counted.goal.usage.tokensUsed, 500);
  assert.equal(counted.goal.usage.costUsed, 0.1);
  assert.equal(counted.goal.updatedAt, NOW + 1);

  const manual = accountRuntimeGoalTurn(active, { tokensUsed: 5 }, NOW + 1);
  assert.equal(manual.turnCounted, false);
  assert.equal(manual.goal.usage.turnsUsed, 0);
  assert.equal(manual.goal.usage.tokensUsed, 5);

  const limited = accountRuntimeGoalTurn(
    baseGoal({ usage: { tokensUsed: 1, activeSeconds: 1, turnsUsed: 1 }, loop: { enabled: true, maxTurns: 2 } }),
    { countAutoTurn: true },
    NOW + 1,
  );
  assert.equal(limited.turnCounted, true);
  assert.equal(limited.turnLimitReached, true);
  assert.equal(limited.statusChangedTo, "blocked");
  assert.equal(limited.goal.status, "blocked");
  assert.equal(limited.goal.loop.enabled, false);

  const aborted = accountRuntimeGoalTurn(active, { stopReason: "aborted" }, NOW + 1);
  assert.equal(aborted.goal.status, "paused");
  assert.equal(aborted.goal.loop.enabled, false);
  assert.equal(aborted.statusChangedTo, "paused");

  const errored = accountRuntimeGoalTurn(active, { stopReason: "error" }, NOW + 1);
  assert.equal(errored.goal.status, "blocked");
  assert.equal(errored.statusChangedTo, "blocked");

  const complete = baseGoal({ status: "complete" });
  const untouched = accountRuntimeGoalTurn(complete, { tokensUsed: 50, countAutoTurn: true }, NOW + 1);
  assert.equal(untouched.goal, complete);
  assert.equal(untouched.turnCounted, false);
});

test("activation modes format exactly like zob and validate strictly", () => {
  assert.equal(asGoalActivationMode("manual"), "manual");
  assert.equal(asGoalActivationMode("auto"), "auto");
  assert.equal(asGoalActivationMode("validation"), "validation");
  assert.equal(asGoalActivationMode("always"), undefined);
  assert.equal(formatGoalActivationMode("manual"), "manual: /goal starts only by explicit user command");
  assert.equal(formatGoalActivationMode("validation"), "validation: assistant proposes /goal for long work and asks confirmation");
  assert.equal(formatGoalActivationMode("auto"), "auto: assistant may create /goal automatically for clearly long multi-step work");
  assert.equal(formatGoalActivationMode(undefined), formatGoalActivationMode("auto"));
});
