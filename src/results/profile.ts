import type { Row } from "../rows.ts";

/** `id`: integer identifiers (internal ids, reference ids). Never summed or thousands-separated. */
export type ColType = "num" | "id" | "date" | "bool" | "str";

export interface ColProfile {
  name: string;
  type: ColType;
  nulls: number;
  distinct: number;
  sum?: number;
  min?: number | string;
  max?: number | string;
  /** Why `sum` is left out of a num column: "mixed currencies", "currency unknown", "report rows nest". */
  sumNa?: string;
  /** One-line explanation for `sumNa` (and min/max caveats), for `nsx results schema`. */
  note?: string;
}

// Saved searches send `.00` for zero amounts.
const NUM = /^-?((\d{1,3}(,\d{3})+|\d+)(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/;
// Dates and datetimes: `2026-3-2`, `2026-03-02 07:18`, `2026-03-02T07:18:00.000Z`, `…+01:00`.
const ISO_DATE = /^\d{4}-\d{1,2}-\d{1,2}([T ]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*([ap]m|Z|[+-]\d{2}:?\d{2})?)?$/i;
const US_DATE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
const BOOL = /^(t|f|true|false)$/i;
const usDateOk = (v: string) => {
  const [m, d] = v.split("/").map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
};

/** Null, undefined, "" and whitespace-only strings (saved searches send blank cells as " "). */
export function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/**
 * A number from a cell: plain (`1,234.5`, `.00`, `-3`), and money as saved searches and reports
 * print it: a currency symbol or ISO code before or after (`$1,234.00`, `EUR 1,234.00`,
 * `1,234.00 USD`, `-$5`) and accounting negatives (`(1,234.00)`). Percentages (`12%`) and
 * anything else are not numbers.
 */
export function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (NUM.test(s)) return Number(s.replace(/,/g, ""));
  return moneyNumber(s);
}

const SYMBOL = /^[$€£¥]$/;
const isTag = (t: string) => SYMBOL.test(t) || ISO_4217.has(t);

function moneyNumber(input: string): number | undefined {
  let s = input;
  let neg = false;
  let marked = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) (s = paren[1].trim()), (neg = true), (marked = true);
  const minus = () => {
    if (!s.startsWith("-")) return true;
    if (neg) return false; // "(-5)" or "--5": not a number
    s = s.slice(1).trim();
    neg = true;
    return true;
  };
  if (!minus()) return undefined;
  const pre = /^([$€£¥]|[A-Z]{3}(?![A-Za-z]))\s*/.exec(s);
  if (pre && isTag(pre[1])) (s = s.slice(pre[0].length)), (marked = true);
  const suf = /\s*((?<![A-Za-z])[A-Z]{3}|[$€£¥])$/.exec(s);
  if (suf && isTag(suf[1])) (s = s.slice(0, suf.index)), (marked = true);
  if (!minus()) return undefined;
  if (!marked || s.startsWith("-") || !NUM.test(s)) return undefined;
  const n = Number(s.replace(/,/g, ""));
  return neg ? -n : n;
}

/** Sortable key for ISO (padded or not, with any time part kept) and M/D/YYYY dates. */
export function dateKey(v: string): string {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const i = /^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/.exec(v);
  return i ? `${i[1]}-${i[2].padStart(2, "0")}-${i[3].padStart(2, "0")}${i[4].replace(/^T/, " ")}` : v.slice(0, 10);
}

/** Money-ish column names: the only columns worth summing or suggesting as a measure. */
export const AMOUNT_LIKE = /amount|total|amt\b|balance|debit|credit|price|cost|revenue/i;
/** Columns suggested as the `--sum` metric in hints. */
const HINT_METRIC = /amount|total/i;
/** Integer ids by name: `id`, `*id`, `internalid`, doc/line numbers. */
const ID_NAME = /(^|[._\s-])(id|internalid|number|num|no|tranid|line|linesequencenumber)$|[a-z]id$/i;
const NOT_ID_NAME = /(paid|void|valid|fluid|rapid|avoid|liquid|humid)$/i;
/** Reference fields SuiteQL and saved searches return as bare internal ids. */
const REF_NAME = /^(subsidiary|currency|period|postingperiod|accountingperiod|entity|account|customer|vendor|employee|department|class|location|item|name|parent|createdby)$/i;
/** Saved-search reference labels: `Last Run By`, `Set By`, `lastmodifiedby` (employee ids), `From Bundle`, `Role`, `Owner`. */
const REF_LABEL = /(set|created|modified|last\s*run|owner|approved|entered|updated|submitted)\s*by$|(^|[\s._-])(bundle|role|owner)$/i;

