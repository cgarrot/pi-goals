#!/usr/bin/env node
// src/cli/goals.ts — Phase 6 standalone read-only CLI over the goals store.
//
// Dist-runnable: `node dist/src/cli/goals.js [--state-dir <dir>]
// <status|tree|list|stats|export> [goalId]` (npm run cli -- ...). Read-only:
// status/tree reuse engine.getGoal (the SAME restore path the extension
// uses, overlay included); list/stats/export reuse restoreAllGoals plus the
// canonical store path helpers. The CLI adds NO business logic — only
// argument parsing and output shaping. Honest errors and uniform exit codes
// (batch-#2 fix): 0 ok; 1 store/runtime failure (restore-blocked, missing
// store); 2 usage errors (unknown command/flag, bad arguments — usage hint
// on stderr). A missing store answers "no goal exists", a restore-blocked
// store prints its diagnostics and exits 1 (fail-closed, never a partial
// view), and list/stats/export print a stderr warning when the quarantine
// directory is non-empty (post-quarantine views may be incomplete).

import { readdirSync } from "node:fs";
import path from "node:path";
import { formatGoalStatusLines, DEFAULT_GOAL_ACTIVATION_MODE } from "../extension/tools.js";
import { renderGoalTodoTree } from "../extension/hud.js";
import { createRuntimeGoalEngine } from "../runtime/engine.js";
import type { GoalRuntimeEngine } from "../runtime/engine.js";
import { restoreAllGoals } from "../store/restore.js";
import type { RestoredGoalStore } from "../store/restore.js";
import { casReceiptsPath, readStreamText } from "../store/log.js";
import { stateDir as resolveStateDir } from "../shared/paths.js";

const USAGE = [
  "usage: goals [--state-dir <dir>] <command> [goalId]",
  "commands:",
  "  status [goalId] — active (or given) goal status block",
  "  tree   [goalId] — TODO tree with icons and progress",
  "  list            — one line per goal in the store",
  "  stats           — aggregate counts over the whole store",
  "  export          — deterministic JSON dump (goal + todos + claims + receipts)",
].join("\n");

interface CliArgs {
  stateDir?: string;
  command?: string;
  goalId?: string;
  error?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {};
  const rest: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--state-dir") {
      const value = argv[index + 1];
      if (value === undefined || value.trim().length === 0) return { error: "--state-dir requires a non-empty directory path" };
      args.stateDir = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") return { command: "help" };
    if (arg.startsWith("--")) return { error: `unknown flag ${arg}` };
    rest.push(arg);
  }
  if (rest.length > 2) return { error: `too many arguments: ${rest.slice(2).join(", ")}` };
  args.command = rest[0];
  args.goalId = rest[1];
  return args;
}

function fail(message: string): never {
  process.stderr.write(`goals: ${message}\n`);
  process.exit(1);
}

/** Usage errors exit 2 (batch-#2 fix): exit 1 stays reserved for
 * store/runtime failures so scripts can tell "bad invocation" from
 * "store-blocked". The usage hint rides along on stderr. */
function failUsage(message: string): never {
  process.stderr.write(`goals: ${message}\n`);
  process.exit(2);
}

/** Count quarantined stream EVIDENCE files (the .diagnostic.json sidecars
 * are metadata, not streams). */
function countQuarantinedStreams(stateDir: string): number {
  let count = 0;
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return; // no quarantine directory (or unreadable) -> nothing to warn
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(directory, entry.name));
      else if (!entry.name.endsWith(".diagnostic.json")) count += 1;
    }
  };
  walk(path.join(stateDir, "quarantine"));
  return count;
}

/** Post-quarantine honesty (batch-#2 fix): after restore quarantined a
 * corrupt stream, later reads see a "clean" but possibly decimated store —
 * list/stats/export say so on stderr (exit stays 0). */
function warnQuarantined(stateDir: string): void {
  const count = countQuarantinedStreams(stateDir);
  if (count > 0) process.stderr.write(`warning: ${count} quarantined stream(s) — goals may be incomplete\n`);
}

interface StoreView {
  readonly goals: readonly { goalId: string; restored: RestoredGoalStore }[];
}

