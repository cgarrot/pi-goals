// test/extension.test.ts — Phase 5 TDD (red first): the Pi extension adapter
// over the Phase-4 GoalRuntimeEngine, using a FAKE ExtensionAPI (pi-mesh
// extension.test.ts pattern — zero real Pi imports).
//
// Under test: src/extension/{pi-types,index,tools,commands,hud,session-mirror}.ts.
// The extension must stay a THIN adapter: param validation -> engine call ->
// formatted result (one-liner + details). Tools/commands register immediately
// and answer blocked-style errors before session_start (pi-mesh I10).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import goalsExtension from "../src/extension/index.js";
import type { GoalsRuntime } from "../src/extension/tools.js";
import { GOALS_WIDGET_ID, renderGoalHudLines, type GoalHudState } from "../src/extension/hud.js";
import type { CommandDefinition, ExtensionAPI, SessionContext, ToolDefinition, ToolResult } from "../src/extension/pi-types.js";
import { createRuntimeGoalEngine } from "../src/runtime/engine.js";

const EXPECTED_TOOLS = [
  "accept_goal_todo_claim",
  "add_goal_todo",
  "add_goal_todos",
  "block_goal_todo",
  "complete_goal_todo",
  "create_goal",
  "get_goal",
  "get_goals",
  "get_goal_todos",
  "link_goal_todo_delegation",
  "propose_goal_completion",
  "record_goal_oracle",
  "reject_goal_todo_claim",
  "resolve_goal_todo",
  "resume_goal",
  "return_goal_todo_claim",
  "split_goal_todo",
  "update_goal",
  "update_goal_todo",
  "validate_goal_todo_claim",
];

interface FakeHarness {
  tools: Map<string, ToolDefinition>;
  commands: Map<string, CommandDefinition>;
  hooks: Map<string, Array<(event: unknown, ctx: SessionContext) => unknown>>;
  entries: Array<{ type: string; data?: unknown }>;
  notifications: string[];
  widgets: Map<string, string[] | undefined>;
  statuses: Map<string, string | undefined>;
  ctx: SessionContext;
  stateDir: string;
  runtimeDir: string;
  getRuntime: () => GoalsRuntime | null;
}

function fakeClock(): { clock: () => number } {
  let now = 1_700_000_000_000;
  return { clock: (): number => (now += 1_000) };
}

function fakeRandom(): (count: number) => Uint8Array {
  let seed = 0;
  return (count: number): Uint8Array => {
    seed += 1;
    const bytes = new Uint8Array(count);
    for (let index = 0; index < count; index += 1) bytes[index] = (seed * 31 + index * 17) % 256;
    return bytes;
  };
}

function makeHarness(appendEntry?: (customType: string, data?: unknown) => void): FakeHarness {
  const stateDir = mkdtempSync(path.join(tmpdir(), "pi-goals-ext-state-"));
  const runtimeDir = mkdtempSync(path.join(tmpdir(), "pi-goals-ext-runtime-"));
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const hooks = new Map<string, Array<(event: unknown, ctx: SessionContext) => unknown>>();
  const entries: Array<{ type: string; data?: unknown }> = [];
  const pi: ExtensionAPI = {
    registerTool: (tool) => {
      tools.set(tool.name, tool);
    },
    registerCommand: (name, def) => {
      commands.set(name, def);
    },
    on: (event, handler) => {
      const list = hooks.get(event) ?? [];
      list.push(handler);
      hooks.set(event, list);
    },
    appendEntry: appendEntry ?? ((type, data) => {
      entries.push({ type, data });
    }),
  };
  const notifications: string[] = [];
  const widgets = new Map<string, string[] | undefined>();
  const statuses = new Map<string, string | undefined>();
  const ctx: SessionContext = {
    cwd: stateDir,
    sessionManager: { getSessionId: () => "sess-test" },
    ui: {
      notify: (message) => {
        notifications.push(message);
      },
      setWidget: (id, content) => {
        widgets.set(id, content);
      },
      setStatus: (id, text) => {
        statuses.set(id, text);
      },
    },
  };
  const { clock } = fakeClock();
  const ext = goalsExtension(pi, {
    stateDir,
    runtimeDir,
    clock,
    randomBytes: fakeRandom(),
  });
  return {
    tools,
    commands,
    hooks,
    entries,
    notifications,
    widgets,
    statuses,
    ctx,
    stateDir,
    runtimeDir,
    getRuntime: ext.getRuntime,
  };
}

