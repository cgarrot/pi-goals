// extension/commands.ts — /goal and /todo slash commands (§commands). All
// output via ctx.ui.notify; every mutation goes through the SAME engine
// calls the tools use (no separate business logic). Command-driven
// mutations auto-generate canonical mutation ids and read the current
// revisions first (commands run outside the model loop, so no CAS params
// arrive from the user).

import type { ExtensionAPI, SessionContext } from "./pi-types.js";
import { renderGoalTodoTree } from "./hud.js";
import { formatGoalStatusLines, type GetRuntime, type GoalActivationMode, type GoalsRuntime } from "./tools.js";
import { DEFAULT_GOAL_ACTIVATION_MODE } from "./tools.js";
import type { GoalSelector } from "../runtime/engine.js";
import { resolveScopeShorthand } from "../shared/scope.js";

const GOAL_HELP = [
  "/goal                          — show the active goal status (objective/usage/oracle/next)",
  "/goal <objective> [--scope s]  — create the runtime goal (scope: local | agent | room:<id>)",
  "/goal scopes                   — list every goal per scope (multi-agent overview)",
  "/goal pause <reason> [--scope s]  — pause a goal (loop off; resume later)",
  "/goal resume <reason> [--scope s] — resume a paused/blocked/oracle_failed goal",
  "/goal clear [--scope s]        — clear the goal view of that lane (streams stay)",
  "/goal mode [manual|validation|auto] — show or set the activation mode",
].join("\n");

const TODO_HELP = [
  "/todo                          — render the TODO tree (icons ○ ● ✓ ⊘ ⤫ + progress)",
  "/todo add <title> [--scope s]  — add one TODO to the goal of that lane",
].join("\n");

function notify(ctx: SessionContext, message: string, level: "info" | "warning" = "info"): void {
  ctx.ui.notify(message, { level });
}