/** Read the whole store fail-closed: blocked diagnostics abort the CLI. */
function readStore(stateDir: string): StoreView {
  let index;
  try {
    index = restoreAllGoals(stateDir);
  } catch (error) {
    fail(`store read failed under ${stateDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const diagnostics = [...index.receipts.diagnostics];
  const goals: { goalId: string; restored: RestoredGoalStore }[] = [];
  for (const [goalId, result] of Object.entries(index.goals)) {
    if (result.status === "blocked") diagnostics.push(...result.diagnostics);
    else if (result.goal !== undefined) goals.push({ goalId, restored: result });
  }
  if (diagnostics.length > 0) {
    const first = diagnostics[0]!;
    process.stderr.write(
      `goals: restore-blocked store (${diagnostics.length} diagnostic(s); first: [${first.stream}] ${first.code}: ${first.message})\n`,
    );
    for (const diagnostic of diagnostics.slice(0, 10)) {
      process.stderr.write(`  - [${diagnostic.stream}] ${diagnostic.code}: ${diagnostic.message}\n`);
    }
    process.exit(1);
  }
  return { goals };
}

function requireActiveGoal(store: StoreView, goalId: string | undefined): { goalId: string; restored: RestoredGoalStore } | undefined {
  if (goalId !== undefined) {
    const match = store.goals.find((entry) => entry.goalId === goalId);
    if (match === undefined) fail(`no goal ${goalId} exists in the store`);
    return match;
  }
  const open = store.goals.filter((entry) => entry.restored.goal?.status !== "complete");
  if (open.length > 1) fail(`multiple non-complete goals exist: ${open.map((entry) => entry.goalId).sort().join(", ")}`);
  if (open.length === 1) return open[0];
  // no open goal: fall back to the most recently updated complete goal (clear semantics)
  let best: { goalId: string; restored: RestoredGoalStore } | undefined;
  for (const entry of store.goals) {
    const goal = entry.restored.goal;
    if (goal === undefined) continue;
    if (
      best === undefined
      || goal.updatedAt > best.restored.goal!.updatedAt
      || (goal.updatedAt === best.restored.goal!.updatedAt && entry.restored.revisions.goal > best.restored.revisions.goal)
    ) {
      best = entry;
    }
  }
  return best;
}

/** Read the global CAS receipts stream as plain receipt records (export). */
function readReceipts(stateDir: string): { count: number; entries: readonly Record<string, unknown>[] } {
  const outcome = readStreamText(casReceiptsPath(stateDir));
  if (!outcome.ok) fail(`cannot read the CAS receipts stream: ${outcome.message}`);
  const lines = outcome.text === "" ? [] : outcome.text.split("\n").slice(0, -1);
  const entries: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      entries.push((parsed.data as { receipt?: Record<string, unknown> })?.receipt ?? parsed);
    } catch {
      // unreachable: readStore already failed closed on malformed receipts
    }
  }
  return { count: entries.length, entries };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.error !== undefined) failUsage(`${args.error}\n${USAGE}`);
  const command = args.command ?? "status";
  if (command === "help") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command !== "status" && command !== "tree" && command !== "list" && command !== "stats" && command !== "export") {
    failUsage(`unknown command '${command}'\n${USAGE}`);
  }
  const shellEnv: NodeJS.ProcessEnv = process["env"];
  const stateDir = args.stateDir ?? resolveStateDir(shellEnv);
  const store = readStore(stateDir);

  if (command === "status" || command === "tree") {
    const target = requireActiveGoal(store, args.goalId);
    if (target === undefined) fail(`no goal exists under ${stateDir} — create one with the extension (/goal <objective>) or pass --state-dir`);
    // same restore path as the extension: engine.getGoal replays streams + overlay
    const engine: GoalRuntimeEngine = createRuntimeGoalEngine({
      stateDir,
      // read-only: the lock lives outside the store and is never acquired here
      runtimeDir: path.join(stateDir, "runtime-lock"),
    });
    const view = engine.getGoal(target.goalId);
    if (view.diagnostics !== undefined && view.diagnostics.length > 0) fail(`goal ${target.goalId} is restore-blocked (${view.diagnostics.length} diagnostic(s))`);
    if (view.goal === undefined) fail(`goal ${target.goalId} could not be restored`);
    const rendered = command === "status"
      ? formatGoalStatusLines(view.goal, DEFAULT_GOAL_ACTIVATION_MODE)
      : renderGoalTodoTree(view.goal.summary, view.goal.nodes).join("\n");
    process.stdout.write(`${rendered}\n`);
    return;
  }

  if (command === "list") {
    warnQuarantined(stateDir);
    if (store.goals.length === 0) fail(`no goals found under ${stateDir}`);
    const sorted = [...store.goals].sort((a, b) => (a.restored.goal?.createdAt ?? 0) - (b.restored.goal?.createdAt ?? 0));
    for (const entry of sorted) {
      const goal = entry.restored.goal;
      process.stdout.write(`${entry.goalId}  ${goal?.status ?? "?"}  rev ${entry.restored.revisions.goal}  todos ${entry.restored.todoGraph.nodes.length}  ${goal?.objective ?? ""}\n`);
    }
    return;
  }

  if (command === "stats") {
    warnQuarantined(stateDir);
    const byStatus: Record<string, number> = {};
    let todosTotal = 0;
    let todosClosed = 0;
    for (const entry of store.goals) {
      const status = entry.restored.goal?.status ?? "unknown";
      byStatus[status] = (byStatus[status] ?? 0) + 1;
      todosTotal += entry.restored.todoGraph.nodes.length;
      todosClosed += entry.restored.todoGraph.nodes.filter((node) => node.status === "done" || node.status === "skipped").length;
    }
    const receipts = readReceipts(stateDir);
    const lines = [
      `stateDir: ${stateDir}`,
      `goals: ${store.goals.length}`,
      ...Object.keys(byStatus).sort().map((status) => `  ${status}: ${byStatus[status]}`),
      `todos: ${todosClosed} closed / ${todosTotal} total`,
      `mutation receipts: ${receipts.count}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  // export: deterministic JSON dump of goal + todos + claims + receipts
  warnQuarantined(stateDir);
  const goals = [...store.goals]
    .sort((a, b) => (a.goalId < b.goalId ? -1 : 1))
    .map((entry) => ({
      goalId: entry.goalId,
      goal: entry.restored.goal,
      revisions: entry.restored.revisions,
      todos: entry.restored.todoGraph.nodes,
      claims: entry.restored.claims,
    }));
  const dump = { schema: "pi-goals.export.v1", stateDir, goals, receipts: readReceipts(stateDir) };
  process.stdout.write(`${JSON.stringify(dump, null, 2)}\n`);
}

main();
