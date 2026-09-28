/**
 * Heuristic SuiteQL checker. Errors are cases where the query is known to return wrong or
 * wasteful results; warnings are likely-but-not-certain problems. Everything here must be
 * fixable from the message alone.
 */
import { type Scope, type Tok, scopes, tokenize } from "./tokenize.ts";

export interface Finding {
  rule: string;
  message: string;
  /** unknown-column / unknown-custom-field: the column as "table.column" (lower-case) */
  columns?: string[];
}

export interface LintContext {
  /** table (lower-case) → set of known column names (lower-case); only for fresh caches */
  fields?: (table: string) => Set<string> | undefined;
  /** known SuiteQL record types (lower-case), if cached */
  recordTypes?: Set<string>;
  /** transaction type code → has approval workflow */
  approvalWorkflows?: Record<string, boolean>;
  /**
   * Metadata type of table.column (both lower-case), lower-cased as the connector reports it
   * ("string", "double", "date", …); undefined when unknown. Only for fresh caches.
   */
  fieldType?: (table: string, column: string) => string | undefined;
  /**
   * The account's subsidiaries use more than one currency (profile). Then SUM(tal.amount) across
   * subsidiaries adds different base currencies together.
   */
  multiCurrencySubsidiaries?: boolean;
}

/**
 * Rules [nolint] can't override: the query is always rejected or always returns the wrong rows.
 * The ROWNUM rules are live-verified always wrong (2026-09-27): ROWNUM with GROUP BY/aggregates or
 * over a sorted/aggregated subquery caps rows before aggregating; ROWNUM > n returns no rows.
 */
export const HARD_RULES = new Set([
  "not-select", "offset-ignored", "html-entity", "multi-statement",
  "rownum-over-subquery", "rownum-with-aggregate", "rownum-greater-than",
]);

export interface LintResult {
  errors: Finding[];
  warnings: Finding[];
  /** Rewritten query when every error is fixable (ROWNUM placement, LIMIT, OFFSET). */
  fixed?: string;
  /** With an OFFSET fix: the connector paging that returns the page OFFSET asked for, with `fixed`. */
  paging?: { pageSize: number; pageIndex: number };
}

// LISTAGG stays here so its block still counts as aggregating; unsupported-function rejects it anyway.
const AGGREGATES = new Set(["sum", "count", "avg", "min", "max", "listagg", "median", "stddev", "variance"]);
const CLAUSES = new Set(["select", "from", "where", "group", "having", "order", "fetch", "offset", "union", "minus", "intersect", "connect", "start"]);
const NOT_ALIAS = new Set([
  "on", "where", "left", "right", "inner", "outer", "full", "cross", "join", "group", "order", "having",
  "union", "minus", "fetch", "offset", "as", "and", "or", "connect", "start",
]);
const CUSTOM_PREFIX = /^(custbody|custcol|custentity|custitem|custrecord|custevent|custpage)/;

/**
 * transaction.type takes internal codes; transaction.recordtype takes record ids.
 * Not yet verified against a live account: the mapping below is from NetSuite docs.
 */
export const TYPE_CODES: Record<string, string> = {
  custinvc: "invoice", salesord: "salesorder", vendbill: "vendorbill", purchord: "purchaseorder",
  journal: "journalentry", custpymt: "customerpayment", vendpymt: "vendorpayment", custcred: "creditmemo",
  vendcred: "vendorcredit", cashsale: "cashsale", estimate: "estimate", itemrcpt: "itemreceipt",
  itemship: "itemfulfillment", deposit: "deposit", check: "check", invadjst: "inventoryadjustment",
  trnfrord: "transferorder", exprept: "expensereport", rtnauth: "returnauthorization", custrfnd: "customerrefund",
  opprtnty: "opportunity", cardchrg: "creditcardcharge", cardrfnd: "creditcardrefund", workord: "workorder",
  vendauth: "vendorreturnauthorization", transfer: "transfer", fxreval: "fxreval", custdep: "customerdeposit",
  depappl: "depositapplication", cashrfnd: "cashrefund", statchng: "statisticaljournalentry",
};
const CODE_DISPLAY: Record<string, string> = Object.fromEntries(
  ["CustInvc", "SalesOrd", "VendBill", "PurchOrd", "Journal", "CustPymt", "VendPymt", "CustCred", "VendCred", "CashSale",
    "Estimate", "ItemRcpt", "ItemShip", "Deposit", "Check", "InvAdjst", "TrnfrOrd", "ExpRept", "RtnAuth", "CustRfnd",
    "Opprtnty", "CardChrg", "CardRfnd", "WorkOrd", "VendAuth", "Transfer", "FxReval", "CustDep", "DepAppl", "CashRfnd", "StatChng",
  ].map((c) => [c.toLowerCase(), c]),
);
const RECORD_TO_CODE: Record<string, string> = Object.fromEntries(Object.entries(TYPE_CODES).map(([c, r]) => [r, c]));

interface ScopeInfo {
  scope: Scope;
  /** direct token indices where ROWNUM appears in WHERE/HAVING */
  rownum: number[];
  /** ROWNUM inside non-subquery parentheses in WHERE/HAVING, e.g. `WHERE (ROWNUM <= 10)` */
  rownumNested: number;
  /** ROWNUM in a JOIN … ON condition (never rewritten) */
  rownumInOn: number;
  aggregate: boolean;
  groupBy: boolean;
  orderBy: boolean;
  /** UNION / MINUS / INTERSECT at this level */
  compound: boolean;
  /** ROWNUM and GROUP BY/aggregates in the same (branch of the) query block */
  rownumWithAggregate: boolean;
  /** ROWNUM and ORDER BY in the same query block (never for compound queries) */
  rownumWithOrderBy: boolean;
  /** alias → table (lower-case); includes table → table; subquery aliases map to "(subquery)" */
  aliases: Map<string, string>;
  fromTable?: string;
  fromAlias?: string;
  fromSubquery: boolean;
  selectStar: boolean;
  leftJoinOnDates: boolean;
  /** aliases on the left side of a LEFT JOIN whose ON has a date/posting filter */
  leftSide: Set<string>;
  /** `alias.col` date/posting filters on a LEFT JOIN's left side inside its ON (they don't drop left rows) */
  leftOnLeftFilters: string[];
  probeLimit: boolean;
  /** OFFSET/FETCH at this level */
  fetch: boolean;
  /** direct token indices of `LIMIT <n>` */
  limit: number[];
  /** OFFSET at this level (LIMIT … OFFSET, OFFSET … FETCH) */
  offset: boolean;
  /** direct indices of `OFFSET n` where n isn't literally 0 */
  offsetSkip: number[];
  /** names a qualified reference may use here: each source's alias, or the table name if it has none */
  declared: string[];
  /** open-paren token index of the FROM subquery */
  fromSource?: number;
  /** currency in GROUP BY, or one currency picked in an AND-only WHERE */
  singleCurrency: boolean;
  /** subsidiary in GROUP BY, or one subsidiary picked in an AND-only WHERE */
  singleSubsidiary: boolean;
  /** words in GROUP BY (incl. inside function calls) */
  groupWords: Set<string>;
}

const SET_OPS = new Set(["union", "minus", "intersect", "except"]);
export const SUBQUERY = "(subquery)";

