// extension/tools.ts — the 17 zob-named Goal/TODO tools (R5: EXACT zob tool
// names; import_* excluded from core per R8/2d — a future coms package may
// add them via ImportProvider). Plain JSON Schema parameters
// (zero-dependency). THIN ADAPTER over the Phase-4 GoalRuntimeEngine:
// param validation -> engine call -> formatted result (pi-mesh honest style:
// a concise one-liner string + details object, never raw dumps).
//
// Disciplines:
//   - I10 (pi-mesh): tools register IMMEDIATELY and answer `blocked` when
//     the session has not started; they never crash the host.
//   - CAS (D-E3): every mutation carries cas { mutation_id, expected_* };
//     the echo appears in details.cas (status/mutation_id/request_hash).
//   - fix_input: adapter-side validation failures name the EXACT invalid
//     parameter so the model can repair the call.
//   - NO business logic here: the engine owns every rule.

import type { GoalMutationGuardInput, GoalMutationReceipt } from "../core/cas.js";
import type { AddGoalTodoNodeItem } from "../core/tree.js";
import type { GoalRuntimeEngine, GoalEngineError, GoalRuntimeView, GoalSelector, GoalOverviewEntry } from "../runtime/engine.js";
import type { MeshIdentity, ScopeShorthandResult } from "../shared/scope.js";
import { readMeshIdentity, resolveScopeShorthand } from "../shared/scope.js";
import type { ExtensionAPI, ToolResult } from "./pi-types.js";
import { textResult } from "./pi-types.js";
import { renderGoalTodoTree } from "./hud.js";
import { mirrorGoalEvent } from "./session-mirror.js";
import { writeScopeOutboxEvent } from "./outbox.js";
import type { GoalOutboxKind } from "./outbox.js";

// ---------------------------------------------------------------------------
// Shared runtime (built at session_start in index.ts)
// ---------------------------------------------------------------------------

export type GoalActivationMode = "manual" | "validation" | "auto";
export const DEFAULT_GOAL_ACTIVATION_MODE: GoalActivationMode = "auto";

export interface GoalsRuntime {
  readonly pi: ExtensionAPI;
  readonly engine: GoalRuntimeEngine;
  readonly stateDir: string;
  readonly runtimeDir: string;
  /** Pi session id — stable across /reload. */
  readonly sessionId: string;
  /** pi-mesh state dir for lazy identity re-reads (M3); absent without a cwd. */
  readonly meshDir?: string;
  /** Best-effort pi-mesh identity (alias/rooms); MUTABLE — refreshed on
   * room-scope resolution so a post-session room join is picked up (M3). */
  meshIdentity?: MeshIdentity;
  /** Canonical default scope from $GOALS_SCOPE (opt-in; undefined = engine fallback). */
  readonly scopeDefault?: string;
  readonly startedAt: number;
  /** Session-level activation mode (zob /goal mode parity). */
  mode: GoalActivationMode;
  /** Best-effort session-mirror counters (see session-mirror.ts). */
  mirrorWrites: number;
  mirrorFailures: number;
}

export type GetRuntime = () => GoalsRuntime | null;

export const GOAL_TOOL_NAMES: readonly string[] = Object.freeze([
  "create_goal",
  "resume_goal",
  "get_goal",
  "get_goals",
  "get_goal_todos",
  "add_goal_todo",
  "add_goal_todos",
  "update_goal_todo",
  "resolve_goal_todo",
  "complete_goal_todo",
  "block_goal_todo",
  "split_goal_todo",
  "link_goal_todo_delegation",
  "return_goal_todo_claim",
  "validate_goal_todo_claim",
  "accept_goal_todo_claim",
  "reject_goal_todo_claim",
  "propose_goal_completion",
  "record_goal_oracle",
  "update_goal",
]);

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

const RESULT_SCHEMA = "pi-goals.tool-result.v1";
const MUTATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const HASH64_PATTERN = /^[a-f0-9]{64}$/;

const GOAL_TODO_STATUS_VALUES = ["planned", "ready", "in_progress", "delegated", "claim_returned", "needs_review", "needs_oracle", "needs_user", "blocked", "done", "skipped"] as const;
const GOAL_TODO_OWNER_VALUES = ["agent", "user", "oracle", "subagent", "factory", "orchestration"] as const;
const GOAL_TODO_PRIORITY_VALUES = ["low", "normal", "high", "critical"] as const;
const RESOLVE_ACTION_VALUES = ["auto", "complete", "accept_claim", "reject_claim", "block", "skip", "reopen"] as const;

function fixInput(parameter: string, message: string): ToolResult {
  return textResult(`fix_input: ${message}`, {
    schema: RESULT_SCHEMA,
    status: "error",
    code: "invalid_input",
    parameter,
    retryPolicy: "fix_input",
  });
}

function blockedSession(): ToolResult {
  return textResult("blocked: session_not_started", {
    schema: RESULT_SCHEMA,
    status: "blocked",
    reason: "session_not_started",
  });
}

function syntheticError(code: GoalEngineError["code"], message: string, retryPolicy?: GoalEngineError["retryPolicy"]): GoalEngineError {
  return { ok: false, code, message, ...(retryPolicy ? { retryPolicy } : {}) };
}

function engineFailure(error: GoalEngineError): ToolResult {
  return textResult(`error ${error.code}: ${error.message}${error.retryPolicy !== undefined ? ` (retry: ${error.retryPolicy})` : ""}`, {
    schema: RESULT_SCHEMA,
    status: "error",
    code: error.code,
    ...(error.retryPolicy !== undefined ? { retryPolicy: error.retryPolicy } : {}),
    ...(error.blockers !== undefined ? { blockers: error.blockers } : {}),
    ...(error.staleCodes !== undefined ? { staleCodes: error.staleCodes } : {}),
    ...(error.freshnessCode !== undefined ? { freshnessCode: error.freshnessCode } : {}),
  });
}

type AnyOutcome = { ok: true; status: "applied" | "replayed"; receipt: GoalMutationReceipt; result: unknown } | GoalEngineError;

function casOf(outcome: AnyOutcome): Record<string, unknown> | undefined {
  if (!outcome.ok) return undefined;
  return {
    status: outcome.status,
    mutation_id: outcome.receipt.mutationId,
    request_hash: outcome.receipt.requestHash,
    bodyStored: false as const,
  };
}

function mirrorMutation(
  rt: GoalsRuntime,
  kind: string,
  receipt: GoalMutationReceipt,
  extra: { goalId?: string; status?: string; revision?: number; todosRevision?: number } = {},
): void {
  const written = mirrorGoalEvent(rt.pi, {
    schema: "pi-goals.mirror.v1",
    kind,
    goalId: extra.goalId ?? "",
    at: Date.now(),
    mutationId: receipt.mutationId,
    ...(extra.status !== undefined ? { status: extra.status } : {}),
    ...(extra.revision !== undefined ? { revision: extra.revision } : {}),
    ...(extra.todosRevision !== undefined ? { todosRevision: extra.todosRevision } : {}),
    bodyStored: false,
  });
  if (written) rt.mirrorWrites += 1;
  else rt.mirrorFailures += 1;
}

/** Room-scope lifecycle events → file outbox for pi-mesh relay (best effort,
 * outbox.ts); private agent lanes and local lanes never broadcast. */
function outboxMutation(rt: GoalsRuntime, kind: GoalOutboxKind, goalId: string, scope: string | undefined, receipt: GoalMutationReceipt, extra: { status?: string; revision?: number } = {}): void {
  if (scope === undefined) return;
  writeScopeOutboxEvent(rt.stateDir, {
    kind,
    goalId,
    scope,
    mutationId: receipt.mutationId,
    at: Date.now(),
    ...(extra.status !== undefined ? { status: extra.status } : {}),
    ...(extra.revision !== undefined ? { revision: extra.revision } : {}),
  });
}

// ---------------------------------------------------------------------------
// Param parsing (every failure names the exact parameter)
// ---------------------------------------------------------------------------

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function strArray(value: unknown, parameter: string): { values?: string[]; error?: ToolResult } {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return { error: fixInput(parameter, `parameter '${parameter}' must be an array of strings`) };
  }
  return { values: value as string[] };
}

function boolParam(value: unknown, parameter: string): { value?: boolean; error?: ToolResult } {
  if (value === undefined) return {};
  if (typeof value !== "boolean") return { error: fixInput(parameter, `parameter '${parameter}' must be a boolean`) };
  return { value };
}

function intParam(value: unknown, parameter: string, minimum: number): { value?: number; error?: ToolResult } {
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    return { error: fixInput(parameter, `parameter '${parameter}' must be an integer >= ${minimum}`) };
  }
  return { value };
}

function enumParam<T extends string>(value: unknown, parameter: string, values: readonly T[]): { value?: T; error?: ToolResult } {
  if (value === undefined) return {};
  if (typeof value !== "string" || !values.includes(value as T)) {
    return { error: fixInput(parameter, `parameter '${parameter}' must be one of: ${values.join(", ")}`) };
  }
  return { value: value as T };
}

function hash64(value: unknown, parameter: string): { value?: string; error?: ToolResult } {
  if (value === undefined) return {};
  if (typeof value !== "string" || !HASH64_PATTERN.test(value)) {
    return { error: fixInput(parameter, `parameter '${parameter}' must be an exact full lowercase 64-char sha256 hex string`) };
  }
  return { value };
}

function parseCasParam(value: unknown): { ok: true; cas: GoalMutationGuardInput | undefined } | { ok: false; result: ToolResult } {
  // SCHEMA-1 fix (zob parity): cas is OPTIONAL — an absent guard simply
  // applies the mutation (the engine auto-generates a fresh, non-replayed
  // mutation id); when present, mutation_id remains required inside it.
  if (value === undefined) {
    return { ok: true, cas: undefined };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, result: fixInput("cas", "parameter 'cas' must be an object") };
  }
  const record = value as Record<string, unknown>;
  const mutationId = record.mutation_id;
  if (typeof mutationId !== "string" || !MUTATION_ID_PATTERN.test(mutationId)) {
    return { ok: false, result: fixInput("cas.mutation_id", "parameter 'cas.mutation_id' must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$") };
  }
  const cas: Record<string, number | string> = { mutationId };
  for (const [key, camel] of [["expected_goal_revision", "expectedGoalRevision"], ["expected_graph_revision", "expectedGraphRevision"], ["expected_todo_revision", "expectedTodoRevision"]] as const) {
    const raw = record[key];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
      return { ok: false, result: fixInput(`cas.${key}`, `parameter 'cas.${key}' must be a non-negative safe integer`) };
    }
    cas[camel] = raw;
  }
  return { ok: true, cas: cas as unknown as GoalMutationGuardInput };
}

