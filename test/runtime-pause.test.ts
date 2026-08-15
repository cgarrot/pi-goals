// test/runtime-pause.test.ts — Phase 6 TDD (red first): engine pauseGoal.
//
// Under test: src/runtime/engine.ts pauseGoal — zob pause semantics reworked
// per the Phase 6 contract: pause is an explicit user action gated to
// active|ready_for_oracle|oracle_failed|budget_limited (zob's /goal pause
// covers only the active case — the wider gate is documented deviation
// D-E7), switches loop.enabled off, bumps the goal-stream revision under
// CAS, persists the runtime overlay, appends the CAS receipt, and notifies
// LoopHooks.onGoalStatusChanged. Replay semantics match every other
// mutation: exact replay = no-op success, conflicting replay = rejected.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeGoalEngine } from "../src/runtime/engine.js";
import type { GoalEngineError, GoalRuntimeEngine } from "../src/runtime/engine.js";
import type { GoalStatusChangedEvent } from "../src/runtime/ports.js";
import { restoreGoalStore } from "../src/store/restore.js";
import { goalStorePaths } from "../src/store/log.js";

interface Harness {
  engine: GoalRuntimeEngine;
  stateDir: string;
  statusChanges: GoalStatusChangedEvent[];
}

function makeHarness(): Harness {
  const stateDir = mkdtempSync(path.join(tmpdir(), "pi-goals-pause-state-"));
  const runtimeDir = mkdtempSync(path.join(tmpdir(), "pi-goals-pause-runtime-"));
  let now = 1_800_000_000_000;
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
    loopHooks: { onGoalStatusChanged: (event) => statusChanges.push(event) },
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

function failure(outcome: { ok: boolean }): GoalEngineError {
  assert.equal(outcome.ok, false);
  return outcome as GoalEngineError;
}

function readJsonl(filePath: string): Record<string, unknown>[] {
  const text = readFileSync(filePath, "utf8");
  return text === "" ? [] : text.split("\n").slice(0, -1).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Drive a goal to the wanted status through the public engine API. */
function goalAt(h: Harness, status: "active" | "ready_for_oracle" | "oracle_failed" | "complete"): { goalId: string; revision: number } {
  const created = h.engine.createGoal("Pause target", cas("create", { goal: 0 }));
  assert.ok(created.ok, `create failed: ${JSON.stringify(created)}`);
  const goalId = created.result.goalId;
  let revision = 1;
  if (status === "active") return { goalId, revision };
  assert.ok(h.engine.addTodos([{ input: { title: "Only", required: true } }], cas("add", { graph: 0 })).ok);
  assert.ok(h.engine.resolveTodo({ todoPath: "1" }, "complete", {}, cas("resolve", { graph: 1 })).ok);
  const propose = h.engine.proposeCompletion(
    {
      completionSummary: "s",
      requirementsChecked: ["r"],
      evidenceRefs: ["e"],
      validationCommands: ["c"],
      knownRisks: [],
      noShip: false,
    },
    cas("propose", { goal: 1, graph: 2 }),
  );
  assert.ok(propose.ok, `propose failed: ${JSON.stringify(propose)}`);
  revision = 2;
  if (status === "ready_for_oracle") return { goalId, revision };
  const verdict = status === "complete" ? "PASS" : "FAIL";
  const oracle = h.engine.recordOracleDecision(
    { verdict, noShip: false, evidenceSummary: "s", evidenceRefs: [] },
    cas("oracle", { goal: 2, graph: 2 }),
  );
  assert.ok(oracle.ok, `oracle failed: ${JSON.stringify(oracle)}`);
  revision = 3;
  if (status === "oracle_failed") return { goalId, revision };
  assert.ok(h.engine.completeGoal(cas("complete", { goal: 3, graph: 2 })).ok);
  return { goalId, revision: 4 };
}

test("pauseGoal: active goal pauses with loop off, revision+1, receipt, and LoopHooks notify", () => {
  const h = makeHarness();
  const { goalId } = goalAt(h, "active");
  const paused = h.engine.pauseGoal("user asked to stop", cas("pause", { goal: 1 }));
  assert.ok(paused.ok, JSON.stringify(paused));
  assert.equal(paused.status, "applied");
  assert.equal(paused.result.goal.status, "paused");
  assert.equal(paused.result.goal.loop.enabled, false);
  assert.equal(paused.result.goal.revision, 2);
  assert.equal(paused.result.previousStatus, "active");
  assert.equal(paused.receipt.toolName, "update_goal");

  const view = h.engine.getGoal(goalId);
  assert.ok(view.goal);
  assert.equal(view.goal.goal.status, "paused");
  assert.equal(view.goal.goal.loop.enabled, false);
  assert.equal(view.goal.revisions.goal, 2);

  const kinds = readJsonl(goalStorePaths(h.stateDir, goalId).goalLog).map((line) => `${line.kind}:${(line.data as { goal?: { status?: string } }).goal?.status ?? ""}`);
  assert.deepEqual(kinds, ["goal_set:active", "goal_set:paused"]);

  const last = h.statusChanges[h.statusChanges.length - 1]!;
  assert.equal(last.goalId, goalId);
  assert.equal(last.fromStatus, "active");
  assert.equal(last.toStatus, "paused");
  assert.equal(last.revision, 2);
});

test("pauseGoal: ready_for_oracle and oracle_failed goals pause too (wider gate)", () => {
  for (const status of ["ready_for_oracle", "oracle_failed"] as const) {
    const h = makeHarness();
    const { goalId, revision } = goalAt(h, status);
    const paused = h.engine.pauseGoal("hold", cas(`pause-${status}`, { goal: revision }));
    assert.ok(paused.ok, `${status}: ${JSON.stringify(paused)}`);
    assert.equal(paused.result.goal.status, "paused");
    assert.equal(paused.result.goal.loop.enabled, false);
    assert.equal(paused.result.previousStatus, status);
    const view = h.engine.getGoal(goalId);
    assert.equal(view.goal?.goal.status, "paused");
  }
});

test("pauseGoal: paused goals rejected with goal_status_invalid; complete goals have no active target", () => {
  const h = makeHarness();
  const active = goalAt(h, "active");
  assert.ok(h.engine.pauseGoal("first", cas("p1", { goal: active.revision })).ok);
  const already = failure(h.engine.pauseGoal("again", cas("p2", { goal: active.revision + 1 })));
  assert.equal(already.code, "goal_status_invalid");
  assert.match(already.message, /paused/);

  // a complete goal is not the active goal (single-active-goal engine):
  // pause answers goal_missing exactly like resumeGoal would.
  const h2 = makeHarness();
  const complete = goalAt(h2, "complete");
  const done = failure(h2.engine.pauseGoal("late", cas("p3", { goal: complete.revision })));
  assert.equal(done.code, "goal_missing");
});

test("pauseGoal: empty reason rejected; CAS stale and replay semantics enforced", () => {
  const h = makeHarness();
  const { goalId } = goalAt(h, "active");
  const noReason = failure(h.engine.pauseGoal("   ", cas("pr", { goal: 1 })));
  assert.equal(noReason.code, "reason_required");

  const stale = failure(h.engine.pauseGoal("r", cas("stale", { goal: 5 })));
  assert.equal(stale.code, "cas_stale");

  const first = h.engine.pauseGoal("real reason", cas("real", { goal: 1 }));
  assert.ok(first.ok);

  const replayed = h.engine.pauseGoal("real reason", cas("real", { goal: 1 }));
  assert.ok(replayed.ok);
  assert.equal(replayed.status, "replayed");
  assert.equal(replayed.result.goal.status, "paused");

  const conflict = failure(h.engine.pauseGoal("different reason", cas("real", { goal: 1 })));
  assert.equal(conflict.code, "cas_conflict");

  // replay appends nothing: goal stream still exactly 2 events
  assert.equal(readJsonl(goalStorePaths(h.stateDir, goalId).goalLog).length, 2);
});

test("pauseGoal: restore replays the paused goal exactly (stream + overlay)", () => {
  const h = makeHarness();
  const { goalId } = goalAt(h, "active");
  assert.ok(h.engine.pauseGoal("user asked to stop", cas("pz", { goal: 1 })).ok);
  const restored = restoreGoalStore(h.stateDir, goalId);
  assert.equal(restored.status, "ok");
  if (restored.status === "ok") {
    assert.equal(restored.goal?.status, "paused");
    assert.equal(restored.revisions.goal, 2);
  }
});