function analyzeScope(toks: Tok[], s: Scope, byOpen: Map<number, Scope>): ScopeInfo {
  const info: ScopeInfo = {
    scope: s, rownum: [], rownumNested: 0, rownumInOn: 0, aggregate: false, groupBy: false, orderBy: false, compound: false,
    rownumWithAggregate: false, rownumWithOrderBy: false, aliases: new Map(),
    fromSubquery: false, selectStar: false, leftJoinOnDates: false, leftSide: new Set(), leftOnLeftFilters: [], probeLimit: false,
    fetch: false, limit: [], offset: false, offsetSkip: [], declared: [], singleCurrency: false,
    singleSubsidiary: false, groupWords: new Set(),
  };
  let clause = "";
  let inLeftJoinOn = false;
  let inOn = false;
  // per set-operation branch
  let bRownum = false;
  let bAgg = false;
  const closeBranch = () => {
    if (bRownum && bAgg) info.rownumWithAggregate = true;
    bRownum = false;
    bAgg = false;
  };
  const d = s.direct;
  let leftNow = new Set<string>();
  /** A row source starting at direct index j (after FROM, JOIN or a FROM-list comma). */
  const addSource = (j: number, isFrom: boolean) => {
    const first = toks[d[j]];
    if (first?.type === "lp") {
      if (isFrom) {
        info.fromSubquery = true;
        info.fromSource = d[j];
      }
      // alias after the closing paren: FROM (…) x / FROM (…) AS x
      const close = byOpen.get(d[j])?.close;
      const ci = d.indexOf(close ?? -1);
      if (ci >= 0) {
        let a = toks[d[ci + 1]];
        if (a?.type === "word" && a.value === "as") a = toks[d[ci + 2]];
        if (a && (a.type === "word" || a.type === "qid") && !NOT_ALIAS.has(a.value)) {
          info.aliases.set(a.value, SUBQUERY);
          info.declared.push(a.value);
        }
      }
    } else if (first?.type === "word" || first?.type === "qid") {
      const table = first.value;
      let a = toks[d[j + 1]];
      if (a?.type === "word" && a.value === "as") a = toks[d[j + 2]];
      const alias = a && (a.type === "word" || a.type === "qid") && !NOT_ALIAS.has(a.value) ? a.value : undefined;
      info.aliases.set(table, table);
      if (alias) info.aliases.set(alias, table);
      info.declared.push(alias ?? table);
      if (isFrom) {
        info.fromTable = table;
        info.fromAlias = alias ?? table;
      }
    }
  };
  for (let k = 0; k < d.length; k++) {
    const t = toks[d[k]];
    const next = toks[d[k + 1]];
    if (t.type === "lp") {
      const child = byOpen.get(d[k]);
      const prev = toks[d[k - 1]];
      // Non-query parens (function args, grouped predicates) belong to this block.
      // OVER (...) holds window ORDER BY/PARTITION BY, not this block's clauses.
      if (child && !child.isQuery && !(prev?.type === "word" && prev.value === "over")) {
        if (findInParens(toks, child, byOpen, (x, nx) => x.type === "word" && AGGREGATES.has(x.value) && nx?.type === "lp")) bAgg = info.aggregate = true;
        if ((clause === "where" || clause === "having") && findInParens(toks, child, byOpen, (x) => x.type === "word" && x.value === "rownum")) {
          info.rownumNested++;
          bRownum = true;
        } else if (inOn && findInParens(toks, child, byOpen, (x) => x.type === "word" && x.value === "rownum")) {
          info.rownumInOn++;
          bRownum = true;
        }
        // GROUP BY BUILTIN.DF(t.currency)
        if (clause === "group") findInParens(toks, child, byOpen, (x) => (x.type === "word" && info.groupWords.add(x.value), false));
      }
    }
    if (t.type === "word") {
      const prevW = toks[d[k - 1]];
      // OFFSET/FETCH are clauses only with their argument: `SELECT a.acctnumber offset FROM …` is an alias.
      const keyword =
        t.value === "offset" ? offsetKeyword(prevW, next) : t.value === "fetch" ? prevW?.type !== "dot" && (isWord(next, "first") || isWord(next, "next")) : true;
      if ((CLAUSES.has(t.value) && keyword) || SET_OPS.has(t.value)) {
        clause = t.value;
        inLeftJoinOn = false;
        inOn = false;
      }
      if (SET_OPS.has(t.value)) {
        info.compound = true;
        closeBranch();
      }
      if (t.value === "group" && next?.value === "by") bAgg = info.groupBy = true;
      if (t.value === "order" && next?.value === "by") info.orderBy = true;
      if ((t.value === "fetch" || t.value === "offset") && keyword) info.fetch = true;
      if (t.value === "offset" && keyword) info.offset = true;
      if (t.value === "limit" && next?.type === "num" && toks[d[k - 1]]?.type !== "dot") info.limit.push(k);
      if (clause === "group") info.groupWords.add(t.value);
      if (AGGREGATES.has(t.value) && next?.type === "lp") bAgg = info.aggregate = true;
      if (t.value === "rownum" && (clause === "where" || clause === "having")) {
        info.rownum.push(k);
        bRownum = true;
      } else if (t.value === "rownum" && inOn) {
        info.rownumInOn++;
        bRownum = true;
      }
      if (t.value === "join") inLeftJoinOn = inOn = false;
      if (t.value === "on") {
        inOn = true;
        inLeftJoinOn = lastJoinKind(toks, d, k) === "left";
        // Everything declared before the joined source is its left side.
        if (inLeftJoinOn) leftNow = new Set(info.declared.slice(0, -1));
      }
      if (inLeftJoinOn && /^(trandate|postingperiod|posting|startdate|enddate|periodname)$/.test(t.value)) {
        info.leftJoinOnDates = true;
        for (const a of leftNow) info.leftSide.add(a);
        const alias = prevW?.type === "dot" ? toks[d[k - 2]]?.value : undefined;
        if (alias && leftNow.has(alias)) info.leftOnLeftFilters.push(`${toks[d[k - 2]].raw}.${t.raw}`);
      }

      if ((t.value === "from" || t.value === "join") && next) addSource(k + 1, t.value === "from");
      if (t.value === "offset" && keyword && intOf(next) !== 0) info.offsetSkip.push(k);
      if (clause === "fetch" && (t.value === "first" || t.value === "next") && next?.type === "num" && Number(next.value) <= 1) info.probeLimit = true;
      if (t.value === "rownum" && next?.type === "op" && toks[d[k + 2]]?.type === "num") {
        const n = Number(toks[d[k + 2]].value);
        if ((next.value === "<=" && n <= 1) || (next.value === "=" && n === 1) || (next.value === "<" && n <= 2)) info.probeLimit = true;
      }
    }
    if (t.type === "comma" && clause === "from" && next) addSource(k + 1, false);
    if (t.type === "star" && clause === "select") {
      const prev = toks[d[k - 1]];
      const isSelectStar = prev && (prev.type === "comma" || prev.type === "dot" || (prev.type === "word" && (prev.value === "select" || prev.value === "distinct" || prev.value === "all" || prev.value === "unique")));
      if (isSelectStar) info.selectStar = true;
    }
  }
  closeBranch();
  info.singleCurrency = info.groupWords.has("currency") || whereSingle(toks, s, byOpen, "currency");
  info.singleSubsidiary = info.groupWords.has("subsidiary") || whereSingle(toks, s, byOpen, "subsidiary");
  const anyRownum = rownumCount(info) > 0;
  if (!info.compound && anyRownum && (info.groupBy || info.aggregate)) info.rownumWithAggregate = true;
  // A trailing ORDER BY on a compound query sorts the combined result; branch ROWNUMs are unrelated.
  if (!info.compound && anyRownum && info.orderBy && !info.rownumWithAggregate) info.rownumWithOrderBy = true;
  return info;
}

/** Search a non-query paren scope and its non-query descendants (subqueries are their own blocks). */
function findInParens(toks: Tok[], s: Scope, byOpen: Map<number, Scope>, pred: (t: Tok, next: Tok | undefined) => boolean): boolean {
  for (let j = 0; j < s.direct.length; j++) {
    const t = toks[s.direct[j]];
    if (pred(t, toks[s.direct[j + 1]])) return true;
    if (t.type === "lp") {
      const c = byOpen.get(s.direct[j]);
      if (c && !c.isQuery && findInParens(toks, c, byOpen, pred)) return true;
    }
  }
  return false;
}

const rownumCount = (q: ScopeInfo) => q.rownum.length + q.rownumNested + q.rownumInOn;

/** OFFSET as a clause keyword: followed by its row count (a number, parameter or expression), not an alias. */
function offsetKeyword(prev: Tok | undefined, next: Tok | undefined): boolean {
  if (prev?.type === "dot" || isWord(prev, "as")) return false;
  return next?.type === "num" || next?.type === "param" || next?.type === "lp";
}

/**
 * One value of `column` (currency, subsidiary) picked in an AND-only WHERE: `col = <literal>`,
 * `col IN (<one literal>)` or `BUILTIN.DF(col) = <literal>`. Any OR in the WHERE (outside
 * subqueries) means it may be several.
 */
function whereSingle(toks: Tok[], s: Scope, byOpen: Map<number, Scope>, column: string): boolean {
  const d = s.direct;
  const lit = (x: Tok | undefined) => x?.type === "num" || x?.type === "str" || x?.type === "param";
  let found = false;
  for (let w = 0; w < d.length; w++) {
    if (!isWord(toks[d[w]], "where")) continue;
    let e = w + 1;
    while (e < d.length && !(toks[d[e]].type === "word" && (CLAUSES.has(toks[d[e]].value) || SET_OPS.has(toks[d[e]].value)))) e++;
    const end = e < d.length ? d[e] : s.close;
    let single = false;
    for (let i = d[w] + 1; i < end; i++) {
      const t = toks[i];
      if (t.type === "lp" && byOpen.get(i)?.isQuery) {
        i = byOpen.get(i)!.close;
        continue;
      }
      if (isWord(t, "or")) return false;
      if (!isWord(t, column)) continue;
      const start = toks[i - 1]?.type === "dot" ? i - 2 : i;
      if (isOp(toks[i + 1], "=") && lit(toks[i + 2])) single = true;
      else if (isWord(toks[i + 1], "in") && toks[i + 2]?.type === "lp" && lit(toks[i + 3]) && toks[i + 4]?.type === "rp") single = true;
      else if (toks[i + 1]?.type === "rp" && toks[start - 1]?.type === "lp" && isWord(toks[start - 2], "df") && isOp(toks[i + 2], "=") && lit(toks[i + 3])) single = true;
    }
    if (single) found = true;
  }
  return found;
}

/** The clause (where, having, on, select, …) of query block q that token i sits in. */
function clauseAt(toks: Tok[], q: ScopeInfo, i: number): string {
  let clause = "";
  for (const j of q.scope.direct) {
    if (j >= i) break;
    const t = toks[j];
    if (t.type !== "word") continue;
    if (CLAUSES.has(t.value) || SET_OPS.has(t.value) || t.value === "on" || t.value === "join") clause = t.value;
  }
  return clause;
}

/** approvalstatus (at token i) compared with a value: =, <>, <, …, [NOT] IN, BETWEEN, LIKE (not IS [NOT] NULL). */
function approvalCompared(toks: Tok[], i: number): boolean {
  const next = toks[i + 1];
  if (next?.type === "op" && COMPARE.has(next.value)) return true;
  if (isWord(next, "in") || isWord(next, "between") || isWord(next, "like")) return true;
  if (isWord(next, "not") && (isWord(toks[i + 2], "in") || isWord(toks[i + 2], "between") || isWord(toks[i + 2], "like"))) return true;
  const start = toks[i - 1]?.type === "dot" ? i - 2 : i;
  const before = toks[start - 1];
  return before?.type === "op" && COMPARE.has(before.value);
}

/** Aliases whose columns appear inside aggregate calls of query block q (not in its subqueries). */
function aggregatesOver(toks: Tok[], infos: ScopeInfo[], q: ScopeInfo): string[] {
  const out: string[] = [];
  const end = Math.min(q.scope.close, toks.length);
  for (let i = q.scope.open + 1; i + 1 < end; i++) {
    if (!(toks[i].type === "word" && AGGREGATES.has(toks[i].value) && toks[i + 1].type === "lp") || enclosing(infos, i)[0] !== q) continue;
    const close = toks.findIndex((x, j) => j > i + 1 && x.type === "rp" && x.depth === toks[i + 1].depth);
    for (const r of columnRefs(toks.slice(i + 2, close < 0 ? end : close))) out.push(r.alias);
  }
  return out;
}

function analyze(toks: Tok[]): ScopeInfo[] {
  const all = scopes(toks);
  const byOpen = new Map(all.filter((x) => x.open >= 0).map((x) => [x.open, x]));
  return all.map((x) => analyzeScope(toks, x, byOpen));
}

function lastJoinKind(toks: Tok[], d: number[], k: number): string | undefined {
  for (let j = k - 1; j >= 0; j--) {
    const t = toks[d[j]];
    if (t.type !== "word") continue;
    if (t.value === "join") {
      const p = toks[d[j - 1]];
      const pp = toks[d[j - 2]];
      if (p?.value === "outer") return pp?.value;
      return p?.type === "word" ? p.value : "inner";
    }
    if (CLAUSES.has(t.value)) return undefined;
  }
  return undefined;
}

/**
 * All `alias.column` references (and `alias.*` when star is set), with the token index of the alias.
 * Skipped: `a.b.c` (schema-qualified), and `ns.fn(` (BUILTIN.DF(…), BUILTIN.CONSOLIDATE(…)):
 * a package namespace, not an alias.
 */
function columnRefs(toks: Tok[], star = false): { alias: string; col: string; idx: number }[] {
  const out: { alias: string; col: string; idx: number }[] = [];
  for (let i = 0; i + 2 < toks.length; i++) {
    const a = toks[i], dot = toks[i + 1], c = toks[i + 2];
    if ((a.type === "word" || a.type === "qid") && dot.type === "dot" && (c.type === "word" || c.type === "qid" || (star && c.type === "star"))) {
      if (toks[i - 1]?.type === "dot" || toks[i + 3]?.type === "dot") continue;
      if (toks[i + 3]?.type === "lp") continue;
      out.push({ alias: a.value, col: c.value, idx: i });
    }
  }
  return out;
}

