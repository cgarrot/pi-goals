// shared/config.ts — typed config + defaults for pi-goals, loaded from
// <stateDir>/config.json when present (graceful fallback to defaults).
import { readFileSync } from "node:fs";
import { configPath } from "./paths.js";

export const DEFAULT_MAX_ACTIVE_GOALS = 256;
export const DEFAULT_MAX_DEPTH = 8;

export interface GoalsConfig {
  /** Max goals kept active per store (0 = unlimited). */
  maxActiveGoals: number;
  /** Max sub-TODO nesting depth under a goal. */
  maxDepth: number;
}

export const DEFAULT_CONFIG: GoalsConfig = {
  maxActiveGoals: DEFAULT_MAX_ACTIVE_GOALS,
  maxDepth: DEFAULT_MAX_DEPTH,
};

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** Load config: defaults < <stateDir>/config.json. Missing/invalid file → defaults. */
export function loadConfig(
  stateDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): GoalsConfig {
  let fileCfg: Partial<GoalsConfig> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(stateDir, env), "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      fileCfg = parsed as Partial<GoalsConfig>;
    }
  } catch {
    // missing/invalid config.json → defaults
  }
  return {
    maxActiveGoals: positiveInt(fileCfg.maxActiveGoals, DEFAULT_CONFIG.maxActiveGoals),
    maxDepth: positiveInt(fileCfg.maxDepth, DEFAULT_CONFIG.maxDepth),
  };
}
