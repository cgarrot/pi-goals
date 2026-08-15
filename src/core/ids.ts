// src/core/ids.ts — Phase 2a canonical ids, visible paths, and the pure
// reference resolution engine (zob-compatible rejection codes; R1 strict
// single schema — no legacy interpretation inside the resolver).
//
// Purity contract: this module performs no filesystem, OS, environment, or
// crypto access of its own. Randomness is injected via GoalTodoRandomBytes
// so a later store phase can wire real crypto without touching core logic,
// and goal state arrives as an injected minimal index (GoalTodoIndex).

import type {
  GoalTodoCanonicalReferenceInput,
  GoalTodoIndex,
  GoalTodoLegacyReferenceAdaptation,
  GoalTodoReferenceBatchResolution,
  GoalTodoReferenceCandidate,
  GoalTodoReferenceCode,
  GoalTodoReferenceError,
  GoalTodoReferenceField,
  GoalTodoReferenceResolution,
  GoalTodoReferenceRetryPolicy,
  TodoIndexEntry,
} from "./types.js";

export const CANONICAL_GOAL_TODO_ID_PATTERN = /^todo_[a-f0-9]{12}$/;
export const VISIBLE_GOAL_TODO_PATH_PATTERN = /^[1-9]\d*(?:\.[1-9]\d*)*$/;

/** Injected randomness source; the store wires real crypto in a later phase. */
export type GoalTodoRandomBytes = (byteCount: number) => Uint8Array;

type SingleReferenceCode = Exclude<
  GoalTodoReferenceCode,
  "reference_mismatch" | "batch_resolution_failed" | "missing_goal_id" | "missing_reference"
>;

interface SingleReferenceResolution {
  entry?: TodoIndexEntry;
  code: SingleReferenceCode;
  errors: GoalTodoReferenceError[];
  candidates: GoalTodoReferenceCandidate[];
  retryPolicy: GoalTodoReferenceRetryPolicy;
}

/** Canonical TODO node id: todo_ + 12 lowercase hex characters from 6 injected random bytes. */
export function generateGoalTodoId(randomBytes: GoalTodoRandomBytes): string {
  const bytes = randomBytes(6);
  if (!(bytes instanceof Uint8Array) || bytes.length < 6) {
    throw new TypeError("generateGoalTodoId: randomBytes(6) must return a Uint8Array with at least 6 bytes");
  }
  let hex = "";
  for (let index = 0; index < 6; index += 1) {
    hex += bytes[index]!.toString(16).padStart(2, "0");
  }
  return `todo_${hex}`;
}

export function isCanonicalGoalTodoId(id: string): boolean {
  return typeof id === "string" && CANONICAL_GOAL_TODO_ID_PATTERN.test(id);
}

export function isVisibleGoalTodoPath(path: string): boolean {
  return typeof path === "string" && VISIBLE_GOAL_TODO_PATH_PATTERN.test(path);
}

/** Parse a visible dotted path (1, 1.2, 12.3.4) into positive integer segments. */
export function parseGoalTodoPath(path: string): number[] | undefined {
  if (!isVisibleGoalTodoPath(path)) return undefined;
  return path.split(".").map((segment) => Number.parseInt(segment, 10));
}

function entryGoalId(entry: TodoIndexEntry, indexGoalId: string): string {
  return entry.goalId ?? indexGoalId;
}

function candidateFor(entry: TodoIndexEntry, goalId: string): GoalTodoReferenceCandidate {
  return { canonicalId: entry.id, goalId, path: entry.path };
}

function compareCandidates(left: GoalTodoReferenceCandidate, right: GoalTodoReferenceCandidate): number {
  return (
    left.goalId.localeCompare(right.goalId)
    || left.path.localeCompare(right.path, undefined, { numeric: true })
    || left.canonicalId.localeCompare(right.canonicalId)
  );
}

