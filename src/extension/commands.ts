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

const GOAL_HELP = [
  "/goal                  — show the active goal status (objective/usage/oracle/next)",
  "/goal <objective>      — create the runtime goal",
  "/goal pause <reason>   — pause the active goal (loop off; resume later)",
  "/goal resume <reason>  — resume a paused/blocked/oracle_failed goal",
  "/goal clear            — clear the current goal view (append-only streams stay)",
  "/goal mode [manual|validation|auto] — show or set the activation mode",
].join("\n");

const TODO_HELP = [
  "/todo                  — render the TODO tree (icons ○ ● ✓ ⊘ ⤫ + progress)",
  "/todo add <title>      — add one TODO to the active goal",
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
function requireView(rt: GoalsRuntime, ctx: SessionContext): ReturnType<GoalsRuntime["engine"]["getGoal"]>["goal"] | undefined {
  const read = rt.engine.getGoal();
  if (read.diagnostics !== undefined && read.diagnostics.length > 0) {
    const first = read.diagnostics[0]!;
    notify(ctx, `goals: restore-blocked (${read.diagnostics.length} diagnostic(s); first: [${first.stream}] ${first.message})`, "warning");
    return undefined;
  }
  return read.goal;
}

function handleGoalStatus(rt: GoalsRuntime, ctx: SessionContext): void {
  const view = requireView(rt, ctx);
  if (view === undefined) {
    notify(ctx, "goals: no active goal\nusage:\n" + GOAL_HELP);
    return;
  }
  notify(ctx, formatGoalStatusLines(view, rt.mode), view.goal.status === "blocked" || view.goal.status === "oracle_failed" ? "warning" : "info");
}

function handleGoalCreate(rt: GoalsRuntime, ctx: SessionContext, objective: string): void {
  const options = rt.mode === "manual" ? { maxTurns: 1 } : undefined;
  const outcome = rt.engine.createGoal(objective, { mutationId: commandMutationId("cmd-create"), expectedGoalRevision: 0 }, options);
  if (!outcome.ok) {
    notifyOutcomeError(ctx, outcome);
    return;
  }
  notify(ctx, `goals: created ${outcome.result.goalId} (status ${outcome.result.goal?.status ?? "active"}, mode ${rt.mode}) — add TODOs with add_goal_todos or /todo add`);
}

function handleGoalResume(rt: GoalsRuntime, ctx: SessionContext, reason: string): void {
  const view = requireView(rt, ctx);
  if (view === undefined) {
    notify(ctx, "goals: no active goal to resume");
    return;
  }
  const outcome = rt.engine.resumeGoal(reason, { mutationId: commandMutationId("cmd-resume"), expectedGoalRevision: view.revisions.goal });
  if (!outcome.ok) {
    notifyOutcomeError(ctx, outcome);
    return;
  }
  notify(ctx, `goals: resumed ${outcome.result.goal.goalId} (was ${outcome.result.previousStatus}, now ${outcome.result.goal.status})`);
}

function handleGoalPause(rt: GoalsRuntime, ctx: SessionContext, reason: string): void {
  if (reason.length === 0) {
    notify(ctx, "usage: /goal pause <reason>", "warning");
    return;
  }
  const view = requireView(rt, ctx);
  if (view === undefined) {
    notify(ctx, "goals: no active goal to pause");
    return;
  }
  const outcome = rt.engine.pauseGoal(reason, { mutationId: commandMutationId("cmd-pause"), expectedGoalRevision: view.revisions.goal });
  if (!outcome.ok) {
    notifyOutcomeError(ctx, outcome);
    return;
  }
  notify(ctx, `goals: paused ${outcome.result.goal.goalId} (was ${outcome.result.previousStatus}, loop off — /goal resume <reason> to continue)`);
}

function handleGoalClear(rt: GoalsRuntime, ctx: SessionContext): void {
  const view = requireView(rt, ctx);
  if (view === undefined) {
    notify(ctx, "goals: no goal to clear");
    return;
  }
  const outcome = rt.engine.clearGoal({ mutationId: commandMutationId("cmd-clear"), expectedGoalRevision: view.revisions.goal });
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

function handleTodoTree(rt: GoalsRuntime, ctx: SessionContext): void {
  const view = requireView(rt, ctx);
  if (view === undefined) {
    notify(ctx, "goals: no active goal\nusage:\n" + TODO_HELP);
    return;
  }
  notify(ctx, renderGoalTodoTree(view.summary, view.nodes).join("\n"));
}

function handleTodoAdd(rt: GoalsRuntime, ctx: SessionContext, title: string): void {
  const view = requireView(rt, ctx);
  if (view === undefined) {
    notify(ctx, "goals: no active goal — create one first (/goal <objective>)", "warning");
    return;
  }
  const outcome = rt.engine.addTodos([{ input: { title } }], { mutationId: commandMutationId("cmd-add"), expectedGraphRevision: view.revisions.todos });
  if (!outcome.ok) {
    notifyOutcomeError(ctx, outcome);
    return;
  }
  const created = outcome.result.created[0];
  notify(ctx, `goals: added todo ${created?.path ?? "?"} '${title}' (todos revision ${outcome.result.todosRevision})`);
}

export function registerCommands(pi: ExtensionAPI, getRuntime: GetRuntime, onChanged?: () => void): void {
  pi.registerCommand("goal", {
    description: "runtime goal lifecycle: status, create, pause, resume, clear, mode",
    handler: async (args, ctx) => {
      const rt = getRuntime();
      if (rt === null) {
        notify(ctx, "goals: session not started", "warning");
        return;
      }
      const text = args.trim();
      if (text === "" || text === "status") {
        handleGoalStatus(rt, ctx);
        return;
      }
      if (text === "help") {
        notify(ctx, GOAL_HELP);
        return;
      }
      if (text === "mode") {
        handleGoalMode(rt, ctx, undefined, onChanged);
        return;
      }
      if (text.startsWith("mode ")) {
        handleGoalMode(rt, ctx, text.slice(5).trim() || undefined, onChanged);
        return;
      }
      if (text === "pause" || text.startsWith("pause ")) {
        handleGoalPause(rt, ctx, text.slice(5).trim());
        onChanged?.();
        return;
      }
      if (text === "resume" || text.startsWith("resume ")) {
        const reason = text.slice(6).trim();
        if (reason.length === 0) {
          notify(ctx, "usage: /goal resume <reason>", "warning");
          return;
        }
        handleGoalResume(rt, ctx, reason);
        onChanged?.();
        return;
      }
      if (text === "clear") {
        handleGoalClear(rt, ctx);
        onChanged?.();
        return;
      }
      handleGoalCreate(rt, ctx, text);
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
      if (text === "" || text === "tree" || text === "view") {
        handleTodoTree(rt, ctx);
        return;
      }
      if (text === "help") {
        notify(ctx, TODO_HELP);
        return;
      }
      if (text.startsWith("add ")) {
        const title = text.slice(4).trim();
        if (title.length === 0) {
          notify(ctx, "usage: /todo add <title>", "warning");
          return;
        }
        handleTodoAdd(rt, ctx, title);
        onChanged?.();
        return;
      }
      notify(ctx, `goals: unknown /todo subcommand\nusage:\n${TODO_HELP}`, "warning");
    },
  });
}