/** Optimal-string-alignment distance: Levenshtein plus adjacent swaps (amout → amount = 1, tpye → type = 1). */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Candidates within distance 2 (and at most half the name, so `ab` doesn't match `id`), nearest first. */
function closest(col: string, pool: string[]): string[] {
  const scored = pool.map((c) => ({ c, n: editDistance(col, c) })).filter((x) => x.n > 0 && x.n <= 2 && 2 * x.n <= col.length);
  const best = Math.min(...scored.map((x) => x.n));
  return scored.filter((x) => x.n === best).map((x) => x.c).sort().slice(0, 3);
}

/** Columns a lint result flagged as missing from the metadata, as "table.column" (unknown-column and unknown-custom-field). */
export function unknownColumns(r: LintResult): string[] {
  return [...new Set(r.warnings.flatMap((w) => w.columns ?? []))];
}

/** The innermost query scope containing token idx. */
function enclosing(infos: ScopeInfo[], idx: number): ScopeInfo[] {
  return infos
    .filter((s) => s.scope.isQuery && s.scope.open < idx && idx < s.scope.close)
    .sort((a, b) => b.scope.depth - a.scope.depth);
}

function resolveAlias(infos: ScopeInfo[], idx: number, alias: string): string | undefined {
  for (const s of enclosing(infos, idx)) {
    const t = s.aliases.get(alias);
    if (t) return t;
  }
  return undefined;
}

/**
 * (column, literal) pairs for `x.type = 'A'` / `type IN ('A','B')` and the same for recordtype.
 * `negated`: `<>`, `!=` or NOT IN (the literal is excluded, not selected).
 */
function typeLiterals(toks: Tok[]): { column: "type" | "recordtype"; value: string; idx: number; negated: boolean }[] {
  const out: { column: "type" | "recordtype"; value: string; idx: number; negated: boolean }[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== "word" || (t.value !== "type" && t.value !== "recordtype")) continue;
    if (toks[i + 1]?.type === "lp") continue; // function call
    const op = toks[i + 1];
    if (op?.type === "op" && (op.value === "=" || op.value === "<>" || op.value === "!=") && toks[i + 2]?.type === "str") {
      out.push({ column: t.value, value: toks[i + 2].value, idx: i, negated: op.value !== "=" });
    } else if (op?.type === "word" && (op.value === "in" || (op.value === "not" && toks[i + 2]?.value === "in"))) {
      let j = i + (op.value === "not" ? 3 : 2);
      if (toks[j]?.type !== "lp") continue;
      for (j++; j < toks.length && toks[j].type !== "rp"; j++) {
        if (toks[j].type === "str") out.push({ column: t.value, value: toks[j].value, idx: i, negated: op.value === "not" });
      }
    }
  }
  return out;
}

/** A result branch of an indicator: a numeric literal (optionally signed) or NULL. */
function constantBranch(toks: Tok[], from: number, to: number): boolean {
  const b = toks.slice(from, to);
  if (b.length === 2 && b[0].type === "op" && (b[0].value === "-" || b[0].value === "+")) b.shift();
  return b.length === 1 && (b[0].type === "num" || isWord(b[0], "null"));
}

/**
 * SUM(<lp> … <close>) whose whole argument is a CASE or DECODE with only constant results, e.g.
 * SUM(CASE WHEN … THEN 1 ELSE 0 END) or SUM(DECODE(x, 'A', 1, 0)): it counts rows, it doesn't add amounts.
 */
function indicatorSum(toks: Tok[], lp: number, close: number): boolean {
  if (close < 0) return false;
  const d = toks[lp].depth + 1;
  const first = toks[lp + 1];
  if (isWord(first, "case") && isWord(toks[close - 1], "end") && toks[close - 1].depth === d) {
    // Branch keywords of this CASE only (a nested CASE sits between its own CASE … END).
    let nest = 0;
    let start = -1;
    let branches = 0;
    for (let j = lp + 2; j < close; j++) {
      const t = toks[j];
      if (t.depth !== d || t.type !== "word") continue;
      if (t.value === "case") nest++;
      if (nest > 0) {
        if (t.value === "end") nest--;
        continue;
      }
      if (t.value === "when" || t.value === "else" || t.value === "end") {
        if (start >= 0) {
          if (!constantBranch(toks, start, j)) return false;
          branches++;
          start = -1;
        }
        if (t.value === "else") start = j + 1;
      } else if (t.value === "then") start = j + 1;
    }
    return branches > 0;
  }
  if (isWord(first, "decode") && toks[lp + 2]?.type === "lp") {
    const dlp = lp + 2;
    const dclose = toks.findIndex((x, j) => j > dlp && x.type === "rp" && x.depth === toks[dlp].depth);
    if (dclose !== close - 1) return false;
    const args: [number, number][] = [];
    let s0 = dlp + 1;
    for (let j = dlp + 1; j <= dclose; j++) {
      if (j === dclose || (toks[j].type === "comma" && toks[j].depth === d + 1)) {
        args.push([s0, j]);
        s0 = j + 1;
      }
    }
    if (args.length < 3) return false;
    const results: number[] = [];
    for (let k = 2; k < args.length; k += 2) results.push(k);
    if (args.length % 2 === 0) results.push(args.length - 1);
    return results.every((k) => constantBranch(toks, args[k][0], args[k][1]));
  }
  return false;
}

/** Rules whose errors fixQuery can rewrite. */
const FIXABLE = new Set(["rownum-with-aggregate", "rownum-with-order-by", "rownum-over-subquery", "limit-clause", "offset-ignored"]);
// WITH is accepted here only so the query reaches cte-unsupported (a clearer message than not-select).
const READ_START = new Set(["select", "with"]);
// Budget (header) and Budget by Period: https://www.netsuite.com.au/help/helpcenter/en_US/srbrowser/Browser2021_1/analytics/record/budgets.html
// and …/budgetsMachine.html (fields budget, period, amount); both in the live record-type list 2026-09-27.
const BUDGET_TABLES = new Set(["budgets", "budgetsmachine"]);
const FACT_TABLES = new Set(["transaction", "transactionline", "transactionaccountingline"]);
/** transactionaccountingline amount columns (base currency of the line's subsidiary). */
const TAL_AMOUNTS = new Set(["amount", "debit", "credit", "netamount"]);

/**
 * Standard columns the connector's ns_getSuiteQLMetadata leaves out but SuiteQL accepts.
 * Allowed, not recommended: prefer the documented columns in the skill.
 */
const HIDDEN_COLUMNS: Record<string, Set<string>> = {
  // live-verified query 2026-09-27; undocumented (transaction currency per Oracle, not base currency)
  transactionline: new Set(["amount"]),
  // live-verified query 2026-09-27; undocumented (documented: fullname, accountsearchdisplayname)
  account: new Set(["acctname"]),
  // "Sub-period of": https://www.netsuite.com.au/help/helpcenter/en_US/srbrowser/Browser2021_1/analytics/record/accountingPeriod.html
  accountingperiod: new Set(["parent"]),
};

const FETCH_FIRST = "Put ORDER BY … FETCH FIRST N ROWS ONLY at the end of the query instead (or use the connector's pageSize + pageIndex: 0). Don't wrap it as SELECT * FROM (…) WHERE ROWNUM <= N: NetSuite applies that outer ROWNUM before the inner GROUP BY/ORDER BY too.";

export function lintSuiteQL(sql: string, ctx: LintContext = {}): LintResult {
  const result = lintOnly(sql, ctx);
  if (result.errors.length && result.errors.every((e) => FIXABLE.has(e.rule))) {
    // OFFSET only has a fix when pageSize + pageIndex can ask for the same page.
    const paging = result.errors.some((e) => e.rule === "offset-ignored") ? offsetPaging(sql) : undefined;
    const base = paging ? paging.sql : sql;
    const fixed = fixQuery(base);
    // A fix that still fails the checks is not offered.
    if ((paging || fixed !== sql) && !lintOnly(fixed, ctx).errors.length) {
      result.fixed = fixed;
      if (paging) result.paging = { pageSize: paging.pageSize, pageIndex: paging.pageIndex };
    }
  }
  return result;
}

/**
 * True when every statement is a SELECT/WITH query. Not a safety boundary: the connector itself
 * only runs read-only queries (article_0905091645: "Only read-only queries are supported"). This
 * just turns a NetSuite error after the call into a clear message before it.
 */
export function isReadQuery(sql: string): boolean {
  return statementHeads(tokenize(sql)).every((t) => t.type === "word" && READ_START.has(t.value));
}

/**
 * The first token of each non-empty statement (split on `;`), skipping only the statement's
 * LEADING parens: "(DELETE FROM t)" starts with DELETE, but the CASE in "SELECT SUM(CASE …)" is
 * never a statement start.
 */
function statementHeads(toks: Tok[]): Tok[] {
  const heads: Tok[] = [];
  let first = true;
  for (const t of toks) {
    if (t.type === "semi") {
      first = true;
      continue;
    }
    if (!first) continue;
    if (t.type === "lp") continue;
    heads.push(t);
    first = false;
  }
  return heads;
}

const HTML_ENTITY = /&(?:(lt|gt|le|ge|amp|quot|apos|nbsp)|#(\d{1,7})|#x([0-9a-f]{1,6}));/gi;
const NAMED_ENTITY: Record<string, string> = { lt: "<", gt: ">", le: "<=", ge: ">=", amp: "&", quot: '"', apos: "'", nbsp: " " };

/**
 * HTML entities outside string literals, quoted identifiers and comments (`&lt;` for `<`). The query
 * can never be right, and the entity's `;` would otherwise split it into two "statements".
 */
/** Index just past a '…' literal or "…" identifier starting at i; a doubled quote is an escape. */
function quotedEnd(sql: string, i: number, q: string): number {
  for (let j = i + 1; j < sql.length; j++) {
    if (sql[j] !== q) continue;
    if (sql[j + 1] === q) j++;
    else return j + 1;
  }
  return sql.length;
}

function htmlEntities(sql: string): { entity: string; char: string }[] {
  const out = new Map<string, string>();
  let code = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    if (c === "'") {
      // Skip literals, quoted identifiers and comments, blanking them to the same length so offsets
      // in `code` stay aligned with `sql`.
      const j = quotedEnd(sql, i, "'");
      code += " ".repeat(j - i);
      i = j;
    } else if (c === '"') {
      const j = quotedEnd(sql, i, '"');
      code += " ".repeat(j - i);
      i = j;
    } else if (c === "-" && sql[i + 1] === "-") {
      const e = sql.indexOf("\n", i);
      const j = e < 0 ? sql.length : e;
      code += " ".repeat(j - i);
      i = j;
    } else if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      const j = e < 0 ? sql.length : e + 2;
      code += " ".repeat(j - i);
      i = j;
    } else {
      code += c;
      i++;
    }
  }
  for (const m of code.matchAll(HTML_ENTITY)) {
    const [raw, name, dec, hex] = m;
    const n = dec ? Number(dec) : hex ? parseInt(hex, 16) : undefined;
    const char = name ? NAMED_ENTITY[name.toLowerCase()] : n !== undefined && n <= 0x10ffff ? String.fromCodePoint(n) : "?";
    if (!out.has(raw.toLowerCase())) out.set(raw.toLowerCase(), char);
  }
  return [...out].map(([entity, char]) => ({ entity, char }));
}

