// test/runtime-engine.test.ts — Phase 4 TDD (red first): the GoalRuntimeEngine
// over a REAL temp stateDir through the 3b store.
//
// Under test: src/runtime/engine.ts — createGoal/getGoal/addTodos/
// updateTodoMetadata/resolveTodo/linkDelegation/returnClaim/
// recordClaimValidation/proposeCompletion/recordOracleDecision/completeGoal/
// resumeGoal/clearGoal. Every mutation is CAS-guarded (2d) with receipt
// replay semantics (exact replay = no-op, conflicting replay = rejected),
// bumps the right stream revision via the 3b append APIs under the
// GoalsFileLock, and persists the runtime overlay next to the streams.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeGoalEngine } from "../src/runtime/engine.js";
import type { GoalEngineError, GoalRuntimeEngine } from "../src/runtime/engine.js";
import type { GoalStatusChangedEvent } from "../src/runtime/ports.js";
import { DEFAULT_GOAL_MAX_TURNS } from "../src/runtime/goal.js";
import { restoreGoalStore } from "../src/store/restore.js";
import { compactGoalStore } from "../src/store/snapshot.js";
import { casReceiptsPath, goalStorePaths } from "../src/store/log.js";
import { buildGoalCompletionProposal, validateGoalCompletionProposal } from "../src/core/proposal.js";
import { buildOracleDecision, composeOracleClaimAutoAccept } from "../src/runtime/oracle.js";
import { buildGoalTodoClaimHash } from "../src/core/claims.js";
import type { GoalTodoNodeMetadataPatch } from "../src/core/tree.js";

interface Harness {
  engine: GoalRuntimeEngine;
  stateDir: string;
  statusChanges: GoalStatusChangedEvent[];
}

function makeHarness(): Harness {
  const stateDir = mkdtempSync(path.join(tmpdir(), "pi-goals-engine-state-"));
  const runtimeDir = mkdtempSync(path.join(tmpdir(), "pi-goals-engine-runtime-"));
  let now = 1_700_000_000_000;
  let seed = 0;
  const statusChanges: GoalStatusChangedEvent[] = [];
  const engine = createRuntimeGoalEngine({
    stateDir,
    runtimeDir,
    clock: (): number => (now += 1_000),
    randomBytes: (count: number): Uint8Array => {
      const bytes = new Uint8Array(count);
      seed += 1;
      for (let index = 0; index < count; index += 1) bytes[index] = (seed * 31 + index * 17) % 256;
      return bytes;
    },
    loopHooks: {
      onGoalStatusChanged: (event) => statusChanges.push(event),
    },
  });
  return { engine, stateDir, statusChanges };
}

function cas(mutationId: string, revisions: { goal?: number; graph?: number } = {}) {
  return {
    mutationId: `mut-${mutationId}`,
    ...(revisions.goal !== undefined ? { expectedGoalRevision: revisions.goal } : {}),
    ...(revisions.graph !== undefined ? { expectedGraphRevision: revisions.graph } : {}),
  };
}

function proposeInput(overrides: Record<string, unknown> = {}) {
  return {
    completionSummary: "All requirements shipped with evidence",
    requirementsChecked: ["engine implemented"],
    evidenceRefs: ["npm test green"],
    validationCommands: ["npm test"],
    knownRisks: [],
    noShip: false,
    ...overrides,
  };
}

function failure(outcome: { ok: boolean }): GoalEngineError {
  assert.equal(outcome.ok, false);
  return outcome as GoalEngineError;
}

function readJsonl(filePath: string): Record<string, unknown>[] {
  try {
    const text = readFileSync(filePath, "utf8");
    return text === "" ? [] : (text.split("\n").slice(0, -1).map((line) => JSON.parse(line) as Record<string, unknown>));
  } catch {
    return [];
  }
}

function streamKinds(stateDir: string, goalId: string, file: "goal.log.jsonl" | "todos.log.jsonl" | "claims.log.jsonl"): string[] {
  return readJsonl(goalStorePaths(stateDir, goalId)[file === "goal.log.jsonl" ? "goalLog" : file === "todos.log.jsonl" ? "todosLog" : "claimsLog"]).map(
    (line) => line.kind as string,
  );
}

function streamRevisions(stateDir: string, goalId: string, file: "goal.log.jsonl" | "todos.log.jsonl"): number[] {
  return readJsonl(goalStorePaths(stateDir, goalId)[file === "goal.log.jsonl" ? "goalLog" : "todosLog"]).map((line) => line.revision as number);
}

