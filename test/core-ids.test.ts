// test/core-ids.test.ts — Phase 2a id/path generation and the pure reference
// resolution matrix (TDD, red first). Mirrors zob goal-todos/reference.ts
// rejection semantics over an injected minimal index.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GoalTodoIndex } from "../src/core/types.js";
import {
  CANONICAL_GOAL_TODO_ID_PATTERN,
  adaptLegacyGoalTodoReference,
  generateGoalTodoId,
  isCanonicalGoalTodoId,
  isVisibleGoalTodoPath,
  parseGoalTodoPath,
  resolveCanonicalGoalTodoReference,
  resolveCanonicalGoalTodoReferences,
  type GoalTodoRandomBytes,
} from "../src/core/ids.js";

function seededRandomBytes(seed: number): GoalTodoRandomBytes {
  let state = seed >>> 0 || 0x9e3779b9;
  return (byteCount: number) => {
    const bytes = new Uint8Array(byteCount);
    for (let index = 0; index < byteCount; index += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      // High byte keeps the full 2^32 LCG period (the low byte has period 2^8).
      bytes[index] = (state >>> 24) & 0xff;
    }
    return bytes;
  };
}

// Entries without explicit goalId default to the index goal (goal_a).
const INDEX: GoalTodoIndex = {
  goalId: "goal_a",
  entries: [
    { id: "todo_aaaaaaaaaaaa", path: "1" },
    { id: "todo_bbbbbbbbbbbb", path: "1.2" },
    { id: "todo_cccccccccccc", path: "1.3" },
    { id: "todo_dddddddddddd", path: "2" },
    { id: "todo_eeeeeeeeeeee", path: "1.2" },
    { id: "todo_999999999999", path: "3" },
    { id: "todo_999999999999", path: "3.1" },
    { id: "todo_aaaaaaaaaaaa", path: "5", goalId: "goal_b" },
    { id: "todo_ffffffffffff", path: "1", goalId: "goal_b" },
    { id: "todo_101010101010", path: "9", goalId: "goal_c" },
    { id: "todo_101010101010", path: "9", goalId: "goal_d" },
  ],
};

test("generateGoalTodoId emits todo_ + 12 lowercase hex and stays unique across 2000 draws", () => {
  const randomBytes = seededRandomBytes(0xabcdef01);
  const seen = new Set<string>();
  for (let draw = 0; draw < 2000; draw += 1) {
    const id = generateGoalTodoId(randomBytes);
    assert.match(id, CANONICAL_GOAL_TODO_ID_PATTERN);
    assert.equal(isCanonicalGoalTodoId(id), true);
    seen.add(id);
  }
  assert.equal(seen.size, 2000);
});

test("generateGoalTodoId is deterministic for an identical injected source", () => {
  assert.equal(generateGoalTodoId(seededRandomBytes(42)), generateGoalTodoId(seededRandomBytes(42)));
});

test("generateGoalTodoId fails closed when the injected source returns short bytes", () => {
  const shortSource: GoalTodoRandomBytes = () => new Uint8Array(3);
  assert.throws(() => generateGoalTodoId(shortSource), TypeError);
});

test("isCanonicalGoalTodoId matches only the canonical shape", () => {
  assert.equal(isCanonicalGoalTodoId("todo_0123456789ab"), true);
  assert.equal(isCanonicalGoalTodoId("todo_0123456789ABC"), false);
  assert.equal(isCanonicalGoalTodoId("todo_0123456789a"), false);
  assert.equal(isCanonicalGoalTodoId("todo_0123456789abc"), false);
  assert.equal(isCanonicalGoalTodoId("0123456789ab"), false);
  assert.equal(isCanonicalGoalTodoId("todo_1.2"), false);
});

test("visible path pattern accepts positive dotted integers without leading zeros", () => {
  for (const valid of ["1", "2", "10", "1.2", "12.3.4", "2.10", "1.2.3.4.5"]) {
    assert.equal(isVisibleGoalTodoPath(valid), true, valid);
  }
});

test("visible path pattern rejects malformed paths", () => {
  for (const invalid of ["", "0", "01", "00.1", "1.", ".1", "1..2", "a", "1.a", "-1", "+1", "1.0", " 1", "1 ", "1 .2", "1,2", "todo_1.2", "0.1"]) {
    assert.equal(isVisibleGoalTodoPath(invalid), false, invalid);
  }
});

