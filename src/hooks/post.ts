/** PostToolUse for `mcp__*__ns_*`: write-through cache, result shaping, error handling. */
import { appendAudit } from "../audit.ts";
import { catalogTarget, descriptionTag, emptyFieldsNote, isEmptySchema, parseSection, shrinkRefusal, tagMismatch } from "../cache/catalog.ts";
import { buildProfile, loadProfile } from "../cache/profile.ts";
import { loadManifest, markStale, readIndex, safeSectionName, sectionNameProblem, storeSection } from "../cache/store.ts";
import { type Ctx, connectorServer, context, recordConnector } from "../config.ts";
import { GENERIC_SUITESCRIPT, MAX_RATE_LIMIT_TRIES, type ErrorClass, advice, classifyError, fieldErrorTable, searchTypeErrorId, tablesInSql } from "../errors.ts";
import { decodeToolResponse, errorText, looksLikeError, nsToolName, resolveSpilled } from "../mcp.ts";
import { isWriteTool } from "../preview.ts";
import { buildSummary, detectTruncation, sourceFooter } from "../results/summary.ts";
import { reportCurrencyInfo, saveResult } from "../results/store.ts";
import { extractRows, normaliseDateValue } from "../rows.ts";
import { RATE_LIMIT_RESET_MS, endCall, heartbeat, loadState, saveState, takeUnknownCols } from "../session.ts";
import { canonicalJson, fmtNum, sha256, truncate } from "../util.ts";
import { type HookInput, type HookOutput, logHookError } from "./io.ts";
import { cliCommand } from "./session-start.ts";

const SHAPED = new Set(["ns_runCustomSuiteQL", "ns_runSavedSearch", "ns_runReport", "ns_getRecord"]);
const PROFILE_SECTIONS = /^(subsidiaries|books|periods|probe\/)/;

function queryLabel(tool: string, input: Record<string, unknown>): string {
  if (tool === "ns_runCustomSuiteQL") return String(input.sqlQuery ?? "");
  return canonicalJson(input);
}

function postOut(ctxLines: string[], replacement?: string): HookOutput | undefined {
  if (!ctxLines.length && replacement === undefined) return undefined;
  const hso: Record<string, unknown> = { hookEventName: "PostToolUse" };
  if (replacement !== undefined) hso.updatedMCPToolOutput = replacement;
  if (ctxLines.length) hso.additionalContext = ctxLines.join("\n");
  return { json: { hookSpecificOutput: hso } };
}

/** One line (~300 chars max) in place of a catalog payload the parser didn't understand. */
export function unparsedNote(section: string, label: string, text: string, json: unknown): string {
  const keys = json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json).slice(0, 5).join(", ") : Array.isArray(json) ? "(array)" : "(not JSON)";
  return truncate(`[su-ns-harness] Stored ${label} (${fmtNum(text.length)} chars, keys: ${keys}) raw, but couldn't parse it; kept out of context. Inspect: nsx cache show ${section}. Please report the format.`, 300);
}

/**
 * Saved searches return `2026-5-3 1:11 pm`; saved results are normalised (rows.ts), but an inline
 * result reaches Claude as NetSuite sent it, so say how to read it, with an example from the payload.
 */
export function looseDateNote(text: string): string | undefined {
  let example: [string, string] | undefined;
  let twelve = false;
  for (const m of text.matchAll(/"(\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?)?)\\?"/gi)) {
    const n = normaliseDateValue(m[1]);
    if (n === undefined || n === m[1]) continue;
    const ampm = /[ap]\.?m\.?$/i.test(m[1]);
    if (!example || (ampm && !twelve)) example = [m[1], n];
    twelve ||= ampm;
    if (twelve) break;
  }
  if (!example) return undefined;
  return `[su-ns-harness] Dates are ${twelve ? "12-hour, " : ""}unpadded (${example[0]} = ${example[1]}).`;
}