function lintOnly(sql: string, ctx: LintContext): LintResult {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const entities = htmlEntities(sql);
  if (entities.length) {
    const ops = entities.every((e) => /^[<>]=?$/.test(e.char));
    const list = entities.map((e) => `${e.entity} (HTML-escaped '${e.char}')`).join(", ");
    return {
      errors: [{ rule: "html-entity", message: `The query contains ${list}: write the ${ops ? "operator" : "character"} itself. sqlQuery is plain SQL, never HTML-escaped.` }],
      warnings,
    };
  }
  const toks = tokenize(sql);
  if (!toks.length) return { errors: [{ rule: "empty", message: "Empty query." }], warnings };
  const heads = statementHeads(toks);
  const bad = heads.find((t) => !(t.type === "word" && READ_START.has(t.value)));
  if (bad) {
    const verb = bad.type === "word" ? bad.raw.toUpperCase() : undefined;
    return {
      errors: [{ rule: "not-select", message: `Only SELECT queries may go through ns_runCustomSuiteQL${verb ? `; this one runs ${verb}` : ""}. Send a single read-only query.` }],
      warnings,
    };
  }
  // Checked before any other rule (incl. cte-unsupported): with two statements nothing else is
  // meaningful, so `WITH … ; SELECT …` reports multi-statement first.
  if (heads.length > 1) {
    return {
      errors: [{ rule: "multi-statement", message: `Send one query; the connector runs a single statement, and this has ${heads.length} (separated by ;). Make one call per query, or combine them with UNION ALL or subqueries.` }],
      warnings,
    };
  }
  // `nsx sql lint select`, or a query cut off after SELECT: nothing NetSuite could run.
  const body = toks.filter((t) => t.type !== "semi" && t.type !== "lp" && t.type !== "rp");
  if (body.length < 2 || isWord(body[1], "from")) {
    return { errors: [{ rule: "incomplete-query", message: "The query is incomplete: SELECT needs a column list and FROM <table>. Send the whole query (quote it on the command line)." }], warnings };
  }
  const infos = analyze(toks);
  const queries = infos.filter((i) => i.scope.isQuery);
  const byOpen = new Map(queries.map((q) => [q.scope.open, q]));

  // --- ROWNUM placement ---
  for (const q of queries) {
    if (q.rownumWithAggregate) {
      errors.push({
        rule: "rownum-with-aggregate",
        message: `ROWNUM is filtered at the same level as GROUP BY/aggregates, so rows are capped BEFORE aggregation and totals are silently wrong. Drop the ROWNUM filter. ${FETCH_FIRST}`,
      });
    } else if (q.rownumWithOrderBy) {
      errors.push({
        rule: "rownum-with-order-by",
        message: `ROWNUM is filtered at the same level as ORDER BY, so an arbitrary N rows are taken BEFORE sorting and the 'top N' is wrong. Drop the ROWNUM filter. ${FETCH_FIRST}`,
      });
    } else if (rownumOverSorted(q, byOpen)) {
      // Live-verified 2026-09-27: SELECT * FROM (<GROUP BY … ORDER BY>) WHERE ROWNUM <= N returned partial
      // sums, unsorted; FETCH FIRST returned the right rows. The e2e fake connector can't catch this.
      errors.push({
        rule: "rownum-over-subquery",
        message:
          "ROWNUM over an aggregated or sorted subquery: NetSuite applies the outer ROWNUM before the inner GROUP BY/ORDER BY, so you get partial sums in arbitrary order. Drop the outer ROWNUM and end the inner query with ORDER BY … FETCH FIRST N ROWS ONLY (or use pageSize + pageIndex: 0).",
      });
    }
    if (q.limit.length) {
      // NetSuite ignores OFFSET (live-verified), so LIMIT … OFFSET gets no rewrite.
      errors.push({
        rule: "limit-clause",
        message: q.offset
          ? "SuiteQL has no LIMIT. To page, drop LIMIT/OFFSET and use the connector's pageSize + pageIndex with a unique ORDER BY (e.g. ORDER BY t.id)."
          : "SuiteQL has no LIMIT. Use FETCH FIRST n ROWS ONLY (after ORDER BY for a top n).",
      });
    }
    // Live-verified 2026-09-27: `ORDER BY t.id OFFSET 3 ROWS FETCH NEXT 3 ROWS ONLY` returned the first
    // 3 rows, with and without pageSize/pageIndex. OFFSET 0 is a no-op either way.
    if (q.offsetSkip.length) {
      errors.push({
        rule: "offset-ignored",
        message: "NetSuite ignores OFFSET (live-verified 2026-09-27) and returns the first rows again. Page with pageSize + pageIndex and a unique ORDER BY, or filter on the sort key (WHERE t.id > <last id> … ORDER BY t.id FETCH FIRST n ROWS ONLY).",
      });
    }
  }

  // --- qualified references to aliases no FROM/JOIN declares (same level or enclosing) ---
  const undef = new Set<string>();
  for (const ref of columnRefs(toks, true)) {
    const scopesUp = enclosing(infos, ref.idx);
    if (!scopesUp.length || scopesUp.some((q) => q.aliases.has(ref.alias))) continue;
    if (undef.has(ref.alias)) continue;
    undef.add(ref.alias);
    const known = [...new Set(scopesUp.flatMap((q) => q.declared))];
    errors.push({
      rule: "undefined-alias",
      message: `${toks[ref.idx].raw}.${toks[ref.idx + 2].raw}: '${toks[ref.idx].raw}' isn't a table or alias in this query's FROM/JOIN (or an enclosing query's)${known.length ? `; in scope: ${known.join(", ")}` : ""}. Use one of those, or join the table it belongs to. NetSuite would fail with a generic error that doesn't name it.`,
    });
  }

  // --- ROWNUM-capped subquery feeding an aggregate (the same truncation, one level down) ---
  for (const q of queries) {
    if (!(q.groupBy || q.aggregate)) continue;
    for (const c of queries) {
      const before = toks[c.scope.open - 1];
      const isSource = c.scope.depth === q.scope.depth + 1 && c.scope.open > q.scope.open && c.scope.close < q.scope.close && before?.type === "word" && (before.value === "from" || before.value === "join");
      // A sorted source already gets its own error (rownum-with-order-by / rownum-over-subquery).
      if (isSource && rownumCount(c) > 0 && !c.orderBy && !rownumOverSorted(c, byOpen)) {
        errors.push({
          rule: "rownum-before-aggregate",
          message:
            "A ROWNUM-limited subquery feeds GROUP BY/aggregates, so an arbitrary N rows are aggregated and totals are wrong. Aggregate the full data, then cap the aggregated result with ORDER BY … FETCH FIRST N ROWS ONLY.",
        });
      }
    }
  }

  // --- SELECT * ---
  for (const q of queries) {
    if (q.selectStar && !q.fromSubquery && !q.probeLimit) {
      errors.push({
        rule: "select-star",
        message: `SELECT * returns every column${q.fromTable ? ` of ${q.fromTable}` : ""} and wastes tokens. Name the columns you need (see: nsx fields ${q.fromTable ?? "<table>"}), or probe with FETCH FIRST 1 ROWS ONLY.`,
      });
    }
  }

  // --- type / recordtype literals ---
  // Only literals compared against transaction.type / transaction.recordtype.
  const lits = typeLiterals(toks).filter((l) => resolvesToTransaction(toks, infos, l.idx));
  for (const l of lits) {
    const v = l.value.toLowerCase();
    if (l.column === "type" && !TYPE_CODES[v] && RECORD_TO_CODE[v]) {
      errors.push({
        rule: "type-literal",
        message: `transaction.type uses internal codes, not record ids: use type = '${CODE_DISPLAY[RECORD_TO_CODE[v]]}' (or recordtype = '${v}') instead of type = '${l.value}'.`,
      });
    } else if (l.column === "recordtype" && TYPE_CODES[v] && !RECORD_TO_CODE[v]) {
      errors.push({
        rule: "recordtype-literal",
        message: `transaction.recordtype uses record ids, not type codes: use recordtype = '${TYPE_CODES[v]}' (or type = '${CODE_DISPLAY[v]}') instead of recordtype = '${l.value}'.`,
      });
    } else if (l.column === "type" && !TYPE_CODES[v]) {
      warnings.push({
        rule: "type-literal-unknown",
        message: `transaction.type '${l.value}' isn't in the harness's list of type codes (a short list; the code may still be right). If the query returns nothing, check the code: it's an internal code like CustInvc, VendBill or Journal, not a record id.`,
      });
    } else if (l.column === "recordtype" && ctx.recordTypes?.size && !ctx.recordTypes.has(v) && !RECORD_TO_CODE[v]) {
      warnings.push({
        rule: "recordtype-unknown",
        message: `recordtype '${l.value}' isn't in the harness's type list or the cached SuiteQL record-type list (neither is complete; the value may still be right). If the query returns nothing, check it (nsx recordtypes --grep ${v}).`,
      });
    }
  }

  // --- approvalstatus on types without approval workflows ---
  // Only a WHERE/HAVING comparison of approvalstatus with a value (=, <>, !=, IN, NOT IN) drops every
  // row of a type without a workflow (its approvalstatus is NULL). Selecting, counting or testing it
  // with IS [NOT] NULL is fine. The types are the ones the same query block selects (=, IN), not
  // the ones it excludes (<>, NOT IN).
  if (ctx.approvalWorkflows) {
    const wf = Object.fromEntries(Object.entries(ctx.approvalWorkflows).map(([k, v]) => [k.toLowerCase(), v]));
    const hit = new Set<string>();
    for (let i = 0; i < toks.length; i++) {
      if (!isWord(toks[i], "approvalstatus") || !approvalCompared(toks, i)) continue;
      const q = enclosing(infos, i)[0];
      if (!q || !["where", "having"].includes(clauseAt(toks, q, i))) continue;
      const codes = lits
        .filter((l) => !l.negated && enclosing(infos, l.idx)[0] === q)
        .map((l) => {
          const v = l.value.toLowerCase();
          return l.column === "type" ? v : (RECORD_TO_CODE[v] ?? (TYPE_CODES[v] ? v : undefined));
        })
        .filter((c): c is string => !!c && c in wf);
      if (codes.length && codes.every((c) => wf[c] === false)) for (const c of codes) hit.add(c);
    }
    if (hit.size) {
      const known = [...hit];
      errors.push({
        rule: "approvalstatus-no-workflow",
        message: `Filtering on approvalstatus for ${known.map((c) => CODE_DISPLAY[c] ?? c).join(", ")}, which has no approval workflow in this account (profile), so the filter returns zero rows. Drop the approvalstatus condition; filter on status with BUILTIN.CF(t.status) = '${CODE_DISPLAY[known[0]] ?? known[0]}:<letter>' instead.`,
      });
    }
  }

  // --- unknown columns against a fresh field cache ---
  if (ctx.fields) {
    const reported = new Set<string>();
    for (const ref of columnRefs(toks)) {
      const table = resolveAlias(infos, ref.idx, ref.alias);
      if (!table) continue;
      const cols = ctx.fields(table);
      if (!cols || !cols.size || cols.has(ref.col)) continue;
      const key = `${table}.${ref.col}`;
      if (reported.has(key)) continue;
      reported.add(key);
      // Live 2026-09-27 (claude.ai connector): a bad column fails with "An unexpected SuiteScript error
      // has occurred" and the field isn't named, so the warning has to say which column to suspect.
      const generic = "if the query then fails with a generic error (\"An unexpected SuiteScript error has occurred\"), this column is the likely cause: NetSuite doesn't name the bad field";
      if (CUSTOM_PREFIX.test(ref.col)) {
        warnings.push({ rule: "unknown-custom-field", columns: [key], message: `Custom field ${key} is not in the cached field list; it may be new, but ${generic} (nsx fields ${table} --grep ${ref.col.slice(0, 10)}).` });
      } else if (!HIDDEN_COLUMNS[table]?.has(ref.col)) {
        // ns_getSuiteQLMetadata is incomplete (live: transactionline.amount is missing), so only warn.
        const pool = [...new Set([...cols, ...(HIDDEN_COLUMNS[table] ?? [])])];
        const close = closest(ref.col, pool);
        const near = pool.filter((c) => !close.includes(c) && (c.includes(ref.col) || ref.col.includes(c))).slice(0, 5);
        const hint = close.length ? ` Did you mean ${close.join(" or ")}?` : near.length ? ` Similar: ${near.join(", ")}.` : "";
        warnings.push({
          rule: "unknown-column",
          columns: [key],
          message: `${key} is not in the connector's metadata for ${table}. It may still exist, but ${generic}.${hint} (nsx fields ${table} --grep ${ref.col.slice(0, 4)})`,
        });
      }
    }
  }

  // --- transactionline sums without a line filter ---
  const hasLineFilter = toks.some((t) => t.type === "word" && /^(mainline|accountinglinetype|taxline|iscogs|transactionlinetype)$/.test(t.value));
  if (!hasLineFilter) {
    for (let i = 0; i + 1 < toks.length; i++) {
      const t = toks[i];
      if (t.type !== "word" || t.value !== "sum" || toks[i + 1].type !== "lp") continue;
      const close = toks.findIndex((x, j) => j > i + 1 && x.type === "rp" && x.depth === toks[i + 1].depth);
      if (indicatorSum(toks, i + 1, close)) continue;
      const inner = columnRefs(toks.slice(i + 2, close < 0 ? toks.length : close));
      if (inner.some((r) => /amount$/.test(r.col) && resolveAlias(infos, i, r.alias) === "transactionline")) {
        warnings.push({
          rule: "transactionline-sum-unfiltered",
          message: "Summing transactionline amounts without a mainline/line-type filter can double count (header + lines, tax lines). Add mainline = 'F' (and taxline = 'F'), or use transactionaccountingline for GL amounts.",
        });
        break;
      }
    }
  }

  // --- sums of transaction-currency amounts across currencies ---
  const mixed = new Set<ScopeInfo>();
  for (let i = 0; i + 1 < toks.length; i++) {
    if (toks[i].type !== "word" || toks[i].value !== "sum" || toks[i + 1].type !== "lp") continue;
    const close = toks.findIndex((x, j) => j > i + 1 && x.type === "rp" && x.depth === toks[i + 1].depth);
    if (indicatorSum(toks, i + 1, close)) continue;
    const inner = toks.slice(i + 2, close < 0 ? toks.length : close);
    const q = enclosing(infos, i)[0];
    if (q && !q.singleCurrency && inner.some((x) => x.type === "word" && (x.value === "foreigntotal" || x.value === "foreignamount"))) mixed.add(q);
  }
  if (mixed.size) {
    warnings.push({
      rule: "sum-mixed-currency",
      // article_1029114601: BUILTIN.CURRENCY_CONVERT(amount, target currency, rate date); rate date defaults to today
      message: "SUM(foreigntotal/foreignamount) adds amounts in each transaction's own currency, so different currencies get added together. Group by currency (and show it), filter to one currency, sum a base amount (transactionaccountingline.amount) per subsidiary (group or filter by tl.subsidiary: each subsidiary has its own base currency), use the consolidated report / BUILTIN.CONSOLIDATE, or convert with BUILTIN.CURRENCY_CONVERT(amount, <target currency id>, <rate date>) (the rate date defaults to today, not the transaction date).",
    });
  }

  // --- base amounts summed across subsidiaries with different base currencies ---
  // transactionaccountingline amounts are in each subsidiary's base currency (profile.ts, ttm_revenue).
  if (ctx.multiCurrencySubsidiaries) {
    for (let i = 0; i + 1 < toks.length; i++) {
      if (!isWord(toks[i], "sum") || toks[i + 1].type !== "lp") continue;
      const close = toks.findIndex((x, j) => j > i + 1 && x.type === "rp" && x.depth === toks[i + 1].depth);
      if (indicatorSum(toks, i + 1, close)) continue;
      const inner = toks.slice(i + 2, close < 0 ? toks.length : close);
      if (inner.some((x) => isWord(x, "consolidate"))) continue;
      const q = enclosing(infos, i)[0];
      if (!q || q.singleSubsidiary) continue;
      const base = columnRefs(inner).find((r) => TAL_AMOUNTS.has(r.col) && resolveAlias(infos, i, r.alias) === "transactionaccountingline");
      if (!base) continue;
      warnings.push({
        rule: "sum-across-subsidiaries",
        message: `SUM(${base.alias}.${base.col}) adds each subsidiary's base-currency amounts together, and this account's subsidiaries use different currencies (profile), so the total mixes currencies. Group or filter by subsidiary (tl.subsidiary, joining transactionline tl ON tl.transaction = ${base.alias}.transaction AND tl.id = ${base.alias}.transactionline), or use the consolidated report / BUILTIN.CONSOLIDATE for a group total.`,
      });
      break;
    }
  }

  // --- budgets and actuals aggregated over one join ---
  const fanout = new Set<ScopeInfo>();
  for (const q of queries) {
    if (!(q.aggregate || q.groupBy)) continue;
    const tables = new Set(q.aliases.values());
    if ([...tables].some((t) => BUDGET_TABLES.has(t)) && [...tables].some((t) => FACT_TABLES.has(t))) fanout.add(q);
  }
  if (fanout.size) {
    warnings.push({
      rule: "budget-fanout",
      message: "Budget rows joined to transaction rows and aggregated in one query: each budget row repeats for every matching transaction line (and vice versa), so both sums inflate. Aggregate budgets and actuals in separate subqueries, then join the totals: FROM (SELECT … GROUP BY …) b LEFT JOIN (SELECT … GROUP BY …) a ON ….",
    });
  }

  // --- LEFT JOIN fan-out / date filter in ON with aggregate on the left table ---
  // Only an aggregate over a left-side column inflates: `FROM account a LEFT JOIN
  // transactionaccountingline tal ON … AND tal.posting = 'T' … SUM(tal.amount)` (all accounts,
  // including zero balances) is the intended pattern.
  for (const q of queries) {
    if (!q.leftJoinOnDates || !(q.aggregate || q.groupBy) || fanout.has(q)) continue;
    if (!aggregatesOver(toks, infos, q).some((a) => q.leftSide.has(a))) continue;
    warnings.push({
      rule: "left-join-aggregate",
      message: `Date/posting filter inside LEFT JOIN … ON while aggregating a left-table column: every left-table row (${q.fromTable ?? "left"}) is kept and multiplied by matching right rows, so left-side sums inflate. Aggregate each side in its own subquery, then join the totals.`,
    });
  }
  const leftFilters = [...new Set(queries.flatMap((q) => q.leftOnLeftFilters))];
  if (leftFilters.length) {
    warnings.push({
      rule: "left-join-on-filter",
      message: `${leftFilters.join(", ")} is filtered inside LEFT JOIN … ON, but it belongs to the left side of that join, so it doesn't remove any rows (a LEFT JOIN keeps every left row). Move the condition to WHERE.`,
    });
  }

  syntaxRules(toks, infos, errors, warnings, ctx);
  orderByAlias(sql, toks, queries, warnings);
  return { errors, warnings };
}