function uniqueCandidates(candidates: readonly GoalTodoReferenceCandidate[]): GoalTodoReferenceCandidate[] {
  const unique = new Map<string, GoalTodoReferenceCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.goalId}\u0000${candidate.canonicalId}\u0000${candidate.path}`;
    if (!unique.has(key)) unique.set(key, { ...candidate });
  }
  return [...unique.values()];
}

function failure(
  code: Exclude<SingleReferenceCode, "resolved">,
  field: GoalTodoReferenceField,
  message: string,
  retryPolicy: GoalTodoReferenceRetryPolicy,
  candidates: GoalTodoReferenceCandidate[] = [],
): SingleReferenceResolution {
  return { code, errors: [{ code, field, message }], candidates, retryPolicy };
}

function resolveTodoId(index: GoalTodoIndex, goalId: string, todoId: unknown): SingleReferenceResolution {
  if (typeof todoId !== "string" || !CANONICAL_GOAL_TODO_ID_PATTERN.test(todoId)) {
    return failure(
      "invalid_todo_id",
      "todo_id",
      "todo_id must be an exact canonical TODO node ID matching todo_<12 lowercase hex characters>",
      "fix_input",
    );
  }

  const inGoal = index.entries.filter((entry) => entryGoalId(entry, goalId) === goalId && entry.id === todoId);
  if (inGoal.length === 1) {
    const entry = inGoal[0]!;
    return { entry, code: "resolved", errors: [], candidates: [candidateFor(entry, goalId)], retryPolicy: "none" };
  }
  if (inGoal.length > 1) {
    return failure(
      "todo_id_ambiguous",
      "todo_id",
      `todo_id ${todoId} matches ${inGoal.length} entries in goal ${goalId}`,
      "refresh_goal_todos",
      inGoal.map((entry) => candidateFor(entry, goalId)).sort(compareCandidates),
    );
  }

  const otherGoals = index.entries.filter((entry) => entryGoalId(entry, goalId) !== goalId && entry.id === todoId);
  if (otherGoals.length > 0) {
    return failure(
      "todo_id_cross_goal",
      "todo_id",
      `todo_id ${todoId} belongs to a different goal and cannot resolve in goal ${goalId}`,
      "refresh_goal_todos",
      otherGoals.map((entry) => candidateFor(entry, entryGoalId(entry, goalId))).sort(compareCandidates),
    );
  }
  return failure(
    "todo_id_not_found",
    "todo_id",
    `todo_id ${todoId} was not found in goal ${goalId}`,
    "refresh_goal_todos",
  );
}

function resolveTodoPath(index: GoalTodoIndex, goalId: string, todoPath: unknown): SingleReferenceResolution {
  if (typeof todoPath !== "string" || !VISIBLE_GOAL_TODO_PATH_PATTERN.test(todoPath)) {
    return failure(
      "invalid_todo_path",
      "todo_path",
      "todo_path must be an exact visible dotted path of positive integers without leading zeros",
      "fix_input",
    );
  }

  const matches = index.entries.filter((entry) => entryGoalId(entry, goalId) === goalId && entry.path === todoPath);
  if (matches.length === 1) {
    const entry = matches[0]!;
    return { entry, code: "resolved", errors: [], candidates: [candidateFor(entry, goalId)], retryPolicy: "none" };
  }
  if (matches.length > 1) {
    return failure(
      "todo_path_ambiguous",
      "todo_path",
      `todo_path ${todoPath} matches ${matches.length} entries in goal ${goalId}`,
      "select_canonical_id",
      matches.map((entry) => candidateFor(entry, goalId)).sort(compareCandidates),
    );
  }
  return failure(
    "todo_path_not_found",
    "todo_path",
    `todo_path ${todoPath} was not found in goal ${goalId}`,
    "refresh_goal_todos",
  );
}

function successfulResolution(
  entry: TodoIndexEntry,
  goalId: string,
  candidates: readonly GoalTodoReferenceCandidate[],
): GoalTodoReferenceResolution {
  return {
    entry: { ...entry },
    canonicalId: entry.id,
    path: entry.path,
    goalId,
    code: "resolved",
    errors: [],
    candidates: uniqueCandidates(candidates),
    retryPolicy: "none",
  };
}

/**
 * Resolve strict canonical fields without legacy interpretation or
 * id-to-path fallback. When both fields are present, each resolves
 * independently in the requested goal and must agree on the same node.
 */
export function resolveCanonicalGoalTodoReference(
  index: GoalTodoIndex,
  input: GoalTodoCanonicalReferenceInput = {},
): GoalTodoReferenceResolution {
  if (typeof index.goalId !== "string" || index.goalId.trim().length === 0) {
    return {
      code: "missing_goal_id",
      errors: [{ code: "missing_goal_id", field: "goal_id", message: "canonical Goal/TODO reference resolution requires a goal_id" }],
      candidates: [],
      retryPolicy: "fix_input",
    };
  }
  const goalId = index.goalId;

  const reference = input ?? {};
  const hasTodoId = reference.todoId !== undefined;
  const hasTodoPath = reference.todoPath !== undefined;
  if (!hasTodoId && !hasTodoPath) {
    return {
      code: "missing_reference",
      errors: [{ code: "missing_reference", field: "references", message: "provide todo_id and/or todo_path" }],
      candidates: [],
      retryPolicy: "fix_input",
    };
  }

  const idResolution = hasTodoId ? resolveTodoId(index, goalId, reference.todoId) : undefined;
  const pathResolution = hasTodoPath ? resolveTodoPath(index, goalId, reference.todoPath) : undefined;
  const errors = [...(idResolution?.errors ?? []), ...(pathResolution?.errors ?? [])];
  const candidates = uniqueCandidates([...(idResolution?.candidates ?? []), ...(pathResolution?.candidates ?? [])]);

  if (errors.length > 0) {
    const first = errors[0]!;
    const retryPolicy: GoalTodoReferenceRetryPolicy = errors.some(
      (error) => error.code === "invalid_todo_id" || error.code === "invalid_todo_path",
    )
      ? "fix_input"
      : errors.some((error) => error.code === "todo_path_ambiguous")
        ? "select_canonical_id"
        : "refresh_goal_todos";
    return { code: first.code, errors, candidates, retryPolicy };
  }

  const idEntry = idResolution?.entry;
  const pathEntry = pathResolution?.entry;
  if (idEntry && pathEntry && idEntry.id !== pathEntry.id) {
    return {
      code: "reference_mismatch",
      errors: [{
        code: "reference_mismatch",
        field: "references",
        message: `todo_id resolves to ${idEntry.id} but todo_path resolves to ${pathEntry.id}`,
      }],
      candidates,
      retryPolicy: "fix_input",
    };
  }

  const entry = idEntry ?? pathEntry;
  if (!entry) {
    return {
      code: "missing_reference",
      errors: [{ code: "missing_reference", field: "references", message: "provide todo_id and/or todo_path" }],
      candidates: [],
      retryPolicy: "fix_input",
    };
  }
  return successfulResolution(entry, goalId, candidates);
}

function batchRetryPolicy(errors: readonly GoalTodoReferenceError[]): GoalTodoReferenceRetryPolicy {
  if (
    errors.some(
      (error) =>
        error.code === "invalid_todo_id"
        || error.code === "invalid_todo_path"
        || error.code === "reference_mismatch"
        || error.code === "missing_reference"
        || error.code === "missing_goal_id",
    )
  ) {
    return "fix_input";
  }
  if (errors.some((error) => error.code === "todo_path_ambiguous")) return "select_canonical_id";
  return "refresh_goal_todos";
}

/** Resolve and deduplicate a batch in input order; any failed item fails the whole batch atomically. */
export function resolveCanonicalGoalTodoReferences(
  index: GoalTodoIndex,
  inputs: readonly GoalTodoCanonicalReferenceInput[],
): GoalTodoReferenceBatchResolution {
  if (inputs.length === 0) {
    const error: GoalTodoReferenceError = {
      code: "missing_reference",
      field: "batch",
      message: "canonical Goal/TODO reference batch must not be empty",
    };
    return {
      entries: [],
      canonicalIds: [],
      paths: [],
      code: "batch_resolution_failed",
      resolutions: [],
      errors: [error],
      candidates: [],
      retryPolicy: "fix_input",
    };
  }

  const resolutions = inputs.map((input) => resolveCanonicalGoalTodoReference(index, input));
  const errors = resolutions.flatMap((resolution, itemIndex) =>
    resolution.errors.map((error) => ({ ...error, index: itemIndex })),
  );
  const candidates = uniqueCandidates(resolutions.flatMap((resolution) => resolution.candidates));
  if (errors.length > 0) {
    return {
      entries: [],
      canonicalIds: [],
      paths: [],
      code: "batch_resolution_failed",
      resolutions,
      errors,
      candidates,
      retryPolicy: batchRetryPolicy(errors),
    };
  }

  const byId = new Map<string, TodoIndexEntry>();
  for (const resolution of resolutions) {
    if (resolution.entry && !byId.has(resolution.entry.id)) byId.set(resolution.entry.id, { ...resolution.entry });
  }
  const entries = [...byId.values()];
  return {
    entries,
    canonicalIds: entries.map((entry) => entry.id),
    paths: entries.map((entry) => entry.path),
    code: "resolved",
    resolutions,
    errors: [],
    candidates,
    retryPolicy: "none",
  };
}

/**
 * Explicit compatibility adapter for legacy mixed refs (todo_<path> shorthand
 * or bare path). Strict resolvers never call this adapter; its result is
 * flagged adapted so callers can distinguish conversion from acceptance.
 */
export function adaptLegacyGoalTodoReference(ref: string): GoalTodoLegacyReferenceAdaptation | undefined {
  if (typeof ref !== "string") return undefined;
  if (CANONICAL_GOAL_TODO_ID_PATTERN.test(ref)) {
    return { input: { todoId: ref }, adapted: true, legacyForm: "canonical_id" };
  }
  if (VISIBLE_GOAL_TODO_PATH_PATTERN.test(ref)) {
    return { input: { todoPath: ref }, adapted: true, legacyForm: "bare_path" };
  }
  const legacyPath = ref.match(/^todo_(\d+(?:\.\d+)*)$/)?.[1];
  return legacyPath !== undefined && VISIBLE_GOAL_TODO_PATH_PATTERN.test(legacyPath)
    ? { input: { todoPath: legacyPath }, adapted: true, legacyForm: "todo_path_shorthand" }
    : undefined;
}
