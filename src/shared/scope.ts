// src/shared/scope.ts — goal scope vocabulary for multi-agent stores.
//
// PROBLEM (observed in production swarms): several Pi agents share one repo
// cwd, hence ONE <cwd>/.goals store, and the zob-parity invariant was
// "1 store = 1 active goal" — the first agent's goal blocked every other
// agent with goal_already_active.
//
// MODEL: a goal carries a canonical `scope` string; the single-active-goal
// invariant becomes "1 active goal PER scope". Canonical scopes:
//   local           — solo/legacy behavior (default; pre-scope goals)
//   agent:<id>      — private lane of ONE agent session. The id MUST be a
//                     STABLE identifier (Pi sessionId — stable across
//                     /reload), never the mesh alias (aliases mutate via
//                     /mesh alias|reset|new and would orphan scopes). The
//                     human-readable alias rides along as scopeLabel.
//   room:<roomId>   — shared goal for every mesh agent in that room.
//
// Resolution order for the CURRENT session default (review P2/P3): an
// explicit tool/command scope argument wins; otherwise $GOALS_SCOPE (opt-in
// auto default); otherwise the engine fallback (exactly one active goal in
// the whole store, else scope_ambiguous). The shared <stateDir>/config.json
// deliberately does NOT set a scope default — one agent must not silently
// impose its lane on every other agent in the same repo.
//
// Purity: only readMeshIdentity touches fs (best-effort read of the
// pi-mesh identity file; missing/unreadable → undefined, never throws).

import { readFileSync } from "node:fs";
import path from "node:path";

/** Legacy/solo scope — also the retro-compatible default for old stores. */
export const LOCAL_GOAL_SCOPE = "local";

/**
 * Canonical scope: `local`, or `<kind>:<id>` with a mesh-safe id charset.
 * The id charset mirrors pi-mesh room/alias slugs (lower/upper letters,
 * digits, dot, underscore, dash; 1–64 chars, no leading dash).
 */
export const GOAL_SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const GOAL_SCOPE_PATTERN = /^(local|agent:[A-Za-z0-9][A-Za-z0-9._-]{0,63}|room:[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/;

export function isCanonicalGoalScope(value: unknown): value is string {
  return typeof value === "string" && GOAL_SCOPE_PATTERN.test(value);
}

/** scopeLabel: free-form display label (e.g. the mesh alias). ≤ 64 chars. */
export const MAX_SCOPE_LABEL_CHARS = 64;

export function isValidScopeLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SCOPE_LABEL_CHARS && !/[\r\n\0]/.test(value);
}

/** Stable per-session scope id for the agent lane: `agent:<sessionId>`. */
export function agentScopeFor(sessionId: string | undefined): string | undefined {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) return undefined;
  const trimmed = sessionId.trim();
  const scope = `agent:${trimmed}`;
  return isCanonicalGoalScope(scope) ? scope : undefined;
}

export interface ScopeShorthandContext {
  /** Pi session id (stable across /reload) — required for "agent". */
  readonly sessionId?: string;
  /** Mesh rooms joined by this session — required for bare "room". */
  readonly rooms?: readonly string[];
}

export type ScopeShorthandResult =
  | { readonly ok: true; readonly scope: string; readonly label?: string }
  | { readonly ok: false; readonly error: string };

/**
 * Resolve a user-supplied scope value:
 *   "local"                 → local
 *   "agent"                 → agent:<sessionId>        (error without one)
 *   "room"                  → room:<the single joined room> (error when the
 *                             session joined ≠1 rooms — never rooms[0]
 *                             implicitly, review P4)
 *   "agent:<id>"/"room:<id> → as-is (charset-validated)
 * Returns a precise error message for fix_input-style reporting.
 */
export function resolveScopeShorthand(value: unknown, context: ScopeShorthandContext = {}): ScopeShorthandResult {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, error: "scope must be a non-empty string" };
  }
  const trimmed = value.trim();
  if (trimmed === LOCAL_GOAL_SCOPE) return { ok: true, scope: LOCAL_GOAL_SCOPE };
  if (trimmed === "agent") {
    const scope = agentScopeFor(context.sessionId);
    if (scope === undefined) return { ok: false, error: "scope 'agent' requires a stable session id (none available)" };
    return { ok: true, scope };
  }
  if (trimmed === "room") {
    const rooms = (context.rooms ?? []).filter((room): room is string => typeof room === "string" && room.trim().length > 0);
    if (rooms.length === 1) return { ok: true, scope: `room:${rooms[0]}` };
    if (rooms.length === 0) return { ok: false, error: "scope 'room' requires the session to have joined exactly one mesh room (joined none)" };
    return { ok: false, error: `scope 'room' is ambiguous: this session joined ${rooms.length} rooms (${rooms.join(", ")}) — use room:<id>` };
  }
  if (isCanonicalGoalScope(trimmed)) {
    // explicit canonical scope: agent:<id> / room:<id>
    return { ok: true, scope: trimmed };
  }
  return { ok: false, error: `scope must be 'local', 'agent', 'room', 'room:<id>' or 'agent:<id>' (got: ${trimmed})` };
}

// ---------------------------------------------------------------------------
// pi-mesh identity (SOFT dependency — best effort, never required)
// ---------------------------------------------------------------------------

export interface MeshIdentity {
  readonly alias: string;
  readonly rooms: readonly string[];
}

const MESH_IDENTITY_ROOM_MAX = 16;

/**
 * Best-effort read of pi-mesh's `<meshStateDir>/identity-<sessionId>.json`
 * ({ version, sessionId, alias, rooms, ... }). Missing/unreadable/malformed
 * → undefined; never throws (the goals extension must work without mesh).
 */
export function readMeshIdentity(meshStateDir: string, sessionId: string | undefined): MeshIdentity | undefined {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId.trim())) return undefined;
  let raw: string;
  try {
    raw = readFileSync(path.join(meshStateDir, `identity-${sessionId.trim()}.json`), "utf8");
  } catch {
    return undefined; // no mesh identity for this session — fine
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.sessionId !== sessionId.trim()) return undefined;
    if (typeof record.alias !== "string" || record.alias.trim().length === 0) return undefined;
    if (!Array.isArray(record.rooms) || record.rooms.length > MESH_IDENTITY_ROOM_MAX) return undefined;
    const rooms: string[] = [];
    for (const room of record.rooms) {
      if (typeof room !== "string" || room.trim().length === 0) return undefined;
      rooms.push(room.trim());
    }
    return { alias: record.alias.trim(), rooms };
  } catch {
    return undefined;
  }
}