/**
 * Unsupported functions → documented alternative. section_158513731864 (SuiteQL Supported and
 * Unsupported Functions). Only matched as `NAME(`, so LEFT/RIGHT JOIN are unaffected.
 */
const UNSUPPORTED_FUNCTIONS: Record<string, string> = {
  listagg: "no SuiteQL equivalent; return the rows and combine them outside SQL",
  datediff: "subtract dates instead (d1 - d2 is days) or use MONTHS_BETWEEN(d1, d2)",
  left: "use SUBSTR(s, 1, n)",
  right: "use SUBSTR(s, -n)",
  substring: "use SUBSTR(s, start, length)",
  charindex: "use INSTR(s, sub)",
  locate: "use INSTR(s, sub)",
  position: "use INSTR(s, sub)",
  ceiling: "use CEIL",
  lcase: "use LOWER",
  ucase: "use UPPER",
  convert: "no SuiteQL equivalent; use TO_CHAR / TO_NUMBER / TO_DATE",
  char_length: "use LENGTH",
  character_length: "use LENGTH",
  repeat: "no SuiteQL equivalent",
  bit_length: "no SuiteQL equivalent",
  bit_xor_agg: "no SuiteQL equivalent",
  cot: "use 1 / TAN(x)",
};
const COMPARE = new Set(["=", "<", ">", "<=", ">=", "<>", "!="]);
const DATE_LIKE = /^\s*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})\b/;
const isWord = (t: Tok | undefined, v?: string) => t?.type === "word" && (v === undefined || t.value === v);
const isOp = (t: Tok | undefined, v: string) => t?.type === "op" && t.value === v;
const intOf = (t: Tok | undefined) => (t?.type === "num" && /^\d+$/.test(t.value) ? Number(t.value) : undefined);
/** `(+)` starting at token i */
const isPlusMarker = (toks: Tok[], i: number) => toks[i]?.type === "lp" && isOp(toks[i + 1], "+") && toks[i + 2]?.type === "rp";