/** Minimal full flow helper: create → one required todo → complete → propose → PASS oracle → complete. */
function driveToComplete(h: Harness): { goalId: string; proposalHash: string; decisionHash: string } {
  const created = h.engine.createGoal("Ship the engine", cas("create", { goal: 0 }));
  assert.ok(created.ok);
  const goalId = created.result.goalId;
  const add = h.engine.addTodos([{ input: { title: "Only todo", required: true } }], cas("add", { graph: 0 }));
  assert.ok(add.ok);
  const resolve = h.engine.resolveTodo({ todoPath: "1" }, "complete", {}, cas("resolve", { graph: 1 }));
  assert.ok(resolve.ok);
  const propose = h.engine.proposeCompletion(proposeInput(), cas("propose", { goal: 1, graph: 2 }));
  assert.ok(propose.ok);
  const oracle = h.engine.recordOracleDecision(
    { verdict: "PASS", noShip: false, evidenceSummary: "strict pass", evidenceRefs: ["tests"] },
    cas("oracle", { goal: 2, graph: 2 }),
  );
  assert.ok(oracle.ok);
  const complete = h.engine.completeGoal(cas("complete", { goal: 3, graph: 2 }));
  assert.ok(complete.ok);
  return { goalId, proposalHash: propose.result.proposal!.proposalHash, decisionHash: oracle.result.decision.oracleDecisionHash };
}

