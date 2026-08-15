// test/core-completion.test.ts — Phase 2c pure completion diagnostics (TDD, red first).
//
// Under test: src/core/completion.ts — evaluateGoalTodoCompletion +
// formatGoalTodoBlockers, distilled from zob goal-todos/formatting.ts
// (goalTodoCompletionBlockers / goalTodoCompletionDiagnostics), adapted to
// the pure pi-goals node shape (no delegation/claim side tables yet: those
// rules land in Phase 2d+; reviewNoShip flags arrive as injected node ids).
//
// Semantics under test (zob mirror + documented deviation):
//   - completionReady only when NO required TODO is open (planned, ready,
//     in_progress, delegated, claim_returned, needs_review, needs_oracle,
//     needs_user, blocked); optional TODOs may stay open
//   - done nodes with open REQUIRED children block (nested gating)
//   - critical/factory/orchestration done-or-skipped nodes need evidence
//   - graph validation issues surface as structured blockers
//   - hardNoShip = blockers exist; reviewNoShip = injected review flags;
//     effectiveNoShip = hard || review (deviation D-E1: also true when the
//     tree is empty — zob returned vacuous readiness for empty goals)

import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateGoalTodoCompletion, formatGoalTodoBlockers } from "../src/core/completion.js";
import type {
  GoalTodoCompletionBlocker,
  GoalTodoCompletionDiagnostics,
  GoalTodoCompletionOptions,
} from "../src/core/completion.js";
import { addGoalTodoNode, updateGoalTodoNodeMetadata, OPEN_REQUIRED_STATUSES } from "../src/core/tree.js";
import type { TreeOpResult } from "../src/core/tree.js";
import type { GoalTodoRandomBytes } from "../src/core/ids.js";
import type { GoalTodoNode, GoalTodoStatus } from "../src/core/types.js";

const NOW = 1_700_000_000;

function sequentialRandom(): GoalTodoRandomBytes {
  let call = 0;
  return (count: number) => {
    const bytes = new Uint8Array(count);
    for (let index = 0; index < count; index += 1) {
      bytes[index] = (call * 37 + index * 7) % 256;
    }
    call += 1;
    return bytes;
  };
}

