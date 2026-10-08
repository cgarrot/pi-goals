// test/runtime-scopes.test.ts — scope-aware engine (v0.2 multi-agent).
//
// Under test: the GoalRuntimeEngine's scoped invariants (D-E8):
//   - single-active-goal PER SCOPE (local | agent:<id> | room:<id>);
//   - different scopes never block each other (the production bug);
//   - legacy fallback: exactly one active goal store-wide resolves without
//     a selector (solo zob contract preserved);
//   - scope_ambiguous when several lanes are active and no selector is given;
//   - attempt-keyed claim resolution across scopes;
//   - CAS revision isolation between goals of different scopes (review P5);
//   - getGoalsOverview lane listing; replay idempotence with scope payloads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRuntimeGoalEngine } from "../src/runtime/engine.js";
import type { GoalEngineError, GoalRuntimeEngine } from "../src/runtime/engine.js";
import { goalStorePaths } from "../src/store/log.js";

interface Harness {
  engine: GoalRuntimeEngine;
  stateDir: string;
}

function makeHarness(): Harness {
  const stateDir = mkdtempSync(path.join(tmpdir(), "pi-goals-scopes-state-"));
  const runtimeDir = mkdtempSync(path.join(tmpdir(), "pi-goals-scopes-runtime-"));
  let now = 1_700_000_000_000;
  let seed = 0;
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
  });
  return { engine, stateDir };
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

const PROPOSE_INPUT = {
  completionSummary: "Shipped with evidence",
  requirementsChecked: ["done"],
  evidenceRefs: ["tests"],
  validationCommands: ["npm test"],
  knownRisks: [],
  noShip: false,
};

test("scopes are independent: agent and room goals coexist with a local goal", () => {
  const { engine } = makeHarness();
  const local = engine.createGoal("local solo goal", cas("a1", { goal: 0 }));
  assert.equal(local.ok, true);
  const agent = engine.createGoal("agent private goal", cas("a2", { goal: 0 }), { scope: "agent:sess-1" });
  assert.equal(agent.ok, true, "agent goal must not be blocked by the active local goal");
  const room = engine.createGoal("room shared goal", cas("a3", { goal: 0 }), { scope: "room:default" });
  assert.equal(room.ok, true, "room goal must not be blocked either");
  assert.equal(engine.getGoal(undefined, "agent:sess-1").goal?.goal.objective, "agent private goal");
  assert.equal(engine.getGoal(undefined, "room:default").goal?.goal.objective, "room shared goal");
});

test("the per-scope single-active invariant still applies within ONE scope", () => {
  const { engine } = makeHarness();
  assert.equal(engine.createGoal("first", cas("b1", { goal: 0 }), { scope: "room:default" }).ok, true);
  const second = engine.createGoal("second", cas("b2", { goal: 0 }), { scope: "room:default" });
  const error = failure(second);
  assert.equal(error.code, "goal_already_active");
  assert.match(error.message, /scope room:default/);
  // a different scope stays free
  assert.equal(engine.createGoal("other lane", cas("b3", { goal: 0 }), { scope: "room:other" }).ok, true);
});

test("invalid scopes are rejected before touching the store", () => {
  const { engine } = makeHarness();
  for (const bad of ["space in id", "room:", "agent:", "LOCAL", "../evil", "room:../evil"]) {
    const outcome = engine.createGoal("x", cas(`c-${bad.length}`), { scope: bad });
    assert.equal(failure(outcome).code, "invalid_input", `scope '${bad}' must be invalid_input`);
  }
});

test("legacy fallback: a bare mutation resolves the single active goal (solo contract)", () => {
  const { engine } = makeHarness();
  assert.equal(engine.createGoal("solo", cas("d1", { goal: 0 })).ok, true);
  const added = engine.addTodos([{ input: { title: "legacy todo" } }], cas("d2", { graph: 0 }));
  assert.equal(added.ok, true, "no selector needed while exactly one goal is active");
  const view = engine.getGoal();
  assert.equal(view.goal?.summary.total, 1);
});

test("scope_ambiguous: several active lanes require an explicit selector", () => {
  const { engine } = makeHarness();
  assert.equal(engine.createGoal("room work", cas("e1", { goal: 0 }), { scope: "room:default" }).ok, true);
  assert.equal(engine.createGoal("agent work", cas("e2", { goal: 0 }), { scope: "agent:sess-1" }).ok, true);
  const bare = failure(engine.addTodos([{ input: { title: "t" } }], cas("e3")));
  assert.equal(bare.code, "scope_ambiguous");
  assert.match(bare.message, /agent:sess-1/);
  assert.match(bare.message, /room:default/);
  // explicit selectors unblock the same mutation
  assert.equal(engine.addTodos([{ input: { title: "room todo" } }], cas("e4", { graph: 0 }), { scope: "room:default" }).ok, true);
  assert.equal(engine.addTodos([{ input: { title: "agent todo" } }], cas("e5", { graph: 0 }), { scope: "agent:sess-1" }).ok, true);
  assert.equal(engine.getGoal(undefined, "room:default").goal?.summary.total, 1);
  assert.equal(engine.getGoal(undefined, "agent:sess-1").goal?.summary.total, 1);
});

