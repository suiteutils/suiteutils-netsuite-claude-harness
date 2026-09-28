import { type Extracted, identicalReportColumns, type Row } from "../rows.ts";
import { csvCell, fmtNum, truncate } from "../util.ts";
import { fmtValue } from "./engine.ts";
import { type ColProfile, currencyCheck, headerRepeatNote, headerRepeats, idLikeName, isHintMetric, profileColumns, toNumber } from "./profile.ts";
import type { ResultMeta } from "./store.ts";

/** Tools whose responses are list envelopes; only their paging fields are result counts. */
const LIST_TOOLS = new Set(["ns_runCustomSuiteQL", "ns_runSavedSearch"]);

/** Outer-most row cap in a SuiteQL string: `ROWNUM <= N` or `FETCH FIRST N ROWS`. */
export function sqlRowCap(sql: string): number | undefined {
  let cap: number | undefined;
  for (const m of sql.matchAll(/rownum\s*(<=|<|=)\s*(\d+)/gi)) {
    const n = m[1] === "<" ? Number(m[2]) - 1 : Number(m[2]);
    cap = cap === undefined ? n : Math.min(cap, n);
  }
  const f = /fetch\s+(?:first|next)\s+(\d+)\s+rows?/i.exec(sql);
  if (f) cap = cap === undefined ? Number(f[1]) : Math.min(cap, Number(f[1]));
  return cap;
}

/** Mask string literals and comments so keywords inside them don't count. */
function maskSql(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, (m) => "'" + " ".repeat(Math.max(0, m.length - 2)) + "'")
    .replace(/--[^\n]*/g, (m) => " ".repeat(m.length))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
}

/** Paren depth at each index of `s`. */
function depths(s: string): number[] {
  const out: number[] = [];
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ")") d--;
    out.push(d);
    if (s[i] === "(") d++;
  }
  return out;
}

const NOT_ALIAS = /^(where|join|left|right|inner|outer|full|cross|order|group|having|on|fetch|offset|union|minus|intersect|start|connect)$/i;

/**
 * The sort key to cite in a paging hint: the outer query's own ORDER BY, else the first FROM
 * alias's `id` (`c.id`), else plain `id`.
 */
export function pagingKeyHint(sql: string): string {
  const m = maskSql(sql);
  const d = depths(m);
  let order: string | undefined;
  for (const hit of m.matchAll(/\border\s+by\s+/gi)) {
    if (d[hit.index!] !== 0) continue;
    const start = hit.index! + hit[0].length;
    let end = start;
    while (end < m.length && d[end] >= 0 && !(d[end] === 0 && /^(fetch|offset)\b|^;/i.test(m.slice(end)))) end++;
    order = sql.slice(start, end).replace(/\s+/g, " ").trim();
  }
  let alias: string | undefined;
  for (const hit of m.matchAll(/\bfrom\s+/gi)) {
    if (d[hit.index!] !== 0) continue;
    let rest = hit.index! + hit[0].length;
    // `FROM (SELECT …) x`: skip the subquery to its alias.
    if (m[rest] === "(") {
      while (rest < m.length && !(m[rest] === ")" && d[rest] === 0)) rest++;
      rest++;
    } else rest += /^[a-z_][\w.]*/i.exec(m.slice(rest))?.[0].length ?? 0;
    const a = /^\s+(?:as\s+)?([a-z_]\w*)/i.exec(m.slice(rest));
    if (a && !NOT_ALIAS.test(a[1])) alias = a[1];
    break;
  }
  const key = alias ? `${alias}.id` : "id";
  if (order) {
    const shown = order.length > 60 ? `${order.slice(0, 57)}…` : order;
    return /\bid\b/i.test(order) ? `keep the same unique ORDER BY (${shown})` : `keep a unique ORDER BY, e.g. ${shown}, ${key}`;
  }
  return `add a unique ORDER BY, e.g. ${key}`;
}