function assertOk(result: TreeOpResult) {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

function build(items: (Partial<GoalTodoNode> & { title: string })[]): readonly GoalTodoNode[] {
  const random = sequentialRandom();
  let nodes: readonly GoalTodoNode[] = [];
  for (const item of items) {
    const added = assertOk(addGoalTodoNode(nodes, {
      input: {
        title: item.title,
        status: item.status,
        owner: item.owner,
        required: item.required,
        priority: item.priority,
        evidenceRefs: item.evidenceRefs,
        validationCommands: item.validationCommands,
      },
      randomBytes: random,
      now: NOW,
    }));
    nodes = added.nodes;
  }
  return nodes;
}

function handNode(partial: Partial<GoalTodoNode> & { id: string; path: string }): GoalTodoNode {
  return {
    title: "hand",
    status: "planned",
    owner: "agent",
    priority: "normal",
    required: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

function diag(nodes: readonly GoalTodoNode[], options?: GoalTodoCompletionOptions): GoalTodoCompletionDiagnostics {
  return evaluateGoalTodoCompletion(nodes, options);
}

// ---------------------------------------------------------------------------
// Empty tree (deviation D-E1)
// ---------------------------------------------------------------------------

test("empty tree: nothing is shippable — completionReady=false, effectiveNoShip=true, explicit 'todo tree is empty' blocker", () => {
  const diagnostics = diag([]);
  assert.equal(diagnostics.total, 0);
  assert.equal(diagnostics.completionReady, false);
  assert.equal(diagnostics.hardNoShip, true);
  assert.equal(diagnostics.reviewNoShip, false);
  assert.equal(diagnostics.effectiveNoShip, true);
  assert.equal(diagnostics.blockers.length, 1);
  assert.equal(diagnostics.blockers[0]!.reason, "todo tree is empty");
});

// ---------------------------------------------------------------------------
// All done / optional-open
// ---------------------------------------------------------------------------

test("all closed (done and skipped) trees are completion ready", () => {
  const diagnostics = diag(build([
    { title: "A", status: "done" },
    { title: "B", status: "done", required: true, evidenceRefs: ["r1"] },
    { title: "C", status: "skipped", required: true },
  ]));
  assert.equal(diagnostics.total, 3);
  assert.equal(diagnostics.completionReady, true);
  assert.equal(diagnostics.hardNoShip, false);
  assert.equal(diagnostics.reviewNoShip, false);
  assert.equal(diagnostics.effectiveNoShip, false);
  assert.deepEqual([...diagnostics.blockers], []);
});

test("open OPTIONAL todos never block completion (required-vs-optional semantics)", () => {
  for (const status of ["planned", "in_progress", "blocked", "delegated", "needs_user"] as const) {
    const diagnostics = diag(build([
      { title: "required done", status: "done", required: true, evidenceRefs: ["e"] },
      { title: "optional open", status, required: false },
    ]));
    assert.equal(diagnostics.completionReady, true, status);
    assert.equal(diagnostics.hardNoShip, false, status);
    assert.deepEqual([...diagnostics.blockers], [], status);
  }
});

// ---------------------------------------------------------------------------
// Required-open gating per status
// ---------------------------------------------------------------------------

test("every open status on a REQUIRED todo blocks completion with a structured blocker", () => {
  for (const status of OPEN_REQUIRED_STATUSES) {
    const tree = build([{ title: "the one", status, required: true }]);
    const diagnostics = diag(tree);
    assert.equal(diagnostics.completionReady, false, status);
    assert.equal(diagnostics.hardNoShip, true, status);
    assert.equal(diagnostics.effectiveNoShip, true, status);
    const blocker = diagnostics.blockers[0] as GoalTodoCompletionBlocker | undefined;
    assert.ok(blocker, status);
    assert.equal(blocker!.todoId, tree[0]!.id, status);
    assert.equal(blocker!.path, "1", status);
    assert.equal(blocker!.title, "the one", status);
    assert.equal(blocker!.status, status, status);
    assert.match(blocker!.reason, new RegExp(`required and ${status}`, "i"));
  }
  assert.equal([...OPEN_REQUIRED_STATUSES].length, 9);
});

test("required done or required skipped (normal priority, with no evidence rule hit) do not block", () => {
  const diagnostics = diag(build([
    { title: "done", status: "done", required: true },
    { title: "skipped", status: "skipped", required: true, priority: "low" },
  ]));
  assert.equal(diagnostics.completionReady, true);
  assert.deepEqual([...diagnostics.blockers], []);
});

test("blocked REQUIRED todo produces hardNoShip", () => {
  const tree = build([{ title: "stuck", status: "blocked", required: true }]);
  const diagnostics = diag(tree);
  assert.equal(diagnostics.hardNoShip, true);
  assert.equal(diagnostics.completionReady, false);
  assert.equal(diagnostics.requiredOpen, 1);
  assert.match(diagnostics.blockers[0]!.reason, /required and blocked/);
});

test("delegated and claim_returned REQUIRED todos block completion", () => {
  for (const status of ["delegated", "claim_returned", "needs_review", "needs_oracle", "needs_user"] as const) {
    const diagnostics = diag(build([{ title: "held", status, required: true }]));
    assert.equal(diagnostics.completionReady, false, status);
    assert.equal(diagnostics.requiredOpen, 1, status);
    assert.equal(diagnostics.blockers.length, 1, status);
  }
});

// ---------------------------------------------------------------------------
// Nested subtodos gating the root
// ---------------------------------------------------------------------------

test("a done root with an open REQUIRED child is blocked by both root and child", () => {
  const random = sequentialRandom();
  const root = assertOk(addGoalTodoNode([], { input: { title: "Root", status: "done", required: true, evidenceRefs: ["e"] }, randomBytes: random, now: NOW }));
  const child = assertOk(addGoalTodoNode(root.nodes, { input: { title: "Child", status: "planned", required: true }, parentId: root.nodes[0]!.id, randomBytes: random, now: NOW }));
  const diagnostics = diag(child.nodes);
  assert.equal(diagnostics.completionReady, false);
  assert.equal(diagnostics.hardNoShip, true);
  const reasons = diagnostics.blockers.map((blocker) => blocker.reason);
  assert.ok(reasons.some((reason) => reason.includes("open required child")), reasons.join(" | "));
  assert.ok(reasons.some((reason) => reason.includes("required and planned")), reasons.join(" | "));
  const rootBlocker = diagnostics.blockers.find((blocker) => blocker.path === "1")!;
  assert.equal(rootBlocker.todoId, root.nodes[0]!.id);
  assert.equal(rootBlocker.status, "done");
});

test("a done root with only open OPTIONAL children stays completion ready", () => {
  const random = sequentialRandom();
  const root = assertOk(addGoalTodoNode([], { input: { title: "Root", status: "done", required: true, evidenceRefs: ["e"] }, randomBytes: random, now: NOW }));
  const withChild = assertOk(addGoalTodoNode(root.nodes, { input: { title: "Child", status: "in_progress", required: false }, parentId: root.nodes[0]!.id, randomBytes: random, now: NOW }));
  const diagnostics = diag(withChild.nodes);
  assert.equal(diagnostics.completionReady, true);
  assert.deepEqual([...diagnostics.blockers], []);
});

// ---------------------------------------------------------------------------
// Evidence rule (zob requireEvidenceForCritical mirror)
// ---------------------------------------------------------------------------

test("critical done or skipped nodes without evidence block completion", () => {
  const noEvidence = diag(build([{ title: "crit", status: "done", priority: "critical", required: true }]));
  assert.equal(noEvidence.completionReady, false);
  assert.match(noEvidence.blockers[0]!.reason, /done without evidence/);

  const skippedCritical = diag(build([{ title: "crit", status: "skipped", priority: "critical", required: true }]));
  assert.equal(skippedCritical.completionReady, false);
  assert.match(skippedCritical.blockers[0]!.reason, /skipped without evidence/);
});

test("evidenceRefs or validationCommands satisfy the critical evidence rule", () => {
  const withRefs = diag(build([{ title: "crit", status: "done", priority: "critical", evidenceRefs: ["reports/x.md"] }]));
  assert.equal(withRefs.completionReady, true);
  const withCommands = diag(build([{ title: "crit", status: "done", priority: "critical", validationCommands: ["npm test"] }]));
  assert.equal(withCommands.completionReady, true);
});

test("factory and orchestration owners need evidence; normal agent work does not", () => {
  for (const owner of ["factory", "orchestration"] as const) {
    const diagnostics = diag(build([{ title: "auto", status: "done", owner }]));
    assert.equal(diagnostics.completionReady, false, owner);
    assert.match(diagnostics.blockers[0]!.reason, /without evidence/, owner);
  }
  const plain = diag(build([{ title: "hand", status: "done", owner: "agent" }]));
  assert.equal(plain.completionReady, true);
});

test("requireEvidenceForCritical=false disables the evidence rule", () => {
  const diagnostics = diag(build([{ title: "crit", status: "done", priority: "critical" }]), { requireEvidenceForCritical: false });
  assert.equal(diagnostics.completionReady, true);
  assert.deepEqual([...diagnostics.blockers], []);
});

// ---------------------------------------------------------------------------
// reviewNoShip and effectiveNoShip combinations
// ---------------------------------------------------------------------------

test("injected reviewNoShip ids set reviewNoShip without hard blockers", () => {
  const tree = build([{ title: "done", status: "done", required: true, evidenceRefs: ["e"] }]);
  const diagnostics = diag(tree, { reviewNoShipIds: [tree[0]!.id] });
  assert.equal(diagnostics.reviewNoShip, true);
  assert.equal(diagnostics.hardNoShip, false);
  assert.equal(diagnostics.completionReady, false);
  assert.equal(diagnostics.effectiveNoShip, true);
  assert.deepEqual([...diagnostics.blockers], []);
});

test("unknown reviewNoShip ids are ignored", () => {
  const diagnostics = diag(build([{ title: "done", status: "done", required: true }]), { reviewNoShipIds: ["todo_ffffffffffff"] });
  assert.equal(diagnostics.reviewNoShip, false);
  assert.equal(diagnostics.completionReady, true);
});

test("effectiveNoShip combinations keep the invariant completionReady === !effectiveNoShip", () => {
  const cleanTree = build([{ title: "done", status: "done", required: true, evidenceRefs: ["e"] }]);
  const hardTree = build([{ title: "open", status: "planned", required: true }]);
  const scenarios: Array<Record<string, unknown> & { diagnostics: GoalTodoCompletionDiagnostics }> = [
    { label: "clean", diagnostics: diag(cleanTree) },
    { label: "hard-only", diagnostics: diag(hardTree) },
    { label: "review-only", diagnostics: diag(cleanTree, { reviewNoShipIds: [cleanTree[0]!.id] }) },
    { label: "hard+review", diagnostics: diag(hardTree, { reviewNoShipIds: [hardTree[0]!.id] }) },
    { label: "empty", diagnostics: diag([]) },
  ];
  for (const scenario of scenarios) {
    assert.equal(
      scenario.diagnostics.completionReady,
      !scenario.diagnostics.effectiveNoShip,
      `${String(scenario.label)}: ready=${scenario.diagnostics.completionReady} effective=${scenario.diagnostics.effectiveNoShip}`,
    );
  }
  assert.equal(scenarios[1]!.diagnostics.hardNoShip, true);
  assert.equal(scenarios[1]!.diagnostics.reviewNoShip, false);
  assert.equal(scenarios[2]!.diagnostics.hardNoShip, false);
  assert.equal(scenarios[3]!.diagnostics.hardNoShip, true);
  assert.equal(scenarios[3]!.diagnostics.reviewNoShip, true);
  assert.equal(scenarios[3]!.diagnostics.effectiveNoShip, true);
});

// ---------------------------------------------------------------------------
// Graph issues surface as blockers
// ---------------------------------------------------------------------------

test("graph validation issues become structured blockers", () => {
  const cycle = [
    handNode({ id: "todo_100000000001", path: "1", status: "done", parentId: "todo_100000000002" }),
    handNode({ id: "todo_100000000002", path: "1.1", status: "done", parentId: "todo_100000000001" }),
  ];
  const diagnostics = diag(cycle);
  assert.equal(diagnostics.completionReady, false);
  assert.equal(diagnostics.hardNoShip, true);
  assert.ok(diagnostics.blockers.some((blocker) => blocker.reason.includes("cycle")));

  const duplicate = [
    handNode({ id: "todo_100000000003", path: "1", status: "done" }),
    handNode({ id: "todo_100000000003", path: "2", status: "done" }),
  ];
  const duplicateDiagnostics = diag(duplicate);
  assert.ok(duplicateDiagnostics.blockers.some((blocker) => blocker.reason.includes("duplicate")));
});

test("completion honors the injected policy for graph bounds", () => {
  const deep = [handNode({ id: "todo_100000000004", path: "1.1.1.1.1.1.1", status: "done" })];
  const withDefault = diag(deep);
  assert.equal(withDefault.completionReady, false);
  assert.ok(withDefault.blockers.some((blocker) => blocker.reason.includes("maxDepth=6")));

  const relaxed = diag(deep, { policy: { maxDepth: 8, maxFanout: 8, maxBatch: 80 } });
  assert.equal(relaxed.completionReady, true);
});

// ---------------------------------------------------------------------------
// formatGoalTodoBlockers — later tool output
// ---------------------------------------------------------------------------

test("formatGoalTodoBlockers renders one zob-style line per blocker", () => {
  const tree = build([
    { title: "stuck work", status: "blocked", required: true },
    { title: "fine", status: "done", required: false },
  ]);
  const diagnostics = diag(tree);
  const lines = formatGoalTodoBlockers(diagnostics);
  assert.equal(lines.length, diagnostics.blockers.length);
  assert.match(lines[0]!, /^todo 1 'stuck work' is required and blocked$/);
});

test("formatGoalTodoBlockers returns an empty list for clean diagnostics; the empty tree lists its explicit blocker", () => {
  const clean = diag(build([{ title: "done", status: "done", required: true, evidenceRefs: ["e"] }]));
  assert.deepEqual(formatGoalTodoBlockers(clean), []);
  // GAP-4 fix + batch-#2 cosmetic: the empty tree surfaces as an explicit
  // blocker line rendered WITHOUT the empty path/title prefix
  assert.deepEqual(formatGoalTodoBlockers(diag([])), ["todo tree is empty"]);
});

// ---------------------------------------------------------------------------
// requiredOpen counter
// ---------------------------------------------------------------------------

test("requiredOpen counts only open required todos", () => {
  const tree = build([
    { title: "r-open", status: "in_progress", required: true },
    { title: "r-open-2", status: "blocked", required: true },
    { title: "r-done", status: "done", required: true },
    { title: "opt-open", status: "planned", required: false },
  ]);
  const diagnostics = diag(tree);
  assert.equal(diagnostics.requiredOpen, 2);
  assert.equal(diagnostics.total, 4);
});

// ---------------------------------------------------------------------------
// Integration with tree ops (statuses produced by the 2b engine surface here)
// ---------------------------------------------------------------------------

test("diagnostics track a tree across its lifecycle via tree ops", () => {
  const random = sequentialRandom();
  let nodes = assertOk(addGoalTodoNode([], { input: { title: "Implement", required: true }, randomBytes: random, now: NOW })).nodes;
  assert.equal(diag(nodes).completionReady, false);

  const updated = assertOk(updateGoalTodoNodeMetadata(nodes, nodes[0]!.id, { evidenceRefs: ["cmd output"] }, { now: NOW + 1 }));
  nodes = updated.nodes;
  void updated;

  // complete via the 2b engine's reopen counterpart is Phase 2b's apply; here
  // we emulate the stored outcome by adding a done node through split+patch
  // is out of scope — metadata cannot change status. Instead: a done root.
  const doneTree = assertOk(addGoalTodoNode([], { input: { title: "Shipped", status: "done", required: true, evidenceRefs: ["e"] }, randomBytes: random, now: NOW }));
  assert.equal(diag(doneTree.nodes).completionReady, true);
});
