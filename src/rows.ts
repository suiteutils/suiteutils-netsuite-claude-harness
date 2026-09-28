/**
 * Turn arbitrary connector JSON into flat rows. Written defensively: the real response
 * shapes are pinned down by the sanitized live fixtures in test/fixtures, and anything we do not
 * recognise falls back to "largest array of objects anywhere in the payload".
 */

import { parseDate } from "./cache/profile.ts";

export type Row = Record<string, unknown>;

export interface Extracted {
  rows: Row[];
  columns: string[];
  /** JSON path where the rows were found, for debugging parsers. */
  path: string;
  /** Paging envelope of a list response (SuiteQL: resultCount/totalResults/pageSize/pageIndex/…). */
  hasMore?: boolean;
  totalResults?: number;
  pageIndex?: number;
  pageSize?: number;
  numberOfPages?: number;
  /** Set when the rows were flattened from an ns_runReport `reportData` tree. */
  report?: ReportInfo;
}

/** One ns_runReport value column: the name the harness gave it and what NetSuite sent. */
export interface ReportColumn {
  name: string;
  id?: string;
  path?: string;
  label?: string;
}

export interface ReportInfo {
  title?: string;
  valueColumns: string[];
  /** Per value column, the raw `reportColumns` entry it came from (kept in the result meta). */
  columns?: ReportColumn[];
  /** How the column names were derived when NetSuite didn't send readable ones. */
  notes?: string[];
}

const CONTAINER_KEYS = ["items", "rows", "data", "results", "records", "searchResults", "lines", "value", "result"];
const CHILD_KEYS = ["children", "rows", "lines", "sections", "subRows", "items"];
const LABEL_KEYS = ["label", "name", "title", "account", "description", "text"];

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

function flattenRow(obj: Record<string, unknown>, prefix = "", out: Row = {}): Row {
  for (const [k, v] of Object.entries(obj)) {
    if (k === "links") continue; // REST-style hypermedia noise
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObj(v) && prefix.split(".").length < 3) flattenRow(v, key, out);
    else if (Array.isArray(v)) out[key] = v.length ? JSON.stringify(v) : "";
    else out[key] = v;
  }
  return out;
}

function columnsOf(rows: Row[]): string[] {
  const seen = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
}

function childArray(o: Record<string, unknown>): unknown[] | undefined {
  for (const k of CHILD_KEYS) if (Array.isArray(o[k]) && (o[k] as unknown[]).some(isObj)) return o[k] as unknown[];
  return undefined;
}

function labelOf(o: Record<string, unknown>): string | undefined {
  for (const k of LABEL_KEYS) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  return undefined;
}

/** Report-style trees: every node becomes a row with a `section` path of its ancestors. */
function flattenTree(nodes: unknown[], trail: string[], out: Row[]): void {
  for (const n of nodes) {
    if (!isObj(n)) continue;
    const kids = childArray(n);
    const scalars: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(n)) if (!CHILD_KEYS.includes(k) || !Array.isArray(v)) scalars[k] = v;
    const row = flattenRow(scalars);
    if (Object.keys(row).length) out.push({ section: trail.join(" > "), ...row });
    if (kids) {
      const label = labelOf(n);
      flattenTree(kids, label ? [...trail, label] : trail, out);
    }
  }
}

function fromMatrix(columns: unknown[], data: unknown[]): Row[] {
  const names = columns.map((c, i) =>
    isObj(c) ? String(c.name ?? c.label ?? c.id ?? `c${i}`) : String(c ?? `c${i}`),
  );
  return data.map((r) => {
    const row: Row = {};
    (r as unknown[]).forEach((v, i) => (row[names[i] ?? `c${i}`] = v));
    return row;
  });
}

function fromArray(arr: unknown[], path: string): Extracted | undefined {
  if (!arr.length) return { rows: [], columns: [], path };
  if (arr.every(Array.isArray)) {
    const rows = fromMatrix((arr[0] as unknown[]).map((_, i) => `c${i}`), arr);
    return { rows, columns: columnsOf(rows), path };
  }
  if (!arr.some(isObj)) {
    const rows = arr.map((v) => ({ value: v }));
    return { rows, columns: ["value"], path };
  }
  const objs = arr.filter(isObj);
  const rows: Row[] = [];
  if (objs.some((o) => childArray(o))) flattenTree(objs, [], rows);
  else for (const o of objs) rows.push(flattenRow(o));
  return { rows, columns: columnsOf(rows), path };
}

