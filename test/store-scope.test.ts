// test/store-scope.test.ts — scoped GoalRecord parsing (v0.2):
// optional scope/scopeLabel keys, legacy lines without them, invalid
// rejections (charset/traversal, review P12), and strict round-trips.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGoalRecord, parseGoalStreamEvent, serializeStreamEvent } from "../src/store/events.js";
import type { GoalRecord, GoalSetEvent } from "../src/store/events.js";

const BASE: GoalRecord = {
  goalId: "goal_aaaaaaaaaaaa",
  objective: "test objective",
  status: "active",
  revision: 1,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
};

test("parseGoalRecord accepts legacy records without scope keys (v0.1 stores)", () => {
  const parsed = parseGoalRecord(BASE);
  assert.deepEqual(parsed, BASE);
  assert.equal(parsed?.scope, undefined);
  assert.equal(parsed?.scopeLabel, undefined);
});

test("parseGoalRecord accepts and preserves canonical scope + label", () => {
  for (const scope of ["local", "agent:sess-123", "room:default", "room:dev_lab.2", "agent:x_9-y"]) {
    const parsed = parseGoalRecord({ ...BASE, scope });
    assert.equal(parsed?.scope, scope, `scope ${scope} must parse`);
  }
  const labeled = parseGoalRecord({ ...BASE, scope: "agent:sess-1", scopeLabel: "agent-736fe6" });
  assert.equal(labeled?.scopeLabel, "agent-736fe6");
});

test("parseGoalRecord rejects invalid scopes (charset, traversal, wrong kind)", () => {
  for (const bad of ["Room:default", "AGENT:x", "room:", "agent:", "space id", "room:../evil", "room:" + "a".repeat(65), "team:x", 42, ""]) {
    assert.equal(parseGoalRecord({ ...BASE, scope: bad }), undefined, `scope ${JSON.stringify(bad)} must be rejected`);
  }
  for (const badLabel of ["", "x".repeat(65), "line\nbreak", 7]) {
    assert.equal(parseGoalRecord({ ...BASE, scope: "room:default", scopeLabel: badLabel }), undefined, `scopeLabel ${JSON.stringify(badLabel)} must be rejected`);
  }
});

test("goal_set events round-trip scoped records through parse + serialize", () => {
  const record = { ...BASE, scope: "room:default", scopeLabel: "default" };
  const event: GoalSetEvent = { schema: "pi-goals.goal.v1", kind: "goal_set", revision: 1, at: 1_700_000_000_000, data: { goal: record } };
  const serialized = serializeStreamEvent(event);
  const parsed = parseGoalStreamEvent(JSON.parse(serialized));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.parsed.event.kind, "goal_set");
    const data = (parsed.parsed.event as { data: { goal: unknown } }).data.goal as Record<string, unknown>;
    assert.equal(data.scope, "room:default");
    assert.equal(data.scopeLabel, "default");
  }
});