function startSession(h: FakeHarness): void {
  const handlers = h.hooks.get("session_start");
  assert.ok(handlers !== undefined && handlers.length > 0, "session_start handler registered");
  handlers[0]!(undefined, h.ctx);
}

async function callTool(h: FakeHarness, name: string, params: Record<string, unknown>): Promise<ToolResult> {
  const tool = h.tools.get(name);
  assert.ok(tool !== undefined, `tool ${name} registered`);
  return tool.execute("tc-1", params, undefined, undefined, h.ctx);
}

function text(result: ToolResult): string {
  assert.ok(result.content[0] !== undefined);
  assert.equal(result.content[0]!.type, "text");
  return result.content[0]!.text;
}

function details(result: ToolResult): Record<string, unknown> {
  assert.ok(result.details !== undefined, "result has details");
  return result.details!;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Registration inventory
// ---------------------------------------------------------------------------

test("registers exactly the 20 zob-named tools (incl. delegation pair + get_goals) plus /goal and /todo commands; no import_* tools", () => {
  const h = makeHarness();
  assert.deepEqual([...h.tools.keys()].sort(), [...EXPECTED_TOOLS].sort());
  assert.equal(h.tools.size, 20);
  assert.ok(h.commands.has("goal"), "/goal command registered");
  assert.ok(h.commands.has("todo"), "/todo command registered");
  for (const name of h.tools.keys()) {
    assert.ok(!name.startsWith("import_"), `no import_* tool registered (got ${name})`);
  }
  for (const tool of h.tools.values()) {
    assert.ok(tool.description.length > 0, `${tool.name} has a description`);
    assert.equal(typeof tool.parameters, "object", `${tool.name} has JSON-schema parameters`);
  }
});

// ---------------------------------------------------------------------------
// Offline / lifecycle
// ---------------------------------------------------------------------------

test("tools answer blocked: session_not_started before session_start, and again after session_shutdown", async () => {
  const h = makeHarness();
  const before = await callTool(h, "get_goal", {});
  assert.match(text(before), /^blocked: session_not_started/);
  assert.equal(details(before).status, "blocked");

  startSession(h);
  const during = await callTool(h, "get_goal", {});
  assert.doesNotMatch(text(during), /^blocked/);

  const shutdown = h.hooks.get("session_shutdown");
  assert.ok(shutdown !== undefined && shutdown.length > 0, "session_shutdown handler registered");
  await shutdown[0]!(undefined, h.ctx);
  const after = await callTool(h, "get_goal", {});
  assert.match(text(after), /^blocked: session_not_started/);
  assert.equal(h.widgets.get(GOALS_WIDGET_ID), undefined, "HUD widget cleared on shutdown");
});

test("no-active-goal paths: get_goal answers honestly, mutations surface goal_missing", async () => {
  const h = makeHarness();
  startSession(h);
  const view = await callTool(h, "get_goal", {});
  assert.match(text(view), /no active goal/);
  assert.equal(details(view).status, "no_goal");

  const add = await callTool(h, "add_goal_todo", { title: "orphan", cas: { mutation_id: "n1", expected_graph_revision: 0 } });
  assert.match(text(add), /goal_missing/);
  assert.equal(details(add).code, "goal_missing");

  const complete = await callTool(h, "update_goal", {
    status: "complete",
    expected_proposal_hash: sha256("p"),
    expected_oracle_decision_hash: sha256("o"),
    cas: { mutation_id: "n2", expected_goal_revision: 0 },
  });
  assert.match(text(complete), /goal_missing/);
});

// ---------------------------------------------------------------------------
// Happy path through the TOOLS (not the engine directly)
// ---------------------------------------------------------------------------

test("happy path: create_goal -> add_goal_todos -> complete_goal_todo x2 -> propose_goal_completion -> record_goal_oracle -> update_goal complete", async () => {
  const h = makeHarness();
  startSession(h);

  const created = await callTool(h, "create_goal", {
    objective: "Ship the pi-goals extension adapter",
    cas: { mutation_id: "t-create-1", expected_goal_revision: 0 },
  });
  assert.match(text(created), /^created goal_[a-f0-9]+ \(status active/);
  assert.equal(details(created).status, "applied");
  const casEcho = details(created).cas as Record<string, unknown>;
  assert.equal(casEcho.mutation_id, "t-create-1");
  assert.equal(casEcho.status, "applied");
  assert.equal(casEcho.bodyStored, false);
  const goalId = details(created).goalId as string;
  assert.match(goalId, /^goal_[a-f0-9]{12}$/);

  const added = await callTool(h, "add_goal_todos", {
    todos: [{ title: "Write adapter" }, { title: "Test adapter" }],
    cas: { mutation_id: "t-add-1", expected_graph_revision: 0 },
  });
  assert.match(text(added), /added 2 todo\(s\)/);
  const addedDetails = details(added);
  assert.equal((addedDetails.summary as Record<string, unknown>).total, 2);
  assert.equal(addedDetails.todosRevision, 1);
  assert.equal((addedDetails.created as unknown[]).length, 2);

  const resolvedOne = await callTool(h, "complete_goal_todo", {
    todo_path: "1",
    cas: { mutation_id: "t-res-1", expected_graph_revision: 1 },
  });
  assert.match(text(resolvedOne), /todo 1 .*done/);
  const resolvedTwo = await callTool(h, "complete_goal_todo", {
    todo_path: "2",
    cas: { mutation_id: "t-res-2", expected_graph_revision: 2 },
  });
  assert.match(text(resolvedTwo), /done/);

  const proposed = await callTool(h, "propose_goal_completion", {
    completion_summary: "Adapter shipped with tests",
    requirements_checked: ["17 tools registered"],
    evidence_refs: ["test/extension.test.ts"],
    validation_commands: ["npm test"],
    known_risks: [],
    no_ship: false,
    cas: { mutation_id: "t-prop-1", expected_goal_revision: 1, expected_graph_revision: 3 },
  });
  assert.match(text(proposed), /proposal ready/);
  const proposalHash = details(proposed).proposalHash as string;
  assert.match(proposalHash, /^[a-f0-9]{64}$/);

  const oracle = await callTool(h, "record_goal_oracle", {
    verdict: "PASS",
    no_ship: false,
    evidence_summary: "strict pass with build+test green",
    evidence_refs: ["npm test"],
    expected_proposal_hash: proposalHash,
    cas: { mutation_id: "t-orc-1", expected_goal_revision: 2, expected_graph_revision: 3 },
  });
  assert.match(text(oracle), /oracle PASS recorded/);
  const decisionHash = details(oracle).oracleDecisionHash as string;
  assert.match(decisionHash, /^[a-f0-9]{64}$/);

  const completed = await callTool(h, "update_goal", {
    status: "complete",
    expected_proposal_hash: proposalHash,
    expected_oracle_decision_hash: decisionHash,
    cas: { mutation_id: "t-done-1", expected_goal_revision: 3, expected_graph_revision: 3 },
  });
  assert.match(text(completed), new RegExp(`goal ${goalId} complete`));

  // After completion the goal is no longer ACTIVE: the bare get_goal answers
  // "no active goal"; the explicit goal_id read shows the complete state.
  const bare = await callTool(h, "get_goal", {});
  assert.match(text(bare), /no active goal/);
  const view = await callTool(h, "get_goal", { goal_id: goalId });
  assert.match(text(view), /complete/);
  assert.equal(details(view).goalId, goalId);
  assert.equal(details(view).status, "complete");
});

// ---------------------------------------------------------------------------
// CAS param plumbing
// ---------------------------------------------------------------------------

test("cas plumbing: mutation_id echoed, stale revision -> cas_stale with staleCodes, exact replay -> replayed, conflicting replay -> cas_conflict", async () => {
  const h = makeHarness();
  startSession(h);
  const setup = await callTool(h, "create_goal", { objective: "cas flow", cas: { mutation_id: "m1", expected_goal_revision: 0 } });
  assert.match(text(setup), /^created goal_/);

  const stale = await callTool(h, "add_goal_todos", {
    todos: [{ title: "t" }],
    cas: { mutation_id: "m2", expected_graph_revision: 5 },
  });
  assert.match(text(stale), /cas_stale/);
  assert.deepEqual(details(stale).staleCodes, ["stale_graph_revision"]);
  assert.equal(details(stale).retryPolicy, "after_context_change");

  const applied = await callTool(h, "add_goal_todos", {
    todos: [{ title: "t" }],
    cas: { mutation_id: "m2", expected_graph_revision: 0 },
  });
  assert.equal(details(applied).status, "applied");

  const replayed = await callTool(h, "add_goal_todos", {
    todos: [{ title: "t" }],
    cas: { mutation_id: "m2", expected_graph_revision: 0 },
  });
  assert.equal(details(replayed).status, "replayed");
  assert.equal((details(replayed).cas as Record<string, unknown>).status, "replayed");
  assert.match(text(replayed), /replayed/);

  const conflict = await callTool(h, "add_goal_todos", {
    todos: [{ title: "different" }],
    cas: { mutation_id: "m2", expected_graph_revision: 1 },
  });
  assert.match(text(conflict), /cas_conflict/);
  assert.equal(details(conflict).code, "cas_conflict");
  assert.equal(details(conflict).retryPolicy, "never");
});

// ---------------------------------------------------------------------------
// fix_input validation messages
// ---------------------------------------------------------------------------

test("fix_input validation names the exact invalid parameter", async () => {
  const h = makeHarness();
  startSession(h);

  const noObjective = await callTool(h, "create_goal", { objective: "", cas: { mutation_id: "x1", expected_goal_revision: 0 } });
  assert.match(text(noObjective), /fix_input/);
  assert.equal(details(noObjective).parameter, "objective");

  const badStatus = await callTool(h, "update_goal", { status: "paused" });
  assert.match(text(badStatus), /fix_input/);
  assert.equal(details(badStatus).parameter, "status");

  const badHash = await callTool(h, "update_goal", {
    status: "complete",
    expected_proposal_hash: "zz",
    expected_oracle_decision_hash: "zz",
    cas: { mutation_id: "x2", expected_goal_revision: 0 },
  });
  assert.equal(details(badHash).parameter, "expected_proposal_hash");

  const statusOnTodo = await callTool(h, "update_goal_todo", {
    todo_path: "1",
    status: "done",
    cas: { mutation_id: "x3", expected_graph_revision: 0 },
  });
  assert.equal(details(statusOnTodo).parameter, "status");
  assert.match(text(statusOnTodo), /resolve_goal_todo/);

  const badCas = await callTool(h, "create_goal", { objective: "x", cas: { mutation_id: "", expected_goal_revision: 0 } });
  assert.equal(details(badCas).parameter, "cas.mutation_id");
});

// ---------------------------------------------------------------------------
// Claim tools: strict-PASS composition surface
// ---------------------------------------------------------------------------

test("claim tools expose the strict-PASS composition (fixture built via the engine, surface via tools)", async () => {
  const h = makeHarness();
  startSession(h);

  // Fixture: two delegated todos with returned claims (engine-direct setup,
  // not the surface under test).
  const setup = createRuntimeGoalEngine({
    stateDir: h.stateDir,
    runtimeDir: h.runtimeDir,
    clock: fakeClock().clock,
    randomBytes: fakeRandom(),
  });
  const created = setup.createGoal("claims flow", { mutationId: "s1", expectedGoalRevision: 0 });
  assert.ok(created.ok);
  const added = setup.addTodos([{ input: { title: "strict work" } }, { input: { title: "warn work" } }], { mutationId: "s2", expectedGraphRevision: 0 });
  assert.ok(added.ok);
  const linkedA = setup.linkDelegation({ todoPath: "1" }, { runId: "run-a", agent: "child-a", validationPolicy: "oracle_required" }, { mutationId: "s3", expectedGraphRevision: 1 });
  assert.ok(linkedA.ok);
  const attemptA = linkedA.result.attempt.attemptId;
  const returnedA = setup.returnClaim(attemptA, { claimText: "strict work done", noShip: false }, { mutationId: "s4", expectedGraphRevision: 2 });
  assert.ok(returnedA.ok);
  const claimHashA = returnedA.result.claim.claimHash;
  const linkedB = setup.linkDelegation({ todoPath: "2" }, { runId: "run-b", agent: "child-b", validationPolicy: "oracle_required" }, { mutationId: "s5", expectedGraphRevision: 3 });
  assert.ok(linkedB.ok);
  const attemptB = linkedB.result.attempt.attemptId;
  const returnedB = setup.returnClaim(attemptB, { claimText: "warn work done", noShip: false }, { mutationId: "s6", expectedGraphRevision: 4 });
  assert.ok(returnedB.ok);

  const validated = await callTool(h, "validate_goal_todo_claim", {
    todo_path: "1",
    claim_hash: claimHashA,
    expected_attempt_id: attemptA,
    expected_validation_policy: "oracle_required",
    verdict: "PASS",
    recommended_action: "accept_claim",
    no_ship: false,
    confidence: "HIGH",
    blocking_issues: [],
    output_hash: sha256("output-a"),
    evidence_refs: ["reports/x"],
    validation_commands: ["npm test"],
    cas: { mutation_id: "v1", expected_graph_revision: 5 },
  });
  assert.match(text(validated), /autoAccept true/);
  const vd = details(validated);
  assert.equal(vd.autoAccept, true);
  assert.deepEqual(vd.failures, []);
  const claimRule = vd.claimRule as Record<string, unknown>;
  assert.equal(claimRule.autoAccept, true);

  const warned = await callTool(h, "validate_goal_todo_claim", {
    todo_path: "2",
    claim_hash: returnedB.result.claim.claimHash,
    expected_attempt_id: attemptB,
    expected_validation_policy: "oracle_required",
    verdict: "WARN",
    recommended_action: "needs_review",
    no_ship: false,
    confidence: "MEDIUM",
    output_hash: sha256("output-b"),
    cas: { mutation_id: "v2", expected_graph_revision: 5 },
  });
  assert.match(text(warned), /autoAccept false/);
  const wd = details(warned);
  assert.equal(wd.autoAccept, false);
  assert.ok((wd.failures as string[]).includes("verdict"));

  const accepted = await callTool(h, "accept_goal_todo_claim", {
    todo_path: "1",
    expected_claim_hash: claimHashA,
    expected_attempt_id: attemptA,
    expected_validation_policy: "oracle_required",
    cas: { mutation_id: "a1", expected_graph_revision: 5 },
  });
  assert.match(text(accepted), /accepted/);
  const ad = details(accepted);
  const settlement = ad.settlement as Record<string, unknown>;
  assert.equal(settlement.settlement, "accepted");
  assert.equal(settlement.claimHash, claimHashA);
  const composition = ad.claimComposition as Record<string, unknown>;
  assert.equal(composition.oracleStrictPass, false, "no goal-level oracle bound -> honest composition");

  const bindingMiss = await callTool(h, "validate_goal_todo_claim", {
    todo_path: "1",
    claim_hash: sha256("wrong-claim"),
    expected_attempt_id: attemptA,
    expected_validation_policy: "oracle_required",
    verdict: "PASS",
    recommended_action: "accept_claim",
    no_ship: false,
    confidence: "HIGH",
    output_hash: sha256("output"),
    cas: { mutation_id: "v3", expected_graph_revision: 6 },
  });
  assert.equal(details(bindingMiss).parameter, "claim_hash");
});

// ---------------------------------------------------------------------------
// split_goal_todo
// ---------------------------------------------------------------------------

test("split_goal_todo adds children under the resolved parent through the engine batch API", async () => {
  const h = makeHarness();
  startSession(h);
  await callTool(h, "create_goal", { objective: "split flow", cas: { mutation_id: "sp0", expected_goal_revision: 0 } });
  await callTool(h, "add_goal_todo", { title: "parent", cas: { mutation_id: "sp1", expected_graph_revision: 0 } });

  const split = await callTool(h, "split_goal_todo", {
    todo_path: "1",
    titles: ["child one", "child two"],
    cas: { mutation_id: "sp2", expected_graph_revision: 1 },
  });
  assert.match(text(split), /split todo 1 into 2 child/);
  const createdChildren = details(split).created as Array<Record<string, unknown>>;
  assert.equal(createdChildren.length, 2);
  assert.equal(createdChildren[0]!.todo_path, "1.1");
  assert.equal(createdChildren[1]!.todo_path, "1.2");
});

// ---------------------------------------------------------------------------
// /goal and /todo commands
// ---------------------------------------------------------------------------

test("/goal and /todo command parsing delegates to the same engine calls", async () => {
  const h = makeHarness();
  startSession(h);
  const goal = h.commands.get("goal")!;
  const todo = h.commands.get("todo")!;

  await goal.handler("", h.ctx);
  assert.match(h.notifications.at(-1)!, /no active goal/);
  assert.match(h.notifications.at(-1)!, /\/goal <objective>/);

  await goal.handler("Ship the extension", h.ctx);
  assert.match(h.notifications.at(-1)!, /created goal_[a-f0-9]+/);

  await todo.handler("add First todo", h.ctx);
  assert.match(h.notifications.at(-1)!, /added todo 1/);
  await todo.handler("add Second todo", h.ctx);
  assert.match(h.notifications.at(-1)!, /added todo 2/);

  await callTool(h, "complete_goal_todo", { todo_path: "2", cas: { mutation_id: "cmd-res-1", expected_graph_revision: 2 } });
  await todo.handler("", h.ctx);
  const tree = h.notifications.at(-1)!;
  assert.match(tree, /1\/2 done/);
  assert.ok(tree.includes("○"), "open icon");
  assert.ok(tree.includes("✓"), "done icon");

  await goal.handler("status", h.ctx);
  assert.match(h.notifications.at(-1)!, /objective: Ship the extension/);
  assert.match(h.notifications.at(-1)!, /todos: 1\/2 done/);

  await goal.handler("resume nothing changed", h.ctx);
  assert.match(h.notifications.at(-1)!, /goal_status_invalid/);

  await goal.handler("pause some reason", h.ctx);
  assert.match(h.notifications.at(-1)!, /paused goal_/);
  assert.match(h.notifications.at(-1)!, /was active/);

  await goal.handler("mode manual", h.ctx);
  assert.match(h.notifications.at(-1)!, /manual/);
  await goal.handler("mode bogus", h.ctx);
  assert.match(h.notifications.at(-1)!, /usage/i);

  await goal.handler("clear", h.ctx);
  assert.match(h.notifications.at(-1)!, /cleared goal_/);
  await goal.handler("", h.ctx);
  assert.match(h.notifications.at(-1)!, /no active goal/);
});

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

test("HUD renders the compact progress line with a goal and hides without one", async () => {
  const withGoal: GoalHudState = { hasGoal: true, status: "active", mode: "auto", done: 7, total: 12, open: 5, blocked: 0 };
  assert.deepEqual(renderGoalHudLines(withGoal), ["◆ goals: 7/12 done · open 5 · blocked 0"]);
  const withoutGoal: GoalHudState = { hasGoal: false, status: "none", mode: "auto", done: 0, total: 0, open: 0, blocked: 0 };
  assert.deepEqual(renderGoalHudLines(withoutGoal), []);

  const h = makeHarness();
  startSession(h);
  assert.equal(h.widgets.get(GOALS_WIDGET_ID), undefined, "widget hidden without active goal");

  await callTool(h, "create_goal", { objective: "hud flow", cas: { mutation_id: "hud1", expected_goal_revision: 0 } });
  await callTool(h, "add_goal_todos", {
    todos: [{ title: "a" }, { title: "b" }],
    cas: { mutation_id: "hud2", expected_graph_revision: 0 },
  });
  const widget = h.widgets.get(GOALS_WIDGET_ID);
  assert.ok(widget !== undefined && widget.length > 0, "widget rendered after mutations");
  assert.match(widget[0]!, /^◆ goals: 0\/2 done · open 2 · blocked 0/);
  const status = h.statuses.get("goals");
  assert.ok(status !== undefined && status.includes("0/2"), "footer status set");
});

// ---------------------------------------------------------------------------
// session-mirror
// ---------------------------------------------------------------------------

test("session-mirror: appendEntry success mirrors body-free entries; failures never break tools", async () => {
  const ok = makeHarness();
  startSession(ok);
  const created = await callTool(ok, "create_goal", { objective: "mirror ok", cas: { mutation_id: "mir1", expected_goal_revision: 0 } });
  assert.match(text(created), /^created goal_/);
  const mirrored = ok.entries.filter((entry) => entry.type === "pi-goals-goal-event");
  assert.ok(mirrored.length > 0, "goal lifecycle entries mirrored");
  assert.equal((mirrored[0]!.data as Record<string, unknown>).bodyStored, false);
  assert.ok((mirrored[0]!.data as Record<string, unknown>).goalId !== undefined);

  const boom = makeHarness(() => {
    throw new Error("host exploded");
  });
  startSession(boom);
  const survived = await callTool(boom, "create_goal", { objective: "mirror boom", cas: { mutation_id: "mir2", expected_goal_revision: 0 } });
  assert.match(text(survived), /^created goal_/, "tool still succeeds when appendEntry throws");
  const rt = boom.getRuntime();
  assert.ok(rt !== null);
  assert.equal(rt.mirrorFailures, 1, "mirror failure counted");
});