let commandSequence = 0;
function commandMutationId(prefix: string): string {
  commandSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${commandSequence.toString(36)}`;
}

function asActivationMode(value: string): GoalActivationMode | undefined {
  return value === "manual" || value === "validation" || value === "auto" ? value : undefined;
}

function notifyOutcomeError(ctx: SessionContext, outcome: { ok: false; code: string; message: string; retryPolicy?: string }): void {
  notify(ctx, `goals: error ${outcome.code}: ${outcome.message}${outcome.retryPolicy !== undefined ? ` (retry: ${outcome.retryPolicy})` : ""}`, "warning");
}

/** Current view for command flows; notifies and returns undefined on failure. */
function requireView(rt: GoalsRuntime, ctx: SessionContext, selector?: GoalSelector): ReturnType<GoalsRuntime["engine"]["getGoal"]>["goal"] | undefined {
  const read = rt.engine.getGoal(selector?.goalId, selector?.scope);
  if (read.diagnostics !== undefined && read.diagnostics.length > 0) {
    const first = read.diagnostics[0]!;
    notify(ctx, `goals: restore-blocked (${read.diagnostics.length} diagnostic(s); first: [${first.stream}] ${first.message})`, "warning");
    return undefined;
  }
  return read.goal;
}

/** Trailing `--scope <value>` extractor: { body, scopeValue? }. */
function parseScopedArgs(text: string): { body: string; scopeValue?: string } {
  const match = text.match(/\s--scope\s+([^\s]+)\s*$/);
  if (match === null || match.index === undefined) return { body: text };
  return { body: text.slice(0, match.index).trimEnd(), scopeValue: match[1] };
}

/** Resolve a command scope to a canonical selector; notifies on error. */
function commandSelector(rt: GoalsRuntime, ctx: SessionContext, scopeValue: string | undefined): { selector?: GoalSelector; canonical?: string } | undefined {
  if (scopeValue === undefined) {
    return rt.scopeDefault === undefined ? {} : { selector: { scope: rt.scopeDefault }, canonical: rt.scopeDefault };
  }
  const resolved = resolveScopeShorthand(scopeValue, { sessionId: rt.sessionId, rooms: rt.meshIdentity?.rooms });
  if (!resolved.ok) {
    notify(ctx, `goals: ${resolved.error}`, "warning");
    return undefined;
  }
  return { selector: { scope: resolved.scope }, canonical: resolved.scope };
}

function handleGoalStatus(rt: GoalsRuntime, ctx: SessionContext, selector?: GoalSelector): void {
  const view = requireView(rt, ctx, selector);
  if (view === undefined) {
    notify(ctx, "goals: no active goal\nusage:\n" + GOAL_HELP);
    return;
  }
  notify(ctx, formatGoalStatusLines(view, rt.mode), view.goal.status === "blocked" || view.goal.status === "oracle_failed" ? "warning" : "info");
}

function handleGoalScopes(rt: GoalsRuntime, ctx: SessionContext): void {
  let overview: ReturnType<GoalsRuntime["engine"]["getGoalsOverview"]>;
  try {
    overview = rt.engine.getGoalsOverview();
  } catch (error) {
    notify(ctx, `goals: store read failed (${error instanceof Error ? error.message : String(error)})`, "warning");
    return;
  }
  if (overview.diagnostics !== undefined && overview.diagnostics.length > 0) {
    notify(ctx, `goals: restore-blocked (${overview.diagnostics.length} diagnostic(s))`, "warning");
    return;
  }
  const entries = overview.overview ?? [];
  if (entries.length === 0) {
    notify(ctx, "goals: no goals in the store");
    return;
  }
  const lines = entries.map((entry) =>
    `${entry.status === "complete" ? "✓" : entry.status === "active" ? "◆" : "·"} ${entry.goalId} [${entry.scope}${entry.scopeLabel !== undefined ? ` · ${entry.scopeLabel}` : ""}] ${entry.status} — ${entry.objective.length > 60 ? `${entry.objective.slice(0, 57)}…` : entry.objective}`,
  );
  notify(ctx, [`goals: ${entries.filter((entry) => entry.status !== "complete").length} active / ${entries.length} total`, ...lines].join("\n"));
}

function handleGoalCreate(rt: GoalsRuntime, ctx: SessionContext, objective: string, scopeValue: string | undefined): void {
  const resolved = commandSelector(rt, ctx, scopeValue);
  if (resolved === undefined) return;
  // create uses the CANONICAL scope (not the selector): default stays local (review P2).
  const options: Record<string, unknown> = rt.mode === "manual" ? { maxTurns: 1 } : {};
  if (resolved.canonical !== undefined) options.scope = resolved.canonical;
  if (resolved.canonical !== undefined && resolved.canonical.startsWith("agent:") && rt.meshIdentity !== undefined) {
    options.scopeLabel = rt.meshIdentity.alias;
  }
  const outcome = rt.engine.createGoal(objective, { mutationId: commandMutationId("cmd-create"), expectedGoalRevision: 0 }, options);
  if (!outcome.ok) {
    notifyOutcomeError(ctx, outcome);
    return;
  }
  const scopeText = outcome.result.goal?.scope !== undefined && outcome.result.goal.scope !== "local" ? ` in scope ${outcome.result.goal.scope}` : "";
  notify(ctx, `goals: created ${outcome.result.goalId}${scopeText} (status ${outcome.result.goal?.status ?? "active"}, mode ${rt.mode}) — add TODOs with add_goal_todos or /todo add`);
}

function handleGoalResume(rt: GoalsRuntime, ctx: SessionContext, reason: string, selector?: GoalSelector): void {
  const view = requireView(rt, ctx, selector);
  if (view === undefined) {
    notify(ctx, "goals: no active goal to resume");
    return;
  }
  const outcome = rt.engine.resumeGoal(reason, { mutationId: commandMutationId("cmd-resume"), expectedGoalRevision: view.revisions.goal }, undefined, selector);
  if (!outcome.ok) {
    notifyOutcomeError(ctx, outcome);
    return;
  }
  notify(ctx, `goals: resumed ${outcome.result.goal.goalId} (was ${outcome.result.previousStatus}, now ${outcome.result.goal.status})`);
}

function handleGoalPause(rt: GoalsRuntime, ctx: SessionContext, reason: string, selector?: GoalSelector): void {
  if (reason.length === 0) {
    notify(ctx, "usage: /goal pause <reason>", "warning");
    return;
  }
  const view = requireView(rt, ctx, selector);
  if (view === undefined) {
    notify(ctx, "goals: no active goal to pause");
    return;
  }
  const outcome = rt.engine.pauseGoal(reason, { mutationId: commandMutationId("cmd-pause"), expectedGoalRevision: view.revisions.goal }, selector);
  if (!outcome.ok) {
    notifyOutcomeError(ctx, outcome);
    return;
  }
  notify(ctx, `goals: paused ${outcome.result.goal.goalId} (was ${outcome.result.previousStatus}, loop off — /goal resume <reason> to continue)`);
}

function handleGoalClear(rt: GoalsRuntime, ctx: SessionContext, selector?: GoalSelector): void {
  const view = requireView(rt, ctx, selector);
  if (view === undefined) {
    notify(ctx, "goals: no goal to clear");
    return;
  }
  const outcome = rt.engine.clearGoal({ mutationId: commandMutationId("cmd-clear"), expectedGoalRevision: view.revisions.goal }, selector);
  if (!outcome.ok) {
    notifyOutcomeError(ctx, outcome);
    return;
  }
  notify(ctx, `goals: cleared ${outcome.result.clearedGoalId} (streams stay append-only on disk)`);
}

function handleGoalMode(rt: GoalsRuntime, ctx: SessionContext, requested: string | undefined, onChanged?: () => void): void {
  if (requested === undefined) {
    notify(ctx, `goals: activation mode is ${rt.mode} (default ${DEFAULT_GOAL_ACTIVATION_MODE})`);
    return;
  }
  const mode = asActivationMode(requested);
  if (mode === undefined) {
    notify(ctx, "usage: /goal mode manual|validation|auto", "warning");
    return;
  }
  rt.mode = mode;
  onChanged?.();
  notify(ctx, `goals: activation mode set to ${mode}${mode === "manual" ? " (new goals get max_turns 1 — single-shot)" : ""}`);
}

function handleTodoTree(rt: GoalsRuntime, ctx: SessionContext, selector?: GoalSelector): void {
  const view = requireView(rt, ctx, selector);
  if (view === undefined) {
    notify(ctx, "goals: no active goal\nusage:\n" + TODO_HELP);
    return;
  }
  notify(ctx, renderGoalTodoTree(view.summary, view.nodes).join("\n"));
}

function handleTodoAdd(rt: GoalsRuntime, ctx: SessionContext, title: string, selector?: GoalSelector): void {
  const view = requireView(rt, ctx, selector);
  if (view === undefined) {
    notify(ctx, "goals: no active goal — create one first (/goal <objective>)", "warning");
    return;
  }
  const outcome = rt.engine.addTodos([{ input: { title } }], { mutationId: commandMutationId("cmd-add"), expectedGraphRevision: view.revisions.todos }, selector);
  if (!outcome.ok) {
    notifyOutcomeError(ctx, outcome);
    return;
  }
  const created = outcome.result.created[0];
  notify(ctx, `goals: added todo ${created?.path ?? "?"} '${title}' (todos revision ${outcome.result.todosRevision})`);
}

export function registerCommands(pi: ExtensionAPI, getRuntime: GetRuntime, onChanged?: () => void): void {
  pi.registerCommand("goal", {
    description: "runtime goal lifecycle: status, create, pause, resume, clear, mode, scopes",
    handler: async (args, ctx) => {
      const rt = getRuntime();
      if (rt === null) {
        notify(ctx, "goals: session not started", "warning");
        return;
      }
      // pre-parse the trailing --scope ONCE, then route on the body so every
      // subcommand (status/pause/resume/clear/create) accepts it uniformly.
      const text = args.trim();
      const parsed = parseScopedArgs(text);
      const body = parsed.body;
      const selector = commandSelector(rt, ctx, parsed.scopeValue)?.selector;
      if (body === "" || body === "status") {
        handleGoalStatus(rt, ctx, selector);
        return;
      }
      if (body === "help") {
        notify(ctx, GOAL_HELP);
        return;
      }
      if (body === "scopes" || body === "list") {
        handleGoalScopes(rt, ctx);
        return;
      }
      if (body === "mode") {
        handleGoalMode(rt, ctx, undefined, onChanged);
        return;
      }
      if (body.startsWith("mode ")) {
        handleGoalMode(rt, ctx, body.slice(5).trim() || undefined, onChanged);
        return;
      }
      if (body === "pause" || body.startsWith("pause ")) {
        handleGoalPause(rt, ctx, body.slice(5).trim(), selector);
        onChanged?.();
        return;
      }
      if (body === "resume" || body.startsWith("resume ")) {
        const reason = body.slice(6).trim();
        if (reason.length === 0) {
          notify(ctx, "usage: /goal resume <reason>", "warning");
          return;
        }
        handleGoalResume(rt, ctx, reason, selector);
        onChanged?.();
        return;
      }
      if (body === "clear") {
        handleGoalClear(rt, ctx, selector);
        onChanged?.();
        return;
      }
      handleGoalCreate(rt, ctx, body, parsed.scopeValue);
      onChanged?.();
    },
  });

  pi.registerCommand("todo", {
    description: "goal TODO tree: render with icons and progress, or add a TODO",
    handler: async (args, ctx) => {
      const rt = getRuntime();
      if (rt === null) {
        notify(ctx, "goals: session not started", "warning");
        return;
      }
      const text = args.trim();
      const parsed = parseScopedArgs(text);
      const body = parsed.body;
      const selector = commandSelector(rt, ctx, parsed.scopeValue)?.selector;
      if (body === "" || body === "tree" || body === "view") {
        handleTodoTree(rt, ctx, selector);
        return;
      }
      if (body === "help") {
        notify(ctx, TODO_HELP);
        return;
      }
      if (body.startsWith("add ")) {
        const title = body.slice(4).trim();
        if (title.length === 0) {
          notify(ctx, "usage: /todo add <title>", "warning");
          return;
        }
        handleTodoAdd(rt, ctx, title, selector);
        onChanged?.();
        return;
      }
      notify(ctx, `goals: unknown /todo subcommand\nusage:\n${TODO_HELP}`, "warning");
    },
  });
}
