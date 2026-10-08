// extension/outbox.ts — file-based notification outbox for SHARED-scope
// goal events (review P8).
//
// pi-goals must stay standalone (no pi-mesh import, no network): instead of
// calling the mesh directly, scoped lifecycle events are dropped as one
// small JSON file under <stateDir>/outbox/. A future pi-mesh (or any
// watcher) can poll that directory and relay create/complete/pause/clear
// notifications to the room — exactly like reservations/ledger patterns.
//
// Discipline: BEST EFFORT BY DESIGN — write failures are swallowed and
// counted by the caller; a full or unwritable outbox NEVER blocks or fails
// a goal mutation (the .goals streams remain the single source of truth).
// Files are named `<at>-<mutationId>.json` (unique per mutation, safe
// charset already enforced by the CAS guard pattern).

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export const GOALS_OUTBOX_SCHEMA = "pi-goals.outbox.v1";
export const GOALS_OUTBOX_DIR_NAME = "outbox";
/** M2 (review follow-up): relayed files older than this are pruned on the
 * next write (best effort, never blocking). 7 days. */
export const GOALS_OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type GoalOutboxKind =
  | "goal_created"
  | "goal_completed"
  | "goal_paused"
  | "goal_resumed"
  | "goal_cleared"
  | "completion_proposed"
  | "oracle_recorded";

export interface GoalOutboxEvent {
  readonly schema: typeof GOALS_OUTBOX_SCHEMA;
  readonly kind: GoalOutboxKind;
  readonly goalId: string;
  readonly scope: string;
  readonly status?: string;
  readonly revision?: number;
  readonly mutationId: string;
  readonly at: number;
}

/** Best-effort prune of expired relay files (M2): never throws, never
 * blocks the write — a failing prune is simply retried next time. */
function pruneOutbox(directory: string, now: number): void {
  try {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name);
      try {
        const stats = statSync(file);
        if (stats.isFile() && now - stats.mtimeMs > GOALS_OUTBOX_TTL_MS) unlinkSync(file);
      } catch {
        // unreadable/unremovable single file — skip it silently
      }
    }
  } catch {
    // unreadable directory — nothing to prune
  }
}

/**
 * Append one outbox event when the goal lives in a SHARED scope (room:*).
 * Returns true when written, false on any failure (benign by contract).
 * agent:* lanes are private → NOT broadcast (privacy by default); local
 * lanes are solo → nothing to relay. Expired files are pruned on the way
 * (M2) so the directory stays bounded without a dedicated daemon.
 */
export function writeScopeOutboxEvent(stateDir: string, event: Omit<GoalOutboxEvent, "schema">): boolean {
  if (!event.scope.startsWith("room:")) return true; // nothing to relay — not an error
  try {
    const directory = path.join(stateDir, GOALS_OUTBOX_DIR_NAME);
    mkdirSync(directory, { recursive: true });
    const safeMutationId = event.mutationId.replace(/[^A-Za-z0-9._-]/g, "_");
    const file = path.join(directory, `${event.at}-${safeMutationId}.json`);
    const payload: GoalOutboxEvent = { schema: GOALS_OUTBOX_SCHEMA, ...event };
    writeFileSync(file, JSON.stringify(payload) + "\n");
    pruneOutbox(directory, event.at);
    return true;
  } catch {
    return false; // best effort by contract — never propagate
  }
}
