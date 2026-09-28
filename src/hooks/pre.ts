/** PreToolUse guard for `mcp__*__ns_*`: SuiteQL checks, parameter injection, write safety. */
import * as fs from "node:fs";
import * as path from "node:path";
import { appendAudit } from "../audit.ts";
import { descriptionTag, reportSupportsRange } from "../cache/catalog.ts";
import { isCanonicalProbe } from "../cache/probes.ts";
import { loadProfile } from "../cache/profile.ts";
import { isFresh, loadManifest, readIndex, safeSectionName } from "../cache/store.ts";
import { type Ctx, connectorServer, context, recordConnector } from "../config.ts";
import { STANDALONE_SEARCH_TYPES, tablesInSql } from "../errors.ts";
import { nsToolName } from "../mcp.ts";
import { KNOWN_WRITE_TOOL, describeTarget, diffLines, findPreview, isWriteTool, previewHash, previewsDir } from "../preview.ts";
import { beginCall, endCall, heartbeat, loadState, rememberUnknownCols, saveState, sessionDir } from "../session.ts";
import { HARD_RULES, TYPE_CODES, type LintContext, type LintResult, formatLint, lintSuiteQL, nolintOf, pagingOrderMissing, topFetchRows, unknownColumns } from "../sql/lint.ts";
import { canonicalJson, ensureDir, readJson, sha256 } from "../util.ts";
import { type HookInput, type HookOutput, logHookError } from "./io.ts";
import { cachedSearchRecordType, normaliseFields } from "./post.ts";
import { cliCommand, sessionContext } from "./session-start.ts";

/** Record types whose full ns_getRecord payload (with sublists) is typically huge. */
const LARGE_RECORD = new Set([...Object.values(TYPE_CODES), "transaction", "customer", "vendor", "employee", "item", "inventoryitem", "assemblyitem", "kititem", "project", "job"]);

export function lintContextFor(ctx: Ctx): LintContext {
  if (!ctx.acctDir) return {};
  const acctDir = ctx.acctDir;
  const m = loadManifest(acctDir);
  const fresh = (name: string) => {
    const e = m.sections[safeSectionName(name)];
    return isFresh(e, ctx.cfg, name) && e.status === "ok";
  };
  // One index read per table per query, shared by fields and fieldType.
  const rows = new Map<string, string[][] | undefined>();
  const tableRows = (table: string) => {
    if (!rows.has(table)) {
      const name = `fields/${table}`;
      rows.set(table, fresh(name) ? readIndex(acctDir, name).rows : undefined);
    }
    return rows.get(table);
  };
  const lc: LintContext = {
    fields: (table) => {
      const r = tableRows(table);
      return r && new Set(r.map((x) => (x[0] ?? "").toLowerCase()).filter(Boolean));
    },
    fieldType: (table, column) => tableRows(table)?.find((r) => (r[0] ?? "").toLowerCase() === column)?.[1]?.toLowerCase() || undefined,
  };
  if (fresh("recordtypes")) lc.recordTypes = new Set(readIndex(acctDir, "recordtypes").rows.map((r) => (r[0] ?? "").toLowerCase()));
  const p = loadProfile(acctDir);
  if (p?.approvalWorkflows && Object.keys(p.approvalWorkflows).length) lc.approvalWorkflows = p.approvalWorkflows;
  // Subsidiaries with different base currencies: SUM(tal.amount) across them mixes currencies.
  const curs = new Set(
    [...Object.values(p?.subsidiaryCurrencies ?? {}), ...(p?.ttmRevenueBySubsidiary ?? []).map((x) => x.currency ?? "")]
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean),
  );
  if (curs.size > 1) lc.multiCurrencySubsidiaries = true;
  return lc;
}

interface Decision {
  decision?: "deny" | "ask";
  reason?: string;
  updatedInput?: Record<string, unknown>;
  context: string[];
}

