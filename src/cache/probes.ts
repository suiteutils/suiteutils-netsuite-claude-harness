/**
 * The tagged cache-fill queries init runs (skills/init/SKILL.md step 3 shows the same SQL; a test
 * keeps the two identical). A tag is only a description string, so the hooks accept a tagged
 * result only when its SQL is exactly one of these (after normalisation): a filtered copy of the
 * periods query once replaced 319 periods with 10.
 */
import { tokenize } from "../sql/tokenize.ts";

export interface Probe {
  /** `periods` or `profile:<name>` */
  tag: string;
  description: string;
  sql: string;
  /** Main table (the pre hook skips a probe whose table the role can't see). */
  table: string;
  /** Result columns (lower-case). */
  required: string[];
  /** Columns older versions of the SQL didn't return, or don't need. */
  optional?: string[];
}

export const PROBES: Probe[] = [
  {
    tag: "periods",
    description: "Accounting periods [su-ns-harness:periods]",
    sql: "SELECT id, periodname, TO_CHAR(startdate,'YYYY-MM-DD') AS startdate, TO_CHAR(enddate,'YYYY-MM-DD') AS enddate, closed, isyear, isquarter, isadjust FROM accountingperiod ORDER BY startdate",
    table: "accountingperiod",
    required: ["id", "periodname", "startdate", "enddate", "closed", "isyear", "isquarter", "isadjust"],
  },
  {
    tag: "profile:base_currency",
    description: "Base currency [su-ns-harness:profile:base_currency]",
    sql: "SELECT s.id, BUILTIN.DF(s.currency) AS currency FROM subsidiary s WHERE s.parent IS NULL",
    table: "subsidiary",
    required: ["id", "currency"],
  },
  {
    // Fallback when the role can't see `subsidiary` (live-verified): each subsidiary's own currency
    // is the one its transactions carry at exchange rate 1 (≥ 99.8% of rows on the live account).
    tag: "profile:base_currency_fx",
    description: "Subsidiary currencies [su-ns-harness:profile:base_currency_fx]",
    sql: "SELECT tl.subsidiary AS sub, BUILTIN.DF(t.currency) AS currency, COUNT(*) AS n FROM transaction t JOIN transactionline tl ON tl.transaction = t.id WHERE tl.mainline = 'T' AND t.exchangerate = 1 AND t.trandate >= ADD_MONTHS(SYSDATE, -1) GROUP BY tl.subsidiary, BUILTIN.DF(t.currency)",
    table: "transaction",
    required: ["sub", "currency", "n"],
  },
  {
    tag: "profile:approval_workflows",
    description: "Approval status usage [su-ns-harness:profile:approval_workflows]",
    sql: "SELECT t.type, COUNT(t.approvalstatus) AS with_status, COUNT(*) AS total FROM transaction t WHERE t.trandate >= ADD_MONTHS(SYSDATE, -12) AND t.type IN ('VendBill','PurchOrd','Journal','ExpRept','SalesOrd','CustInvc','VendPymt','CustCred') GROUP BY t.type",
    table: "transaction",
    required: ["type", "with_status"],
    optional: ["total"],
  },
  {
    tag: "profile:ttm_revenue",
    description: "TTM revenue [su-ns-harness:profile:ttm_revenue]",
    sql: "SELECT tl.subsidiary AS subsidiary_id, BUILTIN.DF(tl.subsidiary) AS subsidiary, SUM(tal.amount) * -1 AS revenue FROM transactionaccountingline tal JOIN transaction t ON t.id = tal.transaction JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline JOIN account a ON a.id = tal.account WHERE UPPER(a.accttype) = 'INCOME' AND tal.posting = 'T' AND t.trandate >= ADD_MONTHS(SYSDATE, -12) GROUP BY tl.subsidiary, BUILTIN.DF(tl.subsidiary)",
    table: "transactionaccountingline",
    // One row per subsidiary; an older cached copy may hold one `revenue` row (a cross-subsidiary sum).
    required: ["revenue"],
    optional: ["subsidiary_id", "subsidiary"],
  },
];

/** `profile:base-currency` → `profile:base_currency` (the form the section name uses). */
export function probeKey(tag: string): string {
  return tag.startsWith("profile:") ? `profile:${tag.slice("profile:".length).replace(/[^a-z0-9_]/gi, "_")}` : tag;
}

export function probeFor(tag: string): Probe | undefined {
  const key = probeKey(tag.toLowerCase());
  return PROBES.find((p) => p.tag === key);
}

/**
 * SQL compared as tokens: whitespace and comments don't count, words compare case-insensitively,
 * string literals exactly; a trailing semicolon is ignored.
 */
export function normaliseSql(sql: string): string {
  let toks;
  try {
    toks = tokenize(sql);
  } catch {
    return sql.trim().replace(/;\s*$/, "").replace(/\s+/g, " ").toLowerCase();
  }
  while (toks.length && toks[toks.length - 1].type === "semi") toks.pop();
  return toks.map((t) => (t.type === "str" ? JSON.stringify(t.value) : t.type === "word" ? t.value : t.raw)).join(" ");
}

/** True when `sql` is the canonical SQL for `tag`. */
export function isCanonicalProbe(tag: string | undefined, sql: string): boolean {
  const p = tag ? probeFor(tag) : undefined;
  return !!p && normaliseSql(sql) === normaliseSql(p.sql);
}