test("full happy path: create → todos → resolve → propose → oracle PASS → complete with revision lineage, persisted streams, and snapshot round-trip", () => {
  const h = makeHarness();
  const created = h.engine.createGoal("Ship the pi-goals runtime", cas("create", { goal: 0 }));
  assert.ok(created.ok);
  assert.equal(created.status, "applied");
  const goalId = created.result.goalId;
  assert.match(goalId, /^goal_[a-f0-9]{12}$/);
  assert.equal(created.result.goal?.status, "active");
  assert.equal(created.result.goal?.revision, 1);
  assert.equal(created.result.goal?.loop.maxTurns, DEFAULT_GOAL_MAX_TURNS);

  const add = h.engine.addTodos(
    [
      { input: { title: "Implement engine", required: true } },
      { input: { title: "Optional polish", required: false } },
    ],
    cas("add", { graph: 0 }),
  );
  assert.ok(add.ok);
  assert.equal(add.result.created.length, 2);
  assert.equal(add.result.todosRevision, 1);

  const early = h.engine.proposeCompletion(proposeInput(), cas("early", { goal: 1, graph: 1 }));
  const earlyError = failure(early);
  assert.equal(earlyError.code, "completion_not_ready");
  assert.ok((earlyError.blockers ?? []).some((blocker) => blocker.title === "Implement engine" && blocker.status === "planned"));

  const res1 = h.engine.resolveTodo({ todoPath: "1" }, "complete", {}, cas("res1", { graph: 1 }));
  assert.ok(res1.ok);
  assert.equal(res1.result.node.status, "done");
  assert.equal(res1.result.todosRevision, 2);
  const res2 = h.engine.resolveTodo({ todoPath: "2" }, "skip", { reason: "out of scope" }, cas("res2", { graph: 2 }));
  assert.ok(res2.ok);
  assert.equal(res2.result.node.status, "skipped");
  assert.equal(res2.result.todosRevision, 3);

  const propose = h.engine.proposeCompletion(proposeInput(), cas("propose", { goal: 1, graph: 3 }));
  assert.ok(propose.ok);
  assert.equal(propose.result.goal.status, "ready_for_oracle");
  assert.equal(propose.result.goal.revision, 2);
  assert.equal(propose.result.proposal!.todoGraphRevision, 3);
  const proposalHash = propose.result.proposal!.proposalHash;

  const oracle = h.engine.recordOracleDecision(
    { verdict: "PASS", noShip: false, evidenceSummary: "evidence looks strict", evidenceRefs: ["npm test green"] },
    cas("oracle", { goal: 2, graph: 3 }),
  );
  assert.ok(oracle.ok);
  assert.equal(oracle.result.goal.status, "ready_for_oracle");
  assert.equal(oracle.result.decision.goalRevision, 3);
  assert.equal(oracle.result.decision.proposalHash, proposalHash);

  const complete = h.engine.completeGoal(cas("complete", { goal: 3, graph: 3 }), {
    expectedProposalHash: proposalHash,
    expectedOracleDecisionHash: oracle.result.decision.oracleDecisionHash,
  });
  assert.ok(complete.ok);
  assert.equal(complete.result.goal.status, "complete");
  assert.equal(complete.result.goal.revision, 4); // exactly decision.goalRevision + 1

  // LoopHooks fired for propose / oracle / complete (and nothing else)
  assert.deepEqual(
    h.statusChanges.map((event) => [event.fromStatus, event.toStatus]),
    [
      ["active", "ready_for_oracle"],
      ["ready_for_oracle", "ready_for_oracle"],
      ["ready_for_oracle", "complete"],
    ],
  );

  // Persisted JSONL streams: goal lineage 1..4 (all goal_set), todos lineage 1..3
  assert.deepEqual(streamKinds(h.stateDir, goalId, "goal.log.jsonl"), ["goal_set", "goal_set", "goal_set", "goal_set"]);
  assert.deepEqual(streamRevisions(h.stateDir, goalId, "goal.log.jsonl"), [1, 2, 3, 4]);
  for (const line of readJsonl(goalStorePaths(h.stateDir, goalId).goalLog)) {
    assert.equal((line.data as { goal: { revision: number } }).goal.revision, line.revision as number);
  }
  assert.deepEqual(streamKinds(h.stateDir, goalId, "todos.log.jsonl"), ["todos_snapshot", "todo_updated", "todo_updated"]);
  assert.deepEqual(streamRevisions(h.stateDir, goalId, "todos.log.jsonl"), [1, 2, 3]);
  const receipts = readJsonl(casReceiptsPath(h.stateDir));
  assert.equal(receipts.length, 7);
  assert.equal(new Set(receipts.map((line) => (line.data as { receipt: { mutationId: string } }).receipt.mutationId)).size, 7);

  // getGoal round-trips the full runtime state from disk (overlay included)
  const view = h.engine.getGoal(goalId);
  assert.ok(view.goal);
  assert.equal(view.goal.goal.status, "complete");
  assert.equal(view.goal.goal.completionProposal?.proposalHash, proposalHash);
  assert.equal(view.goal.goal.oracleDecision?.verdict, "PASS");
  assert.equal(view.goal.revisions.goal, 4);
  assert.equal(view.goal.revisions.todos, 3);
  assert.equal(view.goal.summary.done, 1);
  assert.equal(view.goal.completion.completionReady, true);

  // Snapshot + compaction round-trip: restore after compaction === restore before
  const before = restoreGoalStore(h.stateDir, goalId);
  assert.equal(before.status, "ok");
  const compacted = compactGoalStore(h.stateDir, goalId);
  assert.ok(compacted.ok);
  const after = restoreGoalStore(h.stateDir, goalId);
  assert.equal(after.status, "ok");
  if (before.status === "ok" && after.status === "ok") {
    assert.deepEqual(after.goal, before.goal);
    assert.deepEqual(after.todoGraph.nodes, before.todoGraph.nodes);
    assert.deepEqual(after.revisions, before.revisions);
  }
  const viewAfter = h.engine.getGoal(goalId);
  assert.ok(viewAfter.goal);
  assert.equal(viewAfter.goal.goal.status, "complete");
  assert.equal(viewAfter.goal.goal.oracleDecision?.oracleDecisionHash, oracle.result.decision.oracleDecisionHash);

  // A new goal can be created once the previous one is complete
  const next = h.engine.createGoal("Next objective", cas("create2", { goal: 0 }));
  assert.ok(next.ok);
  assert.notEqual(next.result.goalId, goalId);
  assert.equal(next.result.goal?.revision, 1);
});

