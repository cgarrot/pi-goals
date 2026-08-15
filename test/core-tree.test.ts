// test/core-tree.test.ts — Phase 2c pure goal-TODO tree operations (TDD, red first).
//
// Under test: src/core/tree.ts — addGoalTodoNode/addGoalTodoNodes (atomic
// batch)/updateGoalTodoNodeMetadata/splitGoalTodoNode/reopenGoalTodoNode/
// summarizeGoalTodos/validateGoalTodoGraph over readonly GoalTodoNode[],
// distilled from zob goal-todos/operations.ts (add/split/patch graph logic)
// and goal-todos/formatting.ts (summarizeGoalTodos), with the zob
// persistence shell (pi.appendEntry / HarnessRuntimeState) stripped.
//
// Semantics under test (zob mirror + documented deviations):
//   - visible path = 1-based position among siblings in stable insertion
//     order; root children 1..N; children N.M...
//   - depth bound: node depth (root = 1) must satisfy depth <= maxDepth
//     (off-by-one boundary: exactly maxDepth is allowed)
//   - fanout bound: sibling count <= maxFanout, applied uniformly including
//     root level (zob left root breadth uncapped; deviation D-T2)
//   - batch adds are atomic: any failing item fails the whole batch
//   - metadata patches can never touch status (Phase 2b owns transitions)
//   - split appends subtodos AFTER existing siblings
//   - reopen delegates the status change to the 2b transition engine and
//     keeps paths stable

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONABLE_STATUSES,
  ACTIVE_STATUSES,
  DEFAULT_TREE_POLICY,
  OPEN_REQUIRED_STATUSES,
  addGoalTodoNode,
  addGoalTodoNodes,
  normalizeTreePolicy,
  reopenGoalTodoNode,
  splitGoalTodoNode,
  summarizeGoalTodos,
  updateGoalTodoNodeMetadata,
  validateGoalTodoGraph,
} from "../src/core/tree.js";
import type {
  AddGoalTodoNodeInput,
  GoalTodoNodeMetadataPatch,
  GoalTodoGraphIssue,
  GoalTodoSummary,
  TreeOpError,
  TreeOpResult,
  TreeOpSuccess,
  TreePolicy,
} from "../src/core/tree.js";
import type { GoalTodoRandomBytes } from "../src/core/ids.js";
import type { GoalTodoNode, GoalTodoStatus } from "../src/core/types.js";

const NOW = 1_700_000_000;
const LATER = NOW + 42;
const ID_PATTERN = /^todo_[a-f0-9]{12}$/;

/** Deterministic injected randomness: each call returns distinct bytes. */
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