test("explicit goal_id addresses a goal across scopes", () => {
  const { engine } = makeHarness();
  const created = engine.createGoal("target", cas("f1", { goal: 0 }), { scope: "room:default" });
  assert.equal(created.ok, true);
  engine.createGoal("noisy other lane", cas("f2", { goal: 0 }), { scope: "agent:sess-2" });
  const goalId = created.ok ? created.result.goalId : "";
  assert.equal(engine.getGoal(goalId).goal?.goal.objective, "target");
  assert.equal(engine.addTodos([{ input: { title: "by id" } }], cas("f3", { graph: 0 }), { goalId }).ok, true);
});

test("CAS revisions are isolated per goal across scopes (review P5)", () => {
  const { engine } = makeHarness();
  const room = engine.createGoal("room", cas("g1", { goal: 0 }), { scope: "room:default" });
  const agent = engine.createGoal("agent", cas("g2", { goal: 0 }), { scope: "agent:sess-1" });
  assert.ok(room.ok && agent.ok);
  // bump the ROOM todos revision twice, then CAS-mutate the AGENT goal with
  // its own (still-fresh) revisions — must NOT be stale.
  assert.equal(engine.addTodos([{ input: { title: "r1" } }], cas("g3", { graph: 0 }), { scope: "room:default" }).ok, true);
  assert.equal(engine.addTodos([{ input: { title: "r2" } }], cas("g4", { graph: 1 }), { scope: "room:default" }).ok, true);
  const agentAdd = engine.addTodos([{ input: { title: "a1" } }], cas("g5", { goal: 1, graph: 0 }), { scope: "agent:sess-1" });
  assert.equal(agentAdd.ok, true, "agent-lane CAS must be unaffected by room-lane mutations");
  // and a genuinely stale agent CAS still fails (current graph revision is now 1)
  const stale = failure(engine.addTodos([{ input: { title: "a2" } }], cas("g6", { graph: 0 }), { scope: "agent:sess-1" }));
  assert.equal(stale.code, "cas_stale");
});

test("returnClaim resolves the owning goal by attempt across scopes (child agent)", () => {
  const { engine } = makeHarness();
  // room goal with a delegated todo (parent agent works the room lane)
  assert.equal(engine.createGoal("room campaign", cas("h1", { goal: 0 }), { scope: "room:default" }).ok, true);
  assert.equal(engine.addTodos([{ input: { title: "delegate me" } }], cas("h2", { graph: 0 }), { scope: "room:default" }).ok, true);
  const link = engine.linkDelegation({ todoPath: "1" }, { validationPolicy: "parent_review", agent: "child" }, cas("h3", { goal: 1, graph: 1 }), { scope: "room:default" });
  assert.equal(link.ok, true, "delegation must link");
  const attemptId = link.ok ? link.result.attempt.attemptId : "";
  // meanwhile ANOTHER lane becomes active — the child must still return the claim
  assert.equal(engine.createGoal("child private goal", cas("h4", { goal: 0 }), { scope: "agent:child-1" }).ok, true);
  const claimText = "child finished the delegated work with evidence";
  const returned = engine.returnClaim(attemptId, { claimText }, cas("h5"));
  assert.equal(returned.ok, true, "attempt-keyed resolution must find the room goal despite the active agent lane");
  if (returned.ok) {
    assert.equal(returned.result.node?.status, "claim_returned");
  }
  // settle on the room lane
  const view = engine.getGoal(undefined, "room:default");
  assert.ok(view.goal !== undefined);
  const claimHash = view.goal.claims.claims[attemptId]?.claimHash;
  assert.ok(claimHash !== undefined);
  const settled = engine.resolveTodo({ todoPath: "1" }, "accept_claim", { claimHash, attemptId, validationPolicy: "parent_review" }, cas("h6", { goal: 1, graph: 3 }), { scope: "room:default" });
  assert.equal(settled.ok, true);
});

test("getGoalsOverview lists every lane with scope and status", () => {
  const { engine } = makeHarness();
  engine.createGoal("local one", cas("i1", { goal: 0 }));
  engine.createGoal("room one", cas("i2", { goal: 0 }), { scope: "room:default", scopeLabel: "default" });
  const overview = engine.getGoalsOverview();
  assert.equal(overview.diagnostics, undefined);
  const entries = overview.overview ?? [];
  assert.equal(entries.length, 2);
  const scopes = entries.map((entry) => entry.scope).sort();
  assert.deepEqual(scopes, ["local", "room:default"]);
  const roomEntry = entries.find((entry) => entry.scope === "room:default");
  assert.equal(roomEntry?.scopeLabel, "default");
  assert.equal(roomEntry?.status, "active");
});