test("createGoal: rejected while a non-complete goal is active; exact replay is idempotent; conflicting replay rejected", () => {
  const h = makeHarness();
  const created = h.engine.createGoal("First goal", cas("create", { goal: 0 }));
  assert.ok(created.ok);
  const goalId = created.result.goalId;

  const blocked = failure(h.engine.createGoal("Second goal", cas("create2", { goal: 0 })));
  assert.equal(blocked.code, "goal_already_active");

  const replay = h.engine.createGoal("First goal", cas("create", { goal: 0 }));
  assert.ok(replay.ok);
  assert.equal(replay.status, "replayed");
  assert.equal(replay.result.goalId, goalId);
  assert.equal(readJsonl(goalStorePaths(h.stateDir, goalId).goalLog).length, 1);

  const conflict = failure(h.engine.createGoal("Different objective", cas("create", { goal: 0 })));
  assert.equal(conflict.code, "cas_conflict");

  // clearGoal frees the single-active slot (goal_clear semantics preserved)
  const cleared = h.engine.clearGoal(cas("clear", { goal: 1 }));
  assert.ok(cleared.ok);
  assert.equal(cleared.result.clearedGoalId, goalId);
  assert.deepEqual(streamKinds(h.stateDir, goalId, "goal.log.jsonl"), ["goal_set", "goal_clear"]);
  assert.deepEqual(streamRevisions(h.stateDir, goalId, "goal.log.jsonl"), [1, 2]);
  assert.equal(h.engine.getGoal().goal, undefined);

  const recreated = h.engine.createGoal("Second goal", cas("create3", { goal: 0 }));
  assert.ok(recreated.ok);
  assert.notEqual(recreated.result.goalId, goalId);
});

test("addTodos CAS: exact replay appends nothing; conflicting replay and stale revisions rejected", () => {
  const h = makeHarness();
  const created = h.engine.createGoal("Goal", cas("create", { goal: 0 }));
  assert.ok(created.ok);
  const goalId = created.result.goalId;

  const add = h.engine.addTodos([{ input: { title: "One" } }], cas("add", { graph: 0 }));
  assert.ok(add.ok);

  const replay = h.engine.addTodos([{ input: { title: "One" } }], cas("add", { graph: 0 }));
  assert.ok(replay.ok);
  assert.equal(replay.status, "replayed");
  const view = h.engine.getGoal(goalId);
  assert.ok(view.goal);
  assert.equal(view.goal.revisions.todos, 1);
  assert.equal(view.goal.nodes.length, 1);

  const conflict = failure(h.engine.addTodos([{ input: { title: "Other" } }], cas("add", { graph: 0 })));
  assert.equal(conflict.code, "cas_conflict");

  const stale = failure(h.engine.addTodos([{ input: { title: "Two" } }], cas("add2", { graph: 5 })));
  assert.equal(stale.code, "cas_stale");
  assert.ok((stale.staleCodes ?? []).includes("stale_graph_revision"));
});

test("proposeCompletion: empty tree rejected; completion gate lists structured blockers", () => {
  const h = makeHarness();
  const created = h.engine.createGoal("Goal", cas("create", { goal: 0 }));
  assert.ok(created.ok);

  const empty = failure(h.engine.proposeCompletion(proposeInput(), cas("propose", { goal: 1, graph: 0 })));
  assert.equal(empty.code, "completion_not_ready");
  // Engine-message regression (batch-#3): the rejection message must render the
  // path-less empty-tree blocker bare — "todo tree is empty" — with the same
  // semantics as core formatGoalTodoBlockers; never a `todo '' ` empty prefix.
  assert.ok(empty.message.includes("- todo tree is empty"), `message: ${JSON.stringify(empty.message)}`);
  assert.ok(!empty.message.includes("todo '"), `message: ${JSON.stringify(empty.message)}`);
  assert.ok(!empty.message.includes("''"), `message: ${JSON.stringify(empty.message)}`);

  const add = h.engine.addTodos([{ input: { title: "Blocking", required: true } }], cas("add", { graph: 0 }));
  assert.ok(add.ok);
  const blocked = failure(h.engine.proposeCompletion(proposeInput(), cas("propose", { goal: 1, graph: 1 })));
  assert.equal(blocked.code, "completion_not_ready");
  // non-empty blockers keep the full zob-style `todo <path> '<title>' <reason>` line
  assert.ok(blocked.message.includes("todo 1 'Blocking' is required and planned"), `message: ${JSON.stringify(blocked.message)}`);
  const blockers = blocked.blockers ?? [];
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0]?.title, "Blocking");
  assert.equal(blockers[0]?.reason, "is required and planned");
  assert.match(blockers[0]?.todoId ?? "", /^todo_[a-f0-9]{12}$/);
});