function assertOk(result: TreeOpResult): TreeOpSuccess {
  assert.equal(result.ok, true, `expected success: ${JSON.stringify(result)}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value;
}

function assertErr(result: TreeOpResult): TreeOpError {
  assert.equal(result.ok, false, `expected failure: ${JSON.stringify(result)}`);
  if (result.ok) throw new Error("unreachable");
  return result.error;
}

function add(
  nodes: readonly GoalTodoNode[],
  title: string,
  extra: Partial<AddGoalTodoNodeInput> = {},
  options: { parentId?: string; policy?: TreePolicy; randomBytes?: GoalTodoRandomBytes; now?: number } = {},
): TreeOpResult {
  return addGoalTodoNode(nodes, {
    parentId: options.parentId,
    input: { title, ...extra },
    policy: options.policy,
    randomBytes: options.randomBytes ?? sequentialRandom(),
    now: options.now ?? NOW,
  });
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

function clone<T>(value: T): T {
  return structuredClone(value);
}

// ---------------------------------------------------------------------------
// Status vocabulary (zob constants mirror)
// ---------------------------------------------------------------------------

test("OPEN_REQUIRED_STATUSES mirrors zob: 9 statuses, done/skipped excluded", () => {
  assert.deepEqual(
    [...OPEN_REQUIRED_STATUSES].sort(),
    ["blocked", "claim_returned", "delegated", "in_progress", "needs_oracle", "needs_review", "needs_user", "planned", "ready"],
  );
  assert.equal(OPEN_REQUIRED_STATUSES.has("done"), false);
  assert.equal(OPEN_REQUIRED_STATUSES.has("skipped"), false);
  assert.equal(OPEN_REQUIRED_STATUSES instanceof Set, true);
});

test("ACTIVE_STATUSES mirrors zob: ready, in_progress, delegated, claim_returned, needs_review", () => {
  assert.deepEqual([...ACTIVE_STATUSES].sort(), ["claim_returned", "delegated", "in_progress", "needs_review", "ready"]);
});

test("ACTIONABLE_STATUSES mirrors zob: 7 statuses", () => {
  assert.deepEqual(
    [...ACTIONABLE_STATUSES].sort(),
    ["blocked", "in_progress", "needs_oracle", "needs_review", "needs_user", "planned", "ready"],
  );
});

// ---------------------------------------------------------------------------
// TreePolicy defaults and normalization
// ---------------------------------------------------------------------------

test("DEFAULT_TREE_POLICY mirrors zob goal policy caps: depth 6, fanout 8, batch 80", () => {
  assert.deepEqual(DEFAULT_TREE_POLICY, { maxDepth: 6, maxFanout: 8, maxBatch: 80 });
  assert.equal(Object.isFrozen(DEFAULT_TREE_POLICY), true);
});

test("normalizeTreePolicy fills safe defaults for missing or invalid values", () => {
  assert.deepEqual(normalizeTreePolicy(undefined), { maxDepth: 6, maxFanout: 8, maxBatch: 80 });
  assert.deepEqual(normalizeTreePolicy({}), { maxDepth: 6, maxFanout: 8, maxBatch: 80 });
  assert.deepEqual(normalizeTreePolicy({ maxDepth: 3 }), { maxDepth: 3, maxFanout: 8, maxBatch: 80 });
  for (const bad of [0, -2, 2.5, Number.NaN, Number.POSITIVE_INFINITY, "3", null]) {
    const policy = normalizeTreePolicy({ maxDepth: bad as unknown as number });
    assert.equal(policy.maxDepth, 6, `maxDepth ${String(bad)} falls back to default`);
    assert.ok(Number.isSafeInteger(policy.maxDepth) && policy.maxDepth > 0);
  }
  const clamped = normalizeTreePolicy({ maxFanout: 1, maxBatch: 1 });
  assert.deepEqual(clamped, { maxDepth: 6, maxFanout: 1, maxBatch: 1 });
});

// ---------------------------------------------------------------------------
// addGoalTodoNode — path computation matrix
// ---------------------------------------------------------------------------

test("addGoalTodoNode computes 1-based root paths in stable insertion order", () => {
  const random = sequentialRandom();
  const first = assertOk(addGoalTodoNode([], { input: { title: "A" }, randomBytes: random, now: NOW }));
  const second = assertOk(addGoalTodoNode(first.nodes, { input: { title: "B" }, randomBytes: random, now: NOW }));
  const third = assertOk(addGoalTodoNode(second.nodes, { input: { title: "C" }, randomBytes: random, now: NOW }));
  assert.equal(first.nodes[0]!.path, "1");
  assert.equal(second.nodes[1]!.path, "2");
  assert.equal(third.nodes[2]!.path, "3");
  assert.equal(third.nodes.length, 3);
});

test("addGoalTodoNode computes nested dotted paths by 1-based sibling position", () => {
  const random = sequentialRandom();
  const options = (input: AddGoalTodoNodeInput, parentId?: string) => ({ input, parentId, randomBytes: random, now: NOW });
  const a = assertOk(addGoalTodoNode([], options({ title: "A" })));
  const b = assertOk(addGoalTodoNode(a.nodes, options({ title: "B" })));
  const aId = a.nodes[0]!.id;
  const bId = b.nodes[1]!.id;

  const a1 = assertOk(addGoalTodoNode(b.nodes, options({ title: "A.1" }, aId)));
  assert.equal(a1.nodes.at(-1)!.path, "1.1");
  const a2 = assertOk(addGoalTodoNode(a1.nodes, options({ title: "A.2" }, aId)));
  assert.equal(a2.nodes.at(-1)!.path, "1.2");
  const b1 = assertOk(addGoalTodoNode(a2.nodes, options({ title: "B.1" }, bId)));
  assert.equal(b1.nodes.at(-1)!.path, "2.1");
  const a11 = assertOk(addGoalTodoNode(b1.nodes, options({ title: "A.1.1" }, a1.nodes.at(-1)!.id)));
  assert.equal(a11.nodes.at(-1)!.path, "1.1.1");
  const c = assertOk(addGoalTodoNode(a11.nodes, options({ title: "C" })));
  assert.equal(c.nodes.at(-1)!.path, "3");
  // a late child of A still continues A's own numbering, independent of B/C
  const a3 = assertOk(addGoalTodoNode(c.nodes, options({ title: "A.3" }, aId)));
  assert.equal(a3.nodes.at(-1)!.path, "1.3");
  assert.equal(a3.nodes.length, 8);
});

test("addGoalTodoNode applies zob defaults: planned/agent/required/normal, now timestamps, canonical id", () => {
  const added = assertOk(add([], "First"));
  const node = added.nodes[0]!;
  assert.equal(node.title, "First");
  assert.equal(node.status, "planned");
  assert.equal(node.owner, "agent");
  assert.equal(node.required, true);
  assert.equal(node.priority, "normal");
  assert.deepEqual(node.acceptanceCriteria, []);
  assert.deepEqual(node.evidenceRefs, []);
  assert.deepEqual(node.validationCommands, []);
  assert.equal(node.createdAt, NOW);
  assert.equal(node.updatedAt, NOW);
  assert.equal(node.parentId, undefined);
  assert.match(node.id, ID_PATTERN);
  assert.equal(added.changed, true);
  assert.equal(added.created?.length, 1);
  assert.equal(added.created![0]!.id, node.id);
});

test("addGoalTodoNode honors explicit input overrides and trims the title", () => {
  const added = assertOk(add([], "  Padded  ", {
    status: "ready",
    owner: "user",
    required: false,
    priority: "critical",
    acceptanceCriteria: ["ac1"],
    evidenceRefs: ["ev1"],
    validationCommands: ["cmd1"],
  }));
  const node = added.nodes[0]!;
  assert.equal(node.title, "Padded");
  assert.equal(node.status, "ready");
  assert.equal(node.owner, "user");
  assert.equal(node.required, false);
  assert.equal(node.priority, "critical");
  assert.deepEqual(node.acceptanceCriteria, ["ac1"]);
  assert.deepEqual(node.evidenceRefs, ["ev1"]);
  assert.deepEqual(node.validationCommands, ["cmd1"]);
});

test("addGoalTodoNode returns a new array and never mutates the input nodes", () => {
  const base = assertOk(add([], "A")).nodes;
  const snapshot = clone(base);
  const grown = assertOk(add(base, "B"));
  assert.notEqual(grown.nodes, base);
  assert.equal(grown.nodes.length, base.length + 1);
  assert.deepEqual(base, snapshot);
  // created nodes are frozen immutable
  assert.equal(Object.isFrozen(grown.nodes[1]), true);
});

test("addGoalTodoNode rejects blank titles with invalid_title", () => {
  for (const title of ["", "   ", "\t\n"]) {
    const error = assertErr(add([], title));
    assert.equal(error.code, "invalid_title", JSON.stringify(title));
  }
  const missing = assertErr(addGoalTodoNode([], { input: {} as AddGoalTodoNodeInput, randomBytes: sequentialRandom(), now: NOW }));
  assert.equal(missing.code, "invalid_title");
});

test("addGoalTodoNode rejects unknown parents with parent_not_found", () => {
  const error = assertErr(add([], "Orphan", {}, { parentId: "todo_000000000000" }));
  assert.equal(error.code, "parent_not_found");
  assert.match(error.message, /todo_000000000000/);
});

test("addGoalTodoNode enforces the depth boundary: exactly maxDepth allowed, maxDepth+1 rejected", () => {
  const policy: TreePolicy = { maxDepth: 3, maxFanout: 8, maxBatch: 80 };
  const random = sequentialRandom();
  const level1 = assertOk(addGoalTodoNode([], { input: { title: "d1" }, policy, randomBytes: random, now: NOW }));
  const level2 = assertOk(addGoalTodoNode(level1.nodes, { input: { title: "d2" }, parentId: level1.nodes[0]!.id, policy, randomBytes: random, now: NOW }));
  const level3 = assertOk(addGoalTodoNode(level2.nodes, { input: { title: "d3" }, parentId: level2.nodes.at(-1)!.id, policy, randomBytes: random, now: NOW }));
  assert.equal(level3.nodes.at(-1)!.path, "1.1.1");
  const tooDeep = assertErr(addGoalTodoNode(level3.nodes, { input: { title: "d4" }, parentId: level3.nodes.at(-1)!.id, policy, randomBytes: random, now: NOW }));
  assert.equal(tooDeep.code, "depth_exceeded");
  assert.match(tooDeep.message, /maxDepth=3/);
});

test("addGoalTodoNode enforces the depth boundary with the default zob policy (6)", () => {
  const random = sequentialRandom();
  let nodes: readonly GoalTodoNode[] = [];
  let parent: string | undefined;
  for (let level = 1; level <= 6; level += 1) {
    const step = assertOk(addGoalTodoNode(nodes, { input: { title: `L${level}` }, parentId: parent, randomBytes: random, now: NOW }));
    nodes = step.nodes;
    parent = step.nodes.at(-1)!.id;
  }
  assert.equal(nodes.length, 6);
  assert.equal(nodes.at(-1)!.path, "1.1.1.1.1.1");
  const error = assertErr(addGoalTodoNode(nodes, { input: { title: "L7" }, parentId: parent, randomBytes: random, now: NOW }));
  assert.equal(error.code, "depth_exceeded");
});

test("addGoalTodoNode enforces the fanout boundary: maxFanout siblings allowed, one more rejected", () => {
  const policy: TreePolicy = { maxDepth: 6, maxFanout: 2, maxBatch: 80 };
  const random = sequentialRandom();
  const first = assertOk(addGoalTodoNode([], { input: { title: "A" }, policy, randomBytes: random, now: NOW }));
  const parent = first.nodes[0]!.id;
  const child1 = assertOk(addGoalTodoNode(first.nodes, { input: { title: "c1" }, parentId: parent, policy, randomBytes: random, now: NOW }));
  const child2 = assertOk(addGoalTodoNode(child1.nodes, { input: { title: "c2" }, parentId: parent, policy, randomBytes: random, now: NOW }));
  assert.equal(child2.nodes.at(-1)!.path, "1.2");
  const child3 = assertErr(addGoalTodoNode(child2.nodes, { input: { title: "c3" }, parentId: parent, policy, randomBytes: random, now: NOW }));
  assert.equal(child3.code, "fanout_exceeded");
  assert.match(child3.message, /maxFanout=2/);
});

test("addGoalTodoNode applies maxFanout uniformly at root level too (deviation D-T2)", () => {
  const policy: TreePolicy = { maxDepth: 6, maxFanout: 2, maxBatch: 80 };
  const random = sequentialRandom();
  const one = assertOk(addGoalTodoNode([], { input: { title: "r1" }, policy, randomBytes: random, now: NOW }));
  const two = assertOk(addGoalTodoNode(one.nodes, { input: { title: "r2" }, policy, randomBytes: random, now: NOW }));
  const three = assertErr(addGoalTodoNode(two.nodes, { input: { title: "r3" }, policy, randomBytes: random, now: NOW }));
  assert.equal(three.code, "fanout_exceeded");
});

test("addGoalTodoNode retries id generation when the random source collides", () => {
  // first two calls return identical bytes (guaranteed collision on the
  // second node), later calls vary so the retry succeeds
  let call = 0;
  const flaky: GoalTodoRandomBytes = (count: number) => {
    const bytes = new Uint8Array(count);
    const base = call < 2 ? 0 : 100 + call * 13;
    for (let index = 0; index < count; index += 1) {
      bytes[index] = (base + index) % 256;
    }
    call += 1;
    return bytes;
  };
  const first = assertOk(addGoalTodoNode([], { input: { title: "A" }, randomBytes: flaky, now: NOW }));
  const second = assertOk(addGoalTodoNode(first.nodes, { input: { title: "B" }, randomBytes: flaky, now: NOW }));
  assert.notEqual(second.nodes[1]!.id, second.nodes[0]!.id);
  assert.match(second.nodes[1]!.id, ID_PATTERN);
});

// ---------------------------------------------------------------------------
// addGoalTodoNodes — atomic batch (zob add_goal_todos semantics)
// ---------------------------------------------------------------------------

test("addGoalTodoNodes assigns sequential 1-based paths per parent across a mixed batch", () => {
  const random = sequentialRandom();
  const base = assertOk(addGoalTodoNode([], { input: { title: "A" }, randomBytes: random, now: NOW }));
  const aId = base.nodes[0]!.id;
  const b = assertOk(addGoalTodoNode(base.nodes, { input: { title: "B" }, randomBytes: random, now: NOW }));
  const bId = b.nodes[1]!.id;
  const a1 = assertOk(addGoalTodoNode(b.nodes, { input: { title: "A.1" }, parentId: aId, randomBytes: random, now: NOW }));

  const batch = assertOk(addGoalTodoNodes(a1.nodes, {
    items: [
      { input: { title: "A.2" }, parentId: aId },
      { input: { title: "B.1" }, parentId: bId },
      { input: { title: "C" } },
      { input: { title: "A.3" }, parentId: aId },
    ],
    randomBytes: random,
    now: LATER,
  }));
  assert.equal(batch.changed, true);
  assert.equal(batch.created!.length, 4);
  assert.equal(batch.nodes.length, a1.nodes.length + 4);
  const paths = batch.nodes.slice(-4).map((node) => node.path);
  assert.deepEqual(paths, ["1.2", "2.1", "3", "1.3"]);
  for (const node of batch.created!) {
    assert.equal(node.createdAt, LATER);
    assert.match(node.id, ID_PATTERN);
  }
});

test("addGoalTodoNodes is atomic: one failing item fails the batch and leaves the input untouched", () => {
  const policy: TreePolicy = { maxDepth: 6, maxFanout: 2, maxBatch: 80 };
  const random = sequentialRandom();
  const base = assertOk(addGoalTodoNode([], { input: { title: "A" }, policy, randomBytes: random, now: NOW }));
  const aId = base.nodes[0]!.id;
  const withOne = assertOk(addGoalTodoNode(base.nodes, { input: { title: "A.1" }, parentId: aId, policy, randomBytes: random, now: NOW }));
  // A is now at its fanout cap of 2 children
  const withTwo = assertOk(addGoalTodoNode(withOne.nodes, { input: { title: "A.2" }, parentId: aId, policy, randomBytes: random, now: NOW }));
  const snapshot = clone(withTwo.nodes);

  // the second item would exceed A's fanout cap: whole batch fails
  const error = assertErr(addGoalTodoNodes(withTwo.nodes, {
    items: [
      { input: { title: "root-level ok" } },
      { input: { title: "A.3" }, parentId: aId },
    ],
    policy,
    randomBytes: random,
    now: LATER,
  }));
  assert.equal(error.code, "fanout_exceeded");
  assert.deepEqual(withTwo.nodes, snapshot);

  // a bad parent mid-batch also fails atomically
  const parentError = assertErr(addGoalTodoNodes(withTwo.nodes, {
    items: [
      { input: { title: "ok" } },
      { input: { title: "orphan" }, parentId: "todo_ffffffffffff" },
    ],
    policy,
    randomBytes: random,
    now: LATER,
  }));
  assert.equal(parentError.code, "parent_not_found");
  assert.deepEqual(withTwo.nodes, snapshot);

  // a blank title mid-batch fails atomically
  const titleError = assertErr(addGoalTodoNodes(withTwo.nodes, {
    items: [{ input: { title: "ok" } }, { input: { title: "   " } }],
    policy,
    randomBytes: random,
    now: LATER,
  }));
  assert.equal(titleError.code, "invalid_title");
  assert.deepEqual(withTwo.nodes, snapshot);
});

test("addGoalTodoNodes rejects empty batches and batches over maxBatch", () => {
  const random = sequentialRandom();
  const empty = assertErr(addGoalTodoNodes([], { items: [], randomBytes: random, now: NOW }));
  assert.equal(empty.code, "empty_batch");

  const policy: TreePolicy = { maxDepth: 6, maxFanout: 80, maxBatch: 3 };
  const tooLarge = assertErr(addGoalTodoNodes([], {
    items: [
      { input: { title: "1" } },
      { input: { title: "2" } },
      { input: { title: "3" } },
      { input: { title: "4" } },
    ],
    policy,
    randomBytes: random,
    now: NOW,
  }));
  assert.equal(tooLarge.code, "batch_too_large");
  assert.match(tooLarge.message, /maxBatch=3/);

  // exactly maxBatch items is allowed
  const atCap = assertOk(addGoalTodoNodes([], {
    items: [
      { input: { title: "1" } },
      { input: { title: "2" } },
      { input: { title: "3" } },
    ],
    policy,
    randomBytes: random,
    now: NOW,
  }));
  assert.equal(atCap.nodes.length, 3);
});

// ---------------------------------------------------------------------------
// updateGoalTodoNodeMetadata — status never patchable
// ---------------------------------------------------------------------------

test("updateGoalTodoNodeMetadata patches title/priority/owner/required/evidence fields and bumps updatedAt", () => {
  const base = assertOk(add([], "Original", { acceptanceCriteria: ["old"], evidenceRefs: ["e0"] })).nodes;
  const id = base[0]!.id;
  const patched = assertOk(updateGoalTodoNodeMetadata(base, id, {
    title: "  Renamed  ",
    priority: "high",
    owner: "oracle",
    required: false,
    acceptanceCriteria: ["ac-new"],
    evidenceRefs: ["e0", "e1"],
    validationCommands: ["npm test"],
  }, { now: LATER }));
  assert.equal(patched.changed, true);
  const node = patched.nodes[0]!;
  assert.equal(node.title, "Renamed");
  assert.equal(node.priority, "high");
  assert.equal(node.owner, "oracle");
  assert.equal(node.required, false);
  assert.deepEqual(node.acceptanceCriteria, ["ac-new"]);
  assert.deepEqual(node.evidenceRefs, ["e0", "e1"]);
  assert.deepEqual(node.validationCommands, ["npm test"]);
  assert.equal(node.updatedAt, LATER);
  assert.equal(node.createdAt, NOW);
  assert.equal(node.status, "planned");
  assert.equal(node.path, "1");
  // immutability: input untouched, new node object
  assert.notEqual(node, base[0]);
  assert.equal(base[0]!.title, "Original");
  assert.equal(base[0]!.updatedAt, NOW);
  assert.equal(patched.updated!.id, id);
});

test("updateGoalTodoNodeMetadata copies patch arrays defensively", () => {
  const base = assertOk(add([], "A")).nodes;
  const criteria = ["ac1"];
  const patched = assertOk(updateGoalTodoNodeMetadata(base, base[0]!.id, { acceptanceCriteria: criteria }, { now: LATER }));
  criteria.push("mutated-after");
  assert.deepEqual(patched.nodes[0]!.acceptanceCriteria, ["ac1"]);
});

test("updateGoalTodoNodeMetadata rejects status changes: the 2b transition engine owns status", () => {
  const base = assertOk(add([], "A")).nodes;
  for (const status of ["done", "ready", "blocked"] as GoalTodoStatus[]) {
    const error = assertErr(updateGoalTodoNodeMetadata(base, base[0]!.id, { status } as unknown as GoalTodoNodeMetadataPatch, { now: LATER }));
    assert.equal(error.code, "status_change_forbidden", status);
    assert.match(error.message, /transition/i);
  }
});

test("updateGoalTodoNodeMetadata rejects identity field patches", () => {
  const base = assertOk(add([], "A")).nodes;
  const id = base[0]!.id;
  for (const patch of [
    { id: "todo_000000000001" },
    { path: "9" },
    { parentId: "todo_000000000002" },
    { createdAt: 1 },
    { updatedAt: 1 },
  ]) {
    const error = assertErr(updateGoalTodoNodeMetadata(base, id, patch as unknown as GoalTodoNodeMetadataPatch, { now: LATER }));
    assert.equal(error.code, "field_not_patchable", JSON.stringify(patch));
  }
});

test("updateGoalTodoNodeMetadata rejects blank titles and unknown ids", () => {
  const base = assertOk(add([], "A")).nodes;
  const blank = assertErr(updateGoalTodoNodeMetadata(base, base[0]!.id, { title: "   " }, { now: LATER }));
  assert.equal(blank.code, "invalid_title");
  const missing = assertErr(updateGoalTodoNodeMetadata(base, "todo_ffffffffffff", { title: "X" }, { now: LATER }));
  assert.equal(missing.code, "todo_not_found");
});

test("updateGoalTodoNodeMetadata reports changed=false for no-op patches and keeps the array reference", () => {
  const base = assertOk(add([], "A", { priority: "high" })).nodes;
  const untouched = assertOk(updateGoalTodoNodeMetadata(base, base[0]!.id, {}, { now: LATER }));
  assert.equal(untouched.changed, false);
  assert.equal(untouched.nodes, base);
  const sameValues = assertOk(updateGoalTodoNodeMetadata(base, base[0]!.id, { title: "A", priority: "high" }, { now: LATER }));
  assert.equal(sameValues.changed, false);
  assert.equal(sameValues.nodes, base);
  assert.equal(base[0]!.updatedAt, NOW);
});

// ---------------------------------------------------------------------------
// splitGoalTodoNode — subtodos appended after existing siblings
// ---------------------------------------------------------------------------

test("splitGoalTodoNode appends subtodos after existing siblings with inherited zob defaults", () => {
  const random = sequentialRandom();
  const base = assertOk(addGoalTodoNode([], { input: { title: "Parent", priority: "critical" }, randomBytes: random, now: NOW }));
  const parentId = base.nodes[0]!.id;
  const withChild = assertOk(addGoalTodoNode(base.nodes, { input: { title: "Existing child" }, parentId, randomBytes: random, now: NOW }));

  const split = assertOk(splitGoalTodoNode(withChild.nodes, parentId, [" New one ", "", "  ", "New two"], {
    policy: undefined,
    randomBytes: random,
    now: LATER,
  }));
  assert.equal(split.changed, true);
  assert.equal(split.created!.length, 2);
  const appended = split.nodes.slice(-2);
  assert.deepEqual(appended.map((node) => node.path), ["1.2", "1.3"]);
  for (const child of appended) {
    assert.equal(child.parentId, parentId);
    assert.equal(child.required, true);
    assert.equal(child.priority, "critical");
    assert.equal(child.owner, "agent");
    assert.equal(child.status, "planned");
    assert.equal(child.createdAt, LATER);
    assert.match(child.id, ID_PATTERN);
  }
  assert.equal(appended[0]!.title, "New one");
  assert.equal(appended[1]!.title, "New two");
});

test("splitGoalTodoNode rejects blank title lists, unknown parents, and policy violations", () => {
  const random = sequentialRandom();
  const base = assertOk(addGoalTodoNode([], { input: { title: "Parent" }, randomBytes: random, now: NOW }));
  const parentId = base.nodes[0]!.id;

  const noTitles = assertErr(splitGoalTodoNode(base.nodes, parentId, ["  ", ""], { randomBytes: random, now: LATER }));
  assert.equal(noTitles.code, "split_titles_required");

  const missing = assertErr(splitGoalTodoNode(base.nodes, "todo_ffffffffffff", ["x"], { randomBytes: random, now: LATER }));
  assert.equal(missing.code, "todo_not_found");

  const fanoutPolicy: TreePolicy = { maxDepth: 6, maxFanout: 3, maxBatch: 80 };
  const withChildren = [
    ...base.nodes,
    handNode({ id: "todo_a00000000001", path: "1.1", parentId }),
    handNode({ id: "todo_a00000000002", path: "1.2", parentId }),
  ];
  const fanoutError = assertErr(splitGoalTodoNode(withChildren, parentId, ["c3", "c4"], { policy: fanoutPolicy, randomBytes: random, now: LATER }));
  assert.equal(fanoutError.code, "fanout_exceeded");
  assert.match(fanoutError.message, /maxFanout=3/);

  const depthPolicy: TreePolicy = { maxDepth: 2, maxFanout: 8, maxBatch: 80 };
  const childOfParent = [...base.nodes, handNode({ id: "todo_b00000000001", path: "1.1", parentId })];
  const depthError = assertErr(splitGoalTodoNode(childOfParent, childOfParent[1]!.id, ["deep"], { policy: depthPolicy, randomBytes: random, now: LATER }));
  assert.equal(depthError.code, "depth_exceeded");
  // input untouched after failures
  assert.equal(withChildren.length, 3);
});

// ---------------------------------------------------------------------------
// reopenGoalTodoNode — 2b transition engine integration, stable paths
// ---------------------------------------------------------------------------

test("reopenGoalTodoNode reopens done/skipped/blocked nodes to ready with stable paths", () => {
  for (const status of ["done", "skipped", "blocked"] as const) {
    const base = assertOk(add([], `A-${status}`, { status })).nodes;
    const id = base[0]!.id;
    const reopened = assertOk(reopenGoalTodoNode(base, id, { reason: "back to work", now: LATER }));
    assert.equal(reopened.changed, true, status);
    const node = reopened.nodes[0]!;
    assert.equal(node.status, "ready", status);
    assert.equal(node.path, "1", status);
    assert.equal(node.updatedAt, LATER, status);
    assert.equal(reopened.updated!.id, id);
    assert.equal(base[0]!.status, status);
  }
});

test("reopenGoalTodoNode delegates rejections to the 2b transition engine", () => {
  const base = assertOk(add([], "A", { status: "in_progress" })).nodes;
  const invalid = assertErr(reopenGoalTodoNode(base, base[0]!.id, { reason: "try", now: LATER }));
  assert.equal(invalid.code, "transition_rejected");
  assert.equal(invalid.transition!.code, "invalid_transition");
  assert.equal(invalid.transition!.retryPolicy, "never");
  assert.equal(base[0]!.status, "in_progress");

  const done = assertOk(add([], "B", { status: "done" })).nodes;
  const noReason = assertErr(reopenGoalTodoNode(done, done[0]!.id, { reason: "   ", now: LATER }));
  assert.equal(noReason.code, "transition_rejected");
  assert.equal(noReason.transition!.code, "reason_required");

  const missing = assertErr(reopenGoalTodoNode(done, "todo_ffffffffffff", { reason: "x", now: LATER }));
  assert.equal(missing.code, "todo_not_found");
});

// ---------------------------------------------------------------------------
// summarizeGoalTodos — zob-compatible counts
// ---------------------------------------------------------------------------

function buildRepresentativeTree(): readonly GoalTodoNode[] {
  const random = sequentialRandom();
  const step = (nodes: readonly GoalTodoNode[], input: AddGoalTodoNodeInput, parentId?: string) =>
    assertOk(addGoalTodoNode(nodes, { input, parentId, randomBytes: random, now: NOW })).nodes;

  let nodes: readonly GoalTodoNode[] = [];
  nodes = step(nodes, { title: "A", status: "in_progress", required: true }); // 1
  const a = nodes[0]!.id;
  nodes = step(nodes, { title: "A.1", status: "done", required: true }, a); // 1.1
  nodes = step(nodes, { title: "A.2", status: "blocked", required: true }, a); // 1.2
  nodes = step(nodes, { title: "A.3", status: "planned", required: false }, a); // 1.3
  nodes = step(nodes, { title: "B", status: "skipped", required: false }); // 2
  nodes = step(nodes, { title: "C", status: "delegated", required: true }); // 3
  nodes = step(nodes, { title: "D", status: "claim_returned", required: true }); // 4
  nodes = step(nodes, { title: "E", status: "needs_user", owner: "user", required: true }); // 5
  nodes = step(nodes, { title: "F", status: "done", priority: "critical", required: false }); // 6
  return nodes;
}

test("summarizeGoalTodos produces zob-compatible counts on a representative tree", () => {
  const summary: GoalTodoSummary = summarizeGoalTodos(buildRepresentativeTree());
  assert.equal(summary.total, 9);
  assert.equal(summary.required, 6);
  assert.equal(summary.done, 2);
  assert.equal(summary.skipped, 1);
  // open counts status-based (zob semantics), regardless of required
  assert.equal(summary.open, 6); // A, A.2, A.3, C, D, E
  assert.equal(summary.active, 3); // A (in_progress), C (delegated), D (claim_returned)
  assert.equal(summary.inProgress, 1);
  assert.equal(summary.delegated, 1);
  assert.equal(summary.claimReturned, 1);
  assert.deepEqual(summary.perStatus, {
    planned: 1,
    ready: 0,
    in_progress: 1,
    delegated: 1,
    claim_returned: 1,
    needs_review: 0,
    needs_oracle: 0,
    needs_user: 1,
    blocked: 1,
    done: 2,
    skipped: 1,
  });
  assert.equal(summary.maxDepth, 2);
  assert.ok(Math.abs(summary.progress - 3 / 9) < 1e-12, `progress ${summary.progress}`);
  assert.equal(summary.blocked.length, 1);
  assert.equal(summary.blocked[0]!.path, "1.2");
  assert.equal(summary.blocked[0]!.title, "A.2");
  assert.equal(summary.blocked[0]!.status, "blocked");
  // next actionable: A has open children; A.3 (agent-owned planned leaf) wins
  assert.equal(summary.nextActionableTodo!.path, "1.3");
  assert.equal(summary.nextActionableTodo!.title, "A.3");
  assert.equal(summary.nextActionableTodo!.owner, "agent");
});

test("summarizeGoalTodos prefers the first agent candidate without open children, else falls back", () => {
  // agent candidates: root (in_progress, has open child) then leaf (ready, no children)
  const random = sequentialRandom();
  let nodes = assertOk(addGoalTodoNode([], { input: { title: "Root", status: "in_progress" }, randomBytes: random, now: NOW })).nodes;
  const rootId = nodes[0]!.id;
  nodes = assertOk(addGoalTodoNode(nodes, { input: { title: "Leaf", status: "ready" }, parentId: rootId, randomBytes: random, now: NOW })).nodes;
  assert.equal(summarizeGoalTodos(nodes).nextActionableTodo!.path, "1.1");

  // zob find semantics: first agent candidate with no OPEN DIRECT children wins,
  // so the deepest open leaf (Leaf.1) is picked over Root and Leaf
  const deep = assertOk(addGoalTodoNode(nodes, { input: { title: "Leaf.1", status: "planned" }, parentId: nodes[1]!.id, randomBytes: random, now: NOW })).nodes;
  assert.equal(summarizeGoalTodos(deep).nextActionableTodo!.path, "1.1.1");

  // the ?? first-candidate fallback only triggers when EVERY agent candidate
  // has an open direct child, i.e. a cyclic graph
  const cyclic = [
    handNode({ id: "todo_900000000001", path: "1", status: "planned", parentId: "todo_900000000002" }),
    handNode({ id: "todo_900000000002", path: "1.1", status: "planned", parentId: "todo_900000000001" }),
  ];
  const summary = summarizeGoalTodos(cyclic);
  assert.equal(summary.nextActionableTodo!.path, "1");

  // no agent candidates at all -> user candidate fallback (zob nextUser rule)
  const userOnly = [handNode({ id: "todo_c00000000001", path: "1", status: "needs_user", owner: "user" })];
  assert.equal(summarizeGoalTodos(userOnly).nextActionableTodo!.path, "1");
});

test("summarizeGoalTodos on an empty tree returns zeroed counts", () => {
  const summary = summarizeGoalTodos([]);
  assert.equal(summary.total, 0);
  assert.equal(summary.required, 0);
  assert.equal(summary.done, 0);
  assert.equal(summary.skipped, 0);
  assert.equal(summary.open, 0);
  assert.equal(summary.active, 0);
  assert.equal(summary.inProgress, 0);
  assert.equal(summary.delegated, 0);
  assert.equal(summary.claimReturned, 0);
  assert.equal(summary.maxDepth, 0);
  assert.equal(summary.progress, 0);
  assert.deepEqual(summary.blocked, []);
  assert.equal(summary.nextActionableTodo, undefined);
  assert.equal(Object.values(summary.perStatus).reduce((sum, count) => sum + count, 0), 0);
});

// ---------------------------------------------------------------------------
// validateGoalTodoGraph
// ---------------------------------------------------------------------------

test("validateGoalTodoGraph returns no issues for a healthy tree", () => {
  const issues = validateGoalTodoGraph(buildRepresentativeTree());
  assert.deepEqual([...issues], []);
});

test("validateGoalTodoGraph detects duplicate ids, missing parents, and cycles", () => {
  const duplicate = validateGoalTodoGraph([
    handNode({ id: "todo_d00000000001", path: "1" }),
    handNode({ id: "todo_d00000000001", path: "2" }),
  ]);
  assert.equal(duplicate.some((issue: GoalTodoGraphIssue) => issue.code === "duplicate_id"), true);

  const missingParent = validateGoalTodoGraph([
    handNode({ id: "todo_d00000000002", path: "1", parentId: "todo_ghost000000" }),
  ]);
  assert.equal(missingParent[0]!.code, "missing_parent");

  const cycle = validateGoalTodoGraph([
    handNode({ id: "todo_d00000000003", path: "1", parentId: "todo_d00000000004" }),
    handNode({ id: "todo_d00000000004", path: "1.1", parentId: "todo_d00000000003" }),
  ]);
  assert.equal(cycle.some((issue) => issue.code === "parent_cycle"), true);
  assert.ok(cycle.every((issue) => issue.message.length > 0));
});

test("validateGoalTodoGraph flags depth and fanout policy violations with the default policy", () => {
  const tooDeep = validateGoalTodoGraph([handNode({ id: "todo_e00000000001", path: "1.1.1.1.1.1.1" })]);
  assert.equal(tooDeep[0]!.code, "depth_exceeded");
  assert.match(tooDeep[0]!.message, /maxDepth=6/);

  const parent = handNode({ id: "todo_e00000000002", path: "1" });
  const children = Array.from({ length: 9 }, (_, index) =>
    handNode({ id: `todo_f0000000000${index}`, path: `1.${index + 1}`, parentId: parent.id }));
  const fanout = validateGoalTodoGraph([parent, ...children]);
  assert.equal(fanout.some((issue) => issue.code === "fanout_exceeded"), true);
  const fanoutIssue = fanout.find((issue) => issue.code === "fanout_exceeded")!;
  assert.equal(fanoutIssue.todoId, parent.id);

  const custom = validateGoalTodoGraph([handNode({ id: "todo_e00000000003", path: "1.1" })], { maxDepth: 1, maxFanout: 8, maxBatch: 80 });
  assert.equal(custom[0]!.code, "depth_exceeded");
});
