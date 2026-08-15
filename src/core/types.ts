// src/core/types.ts — Phase 2a core type vocabulary for pi-goals.
//
// Clean port of the zob goal-todo vocabulary:
// - R3: all 11 statuses, 6 owners, 4 priorities kept verbatim.
// - R1: strict single schema, no legacy compat layers.
// zob couplings are intentionally stripped from GoalTodoNode: delegation /
// liveness / claim / validation state becomes side tables in later phases,
// and goal scoping lives in the injected index (see GoalTodoIndex), not on
// the node. This module is pure type vocabulary plus frozen union tables.

export type GoalTodoStatus =
  | "planned"
  | "ready"
  | "in_progress"
  | "delegated"
  | "claim_returned"
  | "needs_review"
  | "needs_oracle"
  | "needs_user"
  | "blocked"
  | "done"
  | "skipped";

export type GoalTodoOwner = "agent" | "user" | "oracle" | "subagent" | "factory" | "orchestration";

export type GoalTodoPriority = "low" | "normal" | "high" | "critical";

export const GOAL_TODO_STATUSES: readonly GoalTodoStatus[] = Object.freeze([
  "planned",
  "ready",
  "in_progress",
  "delegated",
  "claim_returned",
  "needs_review",
  "needs_oracle",
  "needs_user",
  "blocked",
  "done",
  "skipped",
]);

export const GOAL_TODO_OWNERS: readonly GoalTodoOwner[] = Object.freeze([
  "agent",
  "user",
  "oracle",
  "subagent",
  "factory",
  "orchestration",
]);

export const GOAL_TODO_PRIORITIES: readonly GoalTodoPriority[] = Object.freeze(["low", "normal", "high", "critical"]);

/**
 * Clean TODO node: canonical identity (id + visible path), lifecycle fields,
 * and acceptance evidence only. No zob runtime couplings, no goal scoping,
 * no delegation/claim/liveness side state (later phases own those tables).
 */
export interface GoalTodoNode {
  id: string;
  path: string;
  title: string;
  status: GoalTodoStatus;
  owner: GoalTodoOwner;
  priority: GoalTodoPriority;
  required: boolean;
  parentId?: string;
  acceptanceCriteria?: string[];
  evidenceRefs?: string[];
  validationCommands?: string[];
  createdAt: number;
  updatedAt: number;
}

/** Small shared discriminated-union result helpers for later phases. */
export interface Ok<T> {
  ok: true;
  value: T;
}

export interface Err<E> {
  ok: false;
  error: E;
}

export type Result<T, E> = Ok<T> | Err<E>;

export type GoalTodoReferenceCode =
  | "resolved"
  | "missing_goal_id"
  | "missing_reference"
  | "invalid_todo_id"
  | "invalid_todo_path"
  | "todo_id_not_found"
  | "todo_id_cross_goal"
  | "todo_id_ambiguous"
  | "todo_path_not_found"
  | "todo_path_ambiguous"
  | "reference_mismatch"
  | "batch_resolution_failed";

export type GoalTodoReferenceField = "goal_id" | "todo_id" | "todo_path" | "references" | "batch";

export type GoalTodoReferenceRetryPolicy = "none" | "fix_input" | "refresh_goal_todos" | "select_canonical_id";

export interface GoalTodoCanonicalReferenceInput {
  todoId?: string;
  todoPath?: string;
}

export interface GoalTodoReferenceCandidate {
  canonicalId: string;
  goalId: string;
  path: string;
}

export interface GoalTodoReferenceError {
  code: Exclude<GoalTodoReferenceCode, "resolved" | "batch_resolution_failed">;
  field: GoalTodoReferenceField;
  message: string;
  index?: number;
}

/**
 * Minimal node identity the pure resolution engine operates over.
 * An omitted goalId means the entry belongs to the index's goal; an explicit
 * different goalId enables cross-goal rejection without zob state coupling.
 */
export interface TodoIndexEntry {
  id: string;
  path: string;
  goalId?: string;
}

/** Goal-scoped index injected into the resolution engine (the store builds it later). */
export interface GoalTodoIndex {
  goalId?: string;
  entries: readonly TodoIndexEntry[];
}

export interface GoalTodoReferenceResolution {
  entry?: TodoIndexEntry;
  canonicalId?: string;
  path?: string;
  goalId?: string;
  code: Exclude<GoalTodoReferenceCode, "batch_resolution_failed">;
  errors: GoalTodoReferenceError[];
  candidates: GoalTodoReferenceCandidate[];
  retryPolicy: GoalTodoReferenceRetryPolicy;
}

export interface GoalTodoReferenceBatchResolution {
  entries: TodoIndexEntry[];
  canonicalIds: string[];
  paths: string[];
  code: "resolved" | "batch_resolution_failed";
  resolutions: GoalTodoReferenceResolution[];
  errors: GoalTodoReferenceError[];
  candidates: GoalTodoReferenceCandidate[];
  retryPolicy: GoalTodoReferenceRetryPolicy;
}

export type GoalTodoLegacyReferenceForm = "canonical_id" | "bare_path" | "todo_path_shorthand";

/**
 * Explicit legacy adaptation result. The adapted flag marks a conversion:
 * strict resolvers never call the adapter and never accept raw legacy refs.
 */
export interface GoalTodoLegacyReferenceAdaptation {
  input: GoalTodoCanonicalReferenceInput;
  adapted: true;
  legacyForm: GoalTodoLegacyReferenceForm;
}