test("recordOracleDecision rejects a stale proposal after todo graph drift", () => {
  const h = makeHarness();
  const created = h.engine.createGoal("Goal", cas("create", { goal: 0 }));
  assert.ok(created.ok);
  assert.ok(h.engine.addTodos([{ input: { title: "Todo", required: true } }], cas("add", { graph: 0 })).ok);
  assert.ok(h.engine.resolveTodo({ todoPath: "1" }, "complete", {}, cas("resolve", { graph: 1 })).ok);
  assert.ok(h.engine.proposeCompletion(proposeInput(), cas("propose", { goal: 1, graph: 2 })).ok);

  // graph drift after the proposal
  const drift = h.engine.updateTodoMetadata({ todoPath: "1" }, { evidenceRefs: ["late evidence"] }, cas("drift", { graph: 2 }));
  assert.ok(drift.ok);
  assert.equal(drift.result.todosRevision, 3);

  const stale = failure(
    h.engine.recordOracleDecision(
      { verdict: "PASS", noShip: false, evidenceSummary: "s", evidenceRefs: [] },
      cas("oracle", { goal: 2, graph: 3 }),
    ),
  );
  assert.equal(stale.code, "proposal_not_fresh");
  assert.equal(stale.freshnessCode, "todo_graph_revision_mismatch");
});

test("completeGoal: without oracle rejected; drift after oracle rejected until reproposal with a new oracle", () => {
  const h = makeHarness();
  const created = h.engine.createGoal("Goal", cas("create", { goal: 0 }));
  assert.ok(created.ok);
  const goalId = created.result.goalId;
  assert.ok(h.engine.addTodos([{ input: { title: "Todo", required: true } }], cas("add", { graph: 0 })).ok);
  assert.ok(h.engine.resolveTodo({ todoPath: "1" }, "complete", {}, cas("resolve", { graph: 1 })).ok);
  assert.ok(h.engine.proposeCompletion(proposeInput(), cas("propose", { goal: 1, graph: 2 })).ok);

  const noOracle = failure(h.engine.completeGoal(cas("complete", { goal: 2, graph: 2 })));
  assert.equal(noOracle.code, "oracle_not_fresh");
  assert.equal(noOracle.freshnessCode, "oracle_binding_missing");

  assert.ok(
    h.engine.recordOracleDecision(
      { verdict: "PASS", noShip: false, evidenceSummary: "strict", evidenceRefs: ["t"] },
      cas("oracle", { goal: 2, graph: 2 }),
    ).ok,
  );

  const drift = h.engine.updateTodoMetadata({ todoPath: "1" }, { evidenceRefs: ["more"] }, cas("drift", { graph: 2 }));
  assert.ok(drift.ok);

  const drifted = failure(h.engine.completeGoal(cas("complete", { goal: 3, graph: 3 })));
  assert.equal(drifted.code, "oracle_not_fresh");
  assert.equal(drifted.freshnessCode, "todo_graph_revision_mismatch");

  // reproposal is allowed from ready_for_oracle with a stale proposal and clears the old decision
  const reproposed = h.engine.proposeCompletion(proposeInput({ completionSummary: "reproposed" }), cas("repropose", { goal: 3, graph: 3 }));
  assert.ok(reproposed.ok);
  assert.equal(reproposed.result.goal.oracleDecision, undefined);
  assert.equal(reproposed.result.proposal!.todoGraphRevision, 3);
  assert.equal(reproposed.result.goal.revision, 4);

  const rebound = failure(
    h.engine.recordOracleDecision(
      { verdict: "PASS", noShip: false, evidenceSummary: "s", evidenceRefs: [] },
      cas("oracle-old", { goal: 3, graph: 3 }),
    ),
  );
  assert.equal(rebound.code, "cas_stale");

  const oracle = h.engine.recordOracleDecision(
    { verdict: "PASS", noShip: false, evidenceSummary: "fresh review", evidenceRefs: ["t"] },
    cas("oracle2", { goal: 4, graph: 3 }),
  );
  assert.ok(oracle.ok);
  assert.equal(oracle.result.decision.goalRevision, 5);

  const complete = h.engine.completeGoal(cas("complete2", { goal: 5, graph: 3 }));
  assert.ok(complete.ok);
  assert.equal(complete.result.goal.status, "complete");
  assert.equal(complete.result.goal.revision, 6);
  const view = h.engine.getGoal(goalId);
  assert.ok(view.goal);
  assert.equal(view.goal.goal.oracleDecision?.oracleDecisionHash, oracle.result.decision.oracleDecisionHash);
});

