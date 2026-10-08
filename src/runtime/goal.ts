// src/runtime/goal.ts — Phase 4 strict runtime goal: shape, normalize,
// status transition gates, and pure usage accounting.
//
// Distilled (read-only) from zob-harness:
//   - .pi/extensions/zob-harness/src/runtime/goal-runtime/state.ts
//     (RuntimeGoal shape and statuses, usage/loop state,
//      DEFAULT_GOAL_MAX_TURNS = 80, DEFAULT_GOAL_RESUME_TURN_EXTENSION = 12,
//      create/pause/resume gates, accountRuntimeGoalTurn / accountElapsed,
//      GoalActivationMode vocabulary + formatGoalActivationMode)
//
// Rework decisions ("en mieux", deliberate deviations documented for review):
//   D-G1 single strict schema: normalizeRuntimeGoal validates the EXACT key
//      set, canonical ids, enum statuses, safe-integer counters, and the 3a
//      proposal/decision records (with hash recompute). Any deviation —
//      including every zob legacy/compat shape — resolves to undefined.
//      There is no normalize-and-repair path.
//   D-G2 the runtime goal references the canonical 3a OracleDecision and
//      core GoalCompletionProposal directly; zob's wider oracle-state blob
//      with compatibility views is gone (blocker text is caller state).
//   D-G3 revision is the goal-stream revision: persisted goals start at 1
//      because the engine appends goal_set inside the creating mutation.
//      zob's unpersisted revision-0 state does not exist here.
//   D-G4 usage accounting is pure: clocks are injected, deltas are clamped,
//      stop reasons map to zob statuses (aborted → paused, error → blocked,
//      turn limit → blocked), and non-active goals are never accounted.
//   D-G5 resume keeps the zob turn-window rule exactly: extend when the
//      window is exhausted or extraTurns is explicit; the new maxTurns is
//      floored at the current maxTurns; extraTurns 0 counts as 1.
//
// Purity contract: no fs/os/env/clock/crypto access. Validators imported
// from core/proposal and runtime/oracle are pure; everything returns new
// frozen data without mutating its input.

import { validateGoalCompletionProposal } from "../core/proposal.js";
import type { GoalCompletionProposal } from "../core/proposal.js";
import { validateOracleDecision } from "./oracle.js";
import type { OracleDecision } from "./oracle.js";
import { isCanonicalGoalId } from "../store/events.js";
import type { GoalRecord } from "../store/events.js";
import { isCanonicalGoalScope, isValidScopeLabel } from "../shared/scope.js";

// ---------------------------------------------------------------------------
// Defaults and vocabularies
// ---------------------------------------------------------------------------

export const DEFAULT_GOAL_MAX_TURNS = 80;
export const DEFAULT_RESUME_TURN_EXTENSION = 12;
/** Mirrors the 3b store objective cap so overlay and stream shapes agree. */
export const MAX_RUNTIME_GOAL_OBJECTIVE_CHARS = 8192;

export type RuntimeGoalStatus =
  | "active"
  | "ready_for_oracle"
  | "oracle_failed"
  | "paused"
  | "blocked"
  | "budget_limited"
  | "complete";

export const RUNTIME_GOAL_STATUSES: readonly RuntimeGoalStatus[] = Object.freeze([
  "active",
  "ready_for_oracle",
  "oracle_failed",
  "paused",
  "blocked",
  "budget_limited",
  "complete",
]);

const RUNTIME_GOAL_STATUS_SET = new Set<string>(RUNTIME_GOAL_STATUSES);

export function asRuntimeGoalStatus(value: unknown): RuntimeGoalStatus | undefined {
  return typeof value === "string" && RUNTIME_GOAL_STATUS_SET.has(value) ? (value as RuntimeGoalStatus) : undefined;
}

/** zob resume gate: only these statuses may resume (with a reason). */
export const RESUMABLE_GOAL_STATUSES: ReadonlySet<RuntimeGoalStatus> = new Set([
  "paused",
  "blocked",
  "oracle_failed",
  "budget_limited",
]);

