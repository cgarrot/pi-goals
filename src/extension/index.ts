// extension/index.ts — Pi extension entrypoint (pi-mesh adapter discipline).
// THIN ADAPTER: all logic lives in the Phase-4 GoalRuntimeEngine; this file
// wires lifecycle (stateDir resolution, engine construction, restore check,
// HUD) and registers tools/commands IMMEDIATELY so they can answer
// blocked-style errors before session_start (I10 — non-blocking connect).
//
// LoopHooks (R7) default to no-ops: the continuation loop is a port the
// host/CLI injects; the store never depends on it.

import { createRuntimeGoalEngine } from "../runtime/engine.js";
import type { GoalRuntimeEngine, GoalRuntimeView } from "../runtime/engine.js";
import type { LoopHooks } from "../runtime/ports.js";
import type { TreePolicy } from "../core/tree.js";
import { runtimeDir as resolveRuntimeDir, stateDir as resolveStateDir } from "../shared/paths.js";
import { readMeshIdentity, resolveScopeShorthand } from "../shared/scope.js";
import type { MeshIdentity } from "../shared/scope.js";
import path from "node:path";
import { registerCommands } from "./commands.js";
import { GoalsHud } from "./hud.js";
import type { ExtensionAPI } from "./pi-types.js";
import { DEFAULT_GOAL_ACTIVATION_MODE } from "./tools.js";
import { registerTools, type GoalsRuntime } from "./tools.js";

export interface GoalsExtensionOptions {
  /** Store root override (default: shared/paths stateDir(process environment)). */
  readonly stateDir?: string;
  /** Lock dir override (default: shared/paths runtimeDir(process environment)). */
  readonly runtimeDir?: string;
  /** Path-resolution environment override (default: the live process one). */
  readonly pathEnv?: NodeJS.ProcessEnv;
  /** Injected clock (tests). */
  readonly clock?: () => number;
  /** Injected randomness (tests). */
  readonly randomBytes?: (count: number) => Uint8Array;
  /** Continuation-loop hooks (R7); no-ops by default. */
  readonly loopHooks?: LoopHooks;
  /** TODO tree policy overrides. */
  readonly treePolicy?: Partial<TreePolicy>;
  /** Lock staleness threshold in ms. */
  readonly lockStaleAfterMs?: number;
  /** Stream read byte cap. */
  readonly maxStreamBytes?: number;
}

export interface GoalsExtensionHandle {
  /** Test/introspection accessor for the session runtime (null offline). */
  getRuntime(): GoalsRuntime | null;
  /** Engine accessor kept for symmetry with the CLI phase (null offline). */
  getEngine(): GoalRuntimeEngine | null;
}

export default function goalsExtension(pi: ExtensionAPI, options: GoalsExtensionOptions = {}): GoalsExtensionHandle {
  let runtime: GoalsRuntime | null = null;
  let hud: GoalsHud | null = null;
  const getRuntime = (): GoalsRuntime | null => runtime;

  // Tools + commands register IMMEDIATELY (they answer `blocked` offline).
  const onChanged = (): void => {
    hud?.refresh();
  };
  registerTools(pi, getRuntime, onChanged);
  registerCommands(pi, getRuntime, onChanged);

  pi.on("session_start", (_event, ctx) => {
    const stateDir = options.stateDir ?? resolveStateDir(options.pathEnv);
    const runtimeDir = options.runtimeDir ?? resolveRuntimeDir(options.pathEnv);
    const sessionId = ctx.sessionManager?.getSessionId() ?? "";
    // SOFT mesh dependency (best effort): pi-mesh writes
    // <meshStateDir>/identity-<sessionId>.json { alias, rooms } — absent
    // without mesh, never blocks the goals extension. Candidate dirs:
    // $MESH_STATE_DIR, the SESSION cwd (ctx.cwd when the host exposes it),
    // the process cwd, then the stateDir parent.
    const sessionCwd = typeof (ctx as { cwd?: unknown }).cwd === "string" && ((ctx as { cwd: unknown }).cwd as string).length > 0 ? (ctx as { cwd: string }).cwd : process.cwd();
    let meshIdentity: MeshIdentity | undefined;
    for (const meshDir of [
      options.pathEnv?.MESH_STATE_DIR ?? process.env.MESH_STATE_DIR,
      path.join(sessionCwd, ".mesh"),
      path.join(process.cwd(), ".mesh"),
      path.join(path.dirname(stateDir), ".mesh"),
    ]) {
      if (typeof meshDir !== "string" || meshDir.trim().length === 0) continue;
      meshIdentity = readMeshIdentity(meshDir, sessionId);
      if (meshIdentity !== undefined) break;
    }
    // $GOALS_SCOPE (opt-in session default, review P2/P3): canonicalized
    // ONCE here so every tool call without an explicit scope resolves the
    // same lane. Invalid value → warning + engine fallback (never crash).
    let scopeDefault: string | undefined;
    const rawScopeDefault = options.pathEnv?.GOALS_SCOPE ?? process.env.GOALS_SCOPE;
    if (typeof rawScopeDefault === "string" && rawScopeDefault.trim().length > 0) {
      const resolved = resolveScopeShorthand(rawScopeDefault, { sessionId, rooms: meshIdentity?.rooms });
      if (resolved.ok) scopeDefault = resolved.scope;
      else ctx.ui.notify(`goals: invalid $GOALS_SCOPE '${rawScopeDefault}' ignored (${resolved.error})`, { level: "warning" });
    }
    const engine = createRuntimeGoalEngine({
      stateDir,
      runtimeDir,
      ...(options.clock !== undefined ? { clock: options.clock } : {}),
      ...(options.randomBytes !== undefined ? { randomBytes: options.randomBytes } : {}),
      ...(options.loopHooks !== undefined ? { loopHooks: options.loopHooks } : {}),
      ...(options.treePolicy !== undefined ? { treePolicy: options.treePolicy } : {}),
      ...(options.lockStaleAfterMs !== undefined ? { lockStaleAfterMs: options.lockStaleAfterMs } : {}),
      ...(options.maxStreamBytes !== undefined ? { maxStreamBytes: options.maxStreamBytes } : {}),
    });
    runtime = {
      pi,
      engine,
      stateDir,
      runtimeDir,
      sessionId,
      ...(meshIdentity !== undefined ? { meshIdentity } : {}),
      ...(scopeDefault !== undefined ? { scopeDefault } : {}),
      startedAt: Date.now(),
      mode: DEFAULT_GOAL_ACTIVATION_MODE,
      mirrorWrites: 0,
      mirrorFailures: 0,
    };

    // Restore: the engine is stateless (D-E1) — restoring means verifying the
    // store reads back cleanly and surfacing restore-blocked diagnostics.
    let restored: { goal?: GoalRuntimeView; diagnostics?: readonly unknown[] } = {};
    try {
      restored = engine.getGoal();
    } catch {
      restored = {};
    }
    if (restored.diagnostics !== undefined && restored.diagnostics.length > 0) {
      ctx.ui.notify(`goals: store restore-blocked (${restored.diagnostics.length} diagnostic(s)) — mutations answer restore_blocked; inspect with get_goal`, { level: "warning" });
    }

    // HUD above the editor: hidden without an active goal (hud.ts).
    hud = new GoalsHud({ getRuntime });
    hud.attach(ctx);
  });

  pi.on("session_shutdown", () => {
    runtime = null;
    hud?.detach();
    hud = null;
  });

  return {
    getRuntime,
    getEngine: (): GoalRuntimeEngine | null => runtime?.engine ?? null,
  };
}