/** Syntax Oracle documents as unsupported (or always wrong) in SuiteQL. */
function syntaxRules(toks: Tok[], infos: ScopeInfo[], errors: Finding[], warnings: Finding[], ctx: LintContext = {}): void {
  const once = new Set<string>();
  const err = (rule: string, message: string, key = rule) => {
    if (once.has(key)) return;
    once.add(key);
    errors.push({ rule, message });
  };

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], prev = toks[i - 1], next = toks[i + 1];
    // article_0824094533: "You can't use WITH clauses in your queries."
    if (isWord(t, "with") && (!prev || prev.type === "lp" || prev.type === "semi")) {
      err("cte-unsupported", "SuiteQL doesn't support WITH clauses; rewrite each CTE as a FROM subquery: FROM (SELECT …) x.");
    }
    // section_158513731864: unsupported functions
    if (t.type === "word" && next?.type === "lp" && prev?.type !== "dot" && UNSUPPORTED_FUNCTIONS[t.value]) {
      err("unsupported-function", `${t.value.toUpperCase()}() isn't supported in SuiteQL: ${UNSUPPORTED_FUNCTIONS[t.value]}.`, `fn:${t.value}`);
    }
    // article_0824094533: "You can't use date literals. You must encapsulate dates using the to_date() function."
    if ((isWord(t, "date") || isWord(t, "timestamp")) && next?.type === "str" && prev?.type !== "dot") {
      err("date-literal", `SuiteQL has no ${t.value.toUpperCase()} '…' literals; use TO_DATE('2026-01-01','YYYY-MM-DD').`);
    }
    // article_0824094533: "For string concatenation, you can't use the + operator. You should use the || operator instead."
    // A numeric string ('5' + 1) is arithmetic Oracle converts implicitly, not concatenation.
    const textLit = (x: typeof t | undefined) => x?.type === "str" && !/^\s*-?\d+(\.\d+)?\s*$/.test(x.value);
    if (isOp(t, "+") && (textLit(prev) || textLit(next))) {
      err("string-plus-concat", "SuiteQL can't concatenate with +; use || to concatenate.");
    } else if (isOp(t, "+") && ctx.fieldType) {
      // A column the metadata types as string next to +, e.g. a.acctnumber + a.acctname. A number on
      // the other side (a.acctnumber + 1) is arithmetic Oracle converts implicitly, so it's left alone.
      const numeric = (x: Tok | undefined) => x?.type === "num" || (x?.type === "str" && !textLit(x));
      const left = operandColumn(toks, infos, i, -1);
      const right = operandColumn(toks, infos, i, 1);
      const str = [left, right].find((c) => c && ctx.fieldType!(c.table, c.col) === "string");
      const other = str === left ? next : prev;
      if (str && !numeric(other)) {
        err("string-plus-concat", `SuiteQL can't concatenate with +; use || to concatenate (${str.table}.${str.col} is a string column).`);
      }
    }
    // section_156257796125: "Square brackets [ ] are not supported in SuiteQL."
    if (isOp(t, "[") && isWord(next, "nolint")) {
      err("bracket-identifier", "[nolint] goes in the tool call's description, not in sqlQuery: remove it from the SQL (in the SQL it's a square bracket, which SuiteQL doesn't support).");
    } else if (isOp(t, "[")) {
      err("bracket-identifier", "Square brackets aren't supported in SuiteQL; drop them and use the plain name (or an AS alias).");
    }
    // article_0824094533: `a1.id (+) = a2.id` (Oracle-syntax right outer join) is not valid SuiteQL
    if (isPlusMarker(toks, i) && isOp(toks[i + 3], "=")) {
      err("right-outer-plus", "(+) on the left of = is an Oracle-syntax right outer join, which SuiteQL doesn't support; move (+) to the other side (swap the operands): b.id = a.id (+).");
    }
    // Oracle SQL reference, ROWNUM pseudocolumn: "Conditions testing for ROWNUM values greater than a
    // positive integer are always false."
    if (isWord(t, "rownum") && rownumNeverTrue(toks, i)) {
      err("rownum-greater-than", "A ROWNUM condition that skips the first row (ROWNUM > n, = n, <> 1, BETWEEN n AND …) always returns no rows; page with pageSize + pageIndex (and a unique ORDER BY) instead.");
    }
    // article_0824094533: "You can't use more than 1000 arguments in a single IN clause."
    if (isWord(t, "in") && next?.type === "lp") {
      let n = 0;
      for (let j = i + 2; j < toks.length && !(toks[j].type === "rp" && toks[j].depth === next.depth); j++) {
        if (toks[j].depth === next.depth + 1 && (toks[j].type === "str" || toks[j].type === "num")) n++;
      }
      if (n > 1000) err("in-list-too-long", `IN (…) has ${n} items; SuiteQL allows at most 1000. Split it into IN lists of up to 1000 joined with OR, or filter by a subquery or id range.`);
    }
  }

  // section_156257796125: "you can't use both syntaxes in the same query" (SQL-92 and Oracle SQL).
  // Only (+) next to ANSI JOIN is flagged; comma joins alongside JOIN are left alone.
  for (const q of infos) {
    if (!q.scope.isQuery) continue;
    const d = q.scope.direct;
    if (d.some((i) => isPlusMarker(toks, i)) && d.some((i) => isWord(toks[i], "join"))) {
      err("mixed-join-syntax", "This query mixes Oracle (+) outer joins with ANSI JOIN … ON, and SuiteQL can't use both syntaxes in the same query. Use one style: comma joins with (+), or LEFT JOIN … ON.");
    }
  }

  // article_0824094533: "Do not use plain string values for date comparisons."
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== "word" || !/date$/.test(t.value) || (t.value === "date" && toks[i - 1]?.type !== "dot") || toks[i + 1]?.type === "lp") continue;
    const lit = (x: Tok | undefined) => x?.type === "str" && DATE_LIKE.test(x.value);
    // TRUNC(t.trandate) = '…': look past the closing parens of one-argument wrappers.
    let o = i + 1;
    while (toks[o]?.type === "rp" && o - i <= 2) o++;
    const op = toks[o];
    const pre = toks[i - 1]?.type === "dot" ? i - 2 : i;
    const inAt = isWord(op, "in") ? o + 1 : isWord(op, "not") && isWord(toks[o + 1], "in") ? o + 2 : -1;
    const hit =
      (op?.type === "op" && COMPARE.has(op.value) && lit(toks[o + 1])) ||
      (isWord(op, "between") && (lit(toks[o + 1]) || lit(toks[betweenAnd(toks, o) + 1]))) ||
      (inAt > 0 && toks[inAt]?.type === "lp" && lit(toks[inAt + 1])) ||
      (toks[pre - 1]?.type === "op" && COMPARE.has(toks[pre - 1].value) && lit(toks[pre - 2]));
    if (hit) {
      warnings.push({ rule: "string-date-compare", message: "Compare dates with TO_DATE('2026-01-01','YYYY-MM-DD'), not a plain string: string comparisons depend on the account's date format." });
      break;
    }
  }

  // article_1029114514: BUILTIN.CF returns the criteria value ('CustInvc:B'); raw status is only 'B'.
  for (let i = 0; i < toks.length; i++) {
    if (!isWord(toks[i], "status")) continue;
    const qualified = toks[i - 1]?.type === "dot";
    const start = qualified ? i - 2 : i;
    const b = start - 1;
    if (toks[b]?.type === "lp" && isWord(toks[b - 1], "cf")) continue;
    const op = toks[i + 1];
    let strs = false;
    if (op?.type === "op" && (op.value === "=" || op.value === "<>" || op.value === "!=")) strs = toks[i + 2]?.type === "str";
    else if (isWord(op, "in") || (isWord(op, "not") && isWord(toks[i + 2], "in"))) {
      const lp = op.value === "not" ? i + 3 : i + 2;
      strs = toks[lp]?.type === "lp" && toks[lp + 1]?.type === "str";
    }
    if (!strs || !resolvesToTransaction(toks, infos, i)) continue;
    const col = qualified ? `${toks[i - 2].raw}.status` : "status";
    warnings.push({
      rule: "status-without-cf",
      message: `Raw ${col} holds only the status letter; filter with BUILTIN.CF(${col}) = 'CustInvc:A' (type:letter).`,
    });
    break;
  }

  // `t.memo = "abc"`: double quotes make an identifier, not a string. Only a quoted name compared
  // with = / <> / != to a qualified column, and not itself qualified or a declared alias.
  for (let i = 0; i < toks.length; i++) {
    const q = toks[i];
    if (q.type !== "qid" || toks[i + 1]?.type === "dot") continue;
    const op = toks[i - 1];
    if (!(isOp(op, "=") || isOp(op, "<>") || isOp(op, "!="))) continue;
    if (!(toks[i - 3]?.type === "dot" && (toks[i - 2]?.type === "word" || toks[i - 2]?.type === "qid"))) continue;
    if (enclosing(infos, i).some((x) => x.aliases.has(q.value))) continue;
    warnings.push({
      rule: "double-quoted-string",
      message: `${q.raw} is in double quotes, which SuiteQL reads as a column/identifier name, not a string. For a string value use single quotes: '${q.raw.slice(1, -1).replace(/'/g, "''")}'.`,
    });
    break;
  }
}

/** Index of the AND that ends the first operand of the BETWEEN at token b (same paren depth), or -2. */
function betweenAnd(toks: Tok[], b: number): number {
  for (let j = b + 1; j < toks.length; j++) {
    const t = toks[j];
    if (t.depth < toks[b].depth || t.type === "semi") break;
    if (t.depth === toks[b].depth && t.type !== "rp" && isWord(t, "and")) return j;
  }
  return -2;
}

/**
 * The column directly left (dir -1) or right (dir 1) of the operator at token i, resolved to its table:
 * `x.col` through the aliases in scope, a bare `col` only when its query block has a single source.
 */