/** The unknown columns the Pre hook remembered for this call, removed from the session state. */
function flaggedColumns(ctx: Ctx, session: string, toolUseId: string | undefined): string[] | undefined {
  if (!toolUseId) return undefined;
  const state = loadState(ctx.data, session);
  if (!state.unknownCols?.[toolUseId]) return undefined;
  const cols = takeUnknownCols(state, toolUseId);
  saveState(ctx.data, session, state);
  return cols;
}

/**
 * A saved search's record type from the searches cache (`System Note`), by its script id
 * (`customsearch900`) or the numeric id NetSuite's error names (`900`).
 */
export function cachedSearchRecordType(acctDir: string, searchId: unknown, errorId?: string): string | undefined {
  const ix = readIndex(acctDir, "searches");
  const [id, rt] = [ix.header.indexOf("id"), ix.header.indexOf("recordtype")];
  if (id < 0 || rt < 0) return undefined;
  const want = [String(searchId ?? ""), errorId ?? "", errorId ? `customsearch${errorId}` : ""].map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const w of want) {
    const r = ix.rows.find((row) => (row[id] ?? "").toLowerCase() === w);
    if (r?.[rt]) return r[rt];
  }
  return undefined;
}

/** `fields` as ns_getRecord takes it: comma-separated, no spaces (spaces drop every field after the first). */
export function normaliseFields(f: unknown): string | undefined {
  const parts = Array.isArray(f) ? f.map((x) => String(x ?? "")) : typeof f === "string" ? f.split(",") : undefined;
  if (!parts) return undefined;
  return parts.map((x) => x.trim()).filter(Boolean).join(",");
}

/** Requested ns_getRecord fields missing from the returned record (case-insensitive; NetSuite returns tranid as tranId). */
export function missingRecordFields(fields: unknown, json: unknown): string[] {
  const want = normaliseFields(fields);
  if (!want || want === "*" || want === "[full]") return [];
  const o = json as Record<string, unknown> | undefined;
  const rec = o && typeof o === "object" && !Array.isArray(o) ? (o.data && typeof o.data === "object" && !Array.isArray(o.data) ? (o.data as Record<string, unknown>) : o) : undefined;
  if (!rec) return [];
  const have = new Set(Object.keys(rec).map((k) => k.toLowerCase()));
  return want.split(",").filter((f) => !f.includes(".") && !have.has(f.toLowerCase()));
}

/**
 * Requested fields the record came back without. With recordmeta/<type> cached, each name is either
 * not a field of the type (misspelled) or a real field that's empty here (NetSuite leaves those out).
 */
export function missingFieldsNote(ctx: Ctx, type: string, missing: string[]): string {
  const ix = ctx.acctDir && type !== "<type>" ? readIndex(ctx.acctDir, `recordmeta/${type}`) : undefined;
  const col = ix ? ix.header.indexOf("field") : -1;
  if (!ix || col < 0 || !ix.rows.length) {
    return `[su-ns-harness] Requested but not in the record: ${missing.join(", ")}. NetSuite leaves out empty fields, and a misspelled name gives no error: check names with nsx fields ${type} --record before saying the record has no value.`;
  }
  const known = new Set(ix.rows.map((r) => (r[col] ?? "").toLowerCase()));
  const bad = missing.filter((f) => !known.has(f.toLowerCase()));
  const empty = missing.filter((f) => known.has(f.toLowerCase()));
  const parts: string[] = [];
  if (bad.length) parts.push(`${bad.join(", ")}: not ${bad.length > 1 ? "fields" : "a field"} of ${type} (check the name: nsx fields ${type} --record --grep <term>)`);
  if (empty.length) parts.push(`${empty.join(", ")}: ${empty.length > 1 ? "fields" : "a field"} of ${type}, empty on this record (NetSuite leaves out empty fields)`);
  return `[su-ns-harness] Requested but not in the record: ${parts.join("; ")}.`;
}