test("parseGoalTodoPath returns positive integer segments or undefined", () => {
  assert.deepEqual(parseGoalTodoPath("12.3.4"), [12, 3, 4]);
  assert.deepEqual(parseGoalTodoPath("2.10"), [2, 10]);
  assert.deepEqual(parseGoalTodoPath("1"), [1]);
  assert.equal(parseGoalTodoPath("01"), undefined);
  assert.equal(parseGoalTodoPath("1."), undefined);
  assert.equal(parseGoalTodoPath("1.0"), undefined);
});

test("exact canonical todo_id resolves", () => {
  const resolution = resolveCanonicalGoalTodoReference(INDEX, { todoId: "todo_bbbbbbbbbbbb" });
  assert.equal(resolution.code, "resolved");
  assert.equal(resolution.canonicalId, "todo_bbbbbbbbbbbb");
  assert.equal(resolution.path, "1.2");
  assert.equal(resolution.goalId, "goal_a");
  assert.equal(resolution.entry?.id, "todo_bbbbbbbbbbbb");
  assert.deepEqual(resolution.errors, []);
  assert.equal(resolution.retryPolicy, "none");
  assert.equal(resolution.candidates.length, 1);
});

test("in-goal id match wins over a cross-goal duplicate id", () => {
  const resolution = resolveCanonicalGoalTodoReference(INDEX, { todoId: "todo_aaaaaaaaaaaa" });
  assert.equal(resolution.code, "resolved");
  assert.equal(resolution.path, "1");
  assert.equal(resolution.goalId, "goal_a");
});

test("exact visible todo_path resolves", () => {
  const resolution = resolveCanonicalGoalTodoReference(INDEX, { todoPath: "1.3" });
  assert.equal(resolution.code, "resolved");
  assert.equal(resolution.canonicalId, "todo_cccccccccccc");
  assert.equal(resolution.path, "1.3");
});

test("entries without explicit goalId default to the index goal", () => {
  const minimal: GoalTodoIndex = { goalId: "goal_solo", entries: [{ id: "todo_abababababab", path: "1" }] };
  const resolution = resolveCanonicalGoalTodoReference(minimal, { todoId: "todo_abababababab" });
  assert.equal(resolution.code, "resolved");
  assert.equal(resolution.goalId, "goal_solo");
  const byPath = resolveCanonicalGoalTodoReference(minimal, { todoPath: "1" });
  assert.equal(byPath.code, "resolved");
  assert.equal(byPath.canonicalId, "todo_abababababab");
});

test("dual id+path reference resolves when both agree on the same node", () => {
  const resolution = resolveCanonicalGoalTodoReference(INDEX, { todoId: "todo_dddddddddddd", todoPath: "2" });
  assert.equal(resolution.code, "resolved");
  assert.equal(resolution.canonicalId, "todo_dddddddddddd");
  assert.equal(resolution.candidates.length, 1);
});

test("dual id+path reference fails with reference_mismatch when they disagree", () => {
  const resolution = resolveCanonicalGoalTodoReference(INDEX, { todoId: "todo_cccccccccccc", todoPath: "2" });
  assert.equal(resolution.code, "reference_mismatch");
  assert.equal(resolution.retryPolicy, "fix_input");
  assert.equal(resolution.errors[0]?.field, "references");
  assert.equal(resolution.candidates.length, 2);
});

test("cross-goal todo_id fails closed with candidates", () => {
  const resolution = resolveCanonicalGoalTodoReference(INDEX, { todoId: "todo_ffffffffffff" });
  assert.equal(resolution.code, "todo_id_cross_goal");
  assert.equal(resolution.retryPolicy, "refresh_goal_todos");
  assert.deepEqual(resolution.candidates, [{ canonicalId: "todo_ffffffffffff", goalId: "goal_b", path: "1" }]);
});

test("cross-goal todo_id reports every other-goal candidate sorted", () => {
  const resolution = resolveCanonicalGoalTodoReference(INDEX, { todoId: "todo_101010101010" });
  assert.equal(resolution.code, "todo_id_cross_goal");
  assert.deepEqual(resolution.candidates.map((candidate) => candidate.goalId), ["goal_c", "goal_d"]);
});