export type GoalActivationMode = "manual" | "validation" | "auto";

export const GOAL_ACTIVATION_MODES: readonly GoalActivationMode[] = Object.freeze(["manual", "validation", "auto"]);

export const DEFAULT_GOAL_ACTIVATION_MODE: GoalActivationMode = "auto";

export function asGoalActivationMode(value: unknown): GoalActivationMode | undefined {
  return value === "manual" || value === "validation" || value === "auto" ? value : undefined;
}

/** zob parity: exact activation-mode description strings. */
export function formatGoalActivationMode(mode: GoalActivationMode | undefined): string {
  const current = mode ?? DEFAULT_GOAL_ACTIVATION_MODE;
  if (current === "auto") return "auto: assistant may create /goal automatically for clearly long multi-step work";
  if (current === "validation") return "validation: assistant proposes /goal for long work and asks confirmation";
  return "manual: /goal starts only by explicit user command";
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** zob GoalState gate (structured goal), carried verbatim when present. */
export interface RuntimeGoalGate {
  readonly originalUserAsk: string;
  readonly activeGoal: string;
  readonly constraints: string;
  readonly expectedOutput: string;
  readonly validationEvidence: string;
  readonly setAt: string;
}

export interface RuntimeGoalUsage {
  readonly tokensUsed: number;
  readonly activeSeconds: number;
  readonly turnsUsed: number;
  readonly costUsed?: number;
}

export interface RuntimeGoalLoop {
  readonly enabled: boolean;
  readonly maxTurns: number;
  readonly customMaxTurns?: boolean;
}

/**
 * Strict runtime goal (single schema). The 6-key projection is the 3b store
 * GoalRecord; gate/oracleDecision/completionProposal/usage/loop persist in
 * the engine-owned runtime overlay next to the goal stream.
 */
export interface RuntimeGoal {
  readonly goalId: string;
  readonly objective: string;
  readonly status: RuntimeGoalStatus;
  /** Canonical scope (local | agent:<id> | room:<id>); absent = local. */
  readonly scope?: string;
  /** Display-only scope label (e.g. mesh alias); absent = none. */
  readonly scopeLabel?: string;
  readonly gate?: RuntimeGoalGate;
  readonly oracleDecision?: OracleDecision;
  readonly completionProposal?: GoalCompletionProposal;
  readonly usage: RuntimeGoalUsage;
  readonly loop: RuntimeGoalLoop;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// Strict normalize
// ---------------------------------------------------------------------------

const GOAL_REQUIRED_KEYS: readonly string[] = Object.freeze([
  "goalId",
  "objective",
  "status",
  "usage",
  "loop",
  "revision",
  "createdAt",
  "updatedAt",
]);
const GOAL_OPTIONAL_KEYS: readonly string[] = Object.freeze(["gate", "oracleDecision", "completionProposal", "scope", "scopeLabel"]);
const USAGE_REQUIRED_KEYS: readonly string[] = Object.freeze(["tokensUsed", "activeSeconds", "turnsUsed"]);
const USAGE_OPTIONAL_KEYS: readonly string[] = Object.freeze(["costUsed"]);
const LOOP_REQUIRED_KEYS: readonly string[] = Object.freeze(["enabled", "maxTurns"]);
const LOOP_OPTIONAL_KEYS: readonly string[] = Object.freeze(["customMaxTurns"]);
const GATE_KEYS: readonly string[] = Object.freeze([
  "originalUserAsk",
  "activeGoal",
  "constraints",
  "expectedOutput",
  "validationEvidence",
  "setAt",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set<string>([...required, ...optional]);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.has(key))) return false;
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function safeIntegerAtLeast(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

/**
 * STRICT normalize (D-G1): the exact key set, a canonical goal id, a
 * non-empty objective (≤ store cap), an enum status, exact usage/loop/gate
 * shapes, strictly validated 3a proposal and oracle decision (hash
 * recompute included), revision ≥ 1, and safe-integer timestamps. Any
 * deviation resolves to undefined — there is no legacy interpretation.
 */
export function normalizeRuntimeGoal(value: unknown): RuntimeGoal | undefined {
  if (!isRecord(value) || !hasExactKeys(value, GOAL_REQUIRED_KEYS, GOAL_OPTIONAL_KEYS)) return undefined;
  if (!isCanonicalGoalId(value.goalId)) return undefined;
  if (typeof value.objective !== "string" || value.objective.trim().length === 0 || value.objective.length > MAX_RUNTIME_GOAL_OBJECTIVE_CHARS) {
    return undefined;
  }
  const status = asRuntimeGoalStatus(value.status);
  if (!status) return undefined;
  if (value.scope !== undefined && !isCanonicalGoalScope(value.scope)) return undefined;
  if (value.scopeLabel !== undefined && !isValidScopeLabel(value.scopeLabel)) return undefined;
  if (!safeIntegerAtLeast(value.revision, 1)) return undefined;
  if (!safeIntegerAtLeast(value.createdAt, 0) || !safeIntegerAtLeast(value.updatedAt, 0)) return undefined;

  const usage = value.usage;
  if (!isRecord(usage) || !hasExactKeys(usage, USAGE_REQUIRED_KEYS, USAGE_OPTIONAL_KEYS)) return undefined;
  if (!safeIntegerAtLeast(usage.tokensUsed, 0) || !safeIntegerAtLeast(usage.activeSeconds, 0) || !safeIntegerAtLeast(usage.turnsUsed, 0)) {
    return undefined;
  }
  if (usage.costUsed !== undefined && !(typeof usage.costUsed === "number" && Number.isFinite(usage.costUsed) && usage.costUsed >= 0)) {
    return undefined;
  }

  const loop = value.loop;
  if (!isRecord(loop) || !hasExactKeys(loop, LOOP_REQUIRED_KEYS, LOOP_OPTIONAL_KEYS)) return undefined;
  if (typeof loop.enabled !== "boolean") return undefined;
  if (!safeIntegerAtLeast(loop.maxTurns, 1)) return undefined;
  if (loop.customMaxTurns !== undefined && typeof loop.customMaxTurns !== "boolean") return undefined;

  let gate: RuntimeGoalGate | undefined;
  if (value.gate !== undefined) {
    const rawGate = value.gate;
    if (!isRecord(rawGate) || !hasExactKeys(rawGate, GATE_KEYS)) return undefined;
    for (const key of GATE_KEYS) {
      if (typeof rawGate[key] !== "string") return undefined;
    }
    if ((rawGate.originalUserAsk as string).trim().length === 0 || (rawGate.activeGoal as string).trim().length === 0) return undefined;
    if (!isIsoTimestamp(rawGate.setAt)) return undefined;
    gate = {
      originalUserAsk: rawGate.originalUserAsk as string,
      activeGoal: rawGate.activeGoal as string,
      constraints: rawGate.constraints as string,
      expectedOutput: rawGate.expectedOutput as string,
      validationEvidence: rawGate.validationEvidence as string,
      setAt: rawGate.setAt as string,
    };
  }

  let oracleDecision: OracleDecision | undefined;
  if (value.oracleDecision !== undefined) {
    const validated = validateOracleDecision(value.oracleDecision);
    if (!validated.valid) return undefined;
    oracleDecision = validated.decision;
  }

  let completionProposal: GoalCompletionProposal | undefined;
  if (value.completionProposal !== undefined) {
    const validated = validateGoalCompletionProposal(value.completionProposal);
    if (!validated.valid) return undefined;
    completionProposal = validated.proposal;
  }

  return Object.freeze({
    goalId: value.goalId,
    objective: value.objective,
    status,
    ...(value.scope !== undefined ? { scope: value.scope } : {}),
    ...(value.scopeLabel !== undefined ? { scopeLabel: value.scopeLabel } : {}),
    ...(gate ? { gate: Object.freeze(gate) } : {}),
    ...(oracleDecision ? { oracleDecision } : {}),
    ...(completionProposal ? { completionProposal } : {}),
    usage: Object.freeze({
      tokensUsed: usage.tokensUsed,
      activeSeconds: usage.activeSeconds,
      turnsUsed: usage.turnsUsed,
      ...(usage.costUsed !== undefined ? { costUsed: usage.costUsed } : {}),
    }),
    loop: Object.freeze({
      enabled: loop.enabled,
      maxTurns: loop.maxTurns,
      ...(loop.customMaxTurns !== undefined ? { customMaxTurns: loop.customMaxTurns } : {}),
    }),
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}

// ---------------------------------------------------------------------------
// Constructors and store projection
// ---------------------------------------------------------------------------

export interface CreateRuntimeGoalOptions {
  /** Canonical goal id (goal_ + 12 lowercase hex); the engine generates it. */
  readonly goalId: string;
  /** Injected epoch-milliseconds timestamp. */
  readonly now: number;
  readonly maxTurns?: number;
  readonly gate?: RuntimeGoalGate;
  /** Canonical scope (shared/scope.ts). Undefined/"local" = legacy solo lane. */
  readonly scope?: string;
  /** Display-only scope label (e.g. mesh alias). */
  readonly scopeLabel?: string;
}

/** Build the canonical fresh goal: active, revision 1, zero usage, loop on. */
export function createRuntimeGoal(objective: string, options: CreateRuntimeGoalOptions): RuntimeGoal {
  const trimmed = typeof objective === "string" ? objective.trim() : "";
  if (trimmed.length === 0 || trimmed.length > MAX_RUNTIME_GOAL_OBJECTIVE_CHARS) {
    throw new TypeError(`createRuntimeGoal: objective must be a non-empty string of at most ${MAX_RUNTIME_GOAL_OBJECTIVE_CHARS} characters`);
  }
  if (!isCanonicalGoalId(options?.goalId)) {
    throw new TypeError("createRuntimeGoal: goalId must be canonical (goal_ + 12 lowercase hex)");
  }
  if (!safeIntegerAtLeast(options?.now, 0)) {
    throw new TypeError("createRuntimeGoal: now must be a safe non-negative integer timestamp");
  }
  const maxTurns = options.maxTurns !== undefined ? Math.trunc(options.maxTurns) : DEFAULT_GOAL_MAX_TURNS;
  if (!safeIntegerAtLeast(maxTurns, 1)) {
    throw new TypeError("createRuntimeGoal: maxTurns must be a safe integer >= 1");
  }
  const goal: RuntimeGoal = Object.freeze({
    goalId: options.goalId,
    objective: trimmed,
    status: "active",
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(options.scopeLabel !== undefined ? { scopeLabel: options.scopeLabel } : {}),
    ...(options.gate !== undefined ? { gate: Object.freeze({ ...options.gate }) } : {}),
    usage: Object.freeze({ tokensUsed: 0, activeSeconds: 0, turnsUsed: 0 }),
    loop: Object.freeze({
      enabled: true,
      maxTurns,
      ...(options.maxTurns !== undefined ? { customMaxTurns: true } : {}),
    }),
    revision: 1,
    createdAt: options.now,
    updatedAt: options.now,
  });
  return goal;
}

/** Project the exact store record (goal_set payload); scope keys ride along. */
export function runtimeGoalToRecord(goal: RuntimeGoal): GoalRecord {
  if (!isCanonicalGoalId(goal?.goalId)) throw new TypeError("runtimeGoalToRecord: goalId must be canonical");
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    status: goal.status,
    ...(goal.scope !== undefined ? { scope: goal.scope } : {}),
    ...(goal.scopeLabel !== undefined ? { scopeLabel: goal.scopeLabel } : {}),
    revision: goal.revision,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

/**
 * Rebuild the degraded runtime view from a bare store record (overlay lost
 * or stale): status/revision/objective survive, gate/proposal/decision and
 * usage/loop customizations are gone — completion paths fail closed and
 * must be re-proposed.
 */
export function runtimeGoalFromRecord(record: GoalRecord): RuntimeGoal {
  return Object.freeze({
    goalId: record.goalId,
    objective: record.objective,
    status: record.status,
    ...(record.scope !== undefined ? { scope: record.scope } : {}),
    ...(record.scopeLabel !== undefined ? { scopeLabel: record.scopeLabel } : {}),
    usage: Object.freeze({ tokensUsed: 0, activeSeconds: 0, turnsUsed: 0 }),
    loop: Object.freeze({ enabled: true, maxTurns: DEFAULT_GOAL_MAX_TURNS }),
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

// ---------------------------------------------------------------------------
// Transition gates (zob parity)
// ---------------------------------------------------------------------------

/** zob create gate: creation fails while ANY non-complete goal is active. */
export function canCreateRuntimeGoal(existing: RuntimeGoal | undefined): boolean {
  return !existing || existing.status === "complete";
}

/** zob pause gate: only an active goal pauses; the loop is switched off. */
export function pauseRuntimeGoal(goal: RuntimeGoal, now: number): RuntimeGoal {
  if (goal.status !== "active") return goal;
  return Object.freeze({
    ...goal,
    status: "paused",
    loop: Object.freeze({ ...goal.loop, enabled: false }),
    updatedAt: now,
  });
}

export interface ResumeRuntimeGoalResult {
  readonly goal: RuntimeGoal;
  readonly previousStatus: RuntimeGoalStatus;
  readonly additionalTurns?: number;
}

/**
 * zob resume gate + turn-window rule (D-G5): resume only from
 * paused/blocked/oracle_failed/budget_limited with a non-empty reason; the
 * window extends by the default +12 (or the explicit extraTurns, 0 → 1)
 * when it is exhausted or extraTurns is provided, floored at maxTurns.
 * Returns undefined when the gate rejects.
 */
export function resumeRuntimeGoal(
  goal: RuntimeGoal,
  reason: string,
  options: { now: number; extraTurns?: number },
): ResumeRuntimeGoalResult | undefined {
  if (!RESUMABLE_GOAL_STATUSES.has(goal.status)) return undefined;
  if (typeof reason !== "string" || reason.trim().length === 0) return undefined;
  if (!safeIntegerAtLeast(options?.now, 0)) return undefined;
  const additionalTurns = Math.max(1, Math.trunc(options.extraTurns ?? DEFAULT_RESUME_TURN_EXTENSION));
  const extendWindow = goal.usage.turnsUsed >= goal.loop.maxTurns || options.extraTurns !== undefined;
  const maxTurns = extendWindow ? Math.max(goal.loop.maxTurns, goal.usage.turnsUsed + additionalTurns) : goal.loop.maxTurns;
  const previousStatus = goal.status;
  const resumed: RuntimeGoal = Object.freeze({
    ...goal,
    status: "active",
    loop: Object.freeze({
      enabled: true,
      maxTurns,
      ...(extendWindow ? { customMaxTurns: true } : "customMaxTurns" in goal.loop ? { customMaxTurns: goal.loop.customMaxTurns } : {}),
    }),
    updatedAt: options.now,
  });
  return {
    goal: resumed,
    previousStatus,
    ...(extendWindow ? { additionalTurns } : {}),
  };
}

// ---------------------------------------------------------------------------
// Pure usage accounting (zob accountElapsed / accountRuntimeGoalTurn)
// ---------------------------------------------------------------------------

export interface RuntimeGoalUsageDelta {
  readonly tokensUsed?: number;
  readonly activeSeconds?: number;
  readonly costUsed?: number;
}

function clampedDelta(value: number | undefined): number {
  return Math.max(0, Math.trunc(value ?? 0));
}

/**
 * Account usage deltas on an ACTIVE goal (non-active goals are returned
 * untouched, zob accountElapsed parity). Deltas are clamped to ≥ 0; cost
 * deltas accumulate as finite non-negative numbers.
 */
export function accountRuntimeGoalUsage(goal: RuntimeGoal, delta: RuntimeGoalUsageDelta, now: number): RuntimeGoal {
  if (goal.status !== "active") return goal;
  const costDelta = typeof delta?.costUsed === "number" && Number.isFinite(delta.costUsed) && delta.costUsed > 0 ? delta.costUsed : 0;
  return Object.freeze({
    ...goal,
    usage: Object.freeze({
      tokensUsed: goal.usage.tokensUsed + clampedDelta(delta?.tokensUsed),
      activeSeconds: goal.usage.activeSeconds + clampedDelta(delta?.activeSeconds),
      turnsUsed: goal.usage.turnsUsed,
      ...("costUsed" in goal.usage || costDelta > 0 ? { costUsed: (goal.usage.costUsed ?? 0) + costDelta } : {}),
    }),
    updatedAt: now,
  });
}

export interface RuntimeGoalTurnInput {
  readonly tokensUsed?: number;
  readonly costUsed?: number;
  /** True only for goal-continuation turns (zob countAutoTurn). */
  readonly countAutoTurn?: boolean;
  readonly stopReason?: "aborted" | "error";
}

export interface RuntimeGoalTurnResult {
  readonly goal: RuntimeGoal;
  readonly turnCounted: boolean;
  readonly turnLimitReached: boolean;
  readonly statusChangedTo?: RuntimeGoalStatus;
}

/**
 * Account one assistant turn purely (D-G4): token/cost deltas accumulate,
 * auto turns increment turnsUsed, and the zob stop gates apply — aborted →
 * paused (loop off), provider error → blocked (loop off), turn limit →
 * blocked (loop off). Non-active goals are never accounted (same reference
 * returned).
 */
export function accountRuntimeGoalTurn(goal: RuntimeGoal, input: RuntimeGoalTurnInput, now: number): RuntimeGoalTurnResult {
  if (goal.status !== "active") {
    return { goal, turnCounted: false, turnLimitReached: goal.usage.turnsUsed >= goal.loop.maxTurns };
  }
  let next = accountRuntimeGoalUsage(goal, { tokensUsed: input?.tokensUsed, costUsed: input?.costUsed }, now);
  let statusChangedTo: RuntimeGoalStatus | undefined;
  if (input?.stopReason === "aborted") {
    next = Object.freeze({ ...next, status: "paused", loop: Object.freeze({ ...next.loop, enabled: false }), updatedAt: now });
    statusChangedTo = "paused";
    return { goal: next, turnCounted: false, turnLimitReached: false, statusChangedTo };
  }
  if (input?.stopReason === "error") {
    next = Object.freeze({ ...next, status: "blocked", loop: Object.freeze({ ...next.loop, enabled: false }), updatedAt: now });
    statusChangedTo = "blocked";
    return { goal: next, turnCounted: false, turnLimitReached: false, statusChangedTo };
  }
  if (input?.countAutoTurn !== true) {
    return { goal: next, turnCounted: false, turnLimitReached: next.usage.turnsUsed >= next.loop.maxTurns };
  }
  const turnsUsed = next.usage.turnsUsed + 1;
  next = Object.freeze({ ...next, usage: Object.freeze({ ...next.usage, turnsUsed }), updatedAt: now });
  const turnLimitReached = turnsUsed >= next.loop.maxTurns;
  if (turnLimitReached) {
    next = Object.freeze({ ...next, status: "blocked", loop: Object.freeze({ ...next.loop, enabled: false }), updatedAt: now });
    statusChangedTo = "blocked";
  }
  return { goal: next, turnCounted: true, turnLimitReached, ...(statusChangedTo ? { statusChangedTo } : {}) };
}