function operandColumn(toks: Tok[], infos: ScopeInfo[], i: number, dir: -1 | 1): { table: string; col: string } | undefined {
  const isName = (x: Tok | undefined) => x?.type === "word" || x?.type === "qid";
  let alias: string | undefined;
  let col: Tok | undefined;
  if (dir === -1) {
    col = toks[i - 1];
    if (!isName(col)) return undefined;
    if (toks[i - 2]?.type === "dot") {
      if (!isName(toks[i - 3]) || toks[i - 4]?.type === "dot") return undefined;
      alias = toks[i - 3].value;
    }
  } else {
    const a = toks[i + 1];
    if (!isName(a)) return undefined;
    if (toks[i + 2]?.type === "dot") {
      col = toks[i + 3];
      if (!isName(col) || toks[i + 4]?.type === "dot" || toks[i + 4]?.type === "lp") return undefined;
      alias = a.value;
    } else {
      if (toks[i + 2]?.type === "lp") return undefined; // function call
      col = a;
    }
  }
  if (alias) {
    const table = resolveAlias(infos, i, alias);
    return table && table !== SUBQUERY ? { table, col: col!.value } : undefined;
  }
  const q = enclosing(infos, i)[0];
  if (!q || q.declared.length !== 1 || !q.fromTable) return undefined;
  return { table: q.fromTable, col: col!.value };
}

const ORDER_MODIFIERS = new Set(["asc", "desc", "nulls", "first", "last"]);
const SELECT_MODIFIERS = new Set(["distinct", "all", "unique"]);

/**
 * ORDER BY on the alias of an aggregate or expression in a GROUP BY query. Live 2026-09-27:
 * `… GROUP BY tl.subsidiary, BUILTIN.DF(tl.subsidiary), BUILTIN.DF(t.currency) ORDER BY tl.subsidiary, n DESC`
 * (n = COUNT(*)) failed with "Invalid or unsupported search"; without the ORDER BY it ran. Only
 * aliases of expressions (a function call, operator or CASE) count; plain column aliases and compound
 * queries (whose trailing ORDER BY must use the first branch's names) are left alone.
 */
function orderByAlias(sql: string, toks: Tok[], queries: ScopeInfo[], warnings: Finding[]): void {
  const flat = (a: number, b: number) => sql.slice(toks[a].start, toks[b].end).replace(/\s+/g, " ");
  const split = (idx: number[]) => {
    const items: number[][] = [[]];
    for (const j of idx) {
      if (toks[j].type === "comma") items.push([]);
      else items[items.length - 1].push(j);
    }
    return items.filter((x) => x.length);
  };
  const hits: string[] = [];
  for (const q of queries) {
    if (!q.groupBy || !q.orderBy || q.compound) continue;
    const d = q.scope.direct;
    if (!isWord(toks[d[0]], "select")) continue;
    let k = 1;
    while (SELECT_MODIFIERS.has(toks[d[k]]?.value) && toks[d[k]]?.type === "word") k++;
    if (isWord(toks[d[k]], "top") && toks[d[k + 1]]?.type === "num") k += 2;
    const fromAt = d.findIndex((j, n) => n >= k && isWord(toks[j], "from"));
    if (fromAt < 0) continue;
    const exprs = new Map<string, string>();
    for (const item of split(d.slice(k, fromAt))) {
      const n = item.length;
      const last = toks[item[n - 1]];
      if (n < 2 || !(last.type === "word" || last.type === "qid") || last.value === "end") continue;
      const hasAs = isWord(toks[item[n - 2]], "as");
      const before = toks[item[n - 2]];
      if (!hasAs && !(before.type === "rp" || before.type === "word" || before.type === "qid" || before.type === "num" || before.type === "str")) continue;
      const body = item.slice(0, hasAs ? n - 2 : n - 1);
      if (!body.length) continue;
      const complex = body.some((j) => toks[j].type === "lp" || toks[j].type === "op" || toks[j].type === "star" || isWord(toks[j], "case"));
      if (complex) exprs.set(last.value, flat(body[0], body[body.length - 1]));
    }
    if (!exprs.size) continue;
    const orderAt = d.findIndex((j, n) => isWord(toks[j], "order") && isWord(toks[d[n + 1]], "by"));
    let end = d.length;
    for (let n = orderAt + 2; n < d.length; n++) {
      if (toks[d[n]].type === "word" && ["fetch", "offset", "limit"].includes(toks[d[n]].value)) {
        end = n;
        break;
      }
    }
    for (const item of split(d.slice(orderAt + 2, end))) {
      const first = toks[item[0]];
      const expr = exprs.get(first.value);
      if (!expr || !(first.type === "word" || first.type === "qid") || !item.slice(1).every((j) => toks[j].type === "word" && ORDER_MODIFIERS.has(toks[j].value))) continue;
      const mods = item.length > 1 ? ` ${flat(item[1], item[item.length - 1])}` : "";
      hits.push(`${expr}${mods} instead of ${first.raw}${mods}`);
    }
  }
  if (hits.length) {
    warnings.push({
      rule: "order-by-alias-group-by",
      message: `NetSuite may reject ORDER BY on an alias with GROUP BY ("Invalid or unsupported search"): order by the full expression (${hits.join("; ")}).`,
    });
  }
}

/** ROWNUM > n (n ≥ 1), >= n / = n (n > 1), BETWEEN a AND b (a > 1), and the reversed forms. */
function rownumNeverTrue(toks: Tok[], i: number): boolean {
  const op = toks[i + 1];
  if (op?.type === "op") {
    const n = intOf(toks[i + 2]);
    if (n !== undefined && ((op.value === ">" && n >= 1) || ((op.value === ">=" || op.value === "=") && n > 1))) return true;
    // ROWNUM <> 1: the first row fails, so the next candidate is ROWNUM 1 again, and so on.
    if (n === 1 && (op.value === "<>" || op.value === "!=")) return true;
  }
  if (isWord(op, "between")) {
    const a = intOf(toks[i + 2]);
    if (a !== undefined && a > 1 && isWord(toks[i + 3], "and")) return true;
  }
  const pop = toks[i - 1];
  if (pop?.type === "op" && toks[i - 3]?.type !== "op") {
    const n = intOf(toks[i - 2]);
    if (n !== undefined && ((pop.value === "<" && n >= 1) || ((pop.value === "<=" || pop.value === "=") && n > 1))) return true;
    if (n === 1 && (pop.value === "<>" || pop.value === "!=")) return true;
  }
  return false;
}

/** True for a top-level detail query (no aggregate/GROUP BY) without ORDER BY: pages of it aren't stable. */
export function pagingOrderMissing(sql: string): boolean {
  const toks = tokenize(sql);
  const top = analyze(toks).find((x) => x.scope.open < 0);
  if (!top || !top.scope.isQuery) return false;
  // Only a single-row aggregate (no GROUP BY) can't be paged out of order; grouped rows can.
  return !top.orderBy && (!!top.groupBy || !top.aggregate);
}

/** ROWNUM filter over a FROM subquery that aggregates or sorts (through pass-through wrappers). */
function rownumOverSorted(q: ScopeInfo, byOpen: Map<number, ScopeInfo>): boolean {
  if (rownumCount(q) === 0) return false;
  for (let src = q.fromSource === undefined ? undefined : byOpen.get(q.fromSource); src; src = src.fromSource === undefined ? undefined : byOpen.get(src.fromSource)) {
    if (src.groupBy || src.aggregate || src.orderBy) return true;
  }
  return false;
}

function resolvesToTransaction(toks: Tok[], infos: ScopeInfo[], idx: number): boolean {
  const alias = toks[idx - 1]?.type === "dot" ? toks[idx - 2]?.value : undefined;
  if (alias) return resolveAlias(infos, idx, alias) === "transaction";
  // Unqualified: only the innermost query block's FROM table counts.
  return enclosing(infos, idx)[0]?.fromTable === "transaction";
}

/** `ROWNUM <= N`, `ROWNUM < N`, `ROWNUM = 1`, `N >= ROWNUM`, `N > ROWNUM` at direct index k, as a row count. */
function rownumBound(toks: Tok[], d: number[], k: number): { limit: number; first: number; last: number } | undefined {
  const op = toks[d[k + 1]];
  const n = toks[d[k + 2]];
  const pop = toks[d[k - 1]];
  const pn = toks[d[k - 2]];
  let limit: number;
  let first = k;
  let last = k;
  if (op?.type === "op" && n?.type === "num" && Number.isInteger(Number(n.value))) {
    const v = Number(n.value);
    if (op.value === "<=") limit = v;
    else if (op.value === "<") limit = v - 1;
    else if (op.value === "=" && v === 1) limit = 1;
    else return undefined;
    last = k + 2;
  } else if (pop?.type === "op" && pn?.type === "num" && Number.isInteger(Number(pn.value))) {
    const v = Number(pn.value);
    if (pop.value === ">=") limit = v;
    else if (pop.value === ">") limit = v - 1;
    else return undefined;
    first = k - 2;
  } else return undefined;
  return limit < 1 ? undefined : { limit, first, last };
}

/**
 * Replace a ROWNUM cap with FETCH FIRST (live-verified 2026-09-27; an outer ROWNUM gave wrong sums):
 * `... WHERE a AND ROWNUM <= 10 GROUP BY ...` becomes `... WHERE a GROUP BY ... FETCH FIRST 10 ROWS ONLY`,
 * and `SELECT * FROM (<sorted/aggregated query>) WHERE ROWNUM <= 10` becomes
 * `<sorted/aggregated query> FETCH FIRST 10 ROWS ONLY`.
 *
 * Only a single, standalone upper bound joined to the rest of WHERE by AND is rewritten, never in a
 * compound (UNION/MINUS/INTERSECT) query or one that already has OFFSET/FETCH. Anything else returns
 * the input unchanged: a wrong "fix" is worse than none.
 */
