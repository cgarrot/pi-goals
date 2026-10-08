// test/extension-scopes.test.ts — the extension adapter over scoped goals:
// scope params (local | agent | room | room:<id>), the solo default (local +
// mesh warning, review P2), $GOALS_SCOPE session default, the get_goals
// overview tool, /goal scopes + --scope commands, and the room outbox.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import goalsExtension from "../src/extension/index.js";
import type { CommandDefinition, ExtensionAPI, SessionContext, ToolDefinition, ToolResult } from "../src/extension/pi-types.js";

interface Harness {
  tools: Map<string, ToolDefinition>;
  commands: Map<string, CommandDefinition>;
  hooks: Map<string, Array<(event: unknown, ctx: SessionContext) => unknown>>;
  notifications: string[];
  ctx: SessionContext;
  stateDir: string;
}

function makeHarness(options: { mesh?: { alias: string; rooms: string[] }; env?: Record<string, string> } = {}): Harness {
  const stateDir = mkdtempSync(path.join(tmpdir(), "pi-goals-ext-scope-"));
  const runtimeDir = mkdtempSync(path.join(tmpdir(), "pi-goals-ext-scope-rt-"));
  if (options.mesh !== undefined) {
    // simulate pi-mesh's identity file: <cwd>/.mesh/identity-<sessionId>.json
    const meshDir = path.join(stateDir, ".mesh");
    mkdirSync(meshDir, { recursive: true });
    writeFileSync(
      path.join(meshDir, "identity-sess-scope.json"),
      JSON.stringify({ version: 1, sessionId: "sess-scope", alias: options.mesh.alias, rooms: options.mesh.rooms, updatedAt: new Date().toISOString() }) + "\n",
    );
  }
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, CommandDefinition>();
  const hooks = new Map<string, Array<(event: unknown, ctx: SessionContext) => unknown>>();
  const notifications: string[] = [];
  const pi: ExtensionAPI = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, def) => commands.set(name, def),
    on: (event, handler) => {
      const list = hooks.get(event) ?? [];
      list.push(handler);
      hooks.set(event, list);
    },
    appendEntry: () => {},
  };
  const ctx: SessionContext = {
    cwd: stateDir,
    sessionManager: { getSessionId: () => "sess-scope" },
    ui: {
      notify: (message) => notifications.push(message),
      setWidget: () => {},
      setStatus: () => {},
    },
  };
  let now = 1_700_000_000_000;
  let seed = 0;
  goalsExtension(pi, {
    stateDir,
    runtimeDir,
    clock: (): number => (now += 1_000),
    randomBytes: (count: number): Uint8Array => {
      const bytes = new Uint8Array(count);
      seed += 1;
      for (let index = 0; index < count; index += 1) bytes[index] = (seed * 31 + index * 17) % 256;
      return bytes;
    },
    ...(options.env !== undefined ? { pathEnv: { ...process.env, ...options.env } } : {}),
  });
  return { tools, commands, hooks, notifications, ctx, stateDir };
}

function startSession(h: Harness): void {
  const handlers = h.hooks.get("session_start");
  assert.ok(handlers !== undefined && handlers.length > 0);
  handlers[0]!(undefined, h.ctx);
}

async function callTool(h: Harness, name: string, params: Record<string, unknown>): Promise<ToolResult> {
  const tool = h.tools.get(name);
  assert.ok(tool !== undefined, `tool ${name} registered`);
  return tool.execute("tc-1", params, undefined, undefined, h.ctx);
}

async function runCommand(h: Harness, name: string, args: string): Promise<void> {
  const command = h.commands.get(name);
  assert.ok(command !== undefined, `command ${name} registered`);
  await command.handler(args, h.ctx);
}

function text(result: ToolResult): string {
  assert.ok(result.content[0] !== undefined);
  assert.equal(result.content[0]!.type, "text");
  return result.content[0]!.text;
}

function details(result: ToolResult): Record<string, unknown> {
  assert.ok(result.details !== undefined);
  return result.details!;
}

test("create_goal scope 'agent' targets agent:<sessionId> with the alias as label", async () => {
  const h = makeHarness({ mesh: { alias: "agent-736fe6", rooms: ["default"] } });
  startSession(h);
  const created = await callTool(h, "create_goal", { objective: "private lane", scope: "agent" });
  assert.match(text(created), /created goal_[a-f0-9]{12}/);
  assert.equal(details(created).scope, "agent:sess-scope");
  assert.equal(details(created).scopeLabel, "agent-736fe6");
});

test("create_goal default stays LOCAL with a mesh hint (no magic switch, review P2)", async () => {
  const h = makeHarness({ mesh: { alias: "worker-1", rooms: ["default"] } });
  startSession(h);
  const created = await callTool(h, "create_goal", { objective: "solo default" });
  const d = details(created);
  assert.equal(d.scope, undefined, "no scope persisted by default");
  assert.match(text(created), /mesh session detected/);
  // without any mesh identity: no hint at all (solo output unchanged)
  const solo = makeHarness();
  startSession(solo);
  const createdSolo = await callTool(solo, "create_goal", { objective: "pure solo" });
  assert.doesNotMatch(text(createdSolo), /mesh session detected/);
});

test("bare 'room' resolves the single joined room; 'room' with ≠1 rooms is a precise fix_input error", async () => {
  const one = makeHarness({ mesh: { alias: "w", rooms: ["default"] } });
  startSession(one);
  const created = await callTool(one, "create_goal", { objective: "room goal", scope: "room" });
  assert.equal(details(created).scope, "room:default");

  const two = makeHarness({ mesh: { alias: "w", rooms: ["a", "b"] } });
  startSession(two);
  const ambiguous = await callTool(two, "create_goal", { objective: "x", scope: "room" });
  assert.match(text(ambiguous), /ambiguous.*rooms \(a, b\)/);
  // explicit room:<id> works with multiple rooms
  const explicit = await callTool(two, "create_goal", { objective: "x", scope: "room:b" });
  assert.equal(details(explicit).scope, "room:b");
});