test("legacy goal streams (no scope key) restore as the local lane", () => {
  const { engine, stateDir } = makeHarness();
  assert.equal(engine.createGoal("legacy", cas("j1", { goal: 0 })).ok, true);
  // the persisted record carries no scope key: strip it like a v0.1 store
  const goalFile = goalStorePaths(stateDir, engine.getGoal()!.goal!.goal.goalId).goalLog;
  const lines = readFileSync(goalFile, "utf8").split("\n").filter((line) => line.length > 0);
  const rewritten = lines.map((line) => {
    const event = JSON.parse(line) as { data: { goal: Record<string, unknown> } };
    delete event.data.goal.scope;
    return JSON.stringify(event);
  });
  writeFileSync(goalFile, `${rewritten.join("\n")}\n`);
  // legacy behavior: the scope-less goal IS the local lane and blocks a new local goal
  assert.equal(failure(engine.createGoal("second local", cas("j2", { goal: 0 }), { scope: "local" })).code, "goal_already_active");
  // while it is the ONLY active goal, bare mutations keep the solo fallback
  assert.equal(engine.addTodos([{ input: { title: "legacy todo" } }], cas("j4", { graph: 0 })).ok, true, "exactly one active goal (the legacy one) → legacy fallback resolves it");
  // but scoped agents are free, and afterwards a bare call is ambiguous
  assert.equal(engine.createGoal("fresh agent lane", cas("j3", { goal: 0 }), { scope: "agent:sess-9" }).ok, true);
  assert.equal(failure(engine.addTodos([{ input: { title: "t" } }], cas("j5"))).code, "scope_ambiguous");
});

test("create_goal replay stays idempotent with scoped payloads", () => {
  const { engine } = makeHarness();
  const guard = cas("k1", { goal: 0 });
  const first = engine.createGoal("replayable", guard, { scope: "room:default" });
  assert.equal(first.ok, true);
  const replay = engine.createGoal("replayable", guard, { scope: "room:default" });
  assert.equal(replay.ok && replay.status, "replayed");
  // a DIFFERENT scope under the same mutation id is a conflict
  const conflict = engine.createGoal("different", cas("k1", { goal: 0 }), { scope: "room:other" });
  assert.equal(failure(conflict).code, "cas_conflict");
});

test("clearGoal is lane-scoped: clearing the room lane leaves the agent lane untouched", () => {
  const { engine } = makeHarness();
  const room = engine.createGoal("room", cas("l1", { goal: 0 }), { scope: "room:default" });
  engine.createGoal("agent", cas("l2", { goal: 0 }), { scope: "agent:sess-1" });
  const goalId = room.ok ? room.result.goalId : "";
  const cleared = engine.clearGoal(cas("l3", { goal: 1 }), { scope: "room:default" });
  assert.equal(cleared.ok, true);
  assert.ok(cleared.ok && cleared.result.clearedGoalId === goalId);
  assert.equal(engine.getGoal(undefined, "room:default").goal, undefined, "room lane is empty after clear");
  assert.equal(engine.getGoal(undefined, "agent:sess-1").goal?.goal.objective, "agent", "agent lane survives the room clear");
});

test("propose/complete flows are gated per scope (the bench-vs-music production bug)", () => {
  const { engine } = makeHarness();
  // the bench campaign goal (local, half-done → NOT completion-ready)
  assert.equal(engine.createGoal("bench campaign with open todos", cas("m1", { goal: 0 })).ok, true);
  assert.equal(engine.addTodos([{ input: { title: "still running" } }], cas("m2", { graph: 0 })).ok, true);
  // the music goal completes cleanly in its own lane (one DONE todo —
  // an empty tree is a no-ship blocker by design)
  const music = engine.createGoal("music model tests", cas("m3", { goal: 0 }), { scope: "agent:music-1" });
  assert.equal(music.ok, true);
  const musicGoalId = music.ok ? music.result.goalId : "";
  assert.equal(engine.addTodos([{ input: { title: "test 4 music models" } }], cas("m3b", { graph: 0 }), { scope: "agent:music-1" }).ok, true);
  assert.equal(engine.resolveTodo({ todoPath: "1" }, "complete", {}, cas("m3c", { goal: 1, graph: 1 }), { scope: "agent:music-1" }).ok, true);
  assert.equal(engine.proposeCompletion(PROPOSE_INPUT, cas("m4", { goal: 1, graph: 2 }), { scope: "agent:music-1" }).ok, true, "music lane proposes despite open local todos");
  assert.equal(engine.recordOracleDecision({ verdict: "PASS", noShip: false, evidenceSummary: "verified" }, cas("m5", { goal: 2 }), { scope: "agent:music-1" }).ok, true);
  const proposalHash = engine.getGoal(musicGoalId).goal?.goal.completionProposal?.proposalHash ?? "";
  const decisionHash = engine.getGoal(musicGoalId).goal?.goal.oracleDecision?.oracleDecisionHash ?? "";
  assert.ok(proposalHash.length === 64 && decisionHash.length === 64);
  const completed = engine.completeGoal(cas("m6", { goal: 3 }), {
    expectedProposalHash: proposalHash,
    expectedOracleDecisionHash: decisionHash,
  }, { scope: "agent:music-1" });
  assert.equal(completed.ok, true, "music lane completes; the local bench campaign never blocked it");
  assert.equal(engine.getGoal(musicGoalId).goal?.goal.status, "complete");
  assert.equal(engine.getGoal().goal?.goal.status, "active", "bench campaign still active");
});