export function fixRownum(sql: string): string {
  const original = sql;
  let out = sql.trim().replace(/;\s*$/, "");
  let changed = false;
  for (let pass = 0; pass < 5; pass++) {
    const toks = tokenize(out);
    const infos = analyze(toks);
    const byOpen = new Map(infos.filter((q) => q.scope.isQuery).map((q) => [q.scope.open, q]));
    const target = infos
      .filter((q) => q.scope.isQuery && (q.rownumWithAggregate || q.rownumWithOrderBy || rownumOverSorted(q, byOpen)))
      .sort((a, b) => b.scope.depth - a.scope.depth)[0];
    if (!target) break;
    if (target.compound || target.rownumNested || target.rownumInOn || target.rownum.length !== 1) return original;
    const d = target.scope.direct;
    const k = target.rownum[0];
    const bound = rownumBound(toks, d, k);
    if (!bound) return original;
    const top = target.scope.open < 0;
    const sStart = top ? 0 : toks[target.scope.open].end;
    const sEnd = target.scope.close >= toks.length ? out.length : toks[target.scope.close].start;
    const fetch = `FETCH FIRST ${bound.limit} ROWS ONLY`;
    let next: string;

    if (!target.rownumWithAggregate && !target.rownumWithOrderBy) {
      // Unwrap: SELECT * FROM (<src>) [[AS] x] WHERE <bound>, nothing else.
      let src = target.fromSource === undefined ? undefined : byOpen.get(target.fromSource);
      if (!src || d[3] !== target.fromSource) return original;
      const w = (i: number) => toks[d[i]];
      if (w(0)?.value !== "select" || w(1)?.type !== "star" || w(2)?.value !== "from" || w(4)?.type !== "rp") return original;
      let j = 5;
      if (w(j)?.value === "as") j++;
      if (w(j) && w(j).value !== "where") j++;
      if (w(j)?.value !== "where" || bound.first !== j + 1 || bound.last !== d.length - 1) return original;
      // Down through pass-through wrappers (SELECT * FROM (…) [x]) to the sorted/aggregated query.
      while (src && !(src.groupBy || src.aggregate || src.orderBy)) {
        if (!passThrough(toks, src)) return original;
        src = src.fromSource === undefined ? undefined : byOpen.get(src.fromSource);
      }
      if (!src || src.fetch || src.scope.close >= toks.length) return original;
      const body = dedent(out.slice(toks[src.scope.open].end, toks[src.scope.close].start));
      const block = top ? `${body}\n${fetch}` : `${body}${fetchSep(body)}${fetch}`;
      next = out.slice(0, sStart) + block + out.slice(sEnd);
    } else {
      if (target.fetch) return original;
      // The predicate must be a plain conjunct of WHERE or HAVING: the keyword or AND on one side,
      // AND/next clause/end on the other, and no OR directly in that clause.
      const before = toks[d[bound.first - 1]];
      const after = toks[d[bound.last + 1]];
      const joinsLeft = before?.type === "word" && (before.value === "where" || before.value === "having" || before.value === "and");
      const joinsRight = !after || after.type === "rp" || (after.type === "word" && (after.value === "and" || CLAUSES.has(after.value)));
      if (!joinsLeft || !joinsRight) return original;
      let clauseAt = -1;
      for (let j = bound.first - 1; j >= 0; j--) {
        const t2 = toks[d[j]];
        if (t2.type === "word" && (CLAUSES.has(t2.value) || t2.value === "on" || t2.value === "join")) {
          clauseAt = j;
          break;
        }
      }
      if (clauseAt < 0 || !["where", "having"].includes(toks[d[clauseAt]].value)) return original;
      let clauseEnd = d.length;
      for (let j = clauseAt + 1; j < d.length; j++) {
        const t2 = toks[d[j]];
        if (t2.type === "word" && CLAUSES.has(t2.value)) {
          clauseEnd = j;
          break;
        }
      }
      if (d.slice(clauseAt + 1, clauseEnd).some((i) => isWord(toks[i], "or"))) return original;
      let cutStart = toks[d[bound.first]].start;
      let cutEnd = toks[d[bound.last]].end;
      if (before.value === "and") cutStart = before.start;
      else if (after?.type === "word" && after.value === "and") cutEnd = after.end;
      else cutStart = before.start; // WHERE <pred> [GROUP BY …]: drop the WHERE too
      const left = out.slice(0, cutStart).replace(/[ \t]+$/, "");
      const mid = out.slice(cutEnd, sEnd).replace(/^[ \t]+/, "");
      const block = (left + (mid && !/^[\s)]/.test(mid) ? " " : "") + mid).trimEnd();
      next = `${block}${fetchSep(block)}${fetch}${out.slice(sEnd)}`;
    }
    // A rewrite that doesn't end up with exactly one more FETCH and one ROWNUM fewer (e.g. the FETCH
    // landed in a comment) is not a fix.
    const nt = tokenize(next);
    const count = (ts: Tok[], v: string) => ts.filter((t) => isWord(t, v)).length;
    if (count(nt, "fetch") !== count(toks, "fetch") + 1 || count(nt, "rownum") !== count(toks, "rownum") - 1) return original;
    out = next;
    changed = true;
  }
  return changed ? out : original;
}

/** `SELECT * FROM (<query>) [[AS] x]` and nothing else. */
function passThrough(toks: Tok[], q: ScopeInfo): boolean {
  const d = q.scope.direct;
  const w = (i: number) => toks[d[i]];
  if (!isWord(w(0), "select") || w(1)?.type !== "star" || !isWord(w(2), "from") || d[3] !== q.fromSource || w(4)?.type !== "rp") return false;
  if (d.length === 5) return true;
  if (d.length === 6) return w(5).type === "word" || w(5).type === "qid";
  return d.length === 7 && isWord(w(5), "as") && (w(6).type === "word" || w(6).type === "qid");
}

/** Separator before an appended FETCH: a newline when the text ends in a `--` comment. */
function fetchSep(text: string): string {
  const ts = tokenize(text);
  const lastEnd = ts.length ? ts[ts.length - 1].end : 0;
  return text.slice(lastEnd).includes("--") ? "\n" : " ";
}

/** Trim a subquery body and strip the indentation its continuation lines share. */
function dedent(s: string): string {
  const lines = s.trim().split("\n");
  const ind = Math.min(...lines.slice(1).filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length));
  return Number.isFinite(ind) && ind > 0 ? [lines[0], ...lines.slice(1).map((l) => l.slice(ind))].join("\n") : lines.join("\n");
}

/**
 * `LIMIT n` → `FETCH FIRST n ROWS ONLY` (live-verified 2026-09-27). LIMIT with OFFSET is left alone:
 * NetSuite ignores OFFSET (live-verified), and paging belongs in pageSize + pageIndex.
 */
export function fixLimit(sql: string): string {
  const toks = tokenize(sql);
  // `… FETCH FIRST 10 ROWS ONLY LIMIT 5` would end up with two FETCH clauses.
  if (toks.some((t, i) => isWord(t, "fetch") && (isWord(toks[i + 1], "first") || isWord(toks[i + 1], "next")))) return sql;
  let out = sql;
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    const n = toks[i + 1];
    if (t.type !== "word" || t.value !== "limit" || n?.type !== "num" || toks[i - 1]?.type === "dot") continue;
    if (toks[i + 2]?.type === "comma") return sql; // LIMIT m, n: leave it to the author
    if (isWord(toks[i + 2], "offset") || isWord(toks[i - 2], "offset")) return sql;
    out = out.slice(0, t.start) + `FETCH FIRST ${n.raw} ROWS ONLY` + out.slice(n.end);
  }
  return out;
}

/**
 * `… ORDER BY t.id OFFSET n ROWS FETCH NEXT m ROWS ONLY` → the same page through the connector:
 * pageSize m, pageIndex n/m, and the query without both clauses (NetSuite ignores OFFSET,
 * live-verified 2026-09-27). Only for one top-level OFFSET that is a multiple of the FETCH size,
 * with m ≥ 5 (the connector's minimum page size); anything else has no equivalent page, so no fix.
 */
export function offsetPaging(sql: string): { sql: string; pageSize: number; pageIndex: number } | undefined {
  const toks = tokenize(sql);
  if (toks.some((t, i) => isWord(t, "limit") && toks[i + 1]?.type === "num" && toks[i - 1]?.type !== "dot")) return undefined;
  const offs = toks.map((t, i) => (isWord(t, "offset") && offsetKeyword(toks[i - 1], toks[i + 1]) ? i : -1)).filter((i) => i >= 0);
  if (offs.length !== 1) return undefined;
  const i = offs[0];
  if (toks[i].depth !== 0) return undefined;
  const n = intOf(toks[i + 1]);
  const m = intOf(toks[i + 5]);
  const rowsWord = (t: Tok | undefined) => isWord(t, "rows") || isWord(t, "row");
  if (n === undefined || m === undefined || !rowsWord(toks[i + 2]) || !isWord(toks[i + 3], "fetch")) return undefined;
  if (!(isWord(toks[i + 4], "next") || isWord(toks[i + 4], "first")) || !rowsWord(toks[i + 6]) || !isWord(toks[i + 7], "only")) return undefined;
  const rest = toks.slice(i + 8);
  if (rest.some((t) => t.type !== "semi")) return undefined;
  if (n <= 0 || m < 5 || n % m !== 0) return undefined;
  return { sql: sql.slice(0, toks[i].start).trimEnd(), pageSize: m, pageIndex: n / m };
}

/** N of a top-level `FETCH FIRST|NEXT N ROWS ONLY`, if the query has one. */
export function topFetchRows(sql: string): number | undefined {
  const toks = tokenize(sql);
  let n: number | undefined;
  toks.forEach((t, i) => {
    if (t.depth === 0 && isWord(t, "fetch") && (isWord(toks[i + 1], "first") || isWord(toks[i + 1], "next"))) {
      const v = intOf(toks[i + 2]);
      if (v !== undefined && (isWord(toks[i + 3], "rows") || isWord(toks[i + 3], "row")) && isWord(toks[i + 4], "only")) n = v;
    }
  });
  return n;
}

/**
 * `[nolint]` in a description overrides every overridable error; `[nolint:rule-a,rule-b]` only the
 * rules named (comma or space separated). HARD_RULES are never overridden.
 */
export function nolintOf(description: unknown): { all: boolean; rules: Set<string> } {
  const out = { all: false, rules: new Set<string>() };
  for (const m of String(description ?? "").matchAll(/\[nolint(?::([^\]]*))?\]/gi)) {
    const names = (m[1] ?? "").split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!names.length) out.all = true;
    for (const n of names) out.rules.add(n);
  }
  return out;
}

/** The automatic rewrites: LIMIT, then ROWNUM placement (OFFSET: see offsetPaging). */
export function fixQuery(sql: string): string {
  return fixRownum(fixLimit(sql));
}

export function formatLint(r: LintResult): string {
  const lines: string[] = [];
  for (const e of r.errors) lines.push(`ERROR [${e.rule}] ${e.message}`);
  for (const w of r.warnings) lines.push(`WARN  [${w.rule}] ${w.message}`);
  if (r.fixed && r.paging) lines.push("", `Suggested fix: call with pageSize: ${r.paging.pageSize}, pageIndex: ${r.paging.pageIndex} and this query (the same rows the OFFSET asked for):`, r.fixed);
  else if (r.fixed) lines.push("", "Suggested fix:", r.fixed);
  return lines.join("\n") || "OK: no issues found.";
}