test("two agents coexist: local + agent goals, todos isolated per lane", async () => {
  const h = makeHarness({ mesh: { alias: "w", rooms: ["default"] } });
  startSession(h);
  await callTool(h, "create_goal", { objective: "room campaign", scope: "room" });
  await callTool(h, "create_goal", { objective: "private", scope: "agent" });
  const roomTodos = await callTool(h, "add_goal_todo", { title: "room todo", scope: "room:default" });
  assert.match(text(roomTodos), /added 1 todo/);
  const agentTodos = await callTool(h, "add_goal_todos", { todos: [{ title: "agent todo" }], scope: "agent" });
  assert.match(text(agentTodos), /added 1 todo/);
  // bare mutation now hits scope_ambiguous with named lanes
  const bare = await callTool(h, "add_goal_todo", { title: "orphan" });
  assert.match(text(bare), /scope_ambiguous/);
  assert.match(text(bare), /agent:sess-scope/);
  assert.match(text(bare), /room:default/);
});

test("get_goals lists every lane; get_goal disambiguates instead of lying", async () => {
  const h = makeHarness();
  startSession(h);
  await callTool(h, "create_goal", { objective: "local work" });
  await callTool(h, "create_goal", { objective: "room work", scope: "room:default" });
  const overview = await callTool(h, "get_goals", {});
  const body = text(overview);
  assert.match(body, /2 active \/ 2 total/);
  assert.match(body, /\[local\]/);
  assert.match(body, /\[room:default\]/);
  const bare = await callTool(h, "get_goal", {});
  assert.match(text(bare), /scope_ambiguous/);
  const scoped = await callTool(h, "get_goal", { scope: "room:default" });
  assert.match(text(scoped), /room work/);
  assert.match(text(scoped), /\[room:default\]/);
});

test("$GOALS_SCOPE=agent makes every bare call resolve the agent lane (opt-in default)", async () => {
  const h = makeHarness({ mesh: { alias: "w", rooms: ["default"] }, env: { GOALS_SCOPE: "agent" } });
  startSession(h);
  await callTool(h, "create_goal", { objective: "room lane", scope: "room" });
  await callTool(h, "create_goal", { objective: "agent lane" });
  const bare = await callTool(h, "get_goal", {});
  assert.match(text(bare), /agent lane/);
  assert.match(text(bare), /agent:sess-scope/);
  const bareTodo = await callTool(h, "add_goal_todo", { title: "goes to agent lane" });
  assert.match(text(bareTodo), /added 1 todo/);
  assert.equal((await callTool(h, "get_goal_todos", { scope: "agent:sess-scope" })).details !== undefined, true);
});

test("room-scoped create writes the outbox event file for mesh relay; local/agent do not", async () => {
  const h = makeHarness();
  startSession(h);
  await callTool(h, "create_goal", { objective: "room goal", scope: "room:default" });
  const outboxDir = path.join(h.stateDir, "outbox");
  const files = readdirSync(outboxDir);
  assert.equal(files.length, 1);
  const event = JSON.parse(readFileSync(path.join(outboxDir, files[0]!), "utf8")) as Record<string, unknown>;
  assert.equal(event.schema, "pi-goals.outbox.v1");
  assert.equal(event.kind, "goal_created");
  assert.equal(event.scope, "room:default");
  // local + agent lanes: no outbox files
  await callTool(h, "create_goal", { objective: "local goal" });
  await callTool(h, "create_goal", { objective: "agent goal", scope: "agent:sess-scope" });
  assert.equal(readdirSync(outboxDir).length, 1, "private lanes never broadcast");
});

test("/goal scopes + --scope create/status/clear drive the same engine paths", async () => {
  const h = makeHarness({ mesh: { alias: "w", rooms: ["default"] } });
  startSession(h);
  await runCommand(h, "goal", "room campaign --scope room:default");
  assert.match(h.notifications.at(-1)!, /created goal_[a-f0-9]{12} in scope room:default/);
  await runCommand(h, "goal", "private lane --scope agent");
  await runCommand(h, "goal", "scopes");
  const listing = h.notifications.at(-1)!;
  assert.match(listing, /2 active \/ 2 total/);
  assert.match(listing, /room:default/);
  assert.match(listing, /agent:sess-scope/);
  await runCommand(h, "goal", "status --scope room:default");
  assert.match(h.notifications.at(-1)!, /room campaign/);
  await runCommand(h, "todo", "add room todo --scope room:default");
  assert.match(h.notifications.at(-1)!, /added todo 1/);
  await runCommand(h, "goal", "pause maintenance window --scope room:default");
  assert.match(h.notifications.at(-1)!, /paused goal_[a-f0-9]{12}/);
  await runCommand(h, "goal", "resume back online --scope room:default");
  assert.match(h.notifications.at(-1)!, /resumed goal_[a-f0-9]{12}/);
  await runCommand(h, "goal", "clear --scope room:default");
  assert.match(h.notifications.at(-1)!, /cleared goal_[a-f0-9]{12}/);
  // the agent lane survived the room clear
  await runCommand(h, "goal", "status --scope agent");
  assert.match(h.notifications.at(-1)!, /private lane/);
});

test("invalid --scope on commands notifies instead of crashing", async () => {
  const h = makeHarness();
  startSession(h);
  await runCommand(h, "goal", "x --scope bogusvalue");
  assert.match(h.notifications.at(-1)!, /scope must be/);
});