const bare = (name: string) => name.slice(name.lastIndexOf(".") + 1).trim();

export function isAmountLike(name: string): boolean {
  return AMOUNT_LIKE.test(name);
}

export function isHintMetric(name: string): boolean {
  return HINT_METRIC.test(name);
}

export function idLikeName(name: string): boolean {
  const b = bare(name);
  if (isAmountLike(b)) return false;
  return REF_NAME.test(b) || REF_LABEL.test(b) || (ID_NAME.test(b) && !NOT_ID_NAME.test(b));
}

/**
 * Currency identity columns by name: `currency`, `Currency`, `t.currency`, `currencycode`, `curr`,
 * `ccy`, `basecurr` — not `Amount (Foreign Currency)`, exchange rates or `current*`/`recurring*`.
 */
export function isCurrencyColumn(name: string): boolean {
  const b = bare(name);
  if (!/currency|ccy|^curr|curr$/i.test(b)) return false;
  return !isAmountLike(name) && !/rate|current|recurr|precision/i.test(name);
}

/**
 * Amounts in some currency: money-ish names plus every `foreign*` column (foreigntotal,
 * foreignamountunpaid…), which is in the *transaction's* currency and differs row to row.
 */
export function isCurrencyBearing(name: string): boolean {
  if (isCurrencyColumn(name) || /rate/i.test(name)) return false;
  return isAmountLike(name) || /^foreign/i.test(bare(name)) || /foreign currency/i.test(name);
}

const ISO_4217 = new Set(
  ("AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF " +
    "CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK " +
    "HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL " +
    "MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON " +
    "RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS " +
    "UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL").split(" "),
);

const present = (rows: Row[], c: string) => rows.map((r) => r[c]).filter((v) => !isEmpty(v));
const allInts = (vs: unknown[]) => vs.every((v) => (typeof v === "number" && Number.isInteger(v)) || (typeof v === "string" && /^-?\d+$/.test(v.trim())));

export interface CurrencyColumns {
  /** The column to name in messages: a display column (`USD`) over an internal-id one (`1`). */
  column?: string;
  /** Every currency column found: grouping by any of them groups by currency. */
  columns: string[];
  /** Distinct values of `column`, sorted. */
  values: string[];
}

/**
 * Currency columns by name, else by value (every value an ISO 4217 code: a renamed
 * `BUILTIN.DF(t.currency) AS x`). Among several, the display-name one is preferred.
 */
export function findCurrency(columns: string[], rows: Row[]): CurrencyColumns {
  let found = columns.filter(isCurrencyColumn);
  if (!found.length) {
    found = columns.filter((c) => {
      if (isCurrencyBearing(c) || idLikeName(c)) return false;
      const vs = present(rows, c);
      return vs.length > 0 && vs.every((v) => typeof v === "string" && ISO_4217.has(v.trim()));
    });
  }
  if (!found.length) return { columns: [], values: [] };
  const display = found.find((c) => {
    const vs = present(rows, c);
    return vs.length > 0 && !allInts(vs);
  });
  const column = display ?? found[0];
  const values = [...new Set(present(rows, column).map(String))].sort();
  return { column, columns: found, values };
}

