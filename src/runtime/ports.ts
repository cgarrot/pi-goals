// src/runtime/ports.ts — Phase 3a/4 injectable runtime ports (R4, R7).
//
// A port, not an adapter: this module declares the seams between the pure
// core (src/core, src/runtime/oracle.ts, src/runtime/goal.ts) and whoever
// actually performs I/O or owns the outer loop. The extension layer
// (Phase 5) injects the real implementations (agent/LLM-backed oracle
// review, session turn accounting, continuation queueing, run import);
// tests inject deterministic stubs. Keeping the ports type-only means the
// core stays pure and the runtime never grows an implicit I/O path.
//
// Purity contract: TYPE ONLY — no implementation, no I/O, no state, no node
// imports. Implementations live in later phases and own their own safety.

import type { GoalTodoCompletionDiagnostics } from "../core/completion.js";
import type { ValidatedGoalCompletionProposal } from "../core/proposal.js";
import type { OracleReviewInput } from "./oracle.js";
import type { RuntimeGoalStatus } from "./goal.js";

/**
 * Injectable oracle verdict provider (R4). review() receives the validated
 * completion proposal and the current completion diagnostics and resolves
 * with the OracleReviewInput that buildOracleDecision binds into a decision.
 * Implementations must supply an injected reviewedAt (no implicit clock) and
 * are responsible for their own evidence gathering and no-ship honesty.
 */
export interface OracleVerdictProvider {
  review(
    proposal: ValidatedGoalCompletionProposal,
    diagnostics: GoalTodoCompletionDiagnostics,
  ): Promise<OracleReviewInput>;
}

// ---------------------------------------------------------------------------
// LoopHooks (R7): the continuation loop is a port, never runtime state.
// ---------------------------------------------------------------------------

/** Emitted by the engine after a committed mutation changes (or binds) the goal status. */
export interface GoalStatusChangedEvent {
  readonly goalId: string;
  readonly fromStatus: RuntimeGoalStatus;
  /** undefined when the goal was cleared. */
  readonly toStatus: RuntimeGoalStatus | undefined;
  readonly revision: number;
  readonly at: number;
}

/** Emitted by the outer loop after a turn was accounted on the active goal. */
export interface GoalTurnAccountedEvent {
  readonly goalId: string;
  readonly turnsUsed: number;
  readonly maxTurns: number;
  readonly turnCounted: boolean;
  readonly at: number;
}

/** Request to queue one continuation turn for an active goal. */
export interface GoalContinuationRequest {
  readonly goalId: string;
  readonly revision: number;
  readonly objective: string;
  readonly at: number;
}

/**
 * Continuation-loop hooks the extension injects (R7). The engine calls
 * onGoalStatusChanged after committed status changes and queueContinuation
 * after a successful resume; the extension's turn listener applies
 * accountRuntimeGoalTurn and emits onGoalTurnAccounted. Implementations
 * must never be required for correctness of the store itself.
 */
export interface LoopHooks {
  onGoalTurnAccounted?(event: GoalTurnAccountedEvent): void;
  onGoalStatusChanged?(event: GoalStatusChangedEvent): void;
  queueContinuation?(request: GoalContinuationRequest): void;
}

// ---------------------------------------------------------------------------
// ImportProvider: importing external run TODOs stays an injected port.
// ---------------------------------------------------------------------------

/** Body-free reference to one importable run. */
export interface ImportRunRef {
  readonly runId: string;
  readonly source: string;
  readonly label?: string;
}

/** One TODO candidate extracted from an imported run (plain data only). */
export interface ImportTodoCandidate {
  readonly title: string;
  readonly required?: boolean;
  readonly parentId?: string;
  readonly acceptanceCriteria?: readonly string[];
}

/** The result of importing one run's TODO plan. */
export interface ImportedRunTodos {
  readonly runId: string;
  readonly source: string;
  readonly todos: readonly ImportTodoCandidate[];
}

/**
 * Injectable import provider for external run artifacts (factory plans,
 * orchestration chains, …). The runtime never reads external stores
 * directly; Phase 5 adapters own file access, sandboxing, and body-free
 * evidence discipline.
 */
export interface ImportProvider {
  listRuns?(source?: string): Promise<readonly ImportRunRef[]>;
  importRunTodos?(runId: string, source?: string): Promise<ImportedRunTodos>;
}