function largestObjectArray(v: unknown, path: string, depth: number): { arr: unknown[]; path: string } | undefined {
  if (depth > 6) return undefined;
  let best: { arr: unknown[]; path: string } | undefined;
  if (Array.isArray(v)) {
    if (v.some(isObj)) best = { arr: v, path };
    // a single wrapper element can still hide the real array
    if (v.length <= 3) {
      v.forEach((el, i) => {
        const c = largestObjectArray(el, `${path}[${i}]`, depth + 1);
        if (c && (!best || c.arr.length > best.arr.length)) best = c;
      });
    }
  } else if (isObj(v)) {
    for (const [k, val] of Object.entries(v)) {
      const c = largestObjectArray(val, `${path}.${k}`, depth + 1);
      if (c && (!best || c.arr.length > best.arr.length)) best = c;
    }
  }
  return best;
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

type Paging = Pick<Extracted, "hasMore" | "totalResults" | "pageIndex" | "pageSize" | "numberOfPages">;

/**
 * List-envelope paging fields. Deliberately not `total`/`count`: on a single record those are
 * business fields (an invoice's `total`), not result counts.
 */
function pagingMeta(o: Record<string, unknown>): Paging {
  const bool = (...ks: string[]) => ks.map((k) => o[k]).find((v): v is boolean => typeof v === "boolean");
  return pickDefined({
    hasMore: bool("hasNextPage", "hasMore", "hasMoreResults"),
    totalResults: num(o.totalResults) ?? num(o.totalRecords) ?? num(o.totalCount),
    pageIndex: num(o.pageIndex),
    pageSize: num(o.pageSize),
    numberOfPages: num(o.numberOfPages) ?? num(o.totalPages),
  });
}

const STRUCTURAL = ["line", "depth", "is_detail", "kind"];
/** NetSuite's default A/P and A/R aging buckets, in the order the five bucket columns come. */
const AGING_BUCKETS = ["Current", "1-30", "31-60", "61-90", "Over 90"];
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/**
 * The name for one column of a group whose labels repeat, from its id's prefix (`<prefix> > <label>`):
 * `2026-01` (range month), `2026-Q1` (range quarter, id `2026-1 > …`), `Total` (`empty > …`), else
 * `<prefix> <label>`. Undefined when the id has no prefix.
 */
function periodName(id: string | undefined, label: string | undefined): string | undefined {
  const m = id ? /^(.+?) > (.+)$/.exec(id) : null;
  if (!m) return undefined;
  const prefix = m[1].trim();
  if (/^\d{4}-\d{2}$/.test(prefix)) return prefix;
  const q = /^(\d{4})-([1-4])$/.exec(prefix);
  if (q) return `${q[1]}-Q${q[2]}`;
  if (prefix === "empty") return "Total";
  return `${prefix} ${label ?? m[2]}`;
}

/**
 * Report column names. A label that is unique is the name (`Amount`). When labels repeat (range
 * month/quarter, aging), the id's prefix names the column: `2026-01 … Total`, `2026-Q1 … Total`,
 * with the label appended when a period carries more than one (`2026-01 Amount`, `2026-01 Budget`).
 * Columns that share a path are positional (aging: ids `Current > Open Balance`, `… (2)` … `(5)`):
 * on an aging report they get NetSuite's default bucket names (not sent, so inferred), elsewhere
 * `<label> 1` … `<label> n`. Names stay clear of the structural columns and unique.
 */
function reportColumnNames(cols: unknown[], title?: string): { cols: ReportColumn[]; notes: string[] } {
  const objs = cols.filter(isObj);
  const raw = objs.map((c) => ({ id: str(c.id), path: str(c.path), label: str(c.label) }));
  const count = (vals: (string | undefined)[]) => {
    const m = new Map<string, number>();
    for (const v of vals) if (v !== undefined) m.set(v, (m.get(v) ?? 0) + 1);
    return m;
  };
  const labels = count(raw.map((c) => c.label));
  const paths = count(raw.map((c) => c.path));
  const multiLabel = labels.size > 1;
  const notes: string[] = [];
  const aging = /aging/i.test(title ?? "");
  const names = raw.map((c, i) => {
    const label = c.label ?? c.id ?? c.path ?? `c${i}`;
    if (!c.label || (labels.get(c.label) ?? 0) < 2) return label;
    const shared = c.path !== undefined && (paths.get(c.path) ?? 0) > 1;
    if (shared) {
      const group = raw.map((x, j) => (x.path === c.path ? j : -1)).filter((j) => j >= 0);
      const k = group.indexOf(i);
      if (aging && group.length === AGING_BUCKETS.length) return multiLabel ? `${AGING_BUCKETS[k]} ${c.label}` : AGING_BUCKETS[k];
      return `${c.label} ${k + 1}`;
    }
    const p = periodName(c.id, c.label);
    if (!p) return `${label} ${i + 1}`;
    return multiLabel && (p === "Total" || /^\d{4}-(\d{2}|Q\d)$/.test(p)) ? `${p} ${c.label}` : p;
  });
  if (aging && raw.some((c) => c.path !== undefined && (paths.get(c.path) ?? 0) === AGING_BUCKETS.length && (labels.get(c.label ?? "") ?? 0) > 1)) {
    notes.push(`Bucket names (${AGING_BUCKETS.join(", ")}) are NetSuite's defaults, inferred from column order (not sent); raw column ids are in the result's meta.json.`);
  }
  const used = new Set(STRUCTURAL);
  const out = raw.map((c, i) => {
    let name = names[i];
    if (used.has(name)) name = `${name} (${c.id ?? i})`;
    for (let n = 2; used.has(name); n++) name = `${names[i]} (${n})`;
    used.add(name);
    return { name, ...pickDefined(c) } as ReportColumn;
  });
  return { cols: out, notes };
}

/**
 * The value for column `i` of a report row. `summaryLineValues`/`detailLineValues` are arrays of
 * single-key objects, one per column in `reportColumns` order. The id is tried first (unique per
 * column in every response seen), then a path or label only when no other column shares it (aging
 * bucket columns all share the first bucket's path), then the position.
 */
function columnValue(c: ReportColumn, i: number, vals: Record<string, unknown>, list: Record<string, unknown>[] | undefined, shared: Set<string>, n: number): unknown {
  if (c.id !== undefined && c.id in vals) return vals[c.id];
  for (const k of [c.path, c.label]) if (k !== undefined && !shared.has(k) && k in vals) return vals[k];
  if (list && list.length === n) {
    const cell = list[i];
    const ks = Object.keys(cell);
    if (ks.length === 1) return cell[ks[0]];
  }
  return null;
}

/**
 * ns_runReport: `{reportData: {"0": {label, alias, value, parent, isDetailLine,
 * summaryLineValues|detailLineValues: [{<col>: n}]}, …}, reportColumns: [{id, label, path}]}`.
 * `parent` is the *alias* of the parent level, not a key, so nesting comes from a stack: a row
 * hangs under the nearest open row whose alias is its parent, and a detail line (the account's
 * own value line) closes that row. Kinds: `structural` (the untitled "Financial Row" container,
 * no alias and no value; depth -1 so `depth>=0` filters leave it out: its amount is not a grand
 * total), `section` (top-level lines: Sales, Gross Profit, Net Profit/(Loss)…), `line`, `detail`,
 * and `spacer` (NetSuite's blank lines between sections: no label, no value).
 * Report rows nest: summing a value column across rows double-counts subtotals.
 */
function fromReport(json: Record<string, unknown>): Extracted {
  const data = json.reportData;
  const entries = Array.isArray(data)
    ? data
    : Object.entries(data as Record<string, unknown>)
        .sort(([a], [b]) => (Number(a) - Number(b)) || a.localeCompare(b))
        .map(([, v]) => v);
  const title = typeof json.title === "string" ? json.title : undefined;
  const { cols, notes } = reportColumnNames(Array.isArray(json.reportColumns) ? json.reportColumns : [], title);
  // Paths and labels that more than one column carries can't identify a column.
  const seen = new Map<string, number>();
  for (const c of cols) for (const k of new Set([c.path, c.label])) if (k !== undefined) seen.set(k, (seen.get(k) ?? 0) + 1);
  const shared = new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
  const rows: Row[] = [];
  const stack: { alias: string; depth: number; line: unknown }[] = [];
  for (const r of entries) {
    if (!isObj(r)) continue;
    const alias = typeof r.alias === "string" && r.alias ? r.alias : undefined;
    const parent = typeof r.parent === "string" && r.parent ? r.parent : undefined;
    const detail = r.isDetailLine === true;
    let depth = 0;
    let owner: (typeof stack)[number] | undefined;
    if (!parent) stack.length = 0;
    else {
      while (stack.length && stack[stack.length - 1].alias !== parent) stack.pop();
      owner = stack[stack.length - 1];
      depth = owner ? owner.depth + 1 : 1;
    }
    const value = r.value ?? r.label ?? null;
    const kind = detail ? "detail" : parent ? "line" : alias || r.value != null ? "section" : "structural";
    if (kind === "structural") depth = -1;
    const line = kind === "detail" ? (r.value ?? r.label ?? owner?.line ?? null) : value;
    const raw = r.summaryLineValues ?? r.detailLineValues;
    const list = Array.isArray(raw) && raw.every(isObj) ? (raw as Record<string, unknown>[]) : undefined;
    const vals: Record<string, unknown> = Object.assign({}, ...(Array.isArray(raw) ? raw.filter(isObj) : isObj(raw) ? [raw] : []));
    const row: Row = { line, depth, is_detail: detail, kind };
    cols.forEach((c, i) => (row[c.name] = columnValue(c, i, vals, list, shared, cols.length)));
    // Reports without reportColumns: keep whatever value keys the rows carry.
    if (!cols.length) for (const [k, v] of Object.entries(vals)) if (!(k in row)) row[k] = v;
    // Blank spacer lines (after Gross Profit, Operating Profit…): no label and no value.
    const blank = row.line === null || row.line === undefined || String(row.line).trim() === "";
    if (kind !== "structural" && blank && Object.keys(row).slice(4).every((k) => row[k] === null || row[k] === undefined || row[k] === "" || row[k] === 0)) row.kind = "spacer";
    rows.push(row);
    if (detail && owner) stack.pop();
    else if (!detail && alias) stack.push({ alias, depth, line });
  }
  const columns = columnsOf(rows);
  const valueColumns = columns.filter((c) => !STRUCTURAL.includes(c));
  const report: ReportInfo = { title, valueColumns };
  if (cols.length) report.columns = cols;
  if (notes.length) report.notes = notes;
  return { rows, columns, path: "$.reportData", report };
}

/**
 * The report column info of a raw ns_runReport payload (names, raw ids, naming notes) without
 * flattening its rows, for the result meta. Undefined for anything that isn't a report.
 */
export function reportInfoOf(json: unknown): ReportInfo | undefined {
  if (!isObj(json) || !(isObj(json.reportData) || Array.isArray(json.reportData)) || !Array.isArray(json.reportColumns)) return undefined;
  const title = typeof json.title === "string" ? json.title : undefined;
  const { cols, notes } = reportColumnNames(json.reportColumns, title);
  const info: ReportInfo = { title, valueColumns: cols.map((c) => c.name), columns: cols };
  if (notes.length) info.notes = notes;
  return info;
}

/**
 * Pairs of report value columns that NetSuite sent as different columns (different ids) but that
 * hold the same value on every row (at least one row non-empty): a sign the values were mapped to
 * the wrong column.
 */
export function identicalReportColumns(rows: Row[], cols: ReportColumn[]): [string, string][] {
  const out: [string, string][] = [];
  const empty = (v: unknown) => v === null || v === undefined || v === "";
  for (let a = 0; a < cols.length; a++) {
    for (let b = a + 1; b < cols.length; b++) {
      const [x, y] = [cols[a], cols[b]];
      if ((x.id ?? x.name) === (y.id ?? y.name)) continue;
      let filled = false;
      const same = rows.every((r) => {
        const [u, v] = [r[x.name], r[y.name]];
        if (!empty(u) || !empty(v)) filled = true;
        return (empty(u) && empty(v)) || u === v;
      });
      if (same && filled) out.push([x.name, y.name]);
    }
  }
  return out;
}

const LOOSE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
/** `2018-9-17 7:18 am`, `2018-9-17 19:18`, `2018-9-17 19:18:05`, `2018-09-17T19:18` (no zone). */
const LOOSE_DATETIME = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?m\.?)?$/i;