export function detectTruncation(tool: string, input: Record<string, unknown>, rowCount: number, ex: Extracted | undefined): string | undefined {
  // ns_getRecord / ns_runReport carry business fields like `total`; never read them as counts.
  if (LIST_TOOLS.has(tool) && ex) {
    const total = ex.totalResults;
    if (ex.hasMore || (total !== undefined && total > rowCount)) {
      const of = total !== undefined ? ` (${fmtNum(rowCount)} of ${fmtNum(total)} rows)` : "";
      if (tool === "ns_runSavedSearch") {
        const end = Number(input.range_end);
        return `the connector reports more rows${of}: this is one slice, not the full result. Next slice: same call with range_start: ${Number.isFinite(end) ? end : rowCount}`;
      }
      const idx = ex.pageIndex ?? (Number.isFinite(Number(input.pageIndex)) ? Number(input.pageIndex) : 0);
      // section_157960586441: paging "must provide a unique and unambiguous sorting order"
      const pages = ex.numberOfPages !== undefined ? ` of ${fmtNum(ex.numberOfPages)}` : "";
      return `this is page ${idx + 1}${pages}${of}, not the full result. More pages: re-run with pageIndex: ${idx + 1} (same sqlQuery and pageSize; ${pagingKeyHint(String(input.sqlQuery ?? ""))}), or aggregate in SuiteQL instead; to combine pages you've fetched, run nsx results concat <id> <id> … (it checks for missing pages) before agg`;
    }
  }
  if (!rowCount) return undefined;
  if (tool === "ns_runCustomSuiteQL") {
    const cap = sqlRowCap(String(input.sqlQuery ?? ""));
    if (cap !== undefined && rowCount === cap) return `result hit the ROWNUM/FETCH cap (${cap})`;
  }
  if (tool === "ns_runSavedSearch") {
    const start = Number(input.range_start ?? 0);
    const end = Number(input.range_end);
    if (Number.isFinite(end) && rowCount >= end - start) return `result hit range_end (${end}) — likely more rows`;
  }
  return undefined;
}

function describeCol(p: ColProfile): string {
  if (p.type === "num") {
    // No sum and no reason: an integer column that isn't an amount or a count (min/max only).
    const parts = p.sumNa ? [`sum n/a: ${p.sumNa}`] : p.sum !== undefined ? [`sum ${fmtValue(p.sum, p.name)}`] : [];
    if (p.min !== undefined) parts.push(`min ${fmtValue(p.min as number, p.name)}`, `max ${fmtValue(p.max as number, p.name)}`);
    if (p.nulls) parts.push(`nulls ${p.nulls}`);
    return `${p.name}(num, ${parts.join(", ")})`;
  }
  if (p.type === "date") return `${p.name}(date ${p.min}..${p.max}${p.nulls ? `, nulls ${p.nulls}` : ""})`;
  return `${p.name}(${p.type}, ${fmtNum(p.distinct)} distinct${p.nulls ? `, nulls ${p.nulls}` : ""})`;
}

