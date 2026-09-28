/** Small in-memory columnar helpers behind `nsx results`. Output is always capped. */
import type { Row } from "../rows.ts";
import { normaliseDateValue } from "../rows.ts";
import { textTable } from "../util.ts";
import { type ColType, type CurrencyCheck, currencyCheck, dateKey, headerRepeatNote, headerRepeats, idLikeName, inferType, isCurrencyBearing, isEmpty, isIdColumn, isReportShape, NOT_SUMMABLE, REPORT_COLS, toNumber, unknownLabel } from "./profile.ts";

export type Pred = (r: Row) => boolean;

function unquote(s: string): string {
  const t = s.trim();
  return /^'.*'$|^".*"$/.test(t) ? t.slice(1, -1) : t;
}

/**
 * Numbers for printing: thousands separators, at most 2 decimals, and never `-0` (a sum that is
 * float noise around zero prints 0). Rates, ratios and percentages (exchangerate 0.912345) keep up
 * to 6 decimals.
 */
export function fmtValue(n: number, column?: string): string {
  if (!Number.isFinite(n)) return String(n);
  const digits = column !== undefined && NOT_SUMMABLE.test(column) ? 6 : 2;
  const f = 10 ** digits;
  const rounded = Math.round(n * f) / f || 0; // `|| 0` turns -0 into 0
  return rounded.toLocaleString("en-US", { maximumFractionDigits: digits });
}

const DATE_LIT = /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4})([T ]\d{1,2}:\d{2}(:\d{2})?(\s*[ap]\.?m\.?)?)?$/i;
const DATE_CELL = /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4})([T ]|$)/;

/** `2026-12-1`, `12/1/2026` (M/D/YYYY), `2026-12-01 7:18 pm` → a padded key (`2026-12-01`, `2026-12-01 19:18`), or undefined. */
export function dateLiteralKey(v: string): string | undefined {
  const t = v.trim();
  if (!DATE_LIT.test(t)) return undefined;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(.*)$/.exec(t);
  const iso = us ? `${us[3]}-${us[1]}-${us[2]}${us[4]}` : t;
  const d = /^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/.exec(iso)!;
  const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const dt = new Date(Date.UTC(y, m - 1, day));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day) return undefined;
  const date = `${d[1]}-${d[2].padStart(2, "0")}-${d[3].padStart(2, "0")}`;
  if (!d[4]) return date;
  return normaliseDateValue(`${date}${d[4].replace(/^T/, " ")}`);
}

/** A date cell's padded key (`2026-9-3 1:00 pm` → `2026-09-03 13:00`), or undefined for a non-date. */
function cellDateKey(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!DATE_CELL.test(t)) return undefined;
  return dateLiteralKey(t) ?? dateKey(t);
}

function cmp(a: unknown, b: string): number {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== undefined && nb !== undefined) return na - nb;
  return String(a ?? "").localeCompare(b, undefined, { sensitivity: "base" });
}

/**
 * Compare a cell with a literal. A date literal against a date cell compares dates (`2026-1-1`
 * equals `2026-01-01`; `12/1/2026` is M/D/YYYY); a literal without a time compares the cell's
 * day, so `<= '2026-12-31'` keeps the whole of Dec 31. Undefined: the cell isn't a date.
 */
function dateCmp(a: unknown, lit: string): number | undefined {
  const cell = cellDateKey(a);
  if (cell === undefined) return undefined;
  const c = lit.length === 10 ? cell.slice(0, 10) : cell;
  return c < lit ? -1 : c > lit ? 1 : 0;
}