function parseRef(params: Record<string, unknown>): { ref?: { todoId?: string; todoPath?: string }; error?: ToolResult } {
  const todoId = params.todo_id;
  const todoPath = params.todo_path;
  if (todoId === undefined && todoPath === undefined) {
    return { error: fixInput("todo_id", "parameter 'todo_id' or 'todo_path' is required to identify the TODO") };
  }
  if (todoId !== undefined && typeof todoId !== "string") return { error: fixInput("todo_id", "parameter 'todo_id' must be a string") };
  if (todoPath !== undefined && typeof todoPath !== "string") return { error: fixInput("todo_path", "parameter 'todo_path' must be a string") };
  return { ref: { ...(todoId !== undefined ? { todoId } : {}), ...(todoPath !== undefined ? { todoPath } : {}) } };
}

// ---------------------------------------------------------------------------
// Scope plumbing (multi-agent stores — see shared/scope.ts)
// ---------------------------------------------------------------------------

/** Lazy mesh-identity refresh (M3): rooms may be joined AFTER this session
 * started; re-read the identity file whenever a room scope is resolved so
 * bare 'room' stays correct without a restart. Best effort, never throws. */
function refreshMeshIdentity(rt: GoalsRuntime): void {
  if (rt.meshDir === undefined) return;
  const refreshed = readMeshIdentity(rt.meshDir, rt.sessionId);
  if (refreshed !== undefined) rt.meshIdentity = refreshed;
}

/** Resolve a scope argument against this session (shorthands agent/room).
 * Absent value → the $GOALS_SCOPE session default (already canonical). */
function resolveScopeValue(rt: GoalsRuntime, value: unknown, parameter: string): { ok: true; scope?: string } | { ok: false; result: ToolResult } {
  if (value === undefined) {
    return rt.scopeDefault === undefined ? { ok: true } : { ok: true, scope: rt.scopeDefault };
  }
  if (typeof value !== "string") return { ok: false, result: fixInput(parameter, `parameter '${parameter}' must be a string scope (local | agent | room | room:<id> | agent:<id>)`) };
  if (value.trim() === "room") refreshMeshIdentity(rt);
  const resolved: ScopeShorthandResult = resolveScopeShorthand(value, { sessionId: rt.sessionId, rooms: rt.meshIdentity?.rooms });
  if (!resolved.ok) return { ok: false, result: fixInput(parameter, `parameter '${parameter}': ${resolved.error}`) };
  return { ok: true, scope: resolved.scope };
}

/** Mutation target selector from params: goal_id wins, else scope, else the
 * session default scope, else the engine's exactly-one-active fallback.
 * M4: when BOTH goal_id and scope are provided, the goal must BELONG to
 * that scope — a mismatch is a precise fix_input, not a silent scope drop. */
function parseGoalTarget(rt: GoalsRuntime, params: Record<string, unknown>): { ok: true; selector?: GoalSelector } | { ok: false; result: ToolResult } {
  const goalId = params.goal_id;
  if (goalId !== undefined) {
    if (typeof goalId !== "string" || goalId.trim().length === 0) {
      return { ok: false, result: fixInput("goal_id", "parameter 'goal_id' must be a non-empty goal id") };
    }
    if (params.scope !== undefined) {
      const scope = resolveScopeValue(rt, params.scope, "scope");
      if (!scope.ok) return scope;
      if (scope.scope !== undefined) {
        const read = readView(rt, goalId);
        if (read.error) return { ok: false, result: read.error };
        if (read.view !== undefined) {
          const goalScope = read.view.goal.scope ?? "local";
          if (goalScope !== scope.scope) {
            return { ok: false, result: fixInput("goal_id", `parameter 'goal_id': goal ${goalId} lives in scope ${goalScope}, not ${scope.scope} — pass one or the other`) };
          }
        }
      }
    }
    return { ok: true, selector: { goalId } };
  }
  const scope = resolveScopeValue(rt, params.scope, "scope");
  if (!scope.ok) return scope;
  return { ok: true, ...(scope.scope !== undefined ? { selector: { scope: scope.scope } } : {}) };
}

/** Compact scope suffix for one-liners; empty for legacy/local goals so
 * solo output stays byte-identical with pre-scope stores. */
function scopeSuffix(scope: string | undefined, label?: string): string {
  if (scope === undefined || scope === "local") return "";
  return ` [${scope}${label !== undefined && label.length > 0 ? ` · ${label}` : ""}]`;
}

function parseTodoItem(record: Record<string, unknown>, label: string): { ok: true; item: AddGoalTodoNodeItem } | { ok: false; result: ToolResult } {
  const title = record.title;
  if (typeof title !== "string" || title.trim().length === 0) {
    return { ok: false, result: fixInput(`${label}title`, `parameter '${label}title' must be a non-empty string`) };
  }
  const input: Record<string, unknown> = { title };
  const owner = enumParam(record.owner, `${label}owner`, GOAL_TODO_OWNER_VALUES);
  if (owner.error) return { ok: false, result: owner.error };
  if (owner.value !== undefined) input.owner = owner.value;
  const required = boolParam(record.required, `${label}required`);
  if (required.error) return { ok: false, result: required.error };
  if (required.value !== undefined) input.required = required.value;
  const priority = enumParam(record.priority, `${label}priority`, GOAL_TODO_PRIORITY_VALUES);
  if (priority.error) return { ok: false, result: priority.error };
  if (priority.value !== undefined) input.priority = priority.value;
  const status = enumParam(record.status, `${label}status`, GOAL_TODO_STATUS_VALUES);
  if (status.error) return { ok: false, result: status.error };
  if (status.value !== undefined) input.status = status.value;
  for (const field of ["acceptance_criteria", "evidence_refs", "validation_commands"] as const) {
    const parsed = strArray(record[field], `${label}${field}`);
    if (parsed.error) return { ok: false, result: parsed.error };
    if (parsed.values !== undefined) {
      const camel = field === "acceptance_criteria" ? "acceptanceCriteria" : field === "evidence_refs" ? "evidenceRefs" : "validationCommands";
      input[camel] = parsed.values;
    }
  }
  const item: Record<string, unknown> = { input };
  const parentId = record.parent_id;
  if (parentId !== undefined) {
    if (typeof parentId !== "string" || parentId.trim().length === 0) {
      return { ok: false, result: fixInput(`${label}parent_id`, `parameter '${label}parent_id' must be a non-empty canonical todo id`) };
    }
    item.parentId = parentId;
  }
  return { ok: true, item: item as unknown as AddGoalTodoNodeItem };
}

/** Read the current view; surface restore-blocked / no-goal as engine-style errors. */
function readView(rt: GoalsRuntime, goalId?: string, scope?: string): { view?: GoalRuntimeView; error?: ToolResult } {
  let read: ReturnType<GoalRuntimeEngine["getGoal"]>;
  try {
    read = rt.engine.getGoal(goalId, scope);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: engineFailure(syntheticError("store_write_failed", `goal store read failed: ${message}`, "after_context_change")) };
  }
  if (read.diagnostics !== undefined && read.diagnostics.length > 0) {
    const first = read.diagnostics[0]!;
    return { error: engineFailure(syntheticError("restore_blocked", `${read.diagnostics.length} restore diagnostic(s); first: [${first.stream}] ${first.message}`, "after_context_change")) };
  }
  if (read.goal === undefined) return {};
  return { view: read.goal };
}

