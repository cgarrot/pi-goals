// extension/pi-types.ts — minimal LOCAL interfaces for the Pi ExtensionAPI
// surface (pi-mesh adapter discipline). ZERO imports from Pi packages: the
// extension is a thin adapter over the Phase-4 GoalRuntimeEngine; tool
// parameters are plain JSON Schema objects (zero-dependency, NO typebox).

/** JSON Schema object (plain, zero-dependency constraint). */
export type JsonSchema = Record<string, unknown>;

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolTextContent[];
  details?: Record<string, unknown>;
}

/** Theme colors supported by the Pi TUI theme.fg (minimal local surface). */
export type ThemeColor = "success" | "warning" | "error" | "muted" | "accent";

export interface UiTheme {
  fg(color: ThemeColor, text: string): string;
}

/** Context passed by Pi to tool execute / command handler / session hooks. */
export interface SessionContext {
  cwd: string;
  /** Pi session manager (read-only surface) — stable sessionId across reloads. */
  sessionManager?: {
    getSessionId(): string;
    getSessionFile?(): string;
  };
  ui: {
    notify(message: string, opts?: { level?: string }): void;
    /** Footer-widget above the editor by default; undefined clears it.
     *  SAFE form ONLY: string[]. */
    setWidget(id: string, content: string[] | undefined): void;
    /** Compact status in the built-in footer; undefined clears it. */
    setStatus(id: string, text: string | undefined): void;
    /** TUI theme (interactive sessions); absent in headless contexts. */
    theme?: UiTheme;
  };
}

export type ToolExecuteFn = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: ToolResult) => void) | undefined,
  ctx: SessionContext,
) => Promise<ToolResult>;

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string;
  /** Plain JSON Schema object — NOT typebox. */
  parameters: JsonSchema;
  execute: ToolExecuteFn;
}

export interface CommandDefinition {
  description: string;
  handler: (args: string, ctx: SessionContext) => void | Promise<void>;
}

export type SessionEventName = "session_start" | "session_shutdown";

export type SessionHookHandler = (
  event: unknown,
  ctx: SessionContext,
) => void | Promise<void>;

/** The subset of the Pi ExtensionAPI used by the goals extension. */
export interface ExtensionAPI {
  on(event: SessionEventName, handler: SessionHookHandler): void;
  registerTool(tool: ToolDefinition): void;
  registerCommand(name: string, def: CommandDefinition): void;
  /**
   * OPTIONAL session transcript append (hosts may not expose it). The goals
   * mirror is best-effort and NON-canonical — the .goals store on disk is
   * the single source of truth (see session-mirror.ts).
   */
  appendEntry?(customType: string, data?: unknown): void;
}

/** Helper: a single-paragraph text tool result. */
export function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  const out: ToolResult = { content: [{ type: "text", text }] };
  if (details !== undefined) out.details = details;
  return out;
}