const realDate = (y: string, m: string, d: string): string | undefined => {
  const dt = parseDate(`${y}-${m}-${d}`);
  // Date.UTC rolls 2026-13-4 over into 2027; only rewrite real calendar dates.
  return dt && dt.getUTCMonth() + 1 === Number(m) && dt.getUTCDate() === Number(d) ? dt.toISOString().slice(0, 10) : undefined;
};

/** A padded, sortable form of a loose date or datetime, or undefined to leave the value alone. */
export function normaliseDateValue(v: string): string | undefined {
  const m = v.length < 10 ? LOOSE_ISO.exec(v) : null;
  if (m) return realDate(m[1], m[2], m[3]);
  const t = v.length <= 24 ? LOOSE_DATETIME.exec(v.trim()) : null;
  if (!t) return undefined;
  const day = realDate(t[1], t[2], t[3]);
  if (!day) return undefined;
  let h = Number(t[4]);
  const min = Number(t[5]);
  const sec = t[6] === undefined ? undefined : Number(t[6]);
  if (t[7]) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (t[7].toLowerCase() === "p" ? 12 : 0);
  } else if (h > 23) return undefined;
  if (min > 59 || (sec !== undefined && sec > 59)) return undefined;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day} ${pad(h)}:${pad(min)}${sec === undefined ? "" : `:${pad(sec)}`}`;
}

/**
 * Saved searches return `2026-3-2` and `2018-9-17 7:18 am`; pad to `2026-03-02` and
 * `2018-09-17 07:18` so dates and datetimes type, sort and range correctly.
 */
function normaliseDates(ex: Extracted): Extracted {
  normaliseSlashDates(ex);
  for (const r of ex.rows) {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v !== "string" || v.length < 8 || !/^\d{4}-/.test(v)) continue;
      const n = normaliseDateValue(v);
      if (n !== undefined && n !== v) r[k] = n;
    }
  }
  return ex;
}

const SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?))?$/i;

/**
 * Saved searches in accounts set to M/D/YYYY or D/M/YYYY send `12/31/2025` or `27/09/2026`. A
 * column is rewritten to ISO (`2025-12-31`, times padded to 24h) only when its order is certain:
 * some first part above 12 → D/M, some second part above 12 → M/D. A column where every part is
 * ≤ 12 is ambiguous and left as sent (read as M/D, NetSuite's default, by the results engine); a
 * column that fits neither order, or holds an impossible date, is left alone too.
 */
function normaliseSlashDates(ex: Extracted): void {
  for (const c of ex.columns) {
    const hits: { r: Row; m: RegExpExecArray }[] = [];
    let ok = true;
    for (const r of ex.rows) {
      const v = r[c];
      if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) continue;
      const m = typeof v === "string" ? SLASH_DATE.exec(v.trim()) : null;
      if (!m) {
        ok = false;
        break;
      }
      hits.push({ r, m });
    }
    if (!ok || !hits.length) continue;
    const first = Math.max(...hits.map((h) => Number(h.m[1])));
    const second = Math.max(...hits.map((h) => Number(h.m[2])));
    const order = first <= 12 && second > 12 ? "md" : first > 12 && second <= 12 ? "dm" : undefined;
    if (!order) continue;
    const out: string[] = [];
    for (const { m } of hits) {
      const [mo, d] = order === "md" ? [m[1], m[2]] : [m[2], m[1]];
      const day = realDate(m[3], mo, d);
      const n = day && (m[4] ? normaliseDateValue(`${day} ${m[4]}`) : day);
      if (!n) {
        ok = false;
        break;
      }
      out.push(n);
    }
    if (ok) hits.forEach((h, i) => (h.r[c] = out[i]));
  }
}

export function extractRows(json: unknown): Extracted | undefined {
  const ex = extractInner(json);
  return ex && normaliseDates(ex);
}

function extractInner(json: unknown): Extracted | undefined {
  if (json === undefined || json === null) return undefined;
  if (Array.isArray(json)) return fromArray(json, "$");
  if (!isObj(json)) return undefined;
  if (isObj(json.reportData) || (Array.isArray(json.reportData) && json.reportData.some(isObj))) return fromReport(json);

  const meta = pagingMeta(json);

  // {columns: [...], rows|data: [[...], ...]}
  const cols = json.columns ?? json.headers;
  if (Array.isArray(cols)) {
    for (const k of ["rows", "data", "values"]) {
      const d = json[k];
      if (Array.isArray(d) && d.every(Array.isArray)) {
        const rows = fromMatrix(cols, d);
        return { rows, columns: columnsOf(rows), path: `$.${k}`, ...meta };
      }
    }
  }

  for (const k of CONTAINER_KEYS) {
    const v = json[k];
    if (Array.isArray(v)) {
      const r = fromArray(v, `$.${k}`);
      if (r) return { ...r, ...meta };
    }
    if (isObj(v)) {
      const inner = extractInner(v);
      if (inner) return { ...meta, ...inner, path: `$.${k}${inner.path.slice(1)}` };
    }
  }

  const found = largestObjectArray(json, "$", 0);
  if (found) {
    const r = fromArray(found.arr, found.path);
    if (r) return { ...r, ...meta };
  }
  // A single object (e.g. ns_getRecord) is one row, and carries no paging envelope.
  const row = flattenRow(json);
  return { rows: [row], columns: Object.keys(row), path: "$" };
}

function pickDefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
