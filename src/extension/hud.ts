// extension/hud.ts — goals HUD: a compact footer-widget ABOVE the Pi editor
// plus the pure TODO-tree rendering helpers shared by tools.ts (get_goal_todos)
// and commands.ts (/todo). renderGoalHudLines / renderGoalTodoTree /
// todoStatusIcon are PURE (no ANSI, no I/O) -> fully unit-testable without a
// TUI. GoalsHud owns state + ctx.ui.setWidget/setStatus wiring (pi-mesh
// hud.ts pattern). The widget is HIDDEN when no active goal exists.

import type { GoalTodoSummary } from "../core/tree.js";
import type { GoalTodoNode } from "../core/types.js";
import type { GoalRuntimeView } from "../runtime/engine.js";
import type { SessionContext } from "./pi-types.js";
import type { GetRuntime, GoalActivationMode } from "./tools.js";

export const GOALS_WIDGET_ID = "pi-goals-hud";
export const GOALS_STATUS_ID = "goals";

/** Plain-data input to the pure renderer. */
export interface GoalHudState {
  readonly hasGoal: boolean;
  readonly status: string;
  readonly mode: GoalActivationMode;
  readonly done: number;
  readonly total: number;
  readonly open: number;
  readonly blocked: number;
}

/**
 * PURE renderer — no ANSI, no Pi API. Exactly one compact line with an
 * active goal, zero lines without one (the widget is then cleared).
 * Sample: "◆ goals: 7/12 done · open 5 · blocked 0"
 */
export function renderGoalHudLines(state: GoalHudState): string[] {
  if (!state.hasGoal) return [];
  return [`◆ goals: ${state.done}/${state.total} done · open ${state.open} · blocked ${state.blocked}`];
}

/** Compact footer status text; undefined (cleared) without an active goal. */
export function goalHudStatusText(state: GoalHudState): string | undefined {
  if (!state.hasGoal) return undefined;
  return `goals:${state.done}/${state.total}`;
}

/** Tree icons: open ○, in-progress ●, done ✓, blocked ⊘, skipped ⤫
 * (batch-#2 fix: skipped gets its own glyph so a skipped node never reads
 * as blocked at a glance — zob shared ⊘ for both). */
export function todoStatusIcon(status: string): string {
  if (status === "done") return "✓";
  if (status === "blocked") return "⊘";
  if (status === "skipped") return "⤫";
  if (status === "in_progress") return "●";
  return "○";
}

function pathSegments(path: string): number[] {
  return path.split(".").map((segment) => Number.parseInt(segment, 10));
}

function comparePaths(a: string, b: string): number {
  const sa = pathSegments(a);
  const sb = pathSegments(b);
  const length = Math.max(sa.length, sb.length);
  for (let index = 0; index < length; index += 1) {
    const da = sa[index] ?? 0;
    const db = sb[index] ?? 0;
    if (da !== db) return da - db;
  }
  return a.localeCompare(b);
}

function indentFor(path: string): string {
  const depth = pathSegments(path).length;
  return depth <= 1 ? "" : "  ".repeat(depth - 1);
}

/**
 * PURE tree render: nodes sorted numerically by path, children indented,
 * zob status icons, and a progress header line. Empty input -> "(no todos)".
 */
export function renderGoalTodoTree(summary: GoalTodoSummary, nodes: readonly GoalTodoNode[]): string[] {
  const percent = Math.round(summary.progress * 100);
  const header = `todo tree — ${summary.done}/${summary.total} done (${percent}%) · open ${summary.open} · blocked ${summary.blocked.length}`;
  if (nodes.length === 0) return [header, "(no todos)"];
  const sorted = [...nodes].sort((a, b) => comparePaths(a.path, b.path));
  const lines = sorted.map((node) => `${indentFor(node.path)}${todoStatusIcon(node.status)} ${node.path}  ${node.title}`);
  return [header, ...lines];
}

/** Build the HUD state from a runtime view (undefined -> hidden). */
export function goalHudStateOf(view: GoalRuntimeView | undefined, mode: GoalActivationMode): GoalHudState {
  if (view === undefined) {
    return { hasGoal: false, status: "none", mode, done: 0, total: 0, open: 0, blocked: 0 };
  }
  const blocked = view.summary.blocked.length;
  return {
    hasGoal: true,
    status: view.goal.status,
    mode,
    done: view.summary.done,
    total: view.summary.total,
    open: view.summary.open,
    blocked,
  };
}

/**
 * GoalsHud — pushes the compact progress widget to the TUI. refresh() is
 * fire-and-forget: an engine read failure clears the widget (never throws
 * into the tool/command path).
 */
export class GoalsHud {
  private ctx: SessionContext | null = null;

  constructor(private readonly deps: { getRuntime: GetRuntime }) {}

  attach(ctx: SessionContext): void {
    this.ctx = ctx;
    this.refresh();
  }

  /** session_shutdown: clear BOTH widget and status. */
  detach(): void {
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx !== null) {
      ctx.ui.setWidget(GOALS_WIDGET_ID, undefined);
      ctx.ui.setStatus(GOALS_STATUS_ID, undefined);
    }
  }

  refresh(): void {
    const ctx = this.ctx;
    if (ctx === null) return;
    const rt = this.deps.getRuntime();
    let view: GoalRuntimeView | undefined;
    try {
      view = rt === null ? undefined : rt.engine.getGoal().goal;
    } catch {
      view = undefined; // read failure -> hidden, never propagate
    }
    const state = goalHudStateOf(view, rt?.mode ?? "auto");
    const lines = renderGoalHudLines(state);
    ctx.ui.setWidget(GOALS_WIDGET_ID, lines.length > 0 ? this.colorize(lines, state) : undefined);
    ctx.ui.setStatus(GOALS_STATUS_ID, goalHudStatusText(state));
  }

  /** Eager colorization; plain lines when no theme (headless). */
  private colorize(lines: string[], state: GoalHudState): string[] {
    const theme = this.ctx?.ui.theme;
    if (theme === undefined) return lines;
    const color = state.status === "complete" ? "success" : "accent";
    return lines.map((line) => theme.fg(color, line));
  }
}