test("recordOracleDecision: FAIL verdict moves the goal to oracle_failed; a second binding is rejected", () => {
  const h = makeHarness();
  const created = h.engine.createGoal("Goal", cas("create", { goal: 0 }));
  assert.ok(created.ok);
  assert.ok(h.engine.addTodos([{ input: { title: "Todo", required: true } }], cas("add", { graph: 0 })).ok);
  assert.ok(h.engine.resolveTodo({ todoPath: "1" }, "complete", {}, cas("resolve", { graph: 1 })).ok);
  assert.ok(h.engine.proposeCompletion(proposeInput(), cas("propose", { goal: 1, graph: 2 })).ok);

  const fail = h.engine.recordOracleDecision(
    { verdict: "FAIL", noShip: true, evidenceSummary: "evidence missing", evidenceRefs: [] },
    cas("oracle", { goal: 2, graph: 2 }),
  );
  assert.ok(fail.ok);
  assert.equal(fail.result.goal.status, "oracle_failed");

  // zob parity: assertGoalOracleRecordable checks goal.status BEFORE the
  // already-bound gate, so a FAILed (oracle_failed) goal reports the status
  // gate first; the immutable binding is still there (repropose clears it).
  const again = failure(
    h.engine.recordOracleDecision(
      { verdict: "PASS", noShip: false, evidenceSummary: "retry", evidenceRefs: [] },
      cas("oracle2", { goal: 3, graph: 2 }),
    ),
  );
  assert.equal(again.code, "goal_status_invalid");
  const view = h.engine.getGoal();
  assert.ok(view.goal);
  assert.notEqual(view.goal.goal.oracleDecision, undefined);
});

test("resumeGoal: wrong status rejected; oracle_failed resumes active with the zob turn-window rule", () => {
  const h = makeHarness();
  const created = h.engine.createGoal("Goal", cas("create", { goal: 0 }));
  assert.ok(created.ok);
  const goalId = created.result.goalId;

  const active = failure(h.engine.resumeGoal("not paused", cas("resume", { goal: 1 })));
  assert.equal(active.code, "goal_status_invalid");

  const noReason = failure(h.engine.resumeGoal("", cas("resume", { goal: 1 })));
  assert.equal(noReason.code, "goal_status_invalid");

  assert.ok(h.engine.addTodos([{ input: { title: "Todo", required: true } }], cas("add", { graph: 0 })).ok);
  assert.ok(h.engine.resolveTodo({ todoPath: "1" }, "complete", {}, cas("resolve", { graph: 1 })).ok);
  assert.ok(h.engine.proposeCompletion(proposeInput(), cas("propose", { goal: 1, graph: 2 })).ok);
  assert.ok(
    h.engine.recordOracleDecision(
      { verdict: "FAIL", noShip: true, evidenceSummary: "no", evidenceRefs: [] },
      cas("oracle", { goal: 2, graph: 2 }),
    ).ok,
  );

  const resumed = h.engine.resumeGoal("evidence repaired", cas("resume", { goal: 3 }), 25);
  assert.ok(resumed.ok);
  assert.equal(resumed.result.goal.status, "active");
  assert.equal(resumed.result.goal.loop.enabled, true);
  assert.equal(resumed.result.previousStatus, "oracle_failed");
  assert.equal(resumed.result.additionalTurns, 25);
  assert.equal(resumed.result.goal.loop.customMaxTurns, true);
  assert.equal(resumed.result.goal.revision, 4);

  const last = h.statusChanges[h.statusChanges.length - 1];
  assert.equal(last?.toStatus, "active");
  assert.equal(last?.fromStatus, "oracle_failed");

  const view = h.engine.getGoal(goalId);
  assert.ok(view.goal);
  assert.equal(view.goal.goal.status, "active");
});