test("ambiguous todo_id within the goal reports candidates", () => {
  const resolution = resolveCanonicalGoalTodoReference(INDEX, { todoId: "todo_999999999999" });
  assert.equal(resolution.code, "todo_id_ambiguous");
  assert.equal(resolution.retryPolicy, "refresh_goal_todos");
  assert.deepEqual(resolution.candidates.map((candidate) => candidate.path), ["3", "3.1"]);
});

test("ambiguous todo_path within the goal suggests selecting the canonical id", () => {
  const resolution = resolveCanonicalGoalTodoReference(INDEX, { todoPath: "1.2" });
  assert.equal(resolution.code, "todo_path_ambiguous");
  assert.equal(resolution.retryPolicy, "select_canonical_id");
  assert.deepEqual(resolution.candidates.map((candidate) => candidate.canonicalId), ["todo_bbbbbbbbbbbb", "todo_eeeeeeeeeeee"]);
});

test("unknown canonical todo_id fails with todo_id_not_found", () => {
  const resolution = resolveCanonicalGoalTodoReference(INDEX, { todoId: "todo_0123456789ab" });
  assert.equal(resolution.code, "todo_id_not_found");
  assert.equal(resolution.retryPolicy, "refresh_goal_todos");
  assert.deepEqual(resolution.candidates, []);
});

test("unknown todo_path fails with todo_path_not_found", () => {
  const resolution = resolveCanonicalGoalTodoReference(INDEX, { todoPath: "4" });
  assert.equal(resolution.code, "todo_path_not_found");
  assert.equal(resolution.retryPolicy, "refresh_goal_todos");
});

test("malformed todo_id values fail with invalid_todo_id", () => {
  for (const invalid of ["todo_1", "TODO_AAAAAAAAAAAA", "todo_aaaaaaaaaaa", "todo_aaaaaaaaaaaaa", "1.2", "todo_1.2", "todo_2"]) {
    const resolution = resolveCanonicalGoalTodoReference(INDEX, { todoId: invalid });
    assert.equal(resolution.code, "invalid_todo_id", invalid);
    assert.equal(resolution.retryPolicy, "fix_input", invalid);
    assert.equal(resolution.errors[0]?.field, "todo_id", invalid);
  }
});

test("malformed todo_path values fail with invalid_todo_path", () => {
  for (const invalid of ["0", "01", "1.", "1..2", "1.0", "todo_2", " 1"]) {
    const resolution = resolveCanonicalGoalTodoReference(INDEX, { todoPath: invalid });
    assert.equal(resolution.code, "invalid_todo_path", invalid);
    assert.equal(resolution.retryPolicy, "fix_input", invalid);
    assert.equal(resolution.errors[0]?.field, "todo_path", invalid);
  }
});

test("when both references are malformed the id error is reported first", () => {
  const resolution = resolveCanonicalGoalTodoReference(INDEX, { todoId: "bad", todoPath: "0" });
  assert.equal(resolution.code, "invalid_todo_id");
  assert.equal(resolution.errors.length, 2);
});

test("missing or blank goal_id fails with missing_goal_id", () => {
  const noGoal = resolveCanonicalGoalTodoReference({ entries: INDEX.entries }, { todoId: "todo_bbbbbbbbbbbb" });
  assert.equal(noGoal.code, "missing_goal_id");
  assert.equal(noGoal.retryPolicy, "fix_input");
  assert.equal(noGoal.errors[0]?.field, "goal_id");
  const blankGoal = resolveCanonicalGoalTodoReference({ goalId: "   ", entries: INDEX.entries }, { todoPath: "1" });
  assert.equal(blankGoal.code, "missing_goal_id");
});

test("absent references fail with missing_reference", () => {
  const resolution = resolveCanonicalGoalTodoReference(INDEX, {});
  assert.equal(resolution.code, "missing_reference");
  assert.equal(resolution.retryPolicy, "fix_input");
});

test("legacy todo_<path> shorthand is rejected raw, then adapted and resolved", () => {
  const raw = resolveCanonicalGoalTodoReference(INDEX, { todoId: "todo_2" });
  assert.equal(raw.code, "invalid_todo_id");
  const adapted = adaptLegacyGoalTodoReference("todo_2");
  assert.ok(adapted);
  assert.equal(adapted.adapted, true);
  assert.equal(adapted.legacyForm, "todo_path_shorthand");
  assert.deepEqual(adapted.input, { todoPath: "2" });
  const resolved = resolveCanonicalGoalTodoReference(INDEX, adapted.input);
  assert.equal(resolved.code, "resolved");
  assert.equal(resolved.canonicalId, "todo_dddddddddddd");
});

