/**
 * Decoding of MCP tool responses as hooks receive them.
 *
 * The `tool_response` shape for MCP tools isn't fixed, so every known shape is accepted: a plain string, an array of content blocks, `{ content: [...] }`, `{ structuredContent }`,
 * or an already-parsed JSON value.
 * Observed in Claude Code 2.1.282: an array of content blocks `[{ type: "text", text }]`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Decoded {
  /** Concatenated text of all text blocks (or the string itself). */
  text: string;
  /** Parsed JSON payload when the text is JSON, else undefined. */
  json: unknown;
  isError: boolean;
}

function tryJson(s: string): unknown {
  const t = s.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

function blocksText(blocks: unknown[]): string | undefined {
  const texts: string[] = [];
  for (const b of blocks) {
    if (b && typeof b === "object" && (b as { type?: unknown }).type === "text") {
      texts.push(String((b as { text?: unknown }).text ?? ""));
    }
  }
  return texts.length ? texts.join("\n") : undefined;
}

export function decodeToolResponse(resp: unknown): Decoded {
  if (typeof resp === "string") {
    const json = tryJson(resp);
    // Some clients double-wrap: a JSON string holding a content-block array.
    if (Array.isArray(json)) {
      const inner = blocksText(json);
      if (inner !== undefined) return { text: inner, json: tryJson(inner) ?? undefined, isError: false };
    }
    return { text: resp, json, isError: false };
  }
  if (Array.isArray(resp)) {
    const inner = blocksText(resp);
    if (inner !== undefined) return { text: inner, json: tryJson(inner), isError: false };
    return { text: JSON.stringify(resp), json: resp, isError: false };
  }
  if (resp && typeof resp === "object") {
    const o = resp as Record<string, unknown>;
    const isError = o.isError === true;
    if (o.structuredContent !== undefined) {
      return { text: JSON.stringify(o.structuredContent), json: o.structuredContent, isError };
    }
    if (Array.isArray(o.content)) {
      const inner = blocksText(o.content) ?? "";
      return { text: inner, json: tryJson(inner), isError };
    }
    return { text: JSON.stringify(resp), json: resp, isError };
  }
  return { text: String(resp ?? ""), json: undefined, isError: false };
}

const SPILL = /exceeds maximum allowed tokens\. Output has been saved to (.+?)\.?\s*\n/;
/** Looser signal that Claude Code spilled the result, used to warn when SPILL no longer matches. */
const SPILL_HINT = /exceeds maximum allowed tokens|has been saved to \S*tool-results/i;

/**
 * Over MAX_MCP_OUTPUT_TOKENS, Claude Code saves the result to
 * <claude config>/projects/<project>/<session>/tool-results/ and hands PostToolUse only a pointer
 * message (observed in Claude Code 2.1.282, next to transcript <project>/<session>.jsonl).
 * We read that file so we can shape the real payload, but only when it is a regular file (not a
 * symlink) whose real parent directory is exactly this session's tool-results directory.
 */
export function resolveSpilled(
  d: Decoded,
  opts: { transcriptPath?: string; claudeHome?: string } = {},
): Decoded & { spilledFrom?: string; spillUnresolved?: boolean } {
  const m = SPILL.exec(d.text);
  if (!m || !opts.transcriptPath) return SPILL_HINT.test(d.text) && d.text.length < 5000 ? { ...d, spillUnresolved: true } : d;
  try {
    const claudeHome = opts.claudeHome ?? (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"));
    const transcript = path.resolve(opts.transcriptPath);
    const expectedDir = fs.realpathSync(path.join(path.dirname(transcript), path.basename(transcript, ".jsonl"), "tool-results"));
    const home = fs.realpathSync(claudeHome) + path.sep;
    const file = path.resolve(m[1].trim());
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return { ...d, spillUnresolved: true };
    const real = fs.realpathSync(file);
    if (!real.startsWith(home) || path.dirname(real) !== expectedDir) return { ...d, spillUnresolved: true };
    // The file may hold the MCP content-block array itself ([{type:"text",text:"{…}"}]): unwrap it
    // like an inline result, or the rows are never found.
    const inner = decodeToolResponse(fs.readFileSync(real, "utf8"));
    return { text: inner.text, json: inner.json, isError: d.isError, spilledFrom: real };
  } catch {
    return { ...d, spillUnresolved: true };
  }
}

/**
 * A bare string result (`"Error loading saved search …"`, JSON-quoted) → its text; undefined when
 * the payload isn't a single string.
 */
function stringPayload(d: Decoded): string | undefined {
  if (typeof d.json === "string") return d.json;
  const t = d.text.trim();
  if (t.startsWith('"')) {
    try {
      const v = JSON.parse(t) as unknown;
      if (typeof v === "string") return v;
    } catch {
      /* not a JSON string */
    }
  }
  return d.json === undefined ? t : undefined;
}

/**
 * Errors that arrive as a successful result holding one string. Live-verified: saved searches,
 * `Error loading saved search with params {…}. Error: Permission Violation: …`; and every live
 * error string (`HTTP 4xx: …`, `Search error occurred: …`, `Failed to parse SQL …`,
 * `Error executing SuiteQL query: …`), which the connector may send as text too.
 */
const STRING_ERROR = /^(HTTP [45]\d\d\b|Error\b|Search error\b|Failed to parse\b|An unexpected SuiteScript error\b|The connector's server is rate-limiting)/i;

/** `{"status":429,"title":"Too Many Requests"}` (RFC 7807 problem details) or `{"status":400,"detail":…}`. */
function isProblemObject(j: Record<string, unknown>): boolean {
  const st = typeof j.status === "number" ? j.status : typeof j.status === "string" && /^\d{3}$/.test(j.status) ? Number(j.status) : NaN;
  // Small, and not a record (a record may have its own status/title fields).
  if (Object.keys(j).length > 8 || "id" in j) return false;
  return st >= 400 && st < 600 && (typeof j.title === "string" || typeof j.detail === "string" || j["o:errorDetails"] !== undefined || typeof j.message === "string");
}

/** Error-ish payloads the connector may return as a "successful" result. */
export function looksLikeError(d: Decoded): boolean {
  if (d.isError) return true;
  const j = d.json as Record<string, unknown> | undefined;
  if (j && typeof j === "object" && !Array.isArray(j)) {
    if (j.success === false) return true;
    if (j.error && !Array.isArray(j.error)) return true;
    if (typeof j["o:errorDetails"] === "object") return true;
    if (isProblemObject(j)) return true;
  }
  const s = stringPayload(d);
  return s !== undefined && s.length < 5000 && STRING_ERROR.test(s.trim());
}

export function errorText(d: Decoded): string {
  const j = d.json as Record<string, unknown> | undefined;
  if (j && typeof j === "object") {
    // Problem details: keep the HTTP status, which classifies it (429 → rate_limit, 404 → not_found).
    if (!Array.isArray(j) && isProblemObject(j)) {
      const why = j.detail ?? j["o:errorDetails"] ?? j.message ?? j.title;
      return `HTTP ${String(j.status)}: ${typeof why === "string" ? why : JSON.stringify(why)}${typeof j.title === "string" && j.title !== why ? ` (${j.title})` : ""}`;
    }
    const e = j.error ?? j.message ?? j["o:errorDetails"] ?? j.detail;
    if (e) return typeof e === "string" ? e : JSON.stringify(e);
  }
  return stringPayload(d) ?? d.text;
}

/** `mcp__netsuite__ns_runCustomSuiteQL` → `ns_runCustomSuiteQL` */
export function nsToolName(toolName: string): string | undefined {
  // The last `__` segment, so a server named e.g. "ns" (mcp__ns__ns_createRecord) can't leak into
  // the tool name. Single underscores are part of the name (ns_create_record, ns_updateRecord_v2):
  // a tool the hooks can't name is a write they can't guard.
  if (typeof toolName !== "string") return undefined;
  const last = toolName.split("__").pop() ?? "";
  return /^ns_[A-Za-z0-9][A-Za-z0-9_]*$/.test(last) ? last : undefined;
}