function wrap(items: string[], width: number, indent: string): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const it of items) {
    if (cur && cur.length + 1 + it.length > width) {
      lines.push(cur);
      cur = indent + it;
    } else cur = cur ? `${cur} ${it}` : it;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Shell-safe column argument for a hint (saved-search labels have spaces and parens). */
const arg = (s: string) => (/^[\w.$#,-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

interface HintCtx {
  /** The currency column, when amounts span currencies. */
  currency?: string;
  /** Transaction-currency amounts with no currency column. */
  unknownAmounts: string[];
  /** Base-currency amounts across subsidiaries, and the subsidiary column. */
  baseAmounts: string[];
  subsidiary?: string;
}

function nextHint(meta: ResultMeta, profiles: ColProfile[], h: HintCtx): string {
  // A header amount repeated on line rows (sum n/a: repeats per …) is no measure to sum.
  const measure = profiles.find((p) => p.type === "num" && isHintMetric(p.name) && !idLikeName(p.name) && !p.sumNa?.startsWith("repeats per"));
  // A group-by that actually groups: near-unique columns (document numbers, memos) don't.
  const dim = profiles.find((p) => p.type === "str" && p.name !== h.currency && p.distinct > 1 && p.distinct <= meta.rowCount / 2);
  // Currency unknown: a sum of this measure prints n/a for most groups, so count instead.
  if (measure && h.unknownAmounts.includes(measure.name)) {
    const redo = `to sum ${arg(measure.name)}, re-run with BUILTIN.DF(t.currency) AS currency`;
    return dim ? `nsx results agg ${meta.id} --by ${arg(dim.name)} --count --top 20   (${redo})` : `nsx results schema ${meta.id}   (${redo})`;
  }
  // Base amounts add up per subsidiary only.
  if (measure && h.subsidiary && h.baseAmounts.includes(measure.name)) {
    const by = [h.subsidiary, h.currency].filter((c, i, a) => c && a.indexOf(c) === i).join(",");
    return `nsx results agg ${meta.id} --by ${arg(by)} --sum ${arg(measure.name)} --top 20`;
  }
  if (measure && (dim || h.currency)) {
    const by = [dim?.name, h.currency].filter(Boolean).join(",");
    return `nsx results agg ${meta.id} --by ${arg(by)} --sum ${arg(measure.name)} --top 20`;
  }
  return `nsx results head ${meta.id} 20   ·   nsx results schema ${meta.id}`;
}

export interface SummaryInput {
  meta: ResultMeta;
  rows: Row[];
  columns: string[];
  budget?: number;
  /**
   * Reports only: the currency the report is in, e.g. `{ code: "USD", label: "Example Inc.'s
   * base currency" }` → "Amounts are in USD (Example Inc.'s base currency)." (see
   * reportCurrencyInfo). Without it the summary names no currency.
   */
  reportCurrency?: { code: string; label: string };
}

/**
 * The compact text Claude sees in place of a large result. Stays under `budget` chars: samples,
 * column stats and the query shrink first, then the column list is cut (whole columns, with a
 * pointer to `nsx results schema`). The header, currency/double-count warnings, truncation warning
 * and Next hint are always kept.
 */
export function buildSummary({ meta, rows, columns, budget = 1400, reportCurrency }: SummaryInput): string {
  if (meta.tool === "ns_runReport" && columns.includes("depth") && columns.includes("line")) return reportSummary({ meta, rows, columns, budget, reportCurrency });
  const profiles = profileColumns(columns, rows);
  const cur = currencyCheck(columns, rows);
  const repeats = headerRepeats(columns, rows);
  const rel = `results/${meta.session}/${meta.files.csv.split("/").pop()}`;
  const took = meta.tookMs !== undefined ? `   Took: ${(meta.tookMs / 1000).toFixed(1)}s` : "";
  const foreignUnknown = cur.unknownColumns.filter((c) => !cur.baseAcrossSubs.includes(c));

  const warnLines: string[] = [];
  // Only amounts care: a customer list with a currency column is not a warning.
  if (cur.status === "mixed" && cur.column) {
    warnLines.push(`Mixed currencies in ${cur.column} (${truncate(cur.values.join(", "), 60)}): amounts don't add across rows and min/max compare different currencies; group by ${cur.column}.`);
  }
  if (cur.baseAcrossSubs.length) {
    const cols = truncate(cur.baseAcrossSubs.join(", "), 60);
    warnLines.push(`Several subsidiaries: ${cols} ${cur.baseAcrossSubs.length > 1 ? "are" : "is"} in each subsidiary's base currency across ${cur.subsidiaries} subsidiaries (${cur.subsidiary}), so a total mixes currencies; group by ${cur.subsidiary}.`);
  }
  if (foreignUnknown.length) {
    warnLines.push(`Currency unknown: no currency column beside ${truncate(foreignUnknown.join(", "), 60)}, so a total may mix currencies. Add one (BUILTIN.DF(t.currency) AS currency) and group by it.`);
  }
  for (const p of profiles) if (p.sumNa?.startsWith("repeats per") && repeats.has(p.name)) warnLines.push(`Double count: ${headerRepeatNote(p.name, repeats.get(p.name)!)}`);
  const tailLines: string[] = [];
  if (meta.truncated) tailLines.push(`Truncation warning: ${meta.truncated} — totals may be incomplete.`);
  tailLines.push(
    `Next: ${nextHint(meta, profiles, {
      currency: cur.status === "mixed" ? cur.column : undefined,
      unknownAmounts: foreignUnknown,
      baseAmounts: cur.baseAcrossSubs,
      subsidiary: cur.subsidiary,
    })}`,
  );

  const attempt = (sampleRows: number, cell: number, detailed: boolean, queryMax: number, maxCols = columns.length): string => {
    const lines: string[] = [];
    lines.push(`[su-ns-harness] ${fmtNum(meta.rowCount)} rows × ${columns.length} cols saved → ${rel} (id ${meta.id})`);
    lines.push(`Query: ${truncate(meta.query, queryMax)}   Source: ${meta.tool}${took}`);
    const cols = (detailed ? profiles.map(describeCol) : profiles.map((p) => `${p.name}(${p.type})`)).slice(0, maxCols);
    if (maxCols < columns.length) cols.push(`… ${columns.length - maxCols} more cols (nsx results schema ${meta.id})`);
    lines.push(...wrap(cols, 110, "         ").map((l, i) => (i === 0 ? `Columns: ${l}` : l)));
    lines.push(...warnLines);
    if (sampleRows > 0 && rows.length) {
      lines.push(`First ${Math.min(sampleRows, rows.length)} rows:`);
      lines.push(columns.map((c) => csvCell(truncate(c, cell))).join(","));
      for (const r of rows.slice(0, sampleRows)) {
        lines.push(columns.map((c) => csvCell(r[c] === null || r[c] === undefined ? "" : truncate(String(r[c]), cell))).join(","));
      }
    }
    lines.push(...tailLines);
    return lines.join("\n");
  };

  const plans: [number, number, boolean, number][] = [
    [5, 24, true, 240],
    [3, 18, true, 160],
    [2, 14, true, 120],
    [2, 12, false, 100],
    [0, 12, false, 80],
  ];
  let text = "";
  for (const p of plans) {
    text = attempt(...p);
    if (text.length <= budget) return text;
  }
  // Very wide results: list the first columns only (whole names), never dropping a warning.
  for (let n = columns.length - 1; n >= 0; n--) {
    text = attempt(0, 12, false, n ? 80 : 60, n);
    if (text.length <= budget) return text;
  }
  return text;
}

/**
 * Reports: the section lines (Sales, Gross Profit, …, Net Profit/(Loss)) are the answer, so show
 * those rather than column stats. The untitled "Financial Row" (kind `structural`, depth -1) is
 * NetSuite's container row, not a total, and summing a value column across rows double-counts every
 * subtotal. Report amounts carry no currency code: they are in the report's currency.
 */
function reportSummary({ meta, rows, columns, budget = 1400, reportCurrency }: SummaryInput): string {
  const rel = `results/${meta.session}/${meta.files.csv.split("/").pop()}`;
  const took = meta.tookMs !== undefined ? `   Took: ${(meta.tookMs / 1000).toFixed(1)}s` : "";
  const valueCols = columns.filter((c) => !["line", "depth", "is_detail", "kind"].includes(c));
  const hasKind = columns.includes("kind");
  const sections = rows.filter((r) => (hasKind ? r.kind === "section" : r.depth === 0 && r.is_detail !== true && r.line !== null));
  const val = (v: unknown) => (typeof v === "number" ? fmtValue(v) : v === null || v === undefined || v === "" ? "–" : String(v));
  const levels = rows.map((r) => Number(r.depth)).filter((n) => Number.isFinite(n) && n >= 0);
  const maxDepth = levels.length ? Math.max(...levels) : 0;
  const structural = rows.some((r) => r.kind === "structural");
  const spacer = rows.some((r) => r.kind === "spacer");
  const v0 = valueCols[0];
  const hint = `nsx results filter ${meta.id} --where "depth>=0 and depth<=1 and is_detail=false${spacer ? " and kind!=spacer" : ""}"${v0 ? ` --cols ${arg(["line", "depth", ...(valueCols.length <= 8 ? valueCols : [...valueCols.slice(0, 3), valueCols[valueCols.length - 1]])].join(","))}` : ""}`;
  // Income statements: account lines carry their P&L sign; expense sections flip it.
  const pnl = sections.some((r) => /profit|loss|income|expense|sales|revenue|purchases|overheads/i.test(String(r.line)));
  const signNote = pnl ? sectionSignNote(rows, v0) : "";
  let input: Record<string, unknown> = {};
  try {
    const q = JSON.parse(meta.query) as unknown;
    if (q && typeof q === "object" && !Array.isArray(q)) input = q as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  // `range` (column grouping) was accepted by the connector but changed nothing.
  const range = input.range !== undefined && input.range !== null && input.range !== "" && valueCols.length <= 1 ? String(input.range) : undefined;
  const query = reportQuery(meta.query, input);
  const aging = /aging/i.test(meta.report?.title ?? "");
  const notes: string[] = [];
  // Columns NetSuite sent as different columns that came out the same on every row.
  const same = meta.report?.columns ? identicalReportColumns(rows, meta.report.columns.filter((c) => valueCols.includes(c.name))) : [];
  if (same.length) {
    const pairs = same.slice(0, 3).map(([a, b]) => `${a} = ${b}`).join(", ");
    notes.push(`Warning: columns ${pairs}${same.length > 3 ? ", …" : ""} hold the same value on every row though NetSuite sent them as different columns; check the raw response (nsx results raw ${meta.id} --head 40) before using them.`);
  }
  for (const n of meta.report?.notes ?? []) notes.push(n);
  // `- No Vendor -` / `- No Customer -`: NetSuite's bucket for lines without that entity.
  for (const r of sections) {
    const m = /^-\s*No\s+(.+?)\s*-$/i.exec(String(r.line ?? "").trim());
    if (m) notes.push(`"${String(r.line).trim()}" holds ${aging ? "open items" : "lines"} with no ${m[1].toLowerCase()}; it is not a ${m[1].toLowerCase()}.`);
  }

  const attempt = (maxSections: number, queryMax: number, inline: boolean): string => {
    const lines: string[] = [];
    lines.push(`[su-ns-harness] Report: ${fmtNum(meta.rowCount)} lines (depth 0-${maxDepth}) × ${valueCols.length} value cols saved → ${rel} (id ${meta.id})`);
    lines.push(`Query: ${truncate(query, queryMax)}   Source: ${meta.tool}${took}`);
    // Cut sections from the middle: the last one is the bottom line (Net Profit/(Loss), a total).
    const shown = maxSections >= sections.length ? sections : maxSections > 1 ? [...sections.slice(0, maxSections - 1), sections[sections.length - 1]] : sections.slice(0, maxSections);
    const cut = sections.length - shown.length;
    const more = `  … ${cut} more section${cut === 1 ? "" : "s"}`;
    if (valueCols.length <= 1) {
      const items = shown.map((r, i) => `${String(r.line)} ${val(v0 ? r[v0] : undefined)}${i < shown.length - 1 ? " ·" : ""}`);
      lines.push(...wrap(items, 110, "  ").map((l, i) => (i === 0 ? `Sections${v0 ? ` (${v0})` : ""}: ${l}` : l)));
    } else if (inline) {
      lines.push("Sections:");
      shown.forEach((r, i) => {
        if (cut && maxSections > 1 && i === shown.length - 1) lines.push(more);
        lines.push(`  ${truncate(String(r.line), 40)}: ${valueCols.map((c) => `${c} ${val(r[c])}`).join(" | ")}`);
      });
    } else {
      lines.push(`Sections (${truncate(valueCols.join(" | "), 120)}):`);
      shown.forEach((r, i) => {
        if (cut && maxSections > 1 && i === shown.length - 1) lines.push(more);
        lines.push(`  ${truncate(String(r.line), 40)}: ${valueCols.map((c) => val(r[c])).join(" | ")}`);
      });
    }
    if (cut && (valueCols.length <= 1 || maxSections <= 1)) lines.push(more);
    if (!sections.length) lines.push("No section lines found.");
    lines.push(`Rows nest by depth (sections > groups > accounts > detail lines); don't sum a value column across rows, it double-counts subtotals.${structural ? " The kind=structural row (depth -1) is NetSuite's container row, not a grand total." : ""}`);
    lines.push(reportCurrency ? `Amounts are in ${reportCurrency.code} (${reportCurrency.label}).` : "Amounts are in the report currency (the parent subsidiary's for consolidated reports).");
    if (signNote) lines.push(signNote);
    lines.push(...notes);
    if (range) lines.push(`range "${truncate(range, 30)}" had no effect. Accepted values (lowercase): month, quarter.`);
    if (meta.truncated) lines.push(`Truncation warning: ${meta.truncated} — totals may be incomplete.`);
    lines.push(`Next: ${hint}`);
    return lines.join("\n");
  };
  let text = "";
  // Fewer sections before anything else goes: the nesting, currency and truncation lines stay.
  // Report queries are short and every parameter matters (range, subsidiaryId, book): shown whole.
  // The most sections that fit; at equal count, each value labelled with its column name.
  for (const q of [300, 160, 100, 60]) {
    for (let n = Math.min(sections.length, 40); n >= 0; n--) {
      for (const inline of valueCols.length > 1 ? [true, false] : [false]) {
        text = attempt(n, q, inline);
        if (text.length <= budget) return text;
      }
    }
  }
  return text;
}

/** Report parameters that pick what the report shows, shown first in the Query line. */
const REPORT_KEYS = ["reportId", "range", "subsidiaryId", "book", "book2", "accountingContext", "nexusId", "taxCashBasisMode", "periodEndTransactionReportMode", "dateFrom", "dateTo"];

/** A report's query with its deciding parameters first, so a cut never hides them. */
function reportQuery(query: string, input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (!keys.length) return query;
  const ordered = [...REPORT_KEYS.filter((k) => k in input), ...keys.filter((k) => !REPORT_KEYS.includes(k))];
  return JSON.stringify(Object.fromEntries(ordered.map((k) => [k, input[k]])));
}

/**
 * How group totals relate to their lines, checked for every non-detail row with a value against
 * the sum of its direct children (the rows at depth + 1 until the next row at its own depth or
 * shallower; detail and spacer rows left out): a row whose value is minus that sum (Overheads,
 * Purchases, or a nested `Expense` group in a US layout) shows the opposite sign (positive = net
 * expense, negative = net credit). A parent that is minus its children only because a child group
 * is itself flipped follows its accounts' sign and isn't named. Rows without children (Gross
 * Profit, account lines) prove nothing.
 */
export function sectionSignNote(rows: Row[], col: string | undefined): string {
  const base = "Account lines carry their P&L sign (income +, expense −)";
  if (!col) return `${base}.`;
  const flipped: string[] = [];
  let matched = 0;
  let neither = 0;
  const skip = (r: Row) => r.kind === "spacer" || r.kind === "detail" || r.is_detail === true;
  const depthOf = (r: Row) => Number(r.depth);
  // Each row's value in the sign of its account lines: minus the shown value for a flipped row.
  // Children come after their parent, so walk bottom-up.
  const lineSign = new Map<number, number>();
  const found: string[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (skip(r) || r.kind === "structural") continue;
    const d = depthOf(r);
    const value = toNumber(r[col]);
    if (!Number.isFinite(d) || d < 0 || value === undefined) continue;
    lineSign.set(i, value);
    let sum = 0;
    let signed = 0;
    let n = 0;
    for (let j = i + 1; j < rows.length && !(depthOf(rows[j]) <= d); j++) {
      const c = rows[j];
      if (depthOf(c) !== d + 1 || skip(c)) continue;
      const v = toNumber(c[col]);
      if (v === undefined) continue;
      sum += v;
      signed += lineSign.get(j) ?? v;
      n++;
    }
    if (!n || Math.abs(sum) < 0.005) continue;
    const tol = Math.max(0.01, Math.abs(sum) * 1e-6);
    // Minus its children, unless that's only because a child group is itself flipped.
    if (Math.abs(value + sum) <= tol && Math.abs(value - signed) > tol) {
      found.push(String(r.line));
      lineSign.set(i, -value);
    } else if (Math.abs(value - sum) <= tol || Math.abs(value - signed) <= tol) matched++;
    else neither++;
  }
  flipped.push(...found.reverse());
  const names = [...new Set(flipped)];
  if (names.length) {
    const shown = names.length > 5 ? `${names.slice(0, 5).join(", ")}, …` : names.join(", ");
    return `${base}; these sections show the opposite sign of their account lines (positive = net expense, negative = net credit): ${shown}.`;
  }
  if (matched && !neither) return `${base}; section totals match the sign of their lines.`;
  return `${base}; expense sections are shown with the opposite sign of their account lines (positive = net expense, negative = net credit).`;
}

/** One-line provenance footer for small results passed through inline. */
export function sourceFooter(tool: string, input: Record<string, unknown>, rowCount?: number, truncated?: string): string {
  const what =
    tool === "ns_runCustomSuiteQL"
      ? `SuiteQL "${truncate(String(input.sqlQuery ?? ""), 80)}"`
      : tool === "ns_runReport"
        ? `report ${input.reportId ?? "?"}${input.dateFrom ? ` ${input.dateFrom}..${input.dateTo ?? ""}` : ""}${input.subsidiaryId ? ` sub ${input.subsidiaryId}` : ""}`
        : tool === "ns_runSavedSearch"
          ? `saved search ${input.searchId ?? "?"}`
          : tool === "ns_getRecord"
            ? `${input.recordType ?? "record"} ${input.recordId ?? ""}`
            : tool;
  const time = new Date().toTimeString().slice(0, 5);
  const parts = [`[su-ns-harness] Source: ${what} · pulled ${time}`];
  if (rowCount !== undefined) parts.push(`${rowCount} rows`);
  if (truncated) parts.push(`⚠ ${truncated}`);
  return parts.join(" · ");
}