const rlKey = (tool: string, ti: Record<string, unknown>) => `rl:${sha256(`${tool}\n${canonicalJson(ti)}`).slice(0, 16)}`;

/** Remember which connector this call went through (PostToolUse/Failure too, not only Pre). */
function noteConnector(ctx: Ctx, toolName: string | undefined): void {
  try {
    const server = connectorServer(toolName);
    if (server) recordConnector(ctx.data, server);
  } catch (err) {
    logHookError("post:connector", err);
  }
}

/**
 * The record id in a write result, or true for a bare `success: true`; undefined when the body
 * gives no positive sign of success (an unrecognised error must never read "Write succeeded").
 */
export function writeSuccess(json: unknown): string | true | undefined {
  const o = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
  if (!o || o.success === false) return undefined;
  const idOf = (r: unknown) => {
    const x = r && typeof r === "object" && !Array.isArray(r) ? (r as Record<string, unknown>) : undefined;
    const v = x?.id ?? x?.recordId ?? x?.internalId;
    return typeof v === "string" || typeof v === "number" ? String(v) : undefined;
  };
  return idOf(o) ?? idOf(o.data) ?? idOf(o.record) ?? idOf(o.result) ?? (o.success === true ? true : undefined);
}

/** Shared by PostToolUse (isError results) and PostToolUseFailure. */
export function failureContext(ctx: Ctx, session: string, tool: string, ti: Record<string, unknown>, message: string, toolUseId?: string): { text: string; cls: ErrorClass } {
  let cls = classifyError(message);
  const flagged = flaggedColumns(ctx, session, toolUseId);
  // NetSuite doesn't name a bad column (live: "An unexpected SuiteScript error has occurred"); if
  // the guard flagged one on this very call, that's the likely cause.
  if (flagged?.length && (cls === "unknown" || GENERIC_SUITESCRIPT.test(message))) cls = "bad_field_likely";
  let tables: string[] = [];
  if (cls === "bad_field" && ctx.acctDir) {
    // The error names the table when it can ("Field 'x' for record 'transactionLine'"); else every FROM/JOIN table.
    const named = fieldErrorTable(message);
    tables = named ? [named] : tool === "ns_runCustomSuiteQL" ? tablesInSql(String(ti.sqlQuery ?? "")) : [String(ti.recordType ?? "").toLowerCase()].filter(Boolean);
    // A REST record type (writes, ns_getRecord) has record metadata, not a SuiteQL field list.
    const kind = tool === "ns_runCustomSuiteQL" || named ? "fields" : "recordmeta";
    for (const t of tables) markStale(ctx.acctDir, `${kind}/${t}`, "error: unknown field");
  }
  if (cls === "not_found" && ctx.acctDir) {
    if (tool === "ns_runReport") markStale(ctx.acctDir, "reports", "error: report not found");
    if (tool === "ns_runSavedSearch") markStale(ctx.acctDir, "searches", "error: search not found");
  }
  let attempt = 1;
  if (cls === "rate_limit") {
    // Hits in a row on this exact call; after 5 quiet minutes a new episode starts at 1.
    const state = loadState(ctx.data, session);
    const key = rlKey(tool, ti);
    const prev = state.rateLimits?.[key];
    const now = Date.now();
    attempt = prev && Number.isFinite(prev.n) && now - prev.at <= RATE_LIMIT_RESET_MS ? prev.n + 1 : 1;
    (state.rateLimits ??= {})[key] = { n: attempt, at: now };
    delete state.retries[key];
    saveState(ctx.data, session, state);
  }
  const searchRecordType = tool === "ns_runSavedSearch" && ctx.acctDir ? cachedSearchRecordType(ctx.acctDir, ti.searchId, searchTypeErrorId(message)) : undefined;
  const a = advice(cls, { attempt, tables, tool, message, columns: flagged, sql: tool === "ns_runCustomSuiteQL" ? String(ti.sqlQuery ?? "") : undefined, searchRecordType });
  const text = a ? `[su-ns-harness] Error class: ${cls}${cls === "rate_limit" ? ` (hit ${attempt} time${attempt === 1 ? "" : "s"} in a row)` : ""}. ${a}` : "";
  return { text, cls };
}