function out(d: Decision): HookOutput | undefined {
  if (!d.decision && !d.updatedInput && !d.context.length) return undefined;
  const hso: Record<string, unknown> = { hookEventName: "PreToolUse" };
  if (d.decision) {
    hso.permissionDecision = d.decision;
    hso.permissionDecisionReason = d.reason;
  }
  // Pass updatedInput without a decision so the user's own permission rules still apply
  // (Claude Code applies updatedInput without a permissionDecision; live-verified).
  if (d.updatedInput && d.decision !== "deny") hso.updatedInput = d.updatedInput;
  if (d.context.length) hso.additionalContext = d.context.join("\n");
  return { json: { hookSpecificOutput: hso } };
}

/** Bookkeeping (config snapshot, heartbeat, audit, session state) must never suppress a decision. */
function bestEffort<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    logHookError("pre:bookkeeping", err);
    return undefined;
  }
}

/** Used by runHook when handlePre throws: a write we could not check is denied, everything else passes. */
export function failClosedForWrites(input: HookInput): HookOutput | undefined {
  const tool = nsToolName(input.tool_name ?? "");
  if (!tool || !isWriteTool(tool)) return undefined;
  // No promise of a log file: with no usable data dir nothing could be logged.
  return out({
    decision: "deny",
    reason: "[su-ns-harness] This NetSuite write was blocked because su-ns-harness could not check it (internal error). Don't retry it as is: run the su-ns-harness:doctor skill (it shows the logged error, when one could be written), fix the problem, then try again.",
    context: [],
  });
}

/** Values `range` takes on ns_runReport (live 2026-09-28: only lowercase month/quarter work; other spellings are ignored). */
const RANGE_VALUES = /^(month|quarter|year|week|day)$/i;

/** Did SessionStart fire for this session? Its heartbeat lists the sessions it fired in. */
function sessionStartFired(data: string, session: string): boolean {
  const hb = readJson<Record<string, { session?: unknown; sessions?: Record<string, unknown> } | undefined>>(path.join(data, "heartbeat.json"), {});
  const e = hb?.["session-start"];
  return !!e && (e.session === session || !!(e.sessions && typeof e.sessions === "object" && session in e.sessions));
}

/**
 * SessionStart doesn't fire for a plugin loaded mid-session (/reload-plugins): no profile block and
 * no Cache CLI line. The first NetSuite call of such a session carries that context instead, once.
 * The flag file is created exclusively, so parallel first calls inject it only once.
 */
export function missedSessionContext(input: HookInput, ctx: Ctx): string | undefined {
  const session = input.session_id ?? "";
  if (!session || !ctx.data || sessionStartFired(ctx.data, session)) return undefined;
  const dir = ensureDir(sessionDir(ctx.data, session));
  try {
    fs.closeSync(fs.openSync(path.join(dir, "session-context-sent"), "wx"));
  } catch {
    return undefined; // already sent (EEXIST), or not writable: never inject on every call
  }
  return `[su-ns-harness] SessionStart didn't run in this session (the plugin was loaded mid-session, e.g. with /reload-plugins), so here is its context:\n${sessionContext(ctx)}`;
}

export function handlePre(input: HookInput, ctx: Ctx = context(input.tool_name)): HookOutput | undefined {
  const res = guard(input, ctx);
  // A denied call's additionalContext may never reach Claude: keep the context for the next call.
  if (!nsToolName(input.tool_name ?? "") || (res?.json?.hookSpecificOutput as Record<string, unknown> | undefined)?.permissionDecision === "deny") return res;
  const intro = bestEffort(() => missedSessionContext(input, ctx));
  if (!intro) return res;
  const hso: Record<string, unknown> = { hookEventName: "PreToolUse", ...((res?.json?.hookSpecificOutput as Record<string, unknown> | undefined) ?? {}) };
  hso.additionalContext = [intro, hso.additionalContext].filter((x) => typeof x === "string" && x).join("\n");
  return { ...res, json: { ...(res?.json ?? {}), hookSpecificOutput: hso } };
}