test("adaptLegacyGoalTodoReference adapts canonical ids and bare paths, flagged adapted", () => {
  const canonical = adaptLegacyGoalTodoReference("todo_bbbbbbbbbbbb");
  assert.ok(canonical);
  assert.deepEqual(canonical, { input: { todoId: "todo_bbbbbbbbbbbb" }, adapted: true, legacyForm: "canonical_id" });

  const bare = adaptLegacyGoalTodoReference("1.3");
  assert.ok(bare);
  assert.deepEqual(bare, { input: { todoPath: "1.3" }, adapted: true, legacyForm: "bare_path" });
  const resolvedBare = resolveCanonicalGoalTodoReference(INDEX, bare.input);
  assert.equal(resolvedBare.code, "resolved");
  assert.equal(resolvedBare.canonicalId, "todo_cccccccccccc");
});

test("adaptLegacyGoalTodoReference refuses malformed legacy refs", () => {
  for (const invalid of ["", "todo_01", "todo_1.a", "nope 1.2", "TODO_1.2", "todo_", "0.1"]) {
    assert.equal(adaptLegacyGoalTodoReference(invalid), undefined, invalid);
  }
});

test("batch resolution succeeds, dedupes by id, and preserves first-seen order", () => {
  const batch = resolveCanonicalGoalTodoReferences(INDEX, [
    { todoId: "todo_bbbbbbbbbbbb" },
    { todoPath: "2" },
    { todoId: "todo_dddddddddddd", todoPath: "2" },
  ]);
  assert.equal(batch.code, "resolved");
  assert.equal(batch.retryPolicy, "none");
  assert.deepEqual(batch.errors, []);
  assert.equal(batch.resolutions.length, 3);
  assert.deepEqual(batch.canonicalIds, ["todo_bbbbbbbbbbbb", "todo_dddddddddddd"]);
  assert.deepEqual(batch.paths, ["1.2", "2"]);
  assert.equal(batch.entries.length, 2);
});

test("batch resolution fails atomically with per-item error indexes", () => {
  const batch = resolveCanonicalGoalTodoReferences(INDEX, [
    { todoPath: "1.3" },
    { todoId: "todo_0123456789ab" },
    { todoPath: "4" },
  ]);
  assert.equal(batch.code, "batch_resolution_failed");
  assert.deepEqual(batch.entries, []);
  assert.deepEqual(batch.canonicalIds, []);
  assert.deepEqual(batch.paths, []);
  assert.equal(batch.resolutions.length, 3);
  assert.equal(batch.errors.length, 2);
  assert.equal(batch.errors[0]?.index, 1);
  assert.equal(batch.errors[1]?.index, 2);
  assert.equal(batch.retryPolicy, "refresh_goal_todos");
});

test("empty batch fails with batch_resolution_failed", () => {
  const batch = resolveCanonicalGoalTodoReferences(INDEX, []);
  assert.equal(batch.code, "batch_resolution_failed");
  assert.equal(batch.errors[0]?.code, "missing_reference");
  assert.equal(batch.errors[0]?.field, "batch");
  assert.equal(batch.retryPolicy, "fix_input");
});

test("batch retry policy escalates to fix_input on malformed items and select_canonical_id on ambiguity", () => {
  const malformed = resolveCanonicalGoalTodoReferences(INDEX, [{ todoId: "bad" }]);
  assert.equal(malformed.retryPolicy, "fix_input");
  const ambiguous = resolveCanonicalGoalTodoReferences(INDEX, [{ todoPath: "1.2" }]);
  assert.equal(ambiguous.code, "batch_resolution_failed");
  assert.equal(ambiguous.retryPolicy, "select_canonical_id");
});

test("src/core modules stay free of filesystem, OS, env, and crypto imports", () => {
  const dot = ".";
  const forbidden = new RegExp(`node:(fs|os|crypto)|process${dot}env`);
  for (const name of ["types.ts", "ids.ts"]) {
    const sourcePath = fileURLToPath(new URL(`../../src/core/${name}`, import.meta.url));
    const source = readFileSync(sourcePath, "utf8");
    assert.doesNotMatch(source, forbidden, `${name} must stay pure`);
  }
});