export function handlePost(input: HookInput, ctx: Ctx = context(input.tool_name)): HookOutput | undefined {
  const tool = nsToolName(input.tool_name ?? "");
  if (!tool) return undefined;
  const session = input.session_id ?? "";
  heartbeat(ctx.data, session, "post");
  noteConnector(ctx, input.tool_name);
  const ti = input.tool_input ?? {};
  const inflight = input.tool_use_id ? endCall(ctx.data, session, input.tool_use_id) : undefined;
  const tookMs = input.duration_ms ?? (inflight ? Date.now() - inflight.startedAt : undefined);
  const decoded = resolveSpilled(decodeToolResponse(input.tool_response), { transcriptPath: input.transcript_path });
  const audit = (e: Partial<Parameters<typeof appendAudit>[1]>) => {
    if (ctx.acctDir) appendAudit(ctx.acctDir, { ts: new Date().toISOString(), session, tool, input: ti, outcome: "ok", durationMs: tookMs, ...e });
  };

  if (decoded.spillUnresolved) {
    audit({ note: "spilled result not resolvable" });
    // A catalog list can't be re-run "as an aggregate".
    const catalog = !!catalogTarget(tool, ti, descriptionTag(ti));
    const how = catalog
      ? "It was not cached either. Don't read the whole file into context: grep it for the entry you need, or read it in small slices."
      : "Don't read the whole file into context: re-run the query as an aggregate or with a tighter filter, or read it in small slices.";
    return postOut([
      `[su-ns-harness] Claude Code saved this large result to a file that su-ns-harness could not read (unexpected message format or location), so it was not summarised. ${how} (Please report this: the Claude Code spill format may have changed.)`,
    ]);
  }

  if (looksLikeError(decoded)) {
    const f = failureContext(ctx, session, tool, ti, errorText(decoded), input.tool_use_id);
    audit({ outcome: "error", errorClass: f.cls, note: truncate(errorText(decoded), 300) });
    // An in-body 429 ({"success":false,"error":"HTTP 429 …"}, ~500 chars) says nothing the recovery line doesn't.
    if (f.cls === "rate_limit" && f.text) return postOut([], f.text);
    return postOut(f.text ? [f.text] : []);
  }

  // Successful call: reset any rate-limit retry counter for this input, drop its flagged columns.
  const state = loadState(ctx.data, session);
  const key = rlKey(tool, ti);
  const flagged = input.tool_use_id ? state.unknownCols?.[input.tool_use_id] : undefined;
  if (state.retries[key] || state.rateLimits?.[key] || flagged) {
    delete state.retries[key];
    if (state.rateLimits) delete state.rateLimits[key];
    if (flagged) delete state.unknownCols![input.tool_use_id!];
    saveState(ctx.data, session, state);
  }

  // Every tool not known to only read, and only a positive signal counts as success.
  if (isWriteTool(tool)) {
    const ok = writeSuccess(decoded.json);
    if (ok === undefined) {
      audit({ outcome: "unknown", note: truncate(decoded.text, 300) });
      return postOut([
        `[su-ns-harness] Write outcome unknown: NetSuite's response has no record id and no success flag, so it may have failed. Read the record back with ns_getRecord (fields=<the fields you changed>) before telling the user it worked, and show them the response if it reads like an error.`,
      ]);
    }
    audit({ note: truncate(decoded.text, 300) });
    return postOut([`[su-ns-harness] Write succeeded${ok === true ? "" : ` (record id ${ok})`}. Verify it by reading the record back with ns_getRecord (fields=<the fields you changed>) and show the user the result.`]);
  }

  // ---- write-through cache ----
  const tag = descriptionTag(ti);
  let target = catalogTarget(tool, ti, tag);
  const notes: string[] = [];
  // A tagged query fills the periods/probe cache; check it really is that query first, so a copied
  // description (or an injected one) can't overwrite the cache with other data.
  const mismatch = target && tag && tool === "ns_runCustomSuiteQL" ? tagMismatch(tag, String(ti.sqlQuery ?? ""), decoded.json ?? decoded.text) : undefined;
  if (mismatch) {
    target = undefined;
    notes.push(`[su-ns-harness] Tag [su-ns-harness:${tag}] ignored: ${mismatch}. Nothing was cached; the result is shown as an ordinary query.`);
  }
  // The section name comes from the tool input (recordType): one that isn't a plain name is never
  // cached, so `../../x` can't write outside the cache.
  const badName = target ? sectionNameProblem(target.section) : undefined;
  if (target && badName) {
    notes.push(`[su-ns-harness] Not cached: ${badName}. Record type and table names are plain lower-case ids (e.g. transaction, vendorbill).`);
    target = undefined;
  }
  if (target && !ctx.acctDir) {
    audit({});
    return postOut(["[su-ns-harness] Caching is off: this call's connector couldn't be identified from the tool name."]);
  }
  if (target && ctx.acctDir) {
    const acctDir = ctx.acctDir;
    const json = decoded.json ?? decoded.text;
    const isSchema = /^(fields|recordmeta)\//.test(target.section);
    const parsed = parseSection(target.section, json);
    const empty = isSchema && isEmptySchema(json) && !parsed?.rows.length;
    const index = empty ? { header: [], rows: [] } : parsed;
    const prev = loadManifest(acctDir).sections[safeSectionName(target.section)];
    // An unparseable payload never replaces a good cached copy (a plain-text error must not
    // overwrite raw/searches.json and leave the old index behind).
    if (!index && prev && prev.status !== "unparsed") {
      audit({ outcome: "error", note: truncate(`unparsed ${target.section} response, cache kept: ${decoded.text}`, 300) });
      return postOut([], truncate(`[su-ns-harness] The ${target.label} response couldn't be parsed, so the cached copy (${fmtNum(prev.count)} rows, fetched ${prev.fetchedAt.slice(0, 10)}) was kept. Response: ${decoded.text.trim()}`, 600));
    }
    // An emptied or halved catalog is refused (M2): `[]` once replaced 10 saved searches.
    const shrink = index ? shrinkRefusal(acctDir, safeSectionName(target.section), index.rows.length) : undefined;
    if (shrink) {
      audit({ rows: index?.rows.length, note: truncate(`not cached: ${shrink}`, 300) });
      if (target.section === "periods") {
        // A periods query is an ordinary SuiteQL result too: shown as one below.
        notes.push(`[su-ns-harness] ${shrink}`);
        target = undefined;
      } else return postOut([], `[su-ns-harness] ${shrink}`);
    }
  }
  if (target && ctx.acctDir) {
    const json = decoded.json ?? decoded.text;
    const isSchema = /^(fields|recordmeta)\//.test(target.section);
    const empty = isSchema && isEmptySchema(json) && !parseSection(target.section, json)?.rows.length;
    const index = empty ? { header: [], rows: [] } : parseSection(target.section, json);
    const entry = storeSection(ctx.acctDir, ctx.cfg, target.section, tool, decoded.text, index, empty ? "empty" : undefined);
    if (PROFILE_SECTIONS.test(target.section)) buildProfile(ctx.acctDir);
    audit({ rows: entry.count, outcome: "ok", note: `cached ${target.section}${empty ? " (empty)" : ""}` });
    // Catalog payloads never reach context: parsed or not, Claude gets one line.
    if (empty) {
      const [kind, table] = target.section.split("/");
      return postOut([], `[su-ns-harness] ${emptyFieldsNote(ctx.acctDir, table, kind === "recordmeta" ? "recordmeta" : "fields")}`);
    }
    if (!index) {
      // Short plain text is most likely an error message: let Claude see it (M2).
      const shown = decoded.json === undefined && decoded.text.trim().length <= 300 ? ` Response: ${decoded.text.trim()}` : "";
      return postOut([], `${unparsedNote(target.section, target.label, decoded.text, decoded.json)}${shown}`);
    }
    const what = target.section.startsWith("probe/") ? `${target.label} (${fmtNum(entry.count)} row${entry.count === 1 ? "" : "s"})` : `${fmtNum(entry.count)} ${target.label}`;
    return postOut([], `[su-ns-harness] Cached ${what} → use: ${target.hint}`);
  }

  if (!SHAPED.has(tool)) {
    audit({});
    return postOut(notes);
  }

  if (tool === "ns_getRecord") {
    const missing = missingRecordFields(ti.fields, decoded.json);
    if (missing.length) notes.push(missingFieldsNote(ctx, String(ti.recordType ?? "<type>").toLowerCase(), missing));
  }

  // ---- result shaping ----
  const ex = extractRows(decoded.json);
  const rowCount = ex?.rows.length;
  const truncated = ex ? detectTruncation(tool, ti, ex.rows.length, ex) : undefined;
  const size = decoded.text.length;

  if (size <= ctx.cfg.inline_max_chars || !ctx.acctDir) {
    audit({ rows: rowCount });
    const lines = [...notes, sourceFooter(tool, ti, rowCount, truncated)];
    const dates = tool === "ns_runSavedSearch" ? looseDateNote(decoded.text) : undefined;
    if (dates) lines.push(dates);
    if (!ctx.acctDir && size > ctx.cfg.inline_max_chars) lines.push("[su-ns-harness] Large result not offloaded: this call's connector couldn't be identified from the tool name.");
    return postOut(lines);
  }

  if (!ex || !ex.rows.length) {
    const meta = saveResult({ acctDir: ctx.acctDir, session, tool, query: queryLabel(tool, ti), columns: [], rows: [], raw: decoded.text, tookMs });
    audit({ resultId: meta.id, note: "unparsed large result" });
    return postOut(notes, `[su-ns-harness] Large response (${fmtNum(size)} chars) was not tabular; saved raw → ${meta.files.raw} (id ${meta.id}).\nPeek: ${cliCommand()} results raw ${meta.id} --grep <term>   or   ${cliCommand()} results raw ${meta.id} --head 40`);
  }

  const meta = saveResult({ acctDir: ctx.acctDir, session, tool, query: queryLabel(tool, ti), columns: ex.columns, rows: ex.rows, raw: decoded.text, truncated, tookMs });
  audit({ rows: meta.rowCount, resultId: meta.id });
  return postOut(notes, buildSummary({ meta, rows: ex.rows, columns: ex.columns, reportCurrency: reportCurrencyInfo(meta, loadProfile(ctx.acctDir), ctx.acctDir) }));
}

export function handleFailure(input: HookInput, ctx: Ctx = context(input.tool_name)): HookOutput | undefined {
  const tool = nsToolName(input.tool_name ?? "");
  if (!tool) return undefined;
  const session = input.session_id ?? "";
  heartbeat(ctx.data, session, "failure");
  noteConnector(ctx, input.tool_name);
  const ti = input.tool_input ?? {};
  const inflight = input.tool_use_id ? endCall(ctx.data, session, input.tool_use_id) : undefined;
  if (input.is_interrupt) return undefined;
  const msg = String(input.error ?? "");
  const f = failureContext(ctx, session, tool, ti, msg, input.tool_use_id);
  if (ctx.acctDir) {
    appendAudit(ctx.acctDir, {
      ts: new Date().toISOString(), session, tool, input: ti, outcome: "error", errorClass: f.cls,
      durationMs: input.duration_ms ?? (inflight ? Date.now() - inflight.startedAt : undefined), note: truncate(msg, 300),
    });
  }
  if (!f.text) return undefined;
  return { json: { hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: f.text } } };
}