test("claim flow: link → return → strict-PASS validation composition → accept_claim settlement", () => {
  const h = makeHarness();
  const created = h.engine.createGoal("Goal", cas("create", { goal: 0 }));
  assert.ok(created.ok);
  const goalId = created.result.goalId;
  assert.ok(h.engine.addTodos([{ input: { title: "Delegated work", required: true } }], cas("add", { graph: 0 })).ok);

  const link = h.engine.linkDelegation({ todoPath: "1" }, { runId: "run-1", agent: "child", validationPolicy: "oracle_required" }, cas("link", { graph: 1 }));
  assert.ok(link.ok);
  const attemptId = link.result.attempt.attemptId;
  assert.match(attemptId, /^att_[a-f0-9]{12}$/);
  assert.equal(link.result.attempt.validationPolicy, "oracle_required");
  assert.equal(link.result.node.status, "delegated");

  const claimText = "delivered the module; tests green";
  const claimHash = buildGoalTodoClaimHash(claimText);
  const returned = h.engine.returnClaim(attemptId, { claimText, evidenceRefs: ["reports/x"] }, cas("return", { graph: 2 }));
  assert.ok(returned.ok);
  assert.equal(returned.result.claim.claimHash, claimHash);
  assert.equal(returned.result.node!.status, "claim_returned");

  const validation = h.engine.recordClaimValidation(
    attemptId,
    {
      verdict: "PASS",
      recommendedAction: "accept_claim",
      noShip: false,
      confidence: "HIGH",
      outputHash: "b".repeat(64),
      evidenceRefs: ["reports/x"],
    },
    cas("validate", { graph: 3 }),
  );
  assert.ok(validation.ok);
  assert.equal(validation.result.claimRule.autoAccept, true);
  assert.equal(validation.result.oracleComposition.oracleStrictPass, false); // no goal-level decision bound yet
  assert.equal(validation.result.oracleComposition.outcome, "needs_review");

  // the 3a strict-PASS oracle composition accepts when a strict-PASS decision is present
  const proposal = validateGoalCompletionProposal(
    buildGoalCompletionProposal({
      goalId,
      goalRevision: 1,
      todoGraphRevision: 3,
      completionSummary: "s",
      requirementsChecked: ["r"],
      evidenceRefs: ["e"],
      validationCommands: ["v"],
      knownRisks: [],
      noShip: false,
      proposedAt: new Date(1_700_000_000_000).toISOString(),
    }),
  );
  assert.ok(proposal.valid);
  const decision = buildOracleDecision(proposal.proposal, {
    goalRevision: 2,
    verdict: "PASS",
    noShip: false,
    evidenceSummary: "s",
    evidenceRefs: [],
    reviewedAt: new Date(1_700_000_000_000).toISOString(),
  });
  const composed = composeOracleClaimAutoAccept(decision, validation.result.validation);
  assert.equal(composed.autoAccept, true);
  assert.equal(composed.oracleStrictPass, true);

  const wrongHash = failure(
    h.engine.resolveTodo({ todoPath: "1" }, "accept_claim", { claimHash: "c".repeat(64), attemptId, validationPolicy: "oracle_required" }, cas("accept-bad", { graph: 3 })),
  );
  assert.equal(wrongHash.code, "transition_rejected");
  assert.equal(wrongHash.transitionCode, "claim_hash_mismatch");

  const accept = h.engine.resolveTodo(
    { todoPath: "1" },
    "accept_claim",
    { claimHash, attemptId, validationPolicy: "oracle_required" },
    cas("accept", { graph: 3 }),
  );
  assert.ok(accept.ok);
  assert.equal(accept.result.node.status, "done");
  assert.equal(accept.result.settlement?.settlement, "accepted");
  assert.ok(accept.result.claimComposition);
  assert.equal(accept.result.todosRevision, 4);

  assert.deepEqual(streamKinds(h.stateDir, goalId, "claims.log.jsonl"), [
    "delegation_attempt_launched",
    "claim_returned",
    "claim_validated",
    "claim_accepted",
  ]);
  const view = h.engine.getGoal(goalId);
  assert.ok(view.goal);
  assert.equal(view.goal.claims.settlements[attemptId]?.settlement, "accepted");
  assert.equal(view.goal.claims.attempts[attemptId]?.status, "running"); // raw launch record; the engine derives claim_returned/settled from the side tables
  assert.equal(view.goal.completion.completionReady, true);
});

