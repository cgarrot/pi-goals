// Pi extension entry (loaded via the "pi" manifest). The goals extension
// implementation lives in src/extension/ (compiled thin adapter over the
// GoalRuntimeEngine — zero Pi imports; the local pi-types.ts mirrors the
// ExtensionAPI surface).
export { default } from "./src/extension/index.js";
export type { GoalsExtensionHandle, GoalsExtensionOptions } from "./src/extension/index.js";
