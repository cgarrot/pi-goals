// shared/paths.ts — state/runtime directory resolution for pi-goals.
// Adapted from the pi-mesh pattern (state dir + env override); no Pi
// imports so the package stays standalone and testable with node:test.
import os from "node:os";
import path from "node:path";

export const LOCK_FILE_NAME = "goals.lock";
export const RUNTIME_DIR_PREFIX = "goals-";
export const STATE_DIR_NAME = ".goals";
export const CONFIG_FILE_NAME = "config.json";

/** Runtime dir (lock): $GOALS_RUNTIME_DIR or $TMPDIR/goals-<uid>. */
export function runtimeDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GOALS_RUNTIME_DIR;
  if (override && override.trim().length > 0) return override;
  let uid = "0";
  try {
    uid = String(os.userInfo().uid);
  } catch {
    // uid unavailable (unusual) → stable fallback
  }
  return path.join(os.tmpdir(), RUNTIME_DIR_PREFIX + uid);
}

/** State dir (store, config): $GOALS_STATE_DIR or <cwd>/.goals. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.GOALS_STATE_DIR;
  if (override && override.trim().length > 0) return override;
  return path.join(process.cwd(), STATE_DIR_NAME);
}

export function lockPath(dir?: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dir ?? runtimeDir(env), LOCK_FILE_NAME);
}

export function configPath(dir?: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dir ?? stateDir(env), CONFIG_FILE_NAME);
}
