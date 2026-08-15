// extension/session-mirror.ts — OPTIONAL best-effort mirror of goal
// lifecycle events into the Pi session transcript via pi.appendEntry.
//
// NON-CANONICAL BY DESIGN: the .goals store on disk (streams + overlay +
// CAS receipts, Phase 3b/4) is the single source of truth. These entries are
// a convenience for /resume greppability ONLY — losing them (or the host not
// exposing appendEntry) never affects correctness, and a throwing
// appendEntry never breaks a tool result (failures are counted, swallowed,
// and reported through the runtime counters).

import type { ExtensionAPI } from "./pi-types.js";

export const GOAL_MIRROR_ENTRY_TYPE = "pi-goals-goal-event";

export interface GoalMirrorEntry {
  readonly schema: "pi-goals.mirror.v1";
  /** Lifecycle kind, e.g. goal_created / todos_added / todo_resolved / ... */
  readonly kind: string;
  readonly goalId: string;
  readonly at: number;
  readonly mutationId?: string;
  /** Goal status after the mutation, when meaningful. */
  readonly status?: string;
  readonly revision?: number;
  readonly todosRevision?: number;
  /** Mirror discipline: bodies are never stored, hashes and ids only. */
  readonly bodyStored: false;
}

/**
 * Append one mirror entry when the host API exposes appendEntry. Returns
 * true when the entry was written, false otherwise (missing API OR throw) —
 * callers MUST treat false as benign.
 */
export function mirrorGoalEvent(
  pi: Pick<ExtensionAPI, "appendEntry"> | null | undefined,
  entry: GoalMirrorEntry,
): boolean {
  if (pi === null || pi === undefined || typeof pi.appendEntry !== "function") return false;
  try {
    pi.appendEntry(GOAL_MIRROR_ENTRY_TYPE, entry);
    return true;
  } catch {
    // best effort by contract — never propagate host transcript failures
    return false;
  }
}