/** Active lanes of the store (get_goals overview), sorted oldest-first. */
function activeLanes(rt: GoalsRuntime): GoalOverviewEntry[] | undefined {
  try {
    const overview = rt.engine.getGoalsOverview();
    if (overview.diagnostics !== undefined && overview.diagnostics.length > 0) return undefined;
    return (overview.overview ?? []).filter((entry) => entry.status !== "complete");
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

export function nextActionFor(status: string): string {
  switch (status) {
    case "active":
      return "work the TODO tree, then propose_goal_completion";
    case "ready_for_oracle":
      return "record_goal_oracle (then update_goal status=complete on PASS)";
    case "oracle_failed":
      return "resume_goal <reason> after addressing the oracle findings";
    case "paused":
    case "blocked":
    case "budget_limited":
      return "resume_goal <reason>";
    case "complete":
      return "goal complete — /goal clear to archive the view";
    default:
      return "get_goal";
  }
}

/** Multi-line status block shared by the get_goal tool and /goal status. */
export function formatGoalStatusLines(view: GoalRuntimeView, mode: GoalActivationMode): string {
  const goal = view.goal;
  const summary = view.summary;
  const percent = Math.round(summary.progress * 100);
  const lines = [
    `goal ${goal.goalId} ${goal.status} (revision ${view.revisions.goal})${scopeSuffix(goal.scope, goal.scopeLabel)}`,
    `objective: ${goal.objective}`,
    `todos: ${summary.done}/${summary.total} done · open ${summary.open} · blocked ${summary.blocked.length} · progress ${percent}%`,
    `usage: turns ${goal.usage.turnsUsed}/${goal.loop.maxTurns} · tokens ${goal.usage.tokensUsed}`,
    `oracle: ${goal.oracleDecision === undefined ? "none" : `${goal.oracleDecision.verdict} no_ship=${goal.oracleDecision.noShip} decision ${goal.oracleDecision.oracleDecisionHash.slice(0, 12)}…`}`,
  ];
  if (goal.completionProposal !== undefined) {
    lines.push(`proposal: ${goal.completionProposal.proposalHash.slice(0, 12)}… (goal revision ${goal.completionProposal.goalRevision}, todos revision ${goal.completionProposal.todoGraphRevision})`);
  }
  lines.push(`mode: ${mode}`, `next: ${nextActionFor(goal.status)}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tool executors
// ---------------------------------------------------------------------------

async function execCreateGoal(getRuntime: GetRuntime, params: Record<string, unknown>): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return blockedSession();
  const objective = params.objective;
  if (typeof objective !== "string" || objective.trim().length === 0) {
    return fixInput("objective", "parameter 'objective' must be a non-empty string");
  }
  const maxTurns = intParam(params.max_turns, "max_turns", 1);
  if (maxTurns.error) return maxTurns.error;
  const scope = resolveScopeValue(rt, params.scope, "scope");
  if (!scope.ok) return scope.result;
  // scope label: the mesh alias rides along for display (agent lanes).
  let scopeLabel: string | undefined;
  if (scope.scope !== undefined && scope.scope.startsWith("agent:") && rt.meshIdentity !== undefined) {
    scopeLabel = rt.meshIdentity.alias;
  }
  const casParsed = parseCasParam(params.cas);
  if (!casParsed.ok) return casParsed.result;
  const outcome = rt.engine.createGoal(objective, casParsed.cas, {
    ...(maxTurns.value !== undefined ? { maxTurns: maxTurns.value } : {}),
    ...(scope.scope !== undefined ? { scope: scope.scope } : {}),
    ...(scopeLabel !== undefined ? { scopeLabel } : {}),
  });
  if (!outcome.ok) return engineFailure(outcome);
  const goal = outcome.result.goal;
  mirrorMutation(rt, "goal_created", outcome.receipt, { goalId: outcome.result.goalId, status: goal?.status, revision: goal?.revision });
  outboxMutation(rt, "goal_created", outcome.result.goalId, goal?.scope, outcome.receipt, { status: goal?.status, revision: goal?.revision });
  // Decision 1 (review P2): the default stays local — a detected mesh session
  // only WARNS so solo behavior never changes implicitly.
  const meshHint = params.scope === undefined && rt.scopeDefault === undefined && rt.meshIdentity !== undefined
    ? ` — mesh session detected (alias ${rt.meshIdentity.alias}, rooms ${rt.meshIdentity.rooms.join(", ") || "none"}): pass scope 'agent' for a private lane or 'room:<id>' to share`
    : "";
  return textResult(
    `${outcome.status === "replayed" ? "replayed: " : ""}created ${outcome.result.goalId} (status ${goal?.status ?? "active"}, revision ${goal?.revision ?? 1})${scopeSuffix(goal?.scope, goal?.scopeLabel)}${meshHint}`,
    {
      schema: RESULT_SCHEMA,
      status: outcome.status,
      goalId: outcome.result.goalId,
      goalStatus: goal?.status,
      revision: goal?.revision,
      ...(goal?.scope !== undefined ? { scope: goal.scope } : {}),
      ...(goal?.scopeLabel !== undefined ? { scopeLabel: goal.scopeLabel } : {}),
      cas: casOf(outcome),
    },
  );
}

async function execResumeGoal(getRuntime: GetRuntime, params: Record<string, unknown>): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return blockedSession();
  const reason = params.resume_reason;
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return fixInput("resume_reason", "parameter 'resume_reason' must be a non-empty string");
  }
  const extraTurns = intParam(params.additional_turns, "additional_turns", 1);
  if (extraTurns.error) return extraTurns.error;
  const goalId = params.goal_id;
  if (goalId !== undefined) {
    if (typeof goalId !== "string" || goalId.trim().length === 0) return fixInput("goal_id", "parameter 'goal_id' must be a non-empty goal id");
    const read = readView(rt, goalId);
    if (read.error) return read.error;
    if (read.view === undefined) return fixInput("goal_id", `parameter 'goal_id': no goal ${goalId} exists in the store`);
  }
  const casParsed = parseCasParam(params.cas);
  if (!casParsed.ok) return casParsed.result;
  const outcome = rt.engine.resumeGoal(reason, casParsed.cas, extraTurns.value, typeof goalId === "string" && goalId.trim().length > 0 ? { goalId } : undefined);
  if (!outcome.ok) return engineFailure(outcome);
  const result = outcome.result;
  mirrorMutation(rt, "goal_resumed", outcome.receipt, { goalId: result.goal.goalId, status: result.goal.status, revision: result.goal.revision });
  outboxMutation(rt, "goal_resumed", result.goal.goalId, result.goal.scope, outcome.receipt, { status: result.goal.status, revision: result.goal.revision });
  return textResult(
    `${outcome.status === "replayed" ? "replayed: " : ""}resumed ${result.goal.goalId} (was ${result.previousStatus}, now ${result.goal.status}, revision ${result.goal.revision})`,
    {
      schema: RESULT_SCHEMA,
      status: outcome.status,
      goalId: result.goal.goalId,
      revision: result.goal.revision,
      previousStatus: result.previousStatus,
      ...(result.additionalTurns !== undefined ? { additionalTurns: result.additionalTurns } : {}),
      cas: casOf(outcome),
    },
  );
}

async function execGetGoal(getRuntime: GetRuntime, params: Record<string, unknown>): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return blockedSession();
  const goalId = params.goal_id;
  if (goalId !== undefined && (typeof goalId !== "string" || goalId.trim().length === 0)) {
    return fixInput("goal_id", "parameter 'goal_id' must be a non-empty goal id");
  }
  const scope = resolveScopeValue(rt, params.scope, "scope");
  if (!scope.ok) return scope.result;
  const requestedGoalId = typeof goalId === "string" && goalId.trim().length > 0 ? goalId : undefined;
  const read = readView(rt, requestedGoalId, scope.scope);
  if (read.error) return read.error;
  if (read.view === undefined) {
    // batch-#2 fix: a PROVIDED but unknown goal id is its own precise
    // answer, distinct from the generic no-active-goal line.
    if (requestedGoalId !== undefined) {
      return textResult(`goal ${requestedGoalId} not found`, {
        schema: RESULT_SCHEMA,
        status: "not_found",
        goalId: requestedGoalId,
      });
    }
    // scope-aware ambiguity (review P6): several active lanes and no
    // goal_id/scope → name them instead of lying "no active goal".
    if (scope.scope === undefined) {
      const lanes = activeLanes(rt);
      if (lanes !== undefined && lanes.length > 1) {
        return textResult(
          `scope_ambiguous: ${lanes.length} active goals across scopes — ${lanes.map((lane) => `${lane.goalId} ${lane.scope}`).join(" · ")}; pass goal_id or scope`,
          { schema: RESULT_SCHEMA, status: "error", code: "scope_ambiguous", retryPolicy: "fix_input", lanes: lanes.map((lane) => ({ goalId: lane.goalId, scope: lane.scope })) },
        );
      }
    }
    return textResult("no active goal — create one with create_goal (or /goal <objective>)", {
      schema: RESULT_SCHEMA,
      status: "no_goal",
    });
  }
  const view = read.view;
  const goal = view.goal;
  return textResult(formatGoalStatusLines(view, rt.mode), {
    schema: RESULT_SCHEMA,
    status: goal.status,
    goalId: goal.goalId,
    revision: view.revisions.goal,
    objective: goal.objective,
    ...(goal.scope !== undefined ? { scope: goal.scope } : {}),
    ...(goal.scopeLabel !== undefined ? { scopeLabel: goal.scopeLabel } : {}),
    revisions: view.revisions,
    summary: {
      total: view.summary.total,
      done: view.summary.done,
      open: view.summary.open,
      blocked: view.summary.blocked.length,
      progress: view.summary.progress,
    },
    usage: goal.usage,
    loop: goal.loop,
    nextAction: nextActionFor(goal.status),
    completion: {
      completionReady: view.completion.completionReady,
      blockerCount: view.completion.blockers.length,
    },
  });
}

async function execGetGoals(getRuntime: GetRuntime, _params: Record<string, unknown>): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return blockedSession();
  let overview: ReturnType<GoalRuntimeEngine["getGoalsOverview"]>;
  try {
    overview = rt.engine.getGoalsOverview();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return engineFailure(syntheticError("store_write_failed", `goal store read failed: ${message}`, "after_context_change"));
  }
  if (overview.diagnostics !== undefined && overview.diagnostics.length > 0) {
    const first = overview.diagnostics[0]!;
    return engineFailure(syntheticError("restore_blocked", `${overview.diagnostics.length} restore diagnostic(s); first: [${first.stream}] ${first.message}`, "after_context_change"));
  }
  const entries = overview.overview ?? [];
  if (entries.length === 0) {
    return textResult("no goals in the store", { schema: RESULT_SCHEMA, status: "no_goal", goals: [] });
  }
  const active = entries.filter((entry) => entry.status !== "complete");
  const lines = [
    `goals: ${active.length} active / ${entries.length} total`,
    ...entries.map((entry) => {
      const trimmedObjective = entry.objective.length > 60 ? `${entry.objective.slice(0, 57)}…` : entry.objective;
      return `${entry.status === "complete" ? "✓" : entry.status === "active" ? "◆" : "·"} ${entry.goalId} [${entry.scope}${entry.scopeLabel !== undefined ? ` · ${entry.scopeLabel}` : ""}] ${entry.status} rev ${entry.revision} todos ${entry.todos} — ${trimmedObjective}`;
    }),
  ];
  return textResult(lines.join("\n"), {
    schema: RESULT_SCHEMA,
    status: "ok",
    activeCount: active.length,
    totalCount: entries.length,
    goals: entries.map((entry) => ({
      goal_id: entry.goalId,
      scope: entry.scope,
      ...(entry.scopeLabel !== undefined ? { scope_label: entry.scopeLabel } : {}),
      status: entry.status,
      revision: entry.revision,
      todos: entry.todos,
      objective: entry.objective,
    })),
  });
}

async function execGetGoalTodos(getRuntime: GetRuntime, params: Record<string, unknown>): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return blockedSession();
  const goalId = params.goal_id;
  if (goalId !== undefined && (typeof goalId !== "string" || goalId.trim().length === 0)) {
    return fixInput("goal_id", "parameter 'goal_id' must be a non-empty goal id");
  }
  const scope = resolveScopeValue(rt, params.scope, "scope");
  if (!scope.ok) return scope.result;
  const read = readView(rt, typeof goalId === "string" && goalId.trim().length > 0 ? goalId : undefined, scope.scope);
  if (read.error) return read.error;
  if (read.view === undefined) {
    return textResult("no active goal — TODOs require an active goal", { schema: RESULT_SCHEMA, status: "no_goal" });
  }
  const view = read.view;
  const ref = parseRef(params);
  let nodes = view.nodes;
  if (params.todo_id !== undefined || params.todo_path !== undefined) {
    if (ref.error) return ref.error;
    const todoId = ref.ref!.todoId;
    const todoPath = ref.ref!.todoPath;
    const matched = view.nodes.filter((node) => (todoId !== undefined ? node.id === todoId : true) && (todoPath !== undefined ? node.path === todoPath : true));
    if (matched.length === 0) {
      return engineFailure(syntheticError("reference_error", `todo ${todoId ?? todoPath} not found in goal ${view.goal.goalId}`, "fix_input"));
    }
    nodes = matched;
  }
  return textResult(renderGoalTodoTree(view.summary, nodes).join("\n"), {
    schema: RESULT_SCHEMA,
    status: "ok",
    goalId: view.goal.goalId,
    todosRevision: view.revisions.todos,
    total: view.summary.total,
    summary: view.summary,
    todos: nodes.map((node) => ({
      todo_id: node.id,
      todo_path: node.path,
      title: node.title,
      status: node.status,
      owner: node.owner,
      priority: node.priority,
      required: node.required,
    })),
  });
}

async function execAddTodos(getRuntime: GetRuntime, params: Record<string, unknown>, items: readonly AddGoalTodoNodeItem[], casValue: unknown, kind: "add_goal_todo" | "add_goal_todos"): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return blockedSession();
  const target = parseGoalTarget(rt, params);
  if (!target.ok) return target.result;
  const casParsed = parseCasParam(casValue);
  if (!casParsed.ok) return casParsed.result;
  const outcome = rt.engine.addTodos(items, casParsed.cas, target.selector);
  if (!outcome.ok) return engineFailure(outcome);
  const result = outcome.result;
  mirrorMutation(rt, kind === "add_goal_todo" ? "todo_added" : "todos_added", outcome.receipt, { todosRevision: result.todosRevision });
  const line = outcome.status === "replayed"
    ? `replayed: ${kind} (mutation_id ${outcome.receipt.mutationId}, no re-apply)`
    : `added ${result.created.length} todo(s) — ${result.summary.done}/${result.summary.total} done, ${result.summary.open} open (todos revision ${result.todosRevision})`;
  return textResult(line, {
    schema: RESULT_SCHEMA,
    status: outcome.status,
    created: result.created.map((node) => ({ todo_id: node.id, todo_path: node.path, title: node.title })),
    todosRevision: result.todosRevision,
    summary: result.summary,
    cas: casOf(outcome),
  });
}

async function execAddGoalTodo(getRuntime: GetRuntime, params: Record<string, unknown>): Promise<ToolResult> {
  const parsed = parseTodoItem(params, "");
  if (!parsed.ok) return parsed.result;
  return execAddTodos(getRuntime, params, [parsed.item], params.cas, "add_goal_todo");
}

async function execAddGoalTodos(getRuntime: GetRuntime, params: Record<string, unknown>): Promise<ToolResult> {
  const todos = params.todos;
  if (!Array.isArray(todos)) {
    return fixInput("todos", "parameter 'todos' must be an array of TODO items ({ title, parent_id?, owner?, required?, priority?, ... })");
  }
  const items: AddGoalTodoNodeItem[] = [];
  for (let index = 0; index < todos.length; index += 1) {
    const raw = todos[index]!;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return fixInput(`todos[${index}]`, `parameter 'todos[${index}]' must be an object`);
    }
    const parsed = parseTodoItem(raw as Record<string, unknown>, `todos[${index}].`);
    if (!parsed.ok) return parsed.result;
    items.push(parsed.item);
  }
  return execAddTodos(getRuntime, params, items, params.cas, "add_goal_todos");
}

async function execUpdateGoalTodo(getRuntime: GetRuntime, params: Record<string, unknown>): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return blockedSession();
  if (params.status !== undefined) {
    return fixInput("status", "parameter 'status' cannot be set here — status transitions go through resolve_goal_todo (or complete_goal_todo / block_goal_todo)");
  }
  const ref = parseRef(params);
  if (ref.error) return ref.error;
  const patch: Record<string, unknown> = {};
  const title = params.title;
  if (title !== undefined) {
    if (typeof title !== "string" || title.trim().length === 0) return fixInput("title", "parameter 'title' must be a non-empty string");
    patch.title = title;
  }
  const owner = enumParam(params.owner, "owner", GOAL_TODO_OWNER_VALUES);
  if (owner.error) return owner.error;
  if (owner.value !== undefined) patch.owner = owner.value;
  const required = boolParam(params.required, "required");
  if (required.error) return required.error;
  if (required.value !== undefined) patch.required = required.value;
  const priority = enumParam(params.priority, "priority", GOAL_TODO_PRIORITY_VALUES);
  if (priority.error) return priority.error;
  if (priority.value !== undefined) patch.priority = priority.value;
  for (const field of ["acceptance_criteria", "evidence_refs", "validation_commands"] as const) {
    const parsed = strArray(params[field], field);
    if (parsed.error) return parsed.error;
    if (parsed.values !== undefined) {
      const camel = field === "acceptance_criteria" ? "acceptanceCriteria" : field === "evidence_refs" ? "evidenceRefs" : "validationCommands";
      patch[camel] = parsed.values;
    }
  }
  const casParsed = parseCasParam(params.cas);
  if (!casParsed.ok) return casParsed.result;
  const target = parseGoalTarget(rt, params);
  if (!target.ok) return target.result;
  const outcome = rt.engine.updateTodoMetadata(ref.ref!, patch, casParsed.cas, target.selector);
  if (!outcome.ok) return engineFailure(outcome);
  const result = outcome.result;
  mirrorMutation(rt, "todo_updated", outcome.receipt, { todosRevision: result.todosRevision });
  return textResult(
    `${outcome.status === "replayed" ? "replayed: " : ""}updated todo ${result.node.path} '${result.node.title}' (changed: ${result.changed}, todos revision ${result.todosRevision})`,
    {
      schema: RESULT_SCHEMA,
      status: outcome.status,
      todo_id: result.node.id,
      todo_path: result.node.path,
      changed: result.changed,
      todosRevision: result.todosRevision,
      cas: casOf(outcome),
    },
  );
}

async function execResolveTodo(getRuntime: GetRuntime, params: Record<string, unknown>, actionOverride?: "complete" | "skip" | "block"): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return blockedSession();
  let actionValue: string;
  if (actionOverride !== undefined) {
    actionValue = actionOverride;
  } else {
    const parsed = enumParam(params.action, "action", RESOLVE_ACTION_VALUES);
    if (parsed.error !== undefined) return parsed.error;
    if (parsed.value === undefined) return fixInput("action", "parameter 'action' must be one of: " + RESOLVE_ACTION_VALUES.join(", "));
    actionValue = parsed.value;
  }
  const ref = parseRef(params);
  if (ref.error) return ref.error;
  const input: Record<string, unknown> = {};
  const reason = str(params.reason);
  if (reason !== undefined) input.reason = reason;
  if (params.user_resolved === true) input.userResolved = true;
  const claimHash = hash64(params.expected_claim_hash, "expected_claim_hash");
  if (claimHash.error) return claimHash.error;
  if (claimHash.value !== undefined) input.claimHash = claimHash.value;
  const attemptId = params.expected_attempt_id;
  if (attemptId !== undefined) {
    if (typeof attemptId !== "string" || !ATTEMPT_ID_PATTERN.test(attemptId)) {
      return fixInput("expected_attempt_id", "parameter 'expected_attempt_id' must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$");
    }
    input.attemptId = attemptId;
  }
  const policy = enumParam(params.expected_validation_policy, "expected_validation_policy", ["parent_review", "oracle_required"] as const);
  if (policy.error) return policy.error;
  if (policy.value !== undefined) input.validationPolicy = policy.value;
  const auto = enumParam(params.expected_auto_resolution, "expected_auto_resolution", ["complete", "accept_claim"] as const);
  if (auto.error) return auto.error;
  const casParsed = parseCasParam(params.cas);
  if (!casParsed.ok) return casParsed.result;
  const target = parseGoalTarget(rt, params);
  if (!target.ok) return target.result;
  const outcome = rt.engine.resolveTodo(ref.ref!, actionValue as Parameters<typeof rt.engine.resolveTodo>[1], input as Parameters<typeof rt.engine.resolveTodo>[2], casParsed.cas, target.selector);
  if (!outcome.ok) return engineFailure(outcome);
  const result = outcome.result;
  mirrorMutation(rt, "todo_resolved", outcome.receipt, { todosRevision: result.todosRevision });
  const suffix = result.settlement !== undefined ? `, claim ${result.settlement.settlement}` : "";
  return textResult(
    `${outcome.status === "replayed" ? "replayed: " : ""}todo ${result.node.path} '${result.node.title}' → ${result.node.status} (action ${actionValue}${suffix}, todos revision ${result.todosRevision})`,
    {
      schema: RESULT_SCHEMA,
      status: outcome.status,
      todo_id: result.node.id,
      todo_path: result.node.path,
      nodeStatus: result.node.status,
      action: actionValue,
      effects: result.effects,
      todosRevision: result.todosRevision,
      ...(result.settlement !== undefined ? { settlement: result.settlement } : {}),
      ...(result.claimComposition !== undefined ? { claimComposition: result.claimComposition, autoAccept: result.claimComposition.autoAccept, failures: result.claimComposition.failures } : {}),
      cas: casOf(outcome),
    },
  );
}

async function execCompleteGoalTodo(getRuntime: GetRuntime, params: Record<string, unknown>): Promise<ToolResult> {
  for (const [field, moved] of [["evidence_refs", "update_goal_todo"], ["validation_commands", "update_goal_todo"]] as const) {
    if (params[field] !== undefined) {
      return fixInput(field, `parameter '${field}' cannot be attached to completion — evidence updates go through ${moved} before completing (the engine transition carries no evidence fields)`);
    }
  }
  const skipped = params.skipped === true;
  if (params.skipped !== undefined && typeof params.skipped !== "boolean") {
    return fixInput("skipped", "parameter 'skipped' must be a boolean");
  }
  if (skipped) {
    const reason = str(params.reason);
    if (reason === undefined) return fixInput("reason", "parameter 'reason' is required when skipped: true");
  }
  return execResolveTodo(getRuntime, params, skipped ? "skip" : "complete");
}

async function execBlockGoalTodo(getRuntime: GetRuntime, params: Record<string, unknown>): Promise<ToolResult> {
  const reason = str(params.reason);
  if (reason === undefined) return fixInput("reason", "parameter 'reason' must be a non-empty blocker reason");
  return execResolveTodo(getRuntime, params, "block");
}

async function execSplitGoalTodo(getRuntime: GetRuntime, params: Record<string, unknown>): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return blockedSession();
  const ref = parseRef(params);
  if (ref.error) return ref.error;
  const titles = params.titles;
  if (!Array.isArray(titles) || titles.length === 0 || titles.some((title) => typeof title !== "string" || title.trim().length === 0)) {
    return fixInput("titles", "parameter 'titles' must be a non-empty array of non-empty child title strings");
  }
  const casParsed = parseCasParam(params.cas);
  if (!casParsed.ok) return casParsed.result;
  const target = parseGoalTarget(rt, params);
  if (!target.ok) return target.result;
  const read = readView(rt, target.selector?.goalId, target.selector?.scope);
  if (read.error) return read.error;
  if (read.view === undefined) {
    return engineFailure(syntheticError("goal_missing", "no active (non-complete) goal exists", "fix_input"));
  }
  const view = read.view;
  const todoId = ref.ref!.todoId;
  const todoPath = ref.ref!.todoPath;
  const parent = view.nodes.find((node) => (todoId !== undefined ? node.id === todoId : node.path === todoPath));
  if (parent === undefined) {
    return engineFailure(syntheticError("reference_error", `todo ${todoId ?? todoPath} not found in goal ${view.goal.goalId}`, "fix_input"));
  }
  const items: AddGoalTodoNodeItem[] = (titles as string[]).map((title) => ({
    parentId: parent.id,
    input: { title: title.trim(), required: true },
  }));
  const outcome = rt.engine.addTodos(items, casParsed.cas, target.selector);
  if (!outcome.ok) return engineFailure(outcome);
  const result = outcome.result;
  mirrorMutation(rt, "todo_split", outcome.receipt, { todosRevision: result.todosRevision });
  return textResult(
    `${outcome.status === "replayed" ? "replayed: " : ""}split todo ${parent.path} into ${result.created.length} children (todos revision ${result.todosRevision})`,
    {
      schema: RESULT_SCHEMA,
      status: outcome.status,
      parent: { todo_id: parent.id, todo_path: parent.path },
      created: result.created.map((node) => ({ todo_id: node.id, todo_path: node.path, title: node.title })),
      todosRevision: result.todosRevision,
      summary: result.summary,
      cas: casOf(outcome),
    },
  );
}

async function execLinkGoalTodoDelegation(getRuntime: GetRuntime, params: Record<string, unknown>): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return blockedSession();
  const ref = parseRef(params);
  if (ref.error) return ref.error;
  const runId = params.run_id;
  if (runId !== undefined && (typeof runId !== "string" || !ATTEMPT_ID_PATTERN.test(runId))) {
    return fixInput("run_id", "parameter 'run_id' must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$");
  }
  const agent = params.agent;
  if (agent !== undefined && (typeof agent !== "string" || !ATTEMPT_ID_PATTERN.test(agent))) {
    return fixInput("agent", "parameter 'agent' must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$");
  }
  const attemptId = params.attempt_id;
  if (attemptId !== undefined && (typeof attemptId !== "string" || !ATTEMPT_ID_PATTERN.test(attemptId))) {
    return fixInput("attempt_id", "parameter 'attempt_id' must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$");
  }
  const policy = enumParam(params.validation_policy, "validation_policy", ["parent_review", "oracle_required"] as const);
  if (policy.error) return policy.error;
  const depth = intParam(params.delegation_depth, "delegation_depth", 1);
  if (depth.error) return depth.error;
  const casParsed = parseCasParam(params.cas);
  if (!casParsed.ok) return casParsed.result;
  const target = parseGoalTarget(rt, params);
  if (!target.ok) return target.result;
  const outcome = rt.engine.linkDelegation(ref.ref!, {
    ...(attemptId !== undefined ? { attemptId } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(policy.value !== undefined ? { validationPolicy: policy.value } : {}),
    ...(depth.value !== undefined ? { delegationDepth: depth.value } : {}),
  }, casParsed.cas, target.selector);
  if (!outcome.ok) return engineFailure(outcome);
  const result = outcome.result;
  mirrorMutation(rt, "delegation_linked", outcome.receipt, { todosRevision: undefined });
  return textResult(
    `${outcome.status === "replayed" ? "replayed: " : ""}todo ${result.node.path} '${result.node.title}' → delegated (attempt ${result.attempt.attemptId}, policy ${result.attempt.validationPolicy}${result.attempt.runId !== undefined ? `, run ${result.attempt.runId}` : ""})`,
    {
      schema: RESULT_SCHEMA,
      status: outcome.status,
      attemptId: result.attempt.attemptId,
      runId: result.attempt.runId,
      agent: result.attempt.agent,
      validationPolicy: result.attempt.validationPolicy,
      delegationDepth: result.attempt.delegationDepth,
      node: { todo_id: result.node.id, todo_path: result.node.path, status: result.node.status },
      cas: casOf(outcome),
    },
  );
}

async function execReturnGoalTodoClaim(getRuntime: GetRuntime, params: Record<string, unknown>): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return blockedSession();
  const attemptId = params.expected_attempt_id;
  if (typeof attemptId !== "string" || !ATTEMPT_ID_PATTERN.test(attemptId)) {
    return fixInput("expected_attempt_id", "parameter 'expected_attempt_id' must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$");
  }
  const claimText = params.claim_text;
  if (claimText !== undefined && typeof claimText !== "string") {
    return fixInput("claim_text", "parameter 'claim_text' must be a string");
  }
  const claimHash = hash64(params.claim_hash, "claim_hash");
  if (claimHash.error) return claimHash.error;
  if (claimText === undefined && claimHash.value === undefined) {
    return fixInput("claim_text", "parameter 'claim_text' (or an exact 'claim_hash') is required to return a claim");
  }
  const evidenceRefs = strArray(params.evidence_refs, "evidence_refs");
  if (evidenceRefs.error) return evidenceRefs.error;
  const validationCommands = strArray(params.validation_commands, "validation_commands");
  if (validationCommands.error) return validationCommands.error;
  const noShip = boolParam(params.no_ship, "no_ship");
  if (noShip.error) return noShip.error;
  const casParsed = parseCasParam(params.cas);
  if (!casParsed.ok) return casParsed.result;
  const target = parseGoalTarget(rt, params);
  if (!target.ok) return target.result;
  const outcome = rt.engine.returnClaim(attemptId, {
    ...(claimText !== undefined ? { claimText } : {}),
    ...(claimHash.value !== undefined ? { claimHash: claimHash.value } : {}),
    ...(evidenceRefs.values !== undefined ? { evidenceRefs: evidenceRefs.values } : {}),
    ...(validationCommands.values !== undefined ? { validationCommands: validationCommands.values } : {}),
    ...(noShip.value !== undefined ? { noShip: noShip.value } : {}),
  }, casParsed.cas, target.selector);
  if (!outcome.ok) return engineFailure(outcome);
  const result = outcome.result;
  mirrorMutation(rt, "claim_returned", outcome.receipt, {});
  return textResult(
    `${outcome.status === "replayed" ? "replayed: " : ""}claim returned for attempt ${attemptId} (hash ${result.claim.claimHash.slice(0, 12)}…${result.node !== undefined ? `, todo ${result.node.path} → ${result.node.status}` : ""})`,
    {
      schema: RESULT_SCHEMA,
      status: outcome.status,
      attemptId,
      claimHash: result.claim.claimHash,
      validationPolicy: result.claim.validationPolicy,
      ...(result.node !== undefined ? { node: { todo_id: result.node.id, todo_path: result.node.path, status: result.node.status } } : {}),
      cas: casOf(outcome),
    },
  );
}

async function execValidateGoalTodoClaim(getRuntime: GetRuntime, params: Record<string, unknown>): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return blockedSession();
  const claimHash = hash64(params.claim_hash, "claim_hash");
  if (claimHash.error) return claimHash.error;
  if (claimHash.value === undefined) return fixInput("claim_hash", "parameter 'claim_hash' (exact full sha256 of the returned claim) is required");
  const attemptId = params.expected_attempt_id;
  if (typeof attemptId !== "string" || !ATTEMPT_ID_PATTERN.test(attemptId)) {
    return fixInput("expected_attempt_id", "parameter 'expected_attempt_id' must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$");
  }
  const policy = enumParam(params.expected_validation_policy, "expected_validation_policy", ["parent_review", "oracle_required"] as const);
  if (policy.error) return policy.error;
  if (policy.value === undefined) return fixInput("expected_validation_policy", "parameter 'expected_validation_policy' must echo the launch-fixed policy (parent_review | oracle_required)");
  const verdict = enumParam(params.verdict, "verdict", ["PASS", "WARN", "FAIL"] as const);
  if (verdict.error) return verdict.error;
  if (verdict.value === undefined) return fixInput("verdict", "parameter 'verdict' (PASS | WARN | FAIL) is required");
  const recommended = enumParam(params.recommended_action, "recommended_action", ["accept_claim", "needs_review", "reject_claim", "block"] as const);
  if (recommended.error) return recommended.error;
  if (recommended.value === undefined) return fixInput("recommended_action", "parameter 'recommended_action' is required");
  const noShip = boolParam(params.no_ship, "no_ship");
  if (noShip.error) return noShip.error;
  if (noShip.value === undefined) return fixInput("no_ship", "parameter 'no_ship' (boolean) is required");
  const confidence = enumParam(params.confidence, "confidence", ["LOW", "MEDIUM", "HIGH"] as const);
  if (confidence.error) return confidence.error;
  if (confidence.value === undefined) return fixInput("confidence", "parameter 'confidence' (LOW | MEDIUM | HIGH) is required");
  const outputHash = hash64(params.output_hash, "output_hash");
  if (outputHash.error) return outputHash.error;
  if (outputHash.value === undefined) return fixInput("output_hash", "parameter 'output_hash' (exact full sha256 of the validated output) is required");
  const blockingIssues = strArray(params.blocking_issues, "blocking_issues");
  if (blockingIssues.error) return blockingIssues.error;
  const evidenceRefs = strArray(params.evidence_refs, "evidence_refs");
  if (evidenceRefs.error) return evidenceRefs.error;
  const validationCommands = strArray(params.validation_commands, "validation_commands");
  if (validationCommands.error) return validationCommands.error;
  const agent = params.agent !== undefined ? str(params.agent) : undefined;
  const runId = params.run_id;
  if (runId !== undefined && (typeof runId !== "string" || !ATTEMPT_ID_PATTERN.test(runId))) {
    return fixInput("run_id", "parameter 'run_id' must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$");
  }

  // Adapter-side binding echo (zob parity): the exact returned claim must
  // match claim_hash / expected_validation_policy before the engine records.
  // Scope-aware (review): the claim may live on ANY lane (room goals); the
  // default view is tried first, then every active lane's goal.
  const target = parseGoalTarget(rt, params);
  if (!target.ok) return target.result;
  const claimCandidates: GoalRuntimeView[] = [];
  const primary = readView(rt, target.selector?.goalId, target.selector?.scope);
  if (primary.error) return primary.error;
  if (primary.view !== undefined) claimCandidates.push(primary.view);
  if (primary.view?.claims.claims[attemptId] === undefined) {
    for (const lane of activeLanes(rt) ?? []) {
      if (primary.view !== undefined && lane.goalId === primary.view.goal.goalId) continue;
      const laneRead = readView(rt, lane.goalId);
      if (laneRead.error !== undefined || laneRead.view === undefined) continue;
      if (laneRead.view.claims.claims[attemptId] !== undefined) {
        claimCandidates.push(laneRead.view);
        break;
      }
    }
  }
  const claimView = claimCandidates.find((candidate) => candidate.claims.claims[attemptId] !== undefined);
  if (claimView === undefined) {
    return engineFailure(syntheticError("goal_missing", `no active (non-complete) goal holds attempt ${attemptId}`, "fix_input"));
  }
  const claim = claimView.claims.claims[attemptId]!;
  if (claim === undefined) {
    return fixInput("expected_attempt_id", `parameter 'expected_attempt_id': no returned claim exists for attempt ${attemptId}`);
  }
  if (claim.claimHash !== claimHash.value) {
    return fixInput("claim_hash", `parameter 'claim_hash' does not match the returned claim hash for attempt ${attemptId}`);
  }
  if (claim.validationPolicy !== policy.value) {
    return fixInput("expected_validation_policy", `parameter 'expected_validation_policy' must echo the launch-fixed policy '${claim.validationPolicy}'`);
  }

  const casParsed = parseCasParam(params.cas);
  if (!casParsed.ok) return casParsed.result;
  const outcome = rt.engine.recordClaimValidation(attemptId, {
    verdict: verdict.value,
    recommendedAction: recommended.value,
    noShip: noShip.value,
    confidence: confidence.value,
    ...(blockingIssues.values !== undefined ? { blockingIssues: blockingIssues.values } : {}),
    outputHash: outputHash.value,
    ...(evidenceRefs.values !== undefined ? { evidenceRefs: evidenceRefs.values } : {}),
    ...(validationCommands.values !== undefined ? { validationCommands: validationCommands.values } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(runId !== undefined ? { runId } : {}),
  }, casParsed.cas, target.selector);
  if (!outcome.ok) return engineFailure(outcome);
  const result = outcome.result;
  mirrorMutation(rt, "claim_validated", outcome.receipt, {});
  const failures = result.claimRule.failures;
  return textResult(
    `${outcome.status === "replayed" ? "replayed: " : ""}claim validated: verdict ${result.validation.verdict} · recommended ${result.validation.recommendedAction} · autoAccept ${result.claimRule.autoAccept}${result.claimRule.autoAccept ? "" : ` (failing: ${failures.join(", ")})`}`,
    {
      schema: RESULT_SCHEMA,
      status: outcome.status,
      attemptId,
      claimHash: claimHash.value,
      validation: result.validation,
      // BUG-4: cleartext blocking issues are echoed TRANSIENTLY here (never persisted)
      ...(blockingIssues.values !== undefined ? { blockingIssues: blockingIssues.values } : {}),
      claimRule: result.claimRule,
      autoAccept: result.claimRule.autoAccept,
      failures,
      oracleComposition: result.oracleComposition,
      cas: casOf(outcome),
    },
  );
}

async function execSettleClaim(getRuntime: GetRuntime, params: Record<string, unknown>, action: "accept_claim" | "reject_claim"): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return blockedSession();
  if (action === "reject_claim") {
    const reason = str(params.reason);
    if (reason === undefined) return fixInput("reason", "parameter 'reason' must be a non-empty rejection reason");
  }
  return execResolveTodo(getRuntime, { ...params, action }, undefined);
}

async function execProposeCompletion(getRuntime: GetRuntime, params: Record<string, unknown>): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return blockedSession();
  const summary = params.completion_summary;
  if (typeof summary !== "string" || summary.trim().length === 0) {
    return fixInput("completion_summary", "parameter 'completion_summary' must be a non-empty string");
  }
  const fields: Record<string, string[]> = {};
  for (const field of ["requirements_checked", "evidence_refs", "validation_commands", "known_risks"] as const) {
    const parsed = strArray(params[field], field);
    if (parsed.error) return parsed.error;
    if (parsed.values === undefined) return fixInput(field, `parameter '${field}' must be an array of strings (empty array allowed)`);
    fields[field] = parsed.values;
  }
  const noShip = boolParam(params.no_ship, "no_ship");
  if (noShip.error) return noShip.error;
  if (noShip.value === undefined) return fixInput("no_ship", "parameter 'no_ship' (boolean) is required — true blocks the proposal");
  const casParsed = parseCasParam(params.cas);
  if (!casParsed.ok) return casParsed.result;
  const target = parseGoalTarget(rt, params);
  if (!target.ok) return target.result;
  const outcome = rt.engine.proposeCompletion({
    completionSummary: summary,
    requirementsChecked: fields.requirements_checked!,
    evidenceRefs: fields.evidence_refs!,
    validationCommands: fields.validation_commands!,
    knownRisks: fields.known_risks!,
    noShip: noShip.value,
  }, casParsed.cas, target.selector);
  if (!outcome.ok) return engineFailure(outcome);
  const result = outcome.result;
  const proposal = result.proposal;
  mirrorMutation(rt, "completion_proposed", outcome.receipt, { goalId: result.goal.goalId, status: result.goal.status, revision: result.goal.revision });
  outboxMutation(rt, "completion_proposed", result.goal.goalId, result.goal.scope, outcome.receipt, { status: result.goal.status, revision: result.goal.revision });
  return textResult(
    `${outcome.status === "replayed" ? "replayed: " : ""}proposal ready (goal → ${result.goal.status}, revision ${result.goal.revision}) — proposalHash ${proposal?.proposalHash.slice(0, 12) ?? "?"}…`,
    {
      schema: RESULT_SCHEMA,
      status: outcome.status,
      goalId: result.goal.goalId,
      proposalHash: proposal?.proposalHash,
      goalRevision: proposal?.goalRevision,
      todoGraphRevision: proposal?.todoGraphRevision,
      noShip: proposal?.noShip,
      cas: casOf(outcome),
    },
  );
}

async function execRecordOracle(getRuntime: GetRuntime, params: Record<string, unknown>): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return blockedSession();
  const verdict = enumParam(params.verdict, "verdict", ["PASS", "WARN", "FAIL"] as const);
  if (verdict.error) return verdict.error;
  if (verdict.value === undefined) return fixInput("verdict", "parameter 'verdict' (PASS | WARN | FAIL) is required");
  const noShip = boolParam(params.no_ship, "no_ship");
  if (noShip.error) return noShip.error;
  if (noShip.value === undefined) return fixInput("no_ship", "parameter 'no_ship' (boolean) is required");
  const evidenceSummary = params.evidence_summary;
  if (typeof evidenceSummary !== "string" || evidenceSummary.trim().length === 0) {
    return fixInput("evidence_summary", "parameter 'evidence_summary' must be a non-empty string");
  }
  const evidenceRefs = strArray(params.evidence_refs, "evidence_refs");
  if (evidenceRefs.error) return evidenceRefs.error;
  const expected = hash64(params.expected_proposal_hash, "expected_proposal_hash");
  if (expected.error) return expected.error;
  if (expected.value === undefined) return fixInput("expected_proposal_hash", "parameter 'expected_proposal_hash' (exact proposal sha256) is required");

  // zob parity: the oracle echoes the EXACT bound proposal hash (scope-aware read).
  const target = parseGoalTarget(rt, params);
  if (!target.ok) return target.result;
  const read = readView(rt, target.selector?.goalId, target.selector?.scope);
  if (read.error) return read.error;
  const proposal = read.view?.goal.completionProposal;
  if (proposal === undefined) {
    return fixInput("expected_proposal_hash", "parameter 'expected_proposal_hash': no completion proposal is bound to the active goal — propose_goal_completion first");
  }
  if (proposal.proposalHash !== expected.value) {
    return fixInput("expected_proposal_hash", "parameter 'expected_proposal_hash' does not match the bound completion proposal hash");
  }

  const casParsed = parseCasParam(params.cas);
  if (!casParsed.ok) return casParsed.result;
  const outcome = rt.engine.recordOracleDecision({
    verdict: verdict.value,
    noShip: noShip.value,
    evidenceSummary,
    ...(evidenceRefs.values !== undefined ? { evidenceRefs: evidenceRefs.values } : {}),
  }, casParsed.cas, target.selector);
  if (!outcome.ok) return engineFailure(outcome);
  const result = outcome.result;
  mirrorMutation(rt, "oracle_recorded", outcome.receipt, { goalId: result.goal.goalId, status: result.goal.status, revision: result.goal.revision });
  outboxMutation(rt, "oracle_recorded", result.goal.goalId, result.goal.scope, outcome.receipt, { status: result.goal.status, revision: result.goal.revision });
  return textResult(
    `${outcome.status === "replayed" ? "replayed: " : ""}oracle ${result.decision.verdict} recorded (goal ${result.goal.status}, revision ${result.goal.revision}) — decisionHash ${result.decision.oracleDecisionHash.slice(0, 12)}…`,
    {
      schema: RESULT_SCHEMA,
      status: outcome.status,
      goalId: result.goal.goalId,
      verdict: result.decision.verdict,
      noShip: result.decision.noShip,
      oracleDecisionHash: result.decision.oracleDecisionHash,
      goalRevision: result.decision.goalRevision,
      proposalHash: result.decision.proposalHash,
      cas: casOf(outcome),
    },
  );
}

async function execUpdateGoal(getRuntime: GetRuntime, params: Record<string, unknown>): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return blockedSession();
  if (params.status !== "complete") {
    return fixInput("status", "parameter 'status' accepts only 'complete' (after a bound strict-PASS oracle decision); pause/resume semantics live in resume_goal");
  }
  const proposalHash = hash64(params.expected_proposal_hash, "expected_proposal_hash");
  if (proposalHash.error) return proposalHash.error;
  if (proposalHash.value === undefined) return fixInput("expected_proposal_hash", "parameter 'expected_proposal_hash' (exact proposal sha256) is required");
  const decisionHash = hash64(params.expected_oracle_decision_hash, "expected_oracle_decision_hash");
  if (decisionHash.error) return decisionHash.error;
  if (decisionHash.value === undefined) return fixInput("expected_oracle_decision_hash", "parameter 'expected_oracle_decision_hash' (exact decision sha256) is required");
  const casParsed = parseCasParam(params.cas);
  if (!casParsed.ok) return casParsed.result;
  const target = parseGoalTarget(rt, params);
  if (!target.ok) return target.result;
  const outcome = rt.engine.completeGoal(casParsed.cas, {
    expectedProposalHash: proposalHash.value,
    expectedOracleDecisionHash: decisionHash.value,
  }, target.selector);
  if (!outcome.ok) return engineFailure(outcome);
  const result = outcome.result;
  mirrorMutation(rt, "goal_completed", outcome.receipt, { goalId: result.goal.goalId, status: result.goal.status, revision: result.goal.revision });
  outboxMutation(rt, "goal_completed", result.goal.goalId, result.goal.scope, outcome.receipt, { status: result.goal.status, revision: result.goal.revision });
  return textResult(
    `${outcome.status === "replayed" ? "replayed: " : ""}goal ${result.goal.goalId} complete (revision ${result.goal.revision})`,
    {
      schema: RESULT_SCHEMA,
      status: outcome.status,
      goalId: result.goal.goalId,
      revision: result.goal.revision,
      cas: casOf(outcome),
    },
  );
}

// ---------------------------------------------------------------------------
// JSON Schema fragments
// ---------------------------------------------------------------------------

/** Goal-target parameters shared by every goal-scoped tool: goal_id
 * (explicit cross-scope addressing) or scope (local | agent | room |
 * room:<id> | agent:<id>). Absent both → the engine's exactly-one-active
 * fallback (solo contract, review P6). */
const GOAL_TARGET_PARAMS: Record<string, unknown> = {
  goal_id: { type: "string", description: "Optional explicit goal id (cross-scope addressing)." },
  scope: { type: "string", description: "Optional goal scope: 'local' (solo), 'agent' (this session's private lane), 'room:<id>' (shared mesh room). 'room' alone works only when the session joined exactly one room." },
};

const CAS_SCHEMA: Record<string, unknown> = {
  type: "object",
  description: "CAS guard (OPTIONAL, zob parity): { mutation_id, expected_goal_revision?, expected_graph_revision?, expected_todo_revision? }. Absent slots are unchecked; without cas the engine applies the mutation under a fresh auto-generated id (not replay-idempotent). Pass mutation_id (revision slots optional) for idempotent mutations; revisions come from the latest result/get_goal.",
  properties: {
    mutation_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", description: "Unique idempotency id for this exact mutation." },
    expected_goal_revision: { type: "integer", minimum: 0, description: "Optimistic goal-stream revision." },
    expected_graph_revision: { type: "integer", minimum: 0, description: "Optimistic TODO-graph revision." },
    expected_todo_revision: { type: "integer", minimum: 0, description: "Optimistic per-todo revision." },
  },
  required: ["mutation_id"],
};

const REF_SCHEMA: Record<string, unknown> = {
  todo_id: { type: "string", description: "Canonical TODO id (todo_xxx). todo_id or todo_path is required." },
  todo_path: { type: "string", description: "Visible TODO path (e.g. '1.2'). todo_id or todo_path is required." },
};

/** Batch-#2 fix: get_goal_todos refs are OPTIONAL — either one narrows the
 * view to a single node, and a BARE call returns the full tree (anyOf
 * style, matching the actual executor behavior). */
const REF_SCHEMA_OPTIONAL: Record<string, unknown> = {
  todo_id: { type: "string", description: "Optional canonical TODO id (todo_xxx); narrows to that node. A bare call returns the full tree." },
  todo_path: { type: "string", description: "Optional visible TODO path (e.g. '1.2'); narrows to that node. A bare call returns the full tree." },
};

const TODO_ITEM_SCHEMA: Record<string, unknown> = {
  title: { type: "string", description: "Atomic TODO title." },
  parent_id: { type: "string", description: "Optional parent TODO id for subtodos." },
  owner: { type: "string", enum: [...GOAL_TODO_OWNER_VALUES], description: "TODO owner. Default agent." },
  required: { type: "boolean", description: "Whether this TODO blocks root completion. Default true." },
  priority: { type: "string", enum: [...GOAL_TODO_PRIORITY_VALUES], description: "TODO priority. Default normal." },
  status: { type: "string", enum: [...GOAL_TODO_STATUS_VALUES], description: "Initial TODO status. Default planned." },
  acceptance_criteria: { type: "array", items: { type: "string" }, description: "Acceptance criteria for this TODO." },
  evidence_refs: { type: "array", items: { type: "string" }, description: "Initial safe evidence refs." },
  validation_commands: { type: "array", items: { type: "string" }, description: "Initial validation commands." },
};

const CLAIM_BINDING_SCHEMA: Record<string, unknown> = {
  expected_claim_hash: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Exact full sha256 of the returned claim." },
  expected_attempt_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$", description: "Exact delegation attempt id bound to the claim." },
  expected_validation_policy: { type: "string", enum: ["parent_review", "oracle_required"], description: "Launch-fixed claim validation policy." },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTools(pi: ExtensionAPI, getRuntime: GetRuntime, onChanged?: () => void): void {
  const fire = (exec: (getRuntime: GetRuntime, params: Record<string, unknown>) => Promise<ToolResult>) => {
    return async (_toolCallId: string, params: Record<string, unknown>): Promise<ToolResult> => {
      const result = await exec(getRuntime, params);
      onChanged?.();
      return result;
    };
  };

  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description: "Create the runtime goal (single active goal per scope: local solo lane, agent private lane, or room shared lane). Returns the goal id and revision for CAS-guarded follow-up mutations.",
    promptSnippet: "Start a runtime goal with a concrete objective.",
    promptGuidelines: "One active goal per scope. Solo default is the local lane; in a mesh swarm pass scope 'agent' (private) or 'room:<id>' (shared). cas.expected_goal_revision must be 0 for a fresh scope. Read revisions from the result details for follow-up calls.",
    parameters: {
      type: "object",
      properties: {
        objective: { type: "string", description: "Concrete objective to pursue until ready_for_oracle." },
        max_turns: { type: "integer", minimum: 1, description: "Optional positive turn cap for the continuation loop." },
        scope: { type: "string", description: "Goal scope: 'local' (default, solo), 'agent' (this session's private lane), 'room:<id>' (shared mesh room). 'room' alone works only when the session joined exactly one room." },
        cas: CAS_SCHEMA,
      },
      required: ["objective"],
    },
    execute: fire(execCreateGoal),
  });

  pi.registerTool({
    name: "resume_goal",
    label: "Resume Goal",
    description: "Resume a paused/blocked/oracle_failed/budget_limited goal with a non-empty reason.",
    parameters: {
      type: "object",
      properties: {
        resume_reason: { type: "string", description: "Why resuming is safe (stored as hash only)." },
        additional_turns: { type: "integer", minimum: 1, description: "Optional turn-window extension." },
        goal_id: { type: "string", description: "Optional expected current goal id." },
        cas: CAS_SCHEMA,
      },
      required: ["resume_reason"],
    },
    execute: fire(execResumeGoal),
  });

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Show the active (or given) runtime goal: status, objective, TODO summary, usage, oracle binding, and the next safe action. Pass goal_id or scope when several lanes are active.",
    parameters: {
      type: "object",
      properties: { ...GOAL_TARGET_PARAMS },
    },
    execute: fire(execGetGoal),
  });

  pi.registerTool({
    name: "get_goals",
    label: "Get Goals",
    description: "List every goal in the store with its scope (multi-agent overview): one line per goal, active lanes flagged, so scope-ambiguous stores can be disambiguated.",
    parameters: { type: "object", properties: {} },
    execute: fire(execGetGoals),
  });

  pi.registerTool({
    name: "get_goal_todos",
    label: "Get Goal Todos",
    description: "Show the goal's TODO tree (status icons ○ ● ✓ ⊘ ⤫ + progress). A bare call renders the full tree; an optional canonical ref narrows to one node.",
    parameters: {
      // Plain object root — some OpenAI-compatible providers (e.g. xAI grok)
      // reject tool parameter roots that resolve to anyOf/oneOf unions with
      // non-object branches (400 "tool parameter root must be an object type").
      // todo_id/todo_path stay OPTIONAL: a bare call returns the full tree,
      // and either ref narrows the view (enforced by the executor).
      type: "object",
      properties: {
        ...GOAL_TARGET_PARAMS,
        ...REF_SCHEMA_OPTIONAL,
      },
    },
    execute: fire(execGetGoalTodos),
  });

  pi.registerTool({
    name: "add_goal_todo",
    label: "Add Goal Todo",
    description: "Add ONE TODO to the active goal. Prefer add_goal_todos for plans (single atomic batch).",
    parameters: { type: "object", properties: { ...TODO_ITEM_SCHEMA, scope: GOAL_TARGET_PARAMS.scope, cas: CAS_SCHEMA }, required: ["title"] },
    execute: fire(execAddGoalTodo),
  });

  pi.registerTool({
    name: "add_goal_todos",
    label: "Add Goal Todos",
    description: "Add multiple TODOs to the active goal in ONE atomic batch (single persisted snapshot).",
    parameters: {
      type: "object",
      properties: {
        todos: { type: "array", items: { type: "object", properties: TODO_ITEM_SCHEMA, required: ["title"] }, description: "Bounded TODO nodes to add." },
        scope: GOAL_TARGET_PARAMS.scope,
        cas: CAS_SCHEMA,
      },
      required: ["todos"],
    },
    execute: fire(execAddGoalTodos),
  });

  pi.registerTool({
    name: "update_goal_todo",
    label: "Update Goal Todo",
    description: "Patch TODO metadata (title/owner/required/priority/acceptance/evidence/validation). Status transitions are forbidden here — use resolve_goal_todo.",
    parameters: {
      type: "object",
      properties: {
        ...REF_SCHEMA,
        scope: GOAL_TARGET_PARAMS.scope,
        status: { type: "string", description: "REJECTED if present — status transitions go through resolve_goal_todo (or complete_goal_todo / block_goal_todo)." },
        title: { type: "string", description: "Replacement title." },
        owner: { type: "string", enum: [...GOAL_TODO_OWNER_VALUES], description: "New owner." },
        required: { type: "boolean", description: "Whether this TODO blocks root completion." },
        priority: { type: "string", enum: [...GOAL_TODO_PRIORITY_VALUES], description: "New priority." },
        acceptance_criteria: { type: "array", items: { type: "string" }, description: "Replacement acceptance criteria." },
        evidence_refs: { type: "array", items: { type: "string" }, description: "Replacement evidence refs." },
        validation_commands: { type: "array", items: { type: "string" }, description: "Replacement validation commands." },
        cas: CAS_SCHEMA,
      },
      required: [],
    },
    execute: fire(execUpdateGoalTodo),
  });

  pi.registerTool({
    name: "resolve_goal_todo",
    label: "Resolve Goal Todo",
    description: "Apply a lifecycle transition to a TODO: auto/complete/accept_claim/reject_claim/block/skip/reopen. Returned claims require the exact claim binding echo.",
    parameters: {
      type: "object",
      properties: {
        ...REF_SCHEMA,
        action: { type: "string", enum: [...RESOLVE_ACTION_VALUES], description: "Transition action." },
        expected_auto_resolution: { type: "string", enum: ["complete", "accept_claim"], description: "Explicit expected resolution for action=auto." },
        ...CLAIM_BINDING_SCHEMA,
        reason: { type: "string", description: "Required for block/reject_claim/reopen; skip reason for skip." },
        user_resolved: { type: "boolean", description: "Parent acknowledgement that a needs_user requirement was resolved." },
        goal_id: { type: "string", description: "Optional goal id. Defaults to the active goal." },
        scope: GOAL_TARGET_PARAMS.scope,
        cas: CAS_SCHEMA,
      },
      required: ["action"],
    },
    execute: fire(execResolveTodo),
  });

  pi.registerTool({
    name: "complete_goal_todo",
    label: "Complete Goal Todo",
    description: "Complete (or skip with skipped:true + reason) a TODO. Attach evidence beforehand via update_goal_todo.",
    parameters: {
      type: "object",
      properties: {
        ...REF_SCHEMA,
        skipped: { type: "boolean", description: "Mark skipped instead of done." },
        reason: { type: "string", description: "Skip reason when skipped=true." },
        ...GOAL_TARGET_PARAMS,
        cas: CAS_SCHEMA,
      },
      required: [],
    },
    execute: fire(execCompleteGoalTodo),
  });

  pi.registerTool({
    name: "block_goal_todo",
    label: "Block Goal Todo",
    description: "Mark a TODO blocked with a non-empty blocker reason.",
    parameters: {
      type: "object",
      properties: { ...REF_SCHEMA, reason: { type: "string", description: "Blocker reason." }, ...GOAL_TARGET_PARAMS, cas: CAS_SCHEMA },
      required: ["reason"],
    },
    execute: fire(execBlockGoalTodo),
  });

  pi.registerTool({
    name: "split_goal_todo",
    label: "Split Goal Todo",
    description: "Split a TODO into required child subtodos (one atomic batch under the resolved parent).",
    parameters: {
      type: "object",
      properties: { ...REF_SCHEMA, titles: { type: "array", items: { type: "string" }, description: "Child TODO titles." }, ...GOAL_TARGET_PARAMS, cas: CAS_SCHEMA },
      required: ["titles"],
    },
    execute: fire(execSplitGoalTodo),
  });

  pi.registerTool({
    name: "link_goal_todo_delegation",
    label: "Link Goal Todo Delegation",
    description: "Launch a delegation attempt for a TODO (parent-owned): freezes the validation policy at launch, moves the node to delegated, and returns the attempt id for the child's return_goal_todo_claim.",
    parameters: {
      type: "object",
      properties: {
        ...REF_SCHEMA,
        attempt_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$", description: "Optional explicit attempt id (auto-generated when omitted)." },
        run_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$", description: "Optional child run id provenance." },
        agent: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$", description: "Optional delegated agent name." },
        validation_policy: { type: "string", enum: ["parent_review", "oracle_required"], description: "Claim validation policy frozen at launch. Default parent_review." },
        delegation_depth: { type: "integer", minimum: 1, description: "Parent-owned delegation depth metadata. Default 1." },
        ...GOAL_TARGET_PARAMS,
        cas: CAS_SCHEMA,
      },
      required: [],
    },
    execute: fire(execLinkGoalTodoDelegation),
  });

  pi.registerTool({
    name: "return_goal_todo_claim",
    label: "Return Goal Todo Claim",
    description: "Return a child's claim for a launched delegation attempt (claim_text or exact claim_hash required); moves the bound TODO to claim_returned for parent settlement.",
    parameters: {
      type: "object",
      properties: {
        expected_attempt_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$", description: "Exact delegation attempt id the claim returns for." },
        claim_text: { type: "string", description: "Full claim text (stored as sha256 hash only)." },
        claim_hash: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Exact full sha256 of the claim (alternative to claim_text)." },
        evidence_refs: { type: "array", items: { type: "string" }, description: "Claim evidence refs." },
        validation_commands: { type: "array", items: { type: "string" }, description: "Claim validation commands." },
        no_ship: { type: "boolean", description: "True when the child flags a no-ship condition." },
        ...GOAL_TARGET_PARAMS,
        cas: CAS_SCHEMA,
      },
      required: ["expected_attempt_id"],
    },
    execute: fire(execReturnGoalTodoClaim),
  });

  pi.registerTool({
    name: "validate_goal_todo_claim",
    label: "Validate Goal Todo Claim",
    description: "Record an oracle validation for a returned delegation claim. Exposes the strict-PASS auto-accept composition (autoAccept true|false with the failing dimensions).",
    parameters: {
      type: "object",
      properties: {
        ...REF_SCHEMA,
        verdict: { type: "string", enum: ["PASS", "WARN", "FAIL"], description: "Oracle verdict for the returned claim." },
        recommended_action: { type: "string", enum: ["accept_claim", "needs_review", "reject_claim", "block"], description: "Oracle recommended parent action." },
        no_ship: { type: "boolean", description: "True when any no-ship blocker remains." },
        confidence: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"], description: "Oracle confidence." },
        blocking_issues: { type: "array", items: { type: "string" }, description: "Blocking issues, or empty for PASS." },
        claim_hash: CLAIM_BINDING_SCHEMA.expected_claim_hash,
        expected_attempt_id: CLAIM_BINDING_SCHEMA.expected_attempt_id,
        expected_validation_policy: CLAIM_BINDING_SCHEMA.expected_validation_policy,
        output_hash: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Exact sha256 of the validated output." },
        evidence_refs: { type: "array", items: { type: "string" }, description: "Evidence refs inspected by the oracle." },
        validation_commands: { type: "array", items: { type: "string" }, description: "Validation commands checked by the oracle." },
        agent: { type: "string", description: "Oracle agent name. Default oracle." },
        run_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$", description: "Optional provenance run id persisted with the validation." },
        ...GOAL_TARGET_PARAMS,
        cas: CAS_SCHEMA,
      },
      required: ["verdict", "recommended_action", "no_ship", "confidence", "claim_hash", "expected_attempt_id", "expected_validation_policy", "output_hash"],
    },
    execute: fire(execValidateGoalTodoClaim),
  });

  pi.registerTool({
    name: "accept_goal_todo_claim",
    label: "Accept Goal Todo Claim",
    description: "Accept a returned delegation claim (exact binding echo required). Surfaces the settlement and the strict-PASS composition.",
    parameters: {
      type: "object",
      properties: { ...REF_SCHEMA, ...CLAIM_BINDING_SCHEMA, ...GOAL_TARGET_PARAMS, cas: CAS_SCHEMA },
      required: ["expected_claim_hash", "expected_attempt_id", "expected_validation_policy"],
    },
    execute: fire((rt, params) => execSettleClaim(rt, params, "accept_claim")),
  });

  pi.registerTool({
    name: "reject_goal_todo_claim",
    label: "Reject Goal Todo Claim",
    description: "Reject a returned delegation claim with a non-empty reason (exact binding echo required).",
    parameters: {
      type: "object",
      properties: { ...REF_SCHEMA, ...CLAIM_BINDING_SCHEMA, reason: { type: "string", description: "Required parent rejection reason." }, ...GOAL_TARGET_PARAMS, cas: CAS_SCHEMA },
      required: ["expected_claim_hash", "expected_attempt_id", "expected_validation_policy", "reason"],
    },
    execute: fire((rt, params) => execSettleClaim(rt, params, "reject_claim")),
  });

  pi.registerTool({
    name: "propose_goal_completion",
    label: "Propose Goal Completion",
    description: "Propose evidence-backed goal completion (goal → ready_for_oracle). Blocked while required TODOs are open or no_ship=true.",
    parameters: {
      type: "object",
      properties: {
        completion_summary: { type: "string", description: "Evidence-backed summary of completed work (stored as hash only)." },
        requirements_checked: { type: "array", items: { type: "string" }, description: "Explicit requirements checked before oracle." },
        evidence_refs: { type: "array", items: { type: "string" }, description: "Safe repo-relative evidence references." },
        validation_commands: { type: "array", items: { type: "string" }, description: "Validation commands run and checked." },
        known_risks: { type: "array", items: { type: "string" }, description: "Known remaining risks or blockers." },
        no_ship: { type: "boolean", description: "True if any no-ship blocker remains." },
        scope: GOAL_TARGET_PARAMS.scope,
        cas: CAS_SCHEMA,
      },
      required: ["completion_summary", "requirements_checked", "evidence_refs", "validation_commands", "known_risks", "no_ship"],
    },
    execute: fire(execProposeCompletion),
  });

  pi.registerTool({
    name: "record_goal_oracle",
    label: "Record Goal Oracle",
    description: "Record the immutable oracle decision for the current completion proposal (exact proposal hash echo required).",
    parameters: {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["PASS", "WARN", "FAIL"], description: "Oracle verdict for the exact proposed completion." },
        no_ship: { type: "boolean", description: "Must be false to allow update_goal complete." },
        evidence_summary: { type: "string", description: "Oracle evidence summary (only a hash is stored)." },
        evidence_refs: { type: "array", items: { type: "string" }, description: "Transient safe evidence refs (hash only)." },
        expected_proposal_hash: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Exact sha256 of the bound completion proposal." },
        scope: GOAL_TARGET_PARAMS.scope,
        cas: CAS_SCHEMA,
      },
      required: ["verdict", "no_ship", "evidence_summary", "expected_proposal_hash"],
    },
    execute: fire(execRecordOracle),
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description: "Complete the goal — ONLY status:'complete', after a bound strict-PASS oracle decision, echoing both exact binding hashes.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["complete"], description: "Only 'complete' is accepted." },
        expected_proposal_hash: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Exact sha256 of the bound completion proposal." },
        expected_oracle_decision_hash: { type: "string", pattern: "^[a-f0-9]{64}$", description: "Exact sha256 of the bound oracle decision." },
        scope: GOAL_TARGET_PARAMS.scope,
        cas: CAS_SCHEMA,
      },
      required: ["status", "expected_proposal_hash", "expected_oracle_decision_hash"],
    },
    execute: fire(execUpdateGoal),
  });
}
