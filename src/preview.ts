/** Write previews: the guard only lets a write through (to a user prompt) once a preview exists. */
import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalJson, readJson, sha256, writeJson } from "./util.ts";

export interface Preview {
  tool: string;
  input: Record<string, unknown>;
  before?: Record<string, unknown>;
  createdAt: string;
  diff: string[];
}

/**
 * Connector tools known to only read (live-verified). Anything else is treated as a write, so
 * ns_removeRecord, ns_voidTransaction, ns_sendEmail… get the write checks even in read_only mode,
 * which a denylist of write verbs would miss. Fail closed.
 */
export const READ_TOOLS = new Set([
  "ns_runCustomSuiteQL",
  "ns_runSavedSearch",
  "ns_runReport",
  "ns_getRecord",
  "ns_listAllReports",
  "ns_listSavedSearches",
  "ns_getSubsidiaries",
  "ns_getAccountingBooks",
  "ns_getAccountingContexts",
  "ns_getNexusIds",
  "ns_getSuiteQLMetadata",
  "ns_getRecordTypeMetadata",
  // The claude.ai NetSuite connector's UI apps (seen in the live tool list): pickers and a prompt library.
  "ns_prompt_library_app",
  "ns_report_filters_app",
  "ns_selector_app",
]);

/** Write verbs the guard knows by name (for messages; every non-read tool is guarded as a write). */
export const KNOWN_WRITE_TOOL = /^ns_(create|update|upsert|delete|transform|attach|detach)/i;

/** `ns_get…` / `ns_list…` read by naming convention; everything else not in READ_TOOLS is a write. */
export function isReadTool(tool: string): boolean {
  return READ_TOOLS.has(tool) || /^ns_(get|list)(?=[A-Z_])/.test(tool);
}

export function isWriteTool(tool: string): boolean {
  return /^ns_/.test(tool) && !isReadTool(tool);
}

export function previewHash(tool: string, input: Record<string, unknown>): string {
  return sha256(`${tool}\n${canonicalJson(input)}`).slice(0, 16);
}

export function previewsDir(baseDir: string): string {
  return path.join(baseDir, "previews");
}

function flat(o: unknown, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (o && typeof o === "object" && !Array.isArray(o) && (Object.keys(o).length || !prefix)) {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) flat(v, prefix ? `${prefix}.${k}` : k, out);
  } else out[prefix] = o;
  return out;
}

const show = (v: unknown) => (v === undefined ? "∅" : JSON.stringify(v));

/** Top-level keys that address the record rather than change it. */
const TARGET_KEYS = /^(recordType|recordId|id|type)$/i;
/** Wrappers the field values may sit in, in a tool input or in an ns_getRecord result. */
const WRAPPERS = ["values", "fields", "data", "record", "body"];
/** Envelope keys of a result (`{ success, data, message }`), never fields. */
const ENVELOPE = /^(success|message|links)$/i;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The field values of a write input or a before-record: known wrappers (values/fields/data/…)
 * stripped, their contents merged with any flat fields, record-addressing keys dropped.
 */
function fieldsOf(o: Record<string, unknown>, envelope: boolean, top = true): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const wrapped: Record<string, unknown>[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (WRAPPERS.includes(k) && isObj(v)) wrapped.push(v);
    // Only at the top level: inside `values`, an `id` or `type` is a field being written.
    else if (top && (TARGET_KEYS.test(k) || (envelope && ENVELOPE.test(k)))) continue;
    else out[k] = v;
  }
  // A result may nest twice ({ success, data: { values: {…} } }).
  for (const w of wrapped) Object.assign(out, fieldsOf(w, envelope, false));
  return out;
}

/**
 * The change list the user approves. Every field of the input is compared with the same path in
 * the before-record (exact path, case-insensitive; never a match on the last path segment, which
 * would pair `subsidiary.id` with `entity.id` and hide the change).
 */
export function diffLines(tool: string, input: Record<string, unknown>, before?: Record<string, unknown>): string[] {
  const after = flat(fieldsOf(input, false));
  const create = /create/i.test(tool);
  const lines: string[] = [];
  if (create || !before) {
    for (const [k, v] of Object.entries(after)) lines.push(`+ ${k} = ${show(v)}`);
    if (!lines.length) lines.push("(the input sets no field values)");
    return lines;
  }
  const prev = flat(fieldsOf(before, true));
  const prevLc = new Map(Object.keys(prev).map((k) => [k.toLowerCase(), k]));
  for (const [k, v] of Object.entries(after)) {
    const bk = k in prev ? k : prevLc.get(k.toLowerCase());
    if (bk === undefined) lines.push(`~ ${k}: (not in the before-record) → ${show(v)}`);
    else if (canonicalJson(prev[bk]) !== canonicalJson(v)) lines.push(`~ ${k}: ${show(prev[bk])} → ${show(v)}`);
  }
  if (!lines.length) lines.push(Object.keys(after).length ? "(no field changes detected: every field in the input already has that value in the before-record)" : "(the input sets no field values)");
  return lines;
}

export function writePreview(baseDir: string, tool: string, input: Record<string, unknown>, before?: Record<string, unknown>): { file: string; preview: Preview } {
  const preview: Preview = { tool, input, before, createdAt: new Date().toISOString(), diff: diffLines(tool, input, before) };
  const file = path.join(previewsDir(baseDir), `${previewHash(tool, input)}.json`);
  writeJson(file, preview);
  return { file, preview };
}

export function findPreview(baseDir: string, tool: string, input: Record<string, unknown>): Preview | undefined {
  const file = path.join(previewsDir(baseDir), `${previewHash(tool, input)}.json`);
  if (!fs.existsSync(file)) return undefined;
  return readJson<Preview | undefined>(file, undefined);
}

/** Previews hold record field values; they expire with the results retention window. */
export function cleanupPreviews(baseDir: string, retentionDays: number, now = Date.now()): number {
  const dir = previewsDir(baseDir);
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (now - fs.statSync(p).mtimeMs > retentionDays * 86_400_000) {
        fs.unlinkSync(p);
        removed++;
      }
    }
  } catch {
    /* no previews yet */
  }
  return removed;
}

export function describeTarget(tool: string, input: Record<string, unknown>): string {
  const t = input.recordType ?? input.type ?? "record";
  const id = input.recordId ?? input.id;
  return `${tool.replace(/^ns_/, "")} ${t}${id ? ` #${id}` : ""}`;
}