function guard(input: HookInput, ctx: Ctx): HookOutput | undefined {
  const tool = nsToolName(input.tool_name ?? "");
  if (!tool) return undefined;
  const server = connectorServer(input.tool_name);
  if (server) bestEffort(() => recordConnector(ctx.data, server));
  bestEffort(() => heartbeat(ctx.data, input.session_id ?? "", "pre"));
  const session = input.session_id ?? "";
  const ti: Record<string, unknown> = { ...(input.tool_input ?? {}) };
  const d: Decision = { context: [] };
  const auditBase = ctx.acctDir ? ctx.acctDir : path.join(ctx.data, "accounts", "_unconfigured");

  const deny = (reason: string, note: string): HookOutput | undefined => {
    // A denied call never reaches PostToolUse, so it must not stay registered as in flight.
    if (input.tool_use_id) bestEffort(() => endCall(ctx.data, session, input.tool_use_id!));
    bestEffort(() => appendAudit(auditBase, { ts: new Date().toISOString(), session, tool, input: ti, outcome: "denied", note }));
    return out({ decision: "deny", reason: `[su-ns-harness] ${reason}`, context: [] });
  };

  // ---- writes ----
  // Every tool not known to only read is guarded as a write.
  if (isWriteTool(tool)) {
    const unknownTool = !KNOWN_WRITE_TOOL.test(tool) ? `${tool} is an unknown NetSuite tool: treated as a write. ` : "";
    if (ctx.cfg.read_only) {
      return deny(
        `${unknownTool}Writes are disabled (read_only = true). Do not retry, and don't change the setting yourself. If the user wants NetSuite writes, they turn them on in their own terminal: ${cliCommand()} config set read_only=false (applies to the next call, no restart).`,
        "read_only",
      );
    }
    // Blank or whitespace-only doesn't count.
    const ext = (v: unknown) => (typeof v === "string" ? v.trim() !== "" : typeof v === "number");
    const sub = (k: string) => (ti[k] && typeof ti[k] === "object" ? (ti[k] as Record<string, unknown>).externalId : undefined);
    if (/create/i.test(tool) && !ext(ti.externalId) && !ext(sub("values")) && !ext(sub("fields")) && !ext(sub("data"))) {
      return deny("Set externalId on every create so a retried call cannot create a duplicate record. Add a stable externalId (e.g. 'claude-<purpose>-<date>-<n>') and call again.", "missing_externalId");
    }
    const base = ctx.acctDir ?? ctx.data;
    const pv = findPreview(base, tool, ti);
    if (!pv) {
      return deny(
        `Writes need a preview first. Pipe the exact tool input to: nsx preview ${tool} -   (add --before <file.json> with the current record from ns_getRecord for updates). Show the user the diff it prints, then make this same call again with identical input (hash ${previewHash(tool, ti)}).`,
        "missing_preview",
      );
    }
    // Not registered as in flight: if the user rejects the prompt no Post hook fires to clear it.
    // Durations for writes come from the Post hook's duration_ms. For the same reason the attempt
    // is audited now as "pending": a rejected write leaves that line, an approved one adds "ok".
    bestEffort(() => appendAudit(auditBase, { ts: new Date().toISOString(), session, tool, input: ti, outcome: "pending", note: "awaiting user approval" }));
    const file = path.join(previewsDir(base), `${previewHash(tool, ti)}.json`);
    const notes: string[] = [];
    // The diff is recomputed from the input actually being sent: the stored one is only a file on
    // disk, and a stale or edited copy must not decide what the user sees.
    const before = pv.before && typeof pv.before === "object" && !Array.isArray(pv.before) ? pv.before : undefined;
    const diff = diffLines(tool, ti, before);
    if (!/create/i.test(tool) && !before) notes.push("No before-state supplied: values shown are what will be written; old values unknown.");
    if (unknownTool) notes.push(`${tool} isn't a tool su-ns-harness knows: check what it does before approving.`);
    if (diff.length > 15) notes.push(`… ${diff.length - 15} more changes. Full input: ${file}`);
    return out({
      decision: "ask",
      reason: `[su-ns-harness] NetSuite WRITE: ${describeTarget(tool, ti)}\n${[...diff.slice(0, 15), ...notes].join("\n")}`,
      context: ["After this write succeeds, verify it by reading the record back with ns_getRecord (fields=…)."],
    });
  }

  // ---- concurrency ----
  const inputHash = sha256(`${tool}\n${canonicalJson(ti)}`).slice(0, 16);
  if (input.tool_use_id) {
    const others = bestEffort(() => beginCall(ctx.data, session, input.tool_use_id!, { tool, startedAt: Date.now(), inputHash })) ?? [];
    if (others.length) {
      d.context.push(`[su-ns-harness] ${others.length} other NetSuite call(s) in flight (${others.join(", ")}). The account's concurrency limit is small: run NetSuite calls one at a time, not in parallel.`);
    }
  }

  // ---- SuiteQL ----
  if (tool === "ns_runCustomSuiteQL") {
    if (typeof ti.sqlQuery !== "string" || !ti.sqlQuery.trim()) {
      const keys = Object.keys(ti).filter((k) => k !== "sqlQuery");
      const what =
        ti.sqlQuery === undefined || ti.sqlQuery === null
          ? "No `sqlQuery` in the input"
          : typeof ti.sqlQuery !== "string"
            ? `\`sqlQuery\` must be a string (got ${Array.isArray(ti.sqlQuery) ? "an array" : `a ${typeof ti.sqlQuery}`})`
            : "`sqlQuery` is empty";
      return deny(
        `${what}${keys.length ? ` (got: ${keys.join(", ")})` : ""}. ns_runCustomSuiteQL takes the SQL text in \`sqlQuery\`; call again with it.`,
        "missing_sqlQuery",
      );
    }
    // null / "" paging values count as absent; anything else must be a whole number.
    const blank = (v: unknown) => v === undefined || v === null || v === "";
    for (const key of ["pageSize", "pageIndex"] as const) {
      const v = ti[key];
      const ok = blank(v) || ((typeof v === "number" || typeof v === "string") && Number.isInteger(Number(v)) && Number(v) >= 0);
      if (!ok) {
        return deny(`${key} must be a whole number ≥ 0 (got ${JSON.stringify(v)}). Omit it to get the default, or pass a number.`, `bad_${key}`);
      }
    }
    const sql = ti.sqlQuery;
    const tag = descriptionTag(ti);
    // Only the exact init query counts as tagged (no paging injection, no metadata gate); any other
    // SQL with a tag is an ordinary query, and the Post hook ignores its tag.
    const probe = !!tag && isCanonicalProbe(tag, sql);
    const nl = nolintOf(ti.description);
    const nolint = nl.all;
    const lc = lintContextFor(ctx);
    // The canonical init probes are fixed, known-good SQL: linting them against a half-built profile
    // only gets in the way (the approval_workflows probe itself mentions approvalstatus).
    const res: LintResult = probe ? { errors: [], warnings: [] } : lintSuiteQL(sql, lc);
    // [nolint] never lets these through: a non-SELECT statement, OFFSET (NetSuite ignores it, so the
    // rows are always the wrong ones; live, [nolint] + OFFSET 5 returned rows 1–5), or a ROWNUM that
    // always gives wrong rows (see HARD_RULES).
    const hard = res.errors.filter((e) => HARD_RULES.has(e.rule));
    if (hard.length) {
      const msg = hard.some((e) => e.rule === "not-select") ? `${formatLint(res)}\nDon't retry.` : `${formatLint(res)}\n[nolint] doesn't apply to this rule: the result would always be wrong. Fix the query and call again.`;
      return deny(msg, hard.map((e) => e.rule).join(","));
    }
    const overridden = res.errors.filter((e) => nl.all || nl.rules.has(e.rule));
    const blocking = res.errors.filter((e) => !overridden.includes(e));
    if (blocking.length) {
      return deny(
        `SuiteQL check failed — fix and call again (only if you are sure an error is a false positive, add [nolint:<rule>] (or [nolint] for all) to the description, not to sqlQuery):\n${formatLint(res)}`,
        blocking.map((e) => e.rule).join(","),
      );
    }
    if (overridden.length) {
      d.context.push(`[su-ns-harness] [nolint] overrode these SuiteQL errors; the query runs as written, so check the result against them:\n${overridden.map((e) => `- [${e.rule}] ${e.message}`).join("\n")}`);
    }
    const warns = res.warnings.map((w) => w.message);
    // section_157960586441 (runSuiteQLPaged): paging "must provide a unique and unambiguous sorting order".
    if (Number(ti.pageIndex) > 0 && pagingOrderMissing(sql)) warns.push("Paging needs a unique ORDER BY (e.g. ORDER BY t.id) or pages can overlap or skip rows.");
    if (warns.length) d.context.push(`[su-ns-harness] SuiteQL warnings:\n${warns.map((w) => `- ${w}`).join("\n")}`);
    // NetSuite answers a bad column with a generic error that doesn't name it: remember what the
    // guard flagged so the Post/Failure hook can point at it.
    const unknown = unknownColumns(res);
    if (unknown.length && input.tool_use_id) {
      bestEffort(() => {
        const st = loadState(ctx.data, session);
        rememberUnknownCols(st, input.tool_use_id!, unknown);
        saveState(ctx.data, session, st);
      });
    }
    // Table checks against the cached SuiteQL record-type list (only when it's cached). [nolint]
    // overrides the hidden-table deny (the cached list can be outdated), not the metadata gate:
    // that costs one metadata call and keeps the query from being written with guessed columns.
    if (ctx.acctDir && lc.recordTypes?.size) {
      const known = lc.recordTypes;
      const tables = tablesInSql(sql);
      const hidden = nolint ? [] : tables.filter((t) => !known.has(t));
      if (hidden.length && probe && tag?.startsWith("profile:")) {
        return deny(
          `Skip this profile probe: ${hidden.map((t) => `'${t}'`).join(", ")} is not in this account's SuiteQL record-type list, so the connector role can't query it. Don't retry; note it as unknown for the Profile Card and go on to the next probe.`,
          "probe_table_hidden",
        );
      }
      if (hidden.length) {
        // Live-verified: a table missing from the list fails with "Record '<t>' was not found"; save the call.
        return deny(
          `${hidden.map((t) => `'${t}'`).join(", ")} ${hidden.length > 1 ? "aren't" : "isn't"} in this account's SuiteQL record-type list, so ${hidden.length > 1 ? "they aren't" : "it isn't"} exposed to the connector role (the call would fail with "Record '${hidden[0]}' was not found"). Don't retry and don't refresh reports or searches: find the data in another table (nsx recordtypes --grep <term>), or ask a NetSuite admin to grant the role access. Only if you know the cached list is outdated, add [nolint] to the description.`,
          "table_not_exposed",
        );
      }
      // First use of a table whose fields aren't cached: fetch its metadata once, then run the query.
      const m = loadManifest(ctx.acctDir);
      const uncached = tables.filter((t) => known.has(t) && !m.sections[safeSectionName(`fields/${t}`)]);
      const state = probe ? undefined : bestEffort(() => loadState(ctx.data, session));
      if (state && uncached.length) {
        const asked = (state.metadataAsked ??= []);
        const ask = uncached.filter((t) => !asked.includes(t));
        if (ask.length) {
          asked.push(...ask);
          bestEffort(() => saveState(ctx.data, session, state));
          return deny(
            `Field metadata for ${ask.map((t) => `'${t}'`).join(", ")} isn't cached yet. First call ns_getSuiteQLMetadata with recordType ${ask.map((t) => `"${t}"`).join(", then ")} (one call at a time; each result is cached automatically), check column names with nsx fields <table> --grep <term>, then run this query again.`,
            "fields_not_cached",
          );
        }
      }
    }
    // Live: pageSize without pageIndex returns ALL pages in one response; only with pageIndex is it
    // one page (+ hasNextPage/totalResults). So both are added, and user-given values are kept.
    if (!probe) {
      // A query that caps itself with FETCH FIRST N (N ≤ 1000) gets one page of N rows, not a
      // default page that shows only part of them.
      const fetchN = topFetchRows(sql);
      const dflt = fetchN !== undefined && fetchN <= 1000 ? Math.max(fetchN, 5) : ctx.cfg.suiteql_default_page_size;
      const size = blank(ti.pageSize) ? dflt : ti.pageSize;
      // Live: pageSize 3 returned 5 rows, and numberOfPages was computed with 5.
      const clamped = Number.isFinite(Number(size)) && Number(size) < 5 ? 5 : size;
      if (clamped !== size) d.context.push(`[su-ns-harness] pageSize raised to 5: the connector's minimum page size is 5 (smaller values return 5 rows anyway).`);
      if (clamped !== ti.pageSize || blank(ti.pageIndex)) d.updatedInput = { ...ti, pageSize: clamped, pageIndex: blank(ti.pageIndex) ? 0 : ti.pageIndex };
    }
  }

  // ---- saved searches ----
  if (tool === "ns_runSavedSearch") {
    const upd: Record<string, unknown> = { ...ti };
    let changed = false;
    if (ti.range_end === undefined || ti.range_end === null || ti.range_end === "") {
      const n = ctx.cfg.saved_search_default_rows;
      const start = Number(ti.range_start ?? 0);
      const from = Number.isFinite(start) && start >= 0 ? start : 0;
      Object.assign(upd, { range_start: from, range_end: from + n });
      changed = true;
      d.context.push(`[su-ns-harness] Saved search limited to ${n} rows (range_end added). If the user needs more, pass range_start/range_end explicitly.`);
    }
    // A standalone search type fails without `type` ("Unable to determine record type"); only
    // live-verified types are added.
    if ((ti.type === undefined || ti.type === null || ti.type === "") && ctx.acctDir) {
      const rt = bestEffort(() => cachedSearchRecordType(ctx.acctDir!, ti.searchId));
      const std = rt ? STANDALONE_SEARCH_TYPES[rt.toLowerCase()] : undefined;
      if (std) {
        upd.type = std;
        changed = true;
        d.context.push(`[su-ns-harness] type: "${std}" added: the searches cache says this is a '${rt}' search, which the connector can't run without it.`);
      }
    }
    if (changed) d.updatedInput = upd;
  }

  // ---- reports ----
  if (tool === "ns_runReport" && ti.range !== undefined && ti.range !== null && ti.range !== "") {
    const upd: Record<string, unknown> = { ...(d.updatedInput ?? ti) };
    const supported = ctx.acctDir ? bestEffort(() => reportSupportsRange(ctx.acctDir!, ti.reportId)) : undefined;
    if (supported === false) {
      // Mirrors `type` on saved searches: a parameter the cache says this report lacks is removed.
      delete upd.range;
      d.updatedInput = upd;
      d.context.push(`[su-ns-harness] report ${String(ti.reportId)} doesn't support range (column grouping); removed.`);
    } else if (typeof ti.range === "string") {
      const v = ti.range.trim();
      // Live: "month"/"quarter" give one column per period + total; "MONTH", "Month", "QUARTER" are
      // accepted and silently ignored. Other values pass through (the Post note covers them).
      if (RANGE_VALUES.test(v) && v.toLowerCase() !== ti.range) {
        upd.range = v.toLowerCase();
        d.updatedInput = upd;
        d.context.push(`[su-ns-harness] range ${JSON.stringify(ti.range)} → ${JSON.stringify(upd.range)} (the connector only accepts lowercase).`);
      }
    }
  }

  // ---- full records ----
  if (tool === "ns_getRecord") {
    const f = ti.fields;
    const type = String(ti.recordType ?? "").toLowerCase();
    const norm = normaliseFields(f);
    if (f === "*" || f === "[full]") {
      const { fields: _drop, ...rest } = ti;
      d.updatedInput = rest;
    } else if (norm !== undefined && norm !== "" && norm !== f) {
      // Live: "tranid, trandate, total" returned only tranId, with no error.
      d.updatedInput = { ...ti, fields: norm };
    } else if ((f === undefined || f === null || f === "") && LARGE_RECORD.has(type)) {
      return deny(
        `A full ${type} record (all fields + sublists) is very large. Pass fields as a comma-separated list (see: nsx fields ${type} --record), or set fields to "[full]" if you really need everything.`,
        "getRecord_no_fields",
      );
    }
  }

  return out(d);
}