export interface CurrencyCheck extends CurrencyColumns {
  /** Numeric, currency-bearing columns. */
  amountColumns: string[];
  /** The subsidiary column, and how many subsidiaries the rows span. */
  subsidiary?: string;
  subsidiaries: number;
  /**
   * Base-currency amounts (not `foreign*`: e.g. transactionaccountingline.amount, a saved search's
   * Amount) on rows that span several subsidiaries: each is in its subsidiary's base currency, so
   * they add up only per subsidiary, whatever the transaction currency column says. Also listed in
   * `unknownColumns`.
   */
  baseAcrossSubs: string[];
  /**
   * `mixed`: amounts plus more than one currency. `unknown`: amounts on several rows but no
   * currency column, so a total may mix currencies. `single`: one currency. `none`: no amounts.
   */
  status: "mixed" | "unknown" | "single" | "none";
  /** With no currency column: the amount columns that may mix currencies (status `unknown`). */
  unknownColumns: string[];
}

export function currencyCheck(columns: string[], rows: Row[]): CurrencyCheck {
  const cur = findCurrency(columns, rows);
  const amountColumns = columns.filter((c) => {
    if (!isCurrencyBearing(c)) return false;
    const vs = present(rows, c);
    return vs.length > 0 && vs.every((v) => toNumber(v) !== undefined) && !isIdColumn(c, vs);
  });
  let status: CurrencyCheck["status"] = "none";
  let unknownColumns: string[] = [];
  const sub = columns.find((c) => /subsidiary/i.test(bare(c)) && !isCurrencyBearing(c) && !isCurrencyColumn(c));
  const subsidiaries = sub ? new Set(present(rows, sub).map((v) => String(v).trim())).size : 0;
  // A base amount (not foreign*) is in each subsidiary's base currency: across subsidiaries it
  // may mix currencies even when every row's transaction currency is the same.
  const baseAcrossSubs = subsidiaries > 1 ? amountColumns.filter((c) => !isForeignAmount(c) && present(rows, c).length > 1) : [];
  if (amountColumns.length) {
    if (cur.values.length > 1) (status = "mixed"), (unknownColumns = baseAcrossSubs);
    else if (cur.column) {
      unknownColumns = baseAcrossSubs;
      status = unknownColumns.length ? "unknown" : "single";
    }
    // No currency column: transaction-currency (foreign*) amounts may differ row to row, and base
    // amounts do across subsidiaries. A base amount on a single-subsidiary result is one
    // currency, so its plain total stands.
    else {
      unknownColumns = amountColumns.filter((c) => (isForeignAmount(c) || baseAcrossSubs.includes(c)) && present(rows, c).length > 1);
      status = unknownColumns.length ? "unknown" : "single";
    }
  }
  return { ...cur, amountColumns, status, unknownColumns, subsidiary: sub, subsidiaries, baseAcrossSubs };
}

/** `foreign*` amounts and saved-search `… (Foreign Currency)` columns: in the transaction's currency. */
export function isForeignAmount(name: string): boolean {
  return /^foreign/i.test(bare(name)) || /foreign currency/i.test(name);
}

/** Why a sum of `col` is n/a when currencyCheck lists it in `unknownColumns`: "2 subsidiaries" or "currency unknown". */
export function unknownLabel(check: CurrencyCheck, col: string): string {
  return check.baseAcrossSubs.includes(col) ? `${check.subsidiaries} subsidiaries` : "currency unknown";
}

/** Document ids a line-level result repeats once per line. */
const DOC_ID = /^(id|internalid|internal id|tranid|transaction|transactionid|transaction id|document number|document no\.?|docnumber|doc number|transactionnumber|transaction number)$/i;

/**
 * Header amounts on line rows: a transaction JOIN transactionline repeats `foreigntotal` on every
 * line of its document, so a sum counts it once per line. Returns amount column → the document id
 * column it repeats per, when the amount is the same on every line of each repeating document (at
 * least two such documents, or one with three or more lines).
 */
