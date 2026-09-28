import * as fs from "node:fs";
import * as path from "node:path";
import { dataDir, pluginRootIfOurs } from "../config.ts";

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_use_id?: string;
  tool_response?: unknown;
  error?: string;
  is_interrupt?: boolean;
  duration_ms?: number;
  transcript_path?: string;
}

export interface HookOutput {
  /** Plain text for SessionStart (added to context). */
  text?: string;
  json?: Record<string, unknown>;
}

export function logHookError(where: string, err: unknown): void {
  try {
    const dir = path.join(dataDir(), "logs");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "hook.log");
    // Keep the log from growing without bound.
    try {
      if (fs.statSync(file).size > 1_000_000) fs.renameSync(file, `${file}.1`);
    } catch {
      /* no log yet */
    }
    const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
    fs.appendFileSync(file, `${new Date().toISOString()} [${where}] ${msg}\n`);
  } catch {
    /* never throw from the error path */
  }
}

/**
 * Fixture capture: with NSX_CAPTURE_DIR set, every raw hook input is saved there.
 * These files contain real account data — sanitize before committing them as fixtures.
 */
function captureInput(name: string, raw: string): void {
  const dir = process.env.NSX_CAPTURE_DIR;
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    let tool = "";
    try {
      tool = String((JSON.parse(raw) as HookInput).tool_name ?? "").replace(/^.*__/, "");
    } catch {
      /* keep raw */
    }
    const stamp = new Date().toISOString().replace(/[-:.]/g, "");
    fs.writeFileSync(path.join(dir, `${stamp}_${name}${tool ? `_${tool}` : ""}.json`), raw);
    // Paths only (no option values, which may be sensitive): how the plugin was located.
    const env = { argv1: process.argv[1], CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA };
    fs.writeFileSync(path.join(dir, `${stamp}_${name}.env.json`), JSON.stringify(env, null, 2));
  } catch (err) {
    logHookError(`${name}:capture`, err);
  }
}

/**
 * `nsx` is not on PATH (the plugin avoids bin/ so it stays installable in Cowork), so every
 * `nsx <cmd>` Claude sees in hook output is expanded to the runnable `node "<root>/scripts/nsx.mjs" <cmd>`.
 */
export function expandNsx<T>(v: T, cmd = nsxCommand()): T {
  if (!cmd) return v;
  if (typeof v === "string") return v.replace(/(^|[\s`(:'"])nsx (?=[a-z-])/g, `$1${cmd} `) as T;
  if (Array.isArray(v)) return v.map((x) => expandNsx(x, cmd)) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, k === "updatedInput" ? x : expandNsx(x, cmd)])) as T;
  }
  return v;
}

/** Our own install's command; with a foreign CLAUDE_PLUGIN_ROOT, the running script instead of the other plugin's. */
export function nsxCommand(): string | undefined {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return undefined;
  const ours = pluginRootIfOurs();
  return `node "${ours ? path.join(ours, "scripts", "nsx.mjs") : path.resolve(process.argv[1] ?? "scripts/nsx.mjs")}"`;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

type Handler = (input: HookInput) => HookOutput | undefined;

/**
 * Hook contract: never break the session. Any internal error → exit 0, no output (pass-through).
 */
export async function runHook(
  name: string,
  handler: Handler,
  /** Output to emit when the handler throws (e.g. deny writes: the write guard must fail closed). */
  onError?: Handler,
): Promise<void> {
  let raw = "";
  try {
    raw = await readStdin();
  } catch (err) {
    logHookError(name, err);
    return;
  }
  const text = processHook(name, raw, handler, onError);
  // A closed pipe (EPIPE) arrives as an async 'error' event; unhandled, it would crash the hook.
  process.stdout.on("error", (err) => logHookError(`${name}:stdout`, err));
  try {
    if (text) process.stdout.write(text);
  } catch (err) {
    logHookError(`${name}:write`, err);
  }
}

/** `{"tool_name":"mcp__x__ns_deleteRecord", …broken` → just the tool name, for fail-closed handlers. */
function toolFromRaw(raw: string): HookInput | undefined {
  const named = /"tool_name"\s*:\s*"([^"\\]{1,200})"/.exec(raw)?.[1];
  const tool = named ?? /\bmcp__[A-Za-z0-9_-]{1,100}?__ns_[A-Za-z0-9_]{1,100}/.exec(raw)?.[0];
  return tool ? { tool_name: tool } : undefined;
}

/** Raw hook input → what goes to stdout ("" = pass through). Never throws. */
export function processHook(name: string, raw: string, handler: Handler, onError?: Handler): string {
  let out: HookOutput | undefined;
  let input: HookInput | undefined;
  try {
    captureInput(name, raw);
    const parsed = (raw.trim() ? JSON.parse(raw) : {}) as HookInput;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    input = parsed;
    out = handler(input);
  } catch (err) {
    logHookError(name, err);
    out = undefined;
    // Unparseable stdin still names its tool: a write the guard couldn't read must be denied, not
    // passed through.
    input ??= toolFromRaw(raw);
    if (input && onError) {
      try {
        out = onError(input);
      } catch (err2) {
        logHookError(`${name}:onError`, err2);
      }
    }
  }
  try {
    if (out?.json) return JSON.stringify(expandNsx(out.json));
    if (out?.text) return expandNsx(out.text);
  } catch (err) {
    logHookError(`${name}:write`, err);
  }
  return "";
}