test("updateTodoMetadata: status patch rejected, unknown ref rejected, no-op patch receipts without events", () => {
  const h = makeHarness();
  const created = h.engine.createGoal("Goal", cas("create", { goal: 0 }));
  assert.ok(created.ok);
  const goalId = created.result.goalId;
  assert.ok(h.engine.addTodos([{ input: { title: "Todo" } }], cas("add", { graph: 0 })).ok);

  const statusPatch = failure(h.engine.updateTodoMetadata({ todoPath: "1" }, { status: "done" } as unknown as GoalTodoNodeMetadataPatch, cas("patch", { graph: 1 })));
  assert.equal(statusPatch.code, "tree_error");
  assert.equal(statusPatch.treeCode, "status_change_forbidden");

  const unknown = failure(h.engine.updateTodoMetadata({ todoPath: "9" }, { title: "x" }, cas("patch2", { graph: 1 })));
  assert.equal(unknown.code, "reference_error");
  assert.equal(unknown.referenceCode, "todo_path_not_found");

  const receiptsBefore = readJsonl(casReceiptsPath(h.stateDir)).length;
  const noop = h.engine.updateTodoMetadata({ todoPath: "1" }, { title: "Todo" }, cas("patch3", { graph: 1 }));
  assert.ok(noop.ok);
  assert.equal(noop.result.changed, false);
  assert.equal(noop.result.todosRevision, 1);
  assert.equal(readJsonl(goalStorePaths(h.stateDir, goalId).todosLog).length, 1);
  assert.equal(readJsonl(casReceiptsPath(h.stateDir)).length, receiptsBefore + 1);

  const real = h.engine.updateTodoMetadata({ todoPath: "1" }, { title: "Renamed", priority: "high" }, cas("patch4", { graph: 1 }));
  assert.ok(real.ok);
  assert.equal(real.result.changed, true);
  assert.equal(real.result.node.title, "Renamed");
  assert.equal(real.result.node.priority, "high");
  assert.equal(real.result.todosRevision, 2);
});

test("goal_missing and invalid cas inputs produce exact errors", () => {
  const h = makeHarness();
  const missing = failure(h.engine.addTodos([{ input: { title: "x" } }], cas("add", { graph: 0 })));
  assert.equal(missing.code, "goal_missing");

  const created = h.engine.createGoal("Goal", cas("create", { goal: 0 }));
  assert.ok(created.ok);
  // SCHEMA-1 fix (zob parity): mutation_id-only guards (no revision slots)
  // now APPLY instead of failing cas_invalid
  const noGraph = h.engine.addTodos([{ input: { title: "x" } }], cas("add-nog", {}));
  assert.ok(noGraph.ok);
  assert.equal(noGraph.status, "applied");
  const badCreate = failure(h.engine.createGoal("  ", cas("create2", { goal: 0 })));
  assert.equal(badCreate.code, "invalid_input");
  const noRoot = failure(h.engine.resumeGoal("r", cas("resume", {})));
  assert.equal(noRoot.code, "goal_status_invalid", "mutation_id-only guard passes the CAS layer; the status gate still applies");
});

test("completeGoal after compaction still verifies via the overlay decision", () => {
  const h = makeHarness();
  const created = h.engine.createGoal("Goal", cas("create", { goal: 0 }));
  assert.ok(created.ok);
  const goalId = created.result.goalId;
  assert.ok(h.engine.addTodos([{ input: { title: "Todo", required: true } }], cas("add", { graph: 0 })).ok);
  assert.ok(h.engine.resolveTodo({ todoPath: "1" }, "complete", {}, cas("resolve", { graph: 1 })).ok);
  assert.ok(h.engine.proposeCompletion(proposeInput(), cas("propose", { goal: 1, graph: 2 })).ok);
  assert.ok(
    h.engine.recordOracleDecision(
      { verdict: "PASS", noShip: false, evidenceSummary: "ok", evidenceRefs: [] },
      cas("oracle", { goal: 2, graph: 2 }),
    ).ok,
  );

  // compaction between the oracle decision and completion
  const compacted = compactGoalStore(h.stateDir, goalId);
  assert.ok(compacted.ok);

  const complete = h.engine.completeGoal(cas("complete", { goal: 3, graph: 2 }));
  assert.ok(complete.ok);
  assert.equal(complete.result.goal.status, "complete");
  assert.equal(complete.result.goal.revision, 4);
});

test("driveToComplete helper flow: minimal path reaches complete with decision lineage", () => {
  const h = makeHarness();
  const { goalId, proposalHash, decisionHash } = driveToComplete(h);
  const view = h.engine.getGoal(goalId);
  assert.ok(view.goal);
  assert.equal(view.goal.goal.status, "complete");
  assert.equal(view.goal.goal.completionProposal?.proposalHash, proposalHash);
  assert.equal(view.goal.goal.oracleDecision?.oracleDecisionHash, decisionHash);
  assert.equal(view.goal.goal.oracleDecision?.goalRevision, 3);
  assert.equal(view.goal.goal.revision, 4);
  assert.deepEqual(streamRevisions(h.stateDir, goalId, "goal.log.jsonl"), [1, 2, 3, 4]);
  assert.deepEqual(streamKinds(h.stateDir, goalId, "todos.log.jsonl"), ["todos_snapshot", "todo_updated"]);
});