export function headerRepeats(columns: string[], rows: Row[]): Map<string, string> {
  const out = new Map<string, string>();
  const ids = columns.filter((c) => DOC_ID.test(bare(c)));
  if (!ids.length || rows.length < 2) return out;
  const amounts = columns.filter((c) => isCurrencyBearing(c) && present(rows, c).some((v) => toNumber(v) !== undefined));
  for (const id of ids) {
    const docs = new Map<string, Row[]>();
    for (const r of rows) {
      if (isEmpty(r[id])) continue;
      const k = String(r[id]).trim();
      const g = docs.get(k);
      if (g) g.push(r);
      else docs.set(k, [r]);
    }
    const multi = [...docs.values()].filter((g) => g.length > 1);
    if (!multi.length) continue;
    for (const a of amounts) {
      if (out.has(a)) continue;
      let constant = true;
      let valued = 0;
      let big = false;
      for (const g of multi) {
        const vs = g.map((r) => toNumber(r[a])).filter((v): v is number => v !== undefined);
        if (vs.length < 2) continue;
        if (vs.some((v) => v !== vs[0])) {
          constant = false;
          break;
        }
        valued++;
        if (vs.length > 2) big = true;
      }
      if (constant && (valued >= 2 || big)) out.set(a, id);
    }
  }
  return out;
}

export const headerRepeatNote = (col: string, id: string) =>
  `${col} repeats per ${id} (a header amount on line rows): sums count it once per line. Take one row per ${id} (--by ${id} --max ${col}) or query at header level.`;

/** Structural columns of a flattened ns_runReport result. */
export const REPORT_COLS = ["line", "depth", "is_detail", "kind"];
/** Report rows that carry no value of their own: the container row and blank lines. */
const REPORT_NO_VALUE = new Set(["structural", "spacer"]);
export const isReportShape = (columns: string[]) => REPORT_COLS.every((c) => columns.includes(c));

/** Counts and measures that happen to be small integers: never read as list ids. */
const MEASURE_NAME = /qty|quantit|count|units?\b|hours?|days?|minutes?|age\b|percent|%|score|weight|size|months?|years?|weeks?|seconds?|duration|nights?|pax|guests?|seats?|people/i;

/**
 * Integer columns that identify rather than measure: id-like names, or integer *strings*
 * (saved searches send references as "4810100") that are near-unique, or that repeat a few
 * small values (a list/select field such as `Handling Type`: 1, 2, 3).
 */
export function isIdColumn(name: string, present: unknown[]): boolean {
  if (!present.length || isAmountLike(name) || isCurrencyBearing(name)) return false;
  const ints = present.every((v) => (typeof v === "number" && Number.isInteger(v)) || (typeof v === "string" && /^-?\d+$/.test(v.trim())));
  if (!ints) return false;
  if (idLikeName(name)) return true;
  const strings = present.every((v) => typeof v === "string");
  if (!strings || present.length < 20) return false;
  const distinct = new Set(present.map((v) => String(v).trim()));
  if (distinct.size >= present.length * 0.9) return true;
  return !MEASURE_NAME.test(name) && distinct.size <= 12 && distinct.size <= present.length / 5 && [...distinct].every((v) => /^\d{1,4}$/.test(v));
}

/** The currency column and its values when amounts span more than one currency. */
export function mixedCurrency(columns: string[], rows: Row[]): { column: string; values: string[] } | undefined {
  const c = currencyCheck(columns, rows);
  return c.status === "mixed" && c.column ? { column: c.column, values: c.values } : undefined;
}

export function inferType(values: unknown[]): ColType {
  const present = values.filter((v) => !isEmpty(v));
  if (!present.length) return "str";
  if (present.every((v) => typeof v === "boolean" || (typeof v === "string" && BOOL.test(v)))) return "bool";
  // Leading-zero strings ("00123") are codes, not numbers.
  if (present.every((v) => toNumber(v) !== undefined && !(typeof v === "string" && /^0\d/.test(v)))) return "num";
  // M/D/YYYY only: a "month" above 12 is D/M/YYYY (or not a date), which dateKey would misread.
  if (present.every((v) => typeof v === "string" && (ISO_DATE.test(v) || (US_DATE.test(v.trim()) && usDateOk(v.trim()))))) return "date";
  return "str";
}

/** Rates, ratios and percentages: a column sum means nothing (27 exchange rates don't add to 27.37 of anything). */
export const NOT_SUMMABLE = /exchange\s*_?rate|fx\s*_?rate|taxrate|(^|[\s._(-])(rate|ratio|pct|percent|percentage)s?([\s._)-]|$)|%/i;