/** Split on a keyword (and/or) outside single/double quotes and backticks. */
function splitOutsideQuotes(s: string, word: "and" | "or"): string[] {
  const parts: string[] = [];
  let cur = "";
  let quote: string | undefined;
  const re = new RegExp(`^\\s+${word}\\s+`, "i");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    const m = re.exec(s.slice(i));
    if (m && /\s/.test(ch)) {
      parts.push(cur);
      cur = "";
      i += m[0].length - 1;
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

/**
 * A column reference: `"Last Run On"`, `` `Last Run On` ``, or bare (`amount`, `t.id`, and, when the
 * result's columns are known, an unquoted label such as `Last Run On`).
 */
const COL = String.raw`"([^"]+)"|\x60([^\x60]+)\x60|([^\s"'\x60<>=!~][^"'\x60<>=!~]*?)`;
const NULL_COND = new RegExp(String.raw`^\s*(?:${COL})\s+is\s+(not\s+)?null\s*$`, "i");
const OP_COND = new RegExp(String.raw`^\s*(?:${COL})\s*(>=|<=|!=|<>|=|>|<|!~|~)\s*(.*?)\s*$`);

type Cond = { col: string; quoted: boolean; op: string; raw: string } | { col: string; quoted: boolean; nul: true; not: boolean };

function conditions(expr: string): Cond[][] {
  return splitOutsideQuotes(expr, "or").map((g) =>
    splitOutsideQuotes(g, "and").map((c): Cond => {
      const n = NULL_COND.exec(c);
      if (n) return { col: (n[1] ?? n[2] ?? n[3]).trim(), quoted: n[3] === undefined, nul: true, not: !!n[4] };
      const m = OP_COND.exec(c);
      if (!m) {
        throw new Error(
          `Cannot parse condition: ${c.trim()} (use col op value; ops = != > >= < <= ~ !~, or 'col is null'; quote a column name with spaces or parentheses: "Last Run On" >= '2026-09-01' or \`Last Run On\` >= '2026-09-01')`,
        );
      }
      const raw = m[5];
      // `amount >> 1`, `amount => 1`, `amount =`: a typo, not a comparison with the text "> 1".
      if (!/^['"]/.test(raw) && (raw === "" || /^[<>=!~]/.test(raw))) {
        throw new Error(`Cannot parse condition: ${c.trim()} (${raw === "" ? "no value after the operator; for blanks use 'col is null'" : `unexpected "${raw[0]}" after ${m[4]}; ops = != > >= < <= ~ !~`}; quote a value that starts with one: amount = '>1')`);
      }
      return { col: (m[1] ?? m[2] ?? m[3]).trim(), quoted: m[3] === undefined, op: m[4], raw };
    }),
  );
}

/** The column names a `--where` expression references, as written (quotes removed). */
export function whereColumns(expr: string): string[] {
  return [...new Set(conditions(expr).flat().map((c) => c.col))];
}

const loose = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/**
 * Resolve a column as written against the result's columns: exact, then case-insensitive, then
 * with spaces and punctuation read as `_` (`last_run_on` → `Last Run On`). Undefined if none or
 * more than one match.
 */
export function resolveColumn(columns: string[], name: string): string | undefined {
  if (columns.includes(name)) return name;
  for (const f of [(s: string) => s.toLowerCase(), loose]) {
    const hits = columns.filter((c) => f(c) === f(name));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return undefined;
  }
  return undefined;
}

const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/**
 * `amount>10000 and status='open' or entity~acme` — AND binds tighter than OR, no parens. Column
 * names with spaces go in double quotes or backticks. With `columns`, every referenced column is
 * resolved (see resolveColumn) and an unknown one throws "Unknown column(s)". Blank cells (null,
 * "", " ") are `is null` and never match a comparison.
 */
export function parseWhere(expr: string, columns?: string[]): Pred {
  const groups = conditions(expr);
  if (columns) {
    const missing = groups.flat().filter((c) => resolveColumn(columns, c.col) === undefined).map((c) => c.col);
    if (missing.length) throw new Error(`Unknown column(s): ${[...new Set(missing)].join(", ")}. Available: ${columns.join(", ")}${columns.some((c) => /\s/.test(c)) ? ' (names are matched case-insensitively; quote one with spaces or parentheses: "Last Run On")' : ""}`);
  } else {
    // Without the column list, an unquoted name can't contain spaces (`Last Run On >= x` is ambiguous).
    const bad = groups.flat().find((c) => !c.quoted && /\s/.test(c.col));
    if (bad) throw new Error(`Cannot parse condition: ${bad.col} … (quote a column name with spaces: "${bad.col}")`);
  }
  const conds = groups.map((group) =>
    group.map((c): Pred => {
      const col = columns ? resolveColumn(columns, c.col)! : c.col;
      if ("nul" in c) return (r) => blank(r[col]) !== c.not;
      const v = unquote(c.raw);
      const lit = c.op === "~" || c.op === "!~" ? undefined : dateLiteralKey(v);
      // A date literal compares dates; a cell that isn't a date then only matches `!=`.
      const order = (x: unknown): number | undefined => (lit === undefined ? cmp(x, v) : dateCmp(x, lit));
      const is = (x: unknown, ok: (n: number) => boolean) => {
        const o = order(x);
        return o !== undefined && ok(o);
      };
      switch (c.op) {
        case "=": return (r) => !blank(r[col]) && is(r[col], (o) => o === 0);
        // Blank cells never match a comparison, `!=` included (use `is null`).
        case "!=": case "<>": return (r) => !blank(r[col]) && !is(r[col], (o) => o === 0);
        case ">": return (r) => !blank(r[col]) && is(r[col], (o) => o > 0);
        case ">=": return (r) => !blank(r[col]) && is(r[col], (o) => o >= 0);
        case "<": return (r) => !blank(r[col]) && is(r[col], (o) => o < 0);
        case "<=": return (r) => !blank(r[col]) && is(r[col], (o) => o <= 0);
        case "~": return (r) => String(r[col] ?? "").toLowerCase().includes(v.toLowerCase());
        default: return (r) => !String(r[col] ?? "").toLowerCase().includes(v.toLowerCase());
      }
    }),
  );
  return (r) => conds.some((g) => g.every((p) => p(r)));
}

export function checkColumns(columns: string[], wanted: string[]): void {
  resolveColumns(columns, wanted);
}

/**
 * Column names as written (`--cols`, `--by`, `--on`, metric columns) resolved like --where's
 * (exact, case-insensitive, spaces and punctuation as `_`; quotes stripped). Throws "Unknown
 * column(s)" naming every one that doesn't resolve; `side` ("a", "b") says which result lacks it.
 */
export function resolveColumns(columns: string[], wanted: string[], side?: string): string[] {
  const out: string[] = [];
  const missing: string[] = [];
  for (const w of wanted) {
    if (!w) continue;
    const name = w.trim().replace(/^(["`])(.*)\1$/, "$2");
    const hit = resolveColumn(columns, name);
    if (hit === undefined) missing.push(name);
    else out.push(hit);
  }
  if (missing.length) throw new Error(`Unknown column(s)${side ? ` in ${side}` : ""}: ${missing.join(", ")}. Available${side ? ` in ${side}` : ""}: ${columns.join(", ")}`);
  return out;
}

/** Ids print as-is (`90000013`, not `90,000,013`); measures get thousands separators. */
const cell = (v: unknown, id: boolean, col: string) => (v === null || v === undefined ? "" : typeof v === "number" && !id ? fmtValue(v, col) : String(v));

export function renderRows(columns: string[], rows: Row[], maxLines = 60): string {
  const ids = columns.map(idLikeName);
  return textTable(columns, rows.map((r) => columns.map((c, i) => cell(r[c], ids[i], c))), maxLines);
}

/**
 * Rows sorted by one column, stably, blanks (null, undefined, whitespace) always last. The column's
 * type (from the result meta, else inferred from the values) picks the order: `num`/`id` compare
 * numerically, largest first; `date` compares normalised ISO strings (see dateKey), latest first;
 * anything else is text, A→Z (case-insensitive, digits by value). `asc` inverts that default for
 * every type: smallest/earliest first, or Z→A. A value that doesn't fit the type (an "n/a (…)"
 * cell in a number column) sorts with the blanks.
 */
export function sortRows(rows: Row[], col: string, type: ColType | undefined, asc = false): Row[] {
  const t = type ?? inferType(rows.map((r) => r[col]));
  const kind = t === "num" || t === "id" ? "num" : t === "date" ? "date" : "text";
  const keyOf = (v: unknown): number | string | undefined => {
    if (isEmpty(v)) return undefined;
    if (kind === "num") return toNumber(v);
    return kind === "date" ? dateKey(String(v).trim()) : String(v);
  };
  // Numbers and dates default to largest/latest first, text to A→Z.
  const dir = (kind === "text" ? 1 : -1) * (asc ? -1 : 1);
  const keyed = rows.map((r, i) => ({ r, i, k: keyOf(r[col]) }));
  keyed.sort((x, y) => {
    if (x.k === undefined || y.k === undefined) return x.k === y.k ? x.i - y.i : x.k === undefined ? 1 : -1;
    const c =
      typeof x.k === "number" && typeof y.k === "number"
        ? x.k - y.k
        : kind === "date"
          ? (x.k < y.k ? -1 : x.k > y.k ? 1 : 0)
          : String(x.k).localeCompare(String(y.k), undefined, { numeric: true, sensitivity: "base" });
    return c ? c * dir : x.i - y.i;
  });
  return keyed.map((e) => e.r);
}

export type AggFn = "sum" | "avg" | "count" | "min" | "max";

export interface AggSpec {
  by: string[];
  metrics: { fn: AggFn; col?: string }[];
  top?: number;
  /** An output column (`sum_amount`, a --by column), or a metric's source column when only one metric uses it. */
  sort?: string;
  asc?: boolean;
  /** Column types from the result meta; a column not listed is typed from its values. */
  types?: Record<string, ColType>;
}

export interface AggResult {
  columns: string[];
  rows: Row[];
  /**
   * Cross-group totals. A sum/avg that would mix currencies, subsidiaries' base currencies or
   * count a header amount once per line is replaced by an "n/a (…)" string; so is a group's own.
   */
  totals: Row;
  /** Every caveat (currencies, repeated header amounts, skipped non-numeric values), one per entry. */
  warnings: string[];
  /** `warnings` joined with "\n⚠ ", for callers that print one `⚠ ${warning}`. */
  warning?: string;
}

/** How a metric column compares: numbers, ids (numbers that can't be summed), dates or text. */
type Kind = "num" | "id" | "date" | "text";

/**
 * Typed by `types` when given, else by its values. A column typed `str` counts as numbers only if
 * every value in these rows parses as one; an untyped mixed column is numbers if any value parses
 * (the rest are skipped and counted in a warning).
 */
function metricKind(rows: Row[], col: string, types: Record<string, ColType> | undefined): Kind {
  const vals = rows.map((r) => r[col]);
  const present = vals.filter((v) => !isEmpty(v));
  if (!present.length) return "num";
  const t = types?.[col];
  if (t === "date") return "date";
  if (t === "id") return "id";
  if (t === "num") return "num";
  if (t === "str" || t === "bool") return present.every((v) => toNumber(v) !== undefined) ? "num" : "text";
  const it = inferType(vals);
  if (it === "date") return "date";
  if (it === "num") return isIdColumn(col, present) ? "id" : "num";
  if (it === "bool") return "text";
  return present.some((v) => toNumber(v) !== undefined) ? "num" : "text";
}

/** sum/avg need numbers that measure something: not dates, text, ids, or (for sum) rates. */
function checkMetric(fn: AggFn, col: string, kind: Kind, rows: Row[]): void {
  if (fn !== "sum" && fn !== "avg") return;
  if (kind === "date") throw new Error(`--${fn} needs a number column; "${col}" is a date (use --min/--max)`);
  if (kind === "text") {
    const present = rows.map((r) => r[col]).filter((v) => !isEmpty(v));
    const bad = present.filter((v) => toNumber(v) === undefined);
    const why = bad.length < present.length ? ` (${bad.length} of ${present.length} values aren't numbers, e.g. "${String(bad[0]).trim().slice(0, 30)}")` : "";
    throw new Error(`--${fn} needs a number column; "${col}" is text${why} (use --count, --min/--max, or --by)`);
  }
  if (kind === "id") throw new Error(`--${fn} needs an amount or a count; "${col}" holds ids (internal ids or list values), which don't add up (use --count, --by, or --min/--max)`);
  if (fn === "sum" && NOT_SUMMABLE.test(col)) throw new Error(`--sum of "${col}" means nothing: rates, ratios and percentages don't add up (use --avg or --min/--max)`);
}

const truthy = (v: unknown) => v === true || String(v).trim().toLowerCase() === "true" || String(v).trim().toLowerCase() === "t";

/**
 * Report rows nest (sections > groups > accounts > detail lines), so a sum across levels adds
 * subtotals to their own lines. A sum/avg is allowed only over rows of one depth with no detail or
 * structural rows (spacers carry no value). Rows with no value in `cols` don't count.
 */
function checkReportLevels(rows: Row[], cols: string[], what: string): void {
  if (!rows.length || !isReportShape(Object.keys(rows[0]))) return;
  const valued = rows.filter((r) => cols.some((c) => !REPORT_COLS.includes(c) && !isEmpty(r[c])));
  const depths = [...new Set(valued.map((r) => String(r.depth)))].sort((x, y) => Number(x) - Number(y));
  const bad = valued.filter((r) => r.kind === "detail" || r.kind === "structural" || truthy(r.is_detail)).length;
  if (depths.length <= 1 && !bad) return;
  const across = [depths.length > 1 ? `depths ${depths.join(", ")}` : "", bad ? `${bad} detail/structural row(s), which repeat their lines` : ""].filter(Boolean).join(" and ");
  throw new Error(`report rows nest; filter to one level: --where "depth=1 and is_detail=false" (${what} across ${across} double-counts subtotals)`);
}

/** True when some value of `id` appears on more than one of `rows`. */
function repeatsIn(rows: Row[], id: string): boolean {
  const seen = new Set<string>();
  for (const r of rows) {
    if (isEmpty(r[id])) continue;
    const k = String(r[id]).trim();
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

const loose2 = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** --sort against the output columns; a metric's source column works when one metric uses it. */
function resolveSort(sort: string | undefined, by: string[], metrics: { fn: AggFn; col?: string }[], names: string[]): string {
  if (sort === undefined) return names[0];
  const s = sort.trim().replace(/^(["`])(.*)\1$/, "$2");
  const out = [...by, ...names];
  const hit = resolveColumn(out, s);
  if (hit) return hit;
  const on = names.filter((_, i) => metrics[i].col !== undefined && loose2(metrics[i].col!) === loose2(s));
  if (on.length === 1) return on[0];
  throw new Error(`--sort ${s} isn't an output column${on.length > 1 ? ` (${s} has ${on.length} metrics: ${on.join(", ")})` : ""}. Sort by one of: ${out.join(", ")}`);
}

const list8 = (vs: string[]) => vs.slice(0, 8).join(", ") + (vs.length > 8 ? ", …" : "");
const argOf = (s: string) => (/^[\w.$#,-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`);

/** The base-currency-across-subsidiaries caveat, shared by agg and pivot. */
function baseSubsNote(cols: string[], cur: CurrencyCheck, tail: string): string {
  const u = [...new Set(cols)];
  return `${u.join(", ")} ${u.length > 1 ? "are" : "is"} in each subsidiary's base currency and the rows span ${cur.subsidiaries} subsidiaries (${cur.subsidiary}): ${tail}`;
}

/**
 * Group and aggregate. min/max on a date column compare the normalised date strings and print
 * them (`2026-09-27 22:05`); on a text column they compare text. sum/avg need a number column that
 * isn't an id (a rate can be averaged, not summed) and throw otherwise, as they do over report rows
 * spanning levels. A group with no non-empty value for a metric shows blank (null), not 0, and its
 * rows' currencies don't count toward that metric's "n/a (k currencies)". Non-numeric values in a
 * number column are skipped and counted in a warning.
 */
export function aggregate(rows: Row[], spec: AggSpec): AggResult {
  const metrics = spec.metrics.length ? spec.metrics : [{ fn: "count" as AggFn }];
  const names = metrics.map((m) => (m.col ? `${m.fn}_${m.col}` : m.fn));
  const kinds: Kind[] = metrics.map((m) => (m.col && m.fn !== "count" ? metricKind(rows, m.col, spec.types) : "num"));
  metrics.forEach((m, i) => m.col && checkMetric(m.fn, m.col, kinds[i], rows));
  const addCols = metrics.filter((m) => (m.fn === "sum" || m.fn === "avg") && m.col).map((m) => m.col!);
  if (addCols.length) checkReportLevels(rows, addCols, "a sum");
  const sortCol = resolveSort(spec.sort, spec.by, metrics, names);
  const allCols = Object.keys(rows[0] ?? {});
  const cur = currencyCheck(allCols, rows);
  const unknownCols = cur.unknownColumns;
  const curOf = currencyOf(cur.column);
  const repeats = headerRepeats(allCols, rows);
  const numeric = (k: Kind) => k === "num" || k === "id";
  type Acc = { sum: number; n: number; min: number | string | undefined; max: number | string | undefined; currencies: Set<string>; rows: Row[]; skipped: number; bad?: string };
  const groups = new Map<string, { key: Row; acc: Acc[] }>();
  const newAcc = (): Acc[] => metrics.map(() => ({ sum: 0, n: 0, min: undefined, max: undefined, currencies: new Set(), rows: [], skipped: 0 }));
  const totalAcc = newAcc();
  for (const r of rows) {
    const keyVals = spec.by.map((b) => r[b]);
    const k = JSON.stringify(keyVals);
    let g = groups.get(k);
    if (!g) {
      g = { key: Object.fromEntries(spec.by.map((b, i) => [b, keyVals[i]])), acc: newAcc() };
      groups.set(k, g);
    }
    const c = curOf(r);
    metrics.forEach((m, i) => {
      for (const a of [g!.acc[i], totalAcc[i]]) {
        if (m.fn === "count" && !m.col) {
          a.n++;
          continue;
        }
        const raw = r[m.col!];
        if (m.fn === "count") {
          if (!isEmpty(raw)) a.n++;
          continue;
        }
        const v = isEmpty(raw) ? undefined : numeric(kinds[i]) ? toNumber(raw) : kinds[i] === "date" ? dateKey(String(raw).trim()) : String(raw);
        if (v === undefined) {
          if (!isEmpty(raw)) (a.skipped++), (a.bad ??= String(raw).trim().slice(0, 30));
          continue;
        }
        // Only rows with a value count toward the metric's currencies.
        if (c !== undefined) a.currencies.add(c);
        a.rows.push(r);
        a.n++;
        if (typeof v === "number") a.sum += v;
        if (a.min === undefined || v < a.min) a.min = v;
        if (a.max === undefined || v > a.max) a.max = v;
      }
    });
  }
  const finish = (acc: Acc[]): Row =>
    Object.fromEntries(
      metrics.map((m, i) => {
        const a = acc[i];
        const v = m.fn === "count" ? a.n : !a.n ? null : m.fn === "sum" ? a.sum : m.fn === "avg" ? a.sum / a.n : m.fn === "min" ? a.min! : a.max!;
        return [names[i], v];
      }),
    );
  // Adding USD to EUR is meaningless: blank sums/averages of amounts that span currencies.
  const money = metrics.filter((m, i) => m.col && m.fn !== "count" && kinds[i] === "num" && isCurrencyBearing(m.col));
  const adds = money.filter((m) => m.fn === "sum" || m.fn === "avg");
  const mixed = cur.values.length > 1;
  const na = (n: number) => `n/a (${n} currencies)`;
  let out = [...groups.values()].map((g) => {
    const row: Row = { ...g.key, ...finish(g.acc) };
    metrics.forEach((m, i) => {
      if ((m.fn !== "sum" && m.fn !== "avg") || !m.col) return;
      const a = g.acc[i];
      if (!a.n) return;
      const rid = repeats.get(m.col);
      if (adds.includes(m) && a.currencies.size > 1) row[names[i]] = na(a.currencies.size);
      else if (adds.includes(m) && unknownCols.includes(m.col)) {
        // A group's own amounts may mix like the whole result's, unless the group can't (one row,
        // one subsidiary for a base amount, one currency): the same rule as mixed-currency groups.
        const chk = currencyCheck(allCols, a.rows);
        if (chk.unknownColumns.includes(m.col)) row[names[i]] = `n/a (${unknownLabel(chk, m.col)})`;
      }
      if (typeof row[names[i]] === "number" && rid && repeatsIn(a.rows, rid)) row[names[i]] = `n/a (repeats per ${rid})`;
    });
    return row;
  });
  const mi = names.indexOf(sortCol);
  const isNa = (v: unknown) => typeof v === "string" && v.startsWith("n/a");
  const sortType: ColType =
    mi >= 0 && kinds[mi] === "date"
      ? "date"
      : mi >= 0 && kinds[mi] === "text"
        ? "str"
        : out.every((r) => isEmpty(r[sortCol]) || isNa(r[sortCol]) || toNumber(r[sortCol]) !== undefined)
          ? "num"
          : spec.types?.[sortCol] ?? inferType(out.map((r) => r[sortCol]));
  // Numbers largest first, dates latest first, text A→Z; --asc inverts; blanks and n/a last.
  out = sortRows(out, sortCol, sortType, !!spec.asc);
  if (spec.top) out = out.slice(0, spec.top);
  const totals = finish(totalAcc);
  const warnings: string[] = [];
  const hasMinMax = money.some((m) => m.fn === "min" || m.fn === "max");
  const minmax = hasMinMax ? " min/max compare amounts in different currencies." : "";
  if (money.length && mixed && cur.column) {
    const grouped = spec.by.some((b) => cur.columns.includes(b));
    const n = cur.values.length;
    const list = list8(cur.values);
    for (const m of adds) totals[`${m.fn}_${m.col}`] = grouped ? na(n) : `n/a (${n} currencies mixed in groups; add --by ${cur.column})`;
    if (grouped) {
      if (adds.length) warnings.push(`${cur.column} has ${n} values (${list}): per-group amounts are fine, the TOTAL isn't.`);
    } else if (!spec.by.length) warnings.push(`the rows are in ${n} currencies (${cur.column}: ${list}):${adds.length ? " amounts don't add up." : ""}${minmax} Add --by ${cur.column}.`);
    // Only sums/averages are blanked; a min/max is still printed, so don't claim n/a for it.
    else warnings.push(`${cur.column} has ${n} values (${list}):${adds.length ? " groups spanning several currencies show n/a." : ""}${minmax} Add ${cur.column} to --by.`);
  }
  const unknownMoney = money.filter((m) => unknownCols.includes(m.col!));
  const baseMoney = unknownMoney.filter((m) => cur.baseAcrossSubs.includes(m.col!));
  const foreignUnknown = unknownMoney.filter((m) => !cur.baseAcrossSubs.includes(m.col!));
  if (baseMoney.length) {
    const label = `n/a (${cur.subsidiaries} subsidiaries)`;
    for (const m of adds) if (baseMoney.includes(m) && !isNa(totals[`${m.fn}_${m.col}`])) totals[`${m.fn}_${m.col}`] = label;
    const grouped = spec.by.includes(cur.subsidiary!);
    const add = baseMoney.some((m) => adds.includes(m));
    const mm = baseMoney.some((m) => m.fn === "min" || m.fn === "max");
    const tail = grouped
      ? `per-subsidiary amounts are fine, the TOTAL isn't.`
      : `${add ? (spec.by.length ? "groups spanning several subsidiaries show n/a" : "they don't add up") : ""}${add && mm ? "; " : ""}${mm ? "min/max compare amounts in different currencies" : ""}. Group by subsidiary: --by ${argOf([...spec.by, cur.subsidiary!].join(","))}.`;
    warnings.push(baseSubsNote(baseMoney.map((m) => m.col!), cur, tail));
  }
  if (foreignUnknown.length) {
    for (const m of adds) if (foreignUnknown.includes(m)) totals[`${m.fn}_${m.col}`] = "n/a (currency unknown)";
    const cols = foreignUnknown.map((m) => m.col).filter((c, i, a) => a.indexOf(c) === i).join(", ");
    const unknownMinMax = foreignUnknown.some((m) => m.fn === "min" || m.fn === "max");
    warnings.push(`currency unknown: no currency column, so ${cols} may mix currencies${spec.by.length && adds.length ? "; groups that may span currencies show n/a" : ""}${unknownMinMax ? "; min/max may compare amounts in different currencies" : ""}. Re-run with a currency column (BUILTIN.DF(t.currency) AS currency) and group by it.`);
  }
  // Header amounts on line rows (transaction JOIN transactionline): one per line, not per document.
  const warnedRepeat = new Set<string>();
  metrics.forEach((m, i) => {
    if ((m.fn !== "sum" && m.fn !== "avg") || !m.col || !repeats.has(m.col)) return;
    const rid = repeats.get(m.col)!;
    if (!repeatsIn(totalAcc[i].rows, rid)) return;
    if (typeof totals[names[i]] === "number") totals[names[i]] = `n/a (repeats per ${rid})`;
    if (!warnedRepeat.has(m.col)) warnings.push(headerRepeatNote(m.col, rid)), warnedRepeat.add(m.col);
  });
  metrics.forEach((m, i) => {
    const a = totalAcc[i];
    if (a.skipped) warnings.push(`${names[i]}: skipped ${a.skipped} non-numeric value(s) of ${m.col} (e.g. "${a.bad}"); they aren't in the ${m.fn}.`);
  });
  return { columns: [...spec.by, ...names], rows: out, totals, warnings, warning: warnings.length ? warnings.join("\n⚠ ") : undefined };
}

const currencyOf = (column: string | undefined) => (r: Row) => (column === undefined || isEmpty(r[column]) ? undefined : String(r[column]).trim());

export interface PivotResult {
  columns: string[];
  rows: Row[];
  warnings: string[];
  /** `warnings` joined with "\n⚠ ". */
  warning?: string;
}

/**
 * One metric per pivot, with agg's rules: sum/avg need a number column that isn't an id (and not
 * across report levels), min/max compare dates as dates and text as text, `count` with a column
 * counts its non-empty values. A sum/avg cell covering more than one currency shows "n/a (k
 * currencies)" ("n/a (currency unknown)" with no currency column, "n/a (k subsidiaries)" for base
 * amounts, "n/a (repeats per id)" for a header amount on line rows).
 */
export function pivot(rows: Row[], rowCol: string, colCol: string, fn: AggFn, valCol?: string, maxCols = 12, types?: Record<string, ColType>): PivotResult {
  const kind: Kind = valCol && fn !== "count" ? metricKind(rows, valCol, types) : "num";
  if (valCol) checkMetric(fn, valCol, kind, rows);
  if (valCol && (fn === "sum" || fn === "avg")) checkReportLevels(rows, [valCol], `a ${fn}`);
  const colVals = [...new Set(rows.map((r) => String(r[colCol] ?? "")))].sort();
  const shown = colVals.slice(0, maxCols);
  const overflow = colVals.length > maxCols;
  const res = new Map<string, Row>();
  type Cell = { rk: string; ck: string; rows: Row[]; n: number; sum: number; min?: number | string; max?: number | string };
  const cells = new Map<string, Cell>();
  let skipped = 0;
  let bad: string | undefined;
  for (const r of rows) {
    const rk = String(r[rowCol] ?? "");
    let ck = String(r[colCol] ?? "");
    if (!shown.includes(ck)) ck = "(other)";
    if (!res.has(rk)) res.set(rk, { [rowCol]: rk });
    let v: number | string | undefined = 1;
    if (valCol) {
      const raw = r[valCol];
      if (isEmpty(raw)) continue;
      if (fn !== "count") {
        v = kind === "num" || kind === "id" ? toNumber(raw) : kind === "date" ? dateKey(String(raw).trim()) : String(raw);
        if (v === undefined) {
          skipped++;
          bad ??= String(raw).trim().slice(0, 30);
          continue;
        }
      }
    }
    const key = `${rk}\u0000${ck}`;
    const cell = cells.get(key) ?? { rk, ck, rows: [], n: 0, sum: 0 };
    cells.set(key, cell);
    cell.rows.push(r);
    cell.n++;
    if (typeof v === "number") cell.sum += v;
    if (cell.min === undefined || v < cell.min) cell.min = v;
    if (cell.max === undefined || v > cell.max) cell.max = v;
  }
  for (const c of cells.values()) {
    res.get(c.rk)![c.ck] = fn === "count" ? c.n : fn === "sum" ? c.sum : fn === "avg" ? c.sum / c.n : fn === "min" ? c.min! : c.max!;
  }
  const warnings: string[] = [];
  const adds = fn === "sum" || fn === "avg";
  if (valCol && fn !== "count" && kind === "num" && isCurrencyBearing(valCol) && rows.length) {
    const allCols = Object.keys(rows[0]);
    const cur = currencyCheck(allCols, rows);
    const onAxis = cur.columns.includes(rowCol) || cur.columns.includes(colCol);
    const done = new Set<Cell>();
    if (cur.status === "mixed" && cur.column && !onAxis) {
      const curOf = currencyOf(cur.column);
      let blanked = 0;
      if (adds) {
        for (const c of cells.values()) {
          const k = new Set(c.rows.map(curOf).filter((v) => v !== undefined)).size;
          if (k > 1) {
            res.get(c.rk)![c.ck] = `n/a (${k} currencies)`;
            done.add(c);
            blanked++;
          }
        }
      }
      const n = cur.values.length;
      warnings.push(`${cur.column} has ${n} values (${list8(cur.values)}) and neither --rows nor --cols is ${cur.column}: ${adds ? `${blanked} cell(s) spanning several currencies show n/a` : "min/max compare amounts in different currencies"}. Put ${cur.column} on --rows or --cols, or filter to one currency.`);
    }
    if (cur.unknownColumns.includes(valCol)) {
      let blanked = 0;
      if (adds) {
        for (const c of cells.values()) {
          if (done.has(c)) continue;
          const chk = currencyCheck(allCols, c.rows);
          if (chk.unknownColumns.includes(valCol)) {
            res.get(c.rk)![c.ck] = `n/a (${unknownLabel(chk, valCol)})`;
            done.add(c);
            blanked++;
          }
        }
      }
      if (cur.baseAcrossSubs.includes(valCol)) {
        const subAxis = rowCol === cur.subsidiary || colCol === cur.subsidiary;
        if (!subAxis) warnings.push(baseSubsNote([valCol], cur, `${adds ? `${blanked} cell(s) spanning several subsidiaries show n/a` : "min/max compare amounts in different currencies"}. Put ${cur.subsidiary} on --rows or --cols, or filter to one subsidiary.`));
      } else {
        warnings.push(`currency unknown: no currency column, so ${valCol} may mix currencies${adds ? "; cells that may span currencies show n/a" : " (min/max may compare different currencies)"}. Re-run with a currency column (BUILTIN.DF(t.currency) AS currency) and pivot on it.`);
      }
    }
  }
  if (valCol && adds) {
    const rid = headerRepeats(Object.keys(rows[0] ?? {}), rows).get(valCol);
    if (rid) {
      let hit = 0;
      for (const c of cells.values()) {
        if (typeof res.get(c.rk)![c.ck] === "number" && repeatsIn(c.rows, rid)) (res.get(c.rk)![c.ck] = `n/a (repeats per ${rid})`), hit++;
      }
      if (hit) warnings.push(headerRepeatNote(valCol, rid));
    }
  }
  if (skipped) warnings.push(`skipped ${skipped} non-numeric value(s) of ${valCol} (e.g. "${bad}"); they aren't in the ${fn}.`);
  return { columns: [rowCol, ...shown, ...(overflow ? ["(other)"] : [])], rows: [...res.values()], warnings, warning: warnings.length ? warnings.join("\n⚠ ") : undefined };
}

export interface DiffResult {
  columns: string[];
  rows: Row[];
  /** The key actually used: `on`, plus `depth` when report lines repeat a name. */
  on: string[];
  /** What was done to make the key unique (report rows left out, depth added). */
  notes: string[];
  /** Every warning (repeating key, currencies), one per line. */
  warnings: string[];
  /** `warnings` joined with "\n⚠ ", for callers that print one `⚠ ${warning}`. */
  warning?: string;
  /**
   * Keys by outcome over every value column, with `opts.tolerance`: `changed` = some column's
   * |delta| > tolerance, is blank on one side only, or the key is on one side only; `incomparable`
   * = nothing changed but some delta is n/a (currencies differ, span several, or are unknown):
   * listed by diffChanged but not counted as changed; `same` = the rest.
   */
  counts: { changed: number; incomparable: number; same: number };
}

export interface DiffOptions {
  /**
   * Report results only: each side's report currency (consolidated → the base currency; a
   * subsidiary → its currency). When both are known and differ, the diff warns.
   */
  reportCurrency?: { a?: string; b?: string };
  /** Deltas at or below this (absolute) count as `same` in `counts`. Default 0; must be a finite number ≥ 0. */
  tolerance?: number;
}

/** Report row kinds that repeat a line's name or carry no value of their own. */
const REPORT_SKIP = new Set(["detail", "structural", "spacer"]);

type Outcome = "changed" | "incomparable" | "same";

function outcome(r: Row, c: string, tol: number): Outcome {
  if (r._presence !== "both") return "changed";
  const d = r[`${c}_delta`];
  const va = r[`${c}_a`];
  const vb = r[`${c}_b`];
  if (typeof d === "number") return Math.abs(d) > tol ? "changed" : "same";
  if (typeof d === "string" || typeof va === "string" || typeof vb === "string") return "incomparable";
  if ((va === null || va === undefined) !== (vb === null || vb === undefined)) return "changed";
  return "same";
}

/**
 * True when a diff row changed by more than `tol` in any of `cols` (or is on one side only). Rows
 * whose delta is n/a are kept (so a tolerance never hides them), though `counts` reports them as
 * incomparable; a column blank on both sides is the same.
 */
export function diffChanged(r: Row, cols: string | string[], tol = 0): boolean {
  return (Array.isArray(cols) ? cols : [cols]).some((c) => outcome(r, c, tol) !== "same");
}

/** Key cells compared as text: `1` (number) matches `"1"` and `" 1 "`; `1.50` matches `1.5`. */
function canonKey(v: unknown): string {
  if (isEmpty(v)) return "";
  if (typeof v === "number") return String(v);
  const t = String(v).trim();
  return /^-?\d+(\.\d+)?$/.test(t) && !/^-?0\d/.test(t) ? String(Number(t)) : t;
}

/**
 * Keys present on one side only get blank values on the other, and no delta. Keys should be unique:
 * report results repeat each account as a `line` row and a `detail` row with the same name, so
 * those are left out first (the section and account lines carry the values) and `depth` joins the
 * key if names still repeat; a report key that still repeats is refused. Elsewhere a repeating key
 * is summed, with a warning. Key cells match as text whatever each side's column type (`1` = `"1"`).
 * The percentage is "n/a" on a base below 1 in absolute value. A value column with no numbers is
 * refused; non-numeric values in a number column are skipped with a warning.
 *
 * Currencies, as `aggregate` treats them: a key whose amounts on one side span several currencies
 * shows "n/a (k currencies)" for that side (no delta or %); a key in one currency on each side but
 * different ones shows its values with an n/a delta. A key that may mix currencies (see
 * currencyCheck: foreign* amounts with no currency column, or base amounts across subsidiaries)
 * shows "n/a (currency unknown)" / "n/a (k subsidiaries)". Two report results in different
 * currencies (`reportCurrency`) keep their values side by side, with every delta and % "n/a (EUR vs
 * USD)", and a warning. A key whose rows are all blank in a column shows blank there (not 0), and
 * those rows' currencies don't count.
 */
export function diff(a: Row[], b: Row[], on: string[], cols: string[], opts: DiffOptions = {}): DiffResult {
  const tol = opts.tolerance ?? 0;
  if (!Number.isFinite(tol) || tol < 0) throw new Error(`--tolerance must be a number ≥ 0 (an absolute amount, e.g. 0.01), not ${opts.tolerance}`);
  let key = [...on];
  const notes: string[] = [];
  const warnings: string[] = [];
  const keyOf = (r: Row) => JSON.stringify(key.map((k) => canonKey(r[k])));
  const repeats = (rows: Row[]) => {
    const n = new Map<string, number>();
    for (const r of rows) n.set(keyOf(r), (n.get(keyOf(r)) ?? 0) + 1);
    return new Map([...n].filter(([, c]) => c > 1));
  };
  const allRepeats = () => {
    const m = repeats(a);
    for (const [k, c] of repeats(b)) m.set(k, Math.max(c, m.get(k) ?? 0));
    return m;
  };
  const show = (k: string) => (JSON.parse(k) as unknown[]).map((v) => String(v ?? "")).join(", ");
  const example = (m: Map<string, number>) => {
    const [k, c] = [...m].sort((x, y) => y[1] - x[1])[0];
    return `"${show(k)}" ×${c}`;
  };
  let rep = allRepeats();
  const report = isReportShape(Object.keys(a[0] ?? b[0] ?? {})) && isReportShape(Object.keys(b[0] ?? a[0] ?? {}));
  if (report && rep.size) {
    // Blank lines saved before the `spacer` kind existed: no label, no value.
    const skip = (r: Row) => REPORT_SKIP.has(String(r.kind)) || (isEmpty(r.line) && cols.every((c) => isEmpty(r[c]) || r[c] === 0));
    const na = a.filter(skip).length;
    const nb = b.filter(skip).length;
    a = a.filter((r) => !skip(r));
    b = b.filter((r) => !skip(r));
    notes.push(`report rows: left out ${na} (a) and ${nb} (b) detail/structural/spacer rows, which repeat a line's name; the section and account lines carry the values.`);
    rep = allRepeats();
    if (rep.size && !key.includes("depth")) {
      key = [...key, "depth"];
      notes.push(`'${on.join(",")}' still repeats among report lines, so rows are keyed on ${key.join(",")}.`);
      rep = allRepeats();
    }
    if (rep.size) {
      throw new Error(`key '${key.join(",")}' isn't unique among the report lines: ${rep.size} keys repeat (e.g. ${example(rep)}). Diffing would add nested rows together; narrow both sides with --where or add a key column.`);
    }
  }
  if (rep.size) warnings.push(`key '${key.join(",")}' isn't unique: ${rep.size} keys repeat (e.g. ${example(rep)}); values were summed — use a unique key or --on a,b`);
  // Value columns are compared as numbers: refuse a text column, count skipped values.
  for (const c of cols) {
    const present = [...a, ...b].map((r) => r[c]).filter((v) => !isEmpty(v));
    const bad = present.filter((v) => toNumber(v) === undefined);
    if (present.length && bad.length === present.length) throw new Error(`diff --cols compares numbers; "${c}" is text (e.g. "${String(bad[0]).trim().slice(0, 30)}"): put it in --on to match on it, or compare with results filter`);
    if (bad.length) warnings.push(`${c}: skipped ${bad.length} non-numeric value(s) (e.g. "${String(bad[0]).trim().slice(0, 30)}"); they aren't compared.`);
  }

  // Report amounts are all in the report's currency; elsewhere each side is checked on its own.
  const money = report ? [] : cols.filter(isCurrencyBearing);
  const checkOf = (rows: Row[]) => currencyCheck(Object.keys(rows[0] ?? {}), rows);
  const curA = checkOf(a);
  const curB = checkOf(b);
  const curCol = curA.column ?? curB.column;
  const keyed = [...curA.columns, ...curB.columns].some((c) => key.includes(c));
  type Entry = { key: Row; v: (number | null)[]; currencies: Set<string>; rows: Row[] };
  const sums = (rows: Row[], cur: ReturnType<typeof checkOf>) => {
    const curOf = currencyOf(cur.column);
    const keepRows = money.length > 0 && cur.unknownColumns.length > 0;
    const m = new Map<string, Entry>();
    for (const r of rows) {
      const k = keyOf(r);
      const e = m.get(k) ?? { key: Object.fromEntries(key.map((o) => [o, r[o]])), v: cols.map(() => null), currencies: new Set<string>(), rows: [] };
      let valued = false;
      cols.forEach((c, i) => {
        const n = toNumber(r[c]);
        if (n === undefined) return;
        e.v[i] = (e.v[i] ?? 0) + n;
        if (money.includes(c)) valued = true;
      });
      // A row with no amount doesn't make its key span its currency.
      if (valued) {
        const c = curOf(r);
        if (c !== undefined) e.currencies.add(c);
        if (keepRows) e.rows.push(r);
      }
      m.set(k, e);
    }
    return m;
  };
  const A = sums(a, curA);
  const B = sums(b, curB);
  const allColsA = Object.keys(a[0] ?? {});
  const allColsB = Object.keys(b[0] ?? {});
  let spanning = 0;
  let crossed = 0;
  let unknownKeys = 0;
  const out: Row[] = [];
  for (const k of new Set([...A.keys(), ...B.keys()])) {
    const ea = A.get(k);
    const eb = B.get(k);
    const row: Row = { ...(ea?.key ?? eb!.key) };
    const checkEntry = (e: Entry | undefined, allCols: string[]) => (e && e.rows.length > 1 ? currencyCheck(allCols, e.rows) : undefined);
    const chkA = checkEntry(ea, allColsA);
    const chkB = checkEntry(eb, allColsB);
    const one = (e: Entry | undefined) => (e && e.currencies.size === 1 ? [...e.currencies][0] : undefined);
    let rowSpans = false;
    let rowCrossed = false;
    let rowUnknown = false;
    cols.forEach((c, i) => {
      let va: number | string | null = ea ? ea.v[i] : null;
      let vb: number | string | null = eb ? eb.v[i] : null;
      let blankDelta = false;
      if (money.includes(c)) {
        if (va === null) {
          /* blank: nothing to compare */
        } else if (ea && ea.currencies.size > 1) (va = `n/a (${ea.currencies.size} currencies)`), (rowSpans = true);
        else if (chkA?.unknownColumns.includes(c)) (va = `n/a (${unknownLabel(chkA, c)})`), (rowUnknown = true);
        if (vb === null) {
          /* blank */
        } else if (eb && eb.currencies.size > 1) (vb = `n/a (${eb.currencies.size} currencies)`), (rowSpans = true);
        else if (chkB?.unknownColumns.includes(c)) (vb = `n/a (${unknownLabel(chkB, c)})`), (rowUnknown = true);
        const ca = one(ea);
        const cb = one(eb);
        if (typeof va === "number" && typeof vb === "number" && ca !== undefined && cb !== undefined && ca !== cb) (blankDelta = true), (rowCrossed = true);
      }
      row[`${c}_a`] = va;
      row[`${c}_b`] = vb;
      if (typeof va === "string" || typeof vb === "string") {
        row[`${c}_delta`] = null;
        row[`${c}_pct`] = null;
      } else if (blankDelta) {
        row[`${c}_delta`] = `n/a (${one(ea)} vs ${one(eb)})`;
        row[`${c}_pct`] = null;
      } else {
        row[`${c}_delta`] = va !== null && vb !== null ? vb - va : null;
        // A % change on a zero or near-zero base is noise (0.01 → 9.4M reads as 94 billion %).
        row[`${c}_pct`] = va === null || vb === null ? null : Math.abs(va) < 1 ? "n/a" : Math.round(((vb - va) / Math.abs(va)) * 1000) / 10;
      }
    });
    if (rowSpans) spanning++;
    if (rowCrossed) crossed++;
    if (rowUnknown) unknownKeys++;
    row._presence = ea && eb ? "both" : ea ? "only_a" : "only_b";
    out.push(row);
  }
  if (money.length && !keyed && (spanning || crossed)) {
    const values = [...new Set([...curA.values, ...curB.values])].sort();
    const what = [spanning ? `${spanning} key(s) spanning several currencies show n/a` : "", crossed ? `${crossed} key(s) in a different currency on each side show an n/a delta` : ""].filter(Boolean).join("; ");
    warnings.push(`${curCol} has ${values.length} values (${list8(values)}): ${what}. Add ${curCol} to --on.`);
  }
  if (money.length && unknownKeys) {
    // Keys of one row each (e.g. --on id) compare a document with itself: no warning then.
    const base = money.filter((c) => curA.baseAcrossSubs.includes(c) || curB.baseAcrossSubs.includes(c));
    const foreign = money.filter((c) => !base.includes(c) && (curA.unknownColumns.includes(c) || curB.unknownColumns.includes(c)));
    const sub = curA.subsidiary ?? curB.subsidiary;
    if (base.length) warnings.push(`${base.join(", ")} ${base.length > 1 ? "are" : "is"} in each subsidiary's base currency and keys span several subsidiaries (${sub}): those keys show n/a. Add ${sub} to --on.`);
    if (foreign.length) warnings.push(`currency unknown: no currency column, so ${foreign.join(", ")} may mix currencies; ${unknownKeys} key(s) that may span currencies show n/a. Re-run with a currency column (BUILTIN.DF(t.currency) AS currency) and add it to --on.`);
  }
  const rc = opts.reportCurrency;
  if (report && rc?.a && rc.b && rc.a.toUpperCase() !== rc.b.toUpperCase()) {
    const vs = `n/a (${rc.a} vs ${rc.b})`;
    for (const r of out) {
      if (r._presence !== "both") continue;
      for (const c of cols) (r[`${c}_delta`] = vs), (r[`${c}_pct`] = vs);
    }
    warnings.push(`a is in ${rc.a}, b is in ${rc.b}: the figures are shown side by side, with no delta. Diff reports run in the same currency (subsidiaries that share one, or both consolidated).`);
  }
  const counts = { changed: 0, incomparable: 0, same: 0 };
  for (const r of out) {
    const o = cols.map((c) => outcome(r, c, tol));
    counts[o.includes("changed") ? "changed" : o.includes("incomparable") ? "incomparable" : "same"]++;
  }
  // Largest change first (over every value column); a key without a numeric delta ranks by the value it has; n/a values rank last.
  const mag = (r: Row) =>
    Math.max(
      -1,
      ...cols.map((c) => {
        const v = [r[`${c}_delta`], r[`${c}_a`], r[`${c}_b`]].find((x) => typeof x === "number");
        return typeof v === "number" ? Math.abs(v) : -1;
      }),
    );
  out.sort((x, y) => mag(y) - mag(x));
  return {
    columns: [...key, ...cols.flatMap((c) => [`${c}_a`, `${c}_b`, `${c}_delta`, `${c}_pct`]), "_presence"],
    rows: out,
    on: key,
    notes,
    warnings,
    warning: warnings.length ? warnings.join("\n⚠ ") : undefined,
    counts,
  };
}