/**
 * Worth summing: amounts, counts/quantities, and anything with fractions. An all-integer column
 * with another name (`Last Run By`, a status code, a year) gets min/max only.
 */
export function summable(name: string, present: unknown[]): boolean {
  if (NOT_SUMMABLE.test(name)) return false;
  if (isAmountLike(name) || isCurrencyBearing(name) || MEASURE_NAME.test(name)) return true;
  return !allInts(present);
}

/**
 * Per-column stats. A sum is left out (with `sumNa`/`note`) where adding rows is wrong: amounts in
 * mixed or unknown currencies, and every value column of a report (rows nest). Integer columns
 * that aren't amounts or counts get no sum (and no note). Report min/max skip the structural
 * container row and spacer lines, and the report's own columns (depth…) get no sum.
 */
export function profileColumns(columns: string[], rows: Row[]): ColProfile[] {
  const report = isReportShape(columns);
  const cur = report ? undefined : currencyCheck(columns, rows);
  const repeats = report ? new Map<string, string>() : headerRepeats(columns, rows);
  const list = (vs: string[]) => (vs.length > 6 ? `${vs.slice(0, 6).join(", ")}…` : vs.join(", "));
  const valueRows = report ? rows.filter((r) => !REPORT_NO_VALUE.has(String(r.kind))) : rows;
  return columns.map((name) => {
    const vals = rows.map((r) => r[name]);
    const present = vals.filter((v) => !isEmpty(v));
    let type = inferType(vals);
    if (type === "num" && isIdColumn(name, present)) type = "id";
    const p: ColProfile = { name, type, nulls: vals.length - present.length, distinct: new Set(present.map(String)).size };
    if (type === "num") {
      const structuralCol = report && REPORT_COLS.includes(name);
      const measured = report && !structuralCol ? valueRows.map((r) => r[name]).filter((v) => !isEmpty(v)) : present;
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const v of measured) {
        const n = toNumber(v)!;
        sum += n;
        if (n < min) min = n;
        if (n > max) max = n;
      }
      p.sum = summable(name, present) ? sum : undefined;
      if (measured.length) {
        p.min = min;
        p.max = max;
      }
      if (structuralCol) {
        p.sum = undefined;
      } else if (report) {
        p.sum = undefined;
        p.sumNa = "report rows nest";
        p.note = "report rows nest (sections > groups > accounts > detail lines): a column sum double-counts subtotals.";
      } else if (cur && cur.amountColumns.includes(name) && cur.status === "mixed") {
        p.sum = undefined;
        p.sumNa = "mixed currencies";
        p.note = `amounts are in ${cur.values.length} currencies (${cur.column}: ${list(cur.values)}): no sum, and min/max compare different currencies. Group by ${cur.column}.`;
      } else if (cur && cur.baseAcrossSubs.includes(name)) {
        p.sum = undefined;
        p.sumNa = `${cur.subsidiaries} subsidiaries`;
        p.note = `base-currency amounts across ${cur.subsidiaries} subsidiaries (${cur.subsidiary}): each is in its subsidiary's currency, so they add up only per subsidiary. Group by ${cur.subsidiary}.`;
      } else if (cur && cur.unknownColumns.includes(name) && cur.status === "unknown") {
        p.sum = undefined;
        p.sumNa = "currency unknown";
        p.note = "currency unknown: no currency column, so this total may mix currencies. Add one (SuiteQL: BUILTIN.DF(t.currency) AS currency) and group by it.";
      } else if (repeats.has(name) && p.sum !== undefined) {
        const id = repeats.get(name)!;
        p.sum = undefined;
        p.sumNa = `repeats per ${id}`;
        p.note = headerRepeatNote(name, id);
      }
    } else if (type === "date") {
      const keys = present.map((v) => dateKey(String(v))).sort();
      p.min = keys[0];
      p.max = keys[keys.length - 1];
    }
    return p;
  });
}
