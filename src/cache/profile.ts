/**
 * Account profile: the handful of facts every NetSuite answer depends on, derived from
 * cached catalog sections and the tagged profile probes the init skill runs.
 */
import * as path from "node:path";
// cliCommand is a hoisted function, so the import cycle with session-start is harmless.
import { cliCommand } from "../hooks/session-start.ts";
import { readJson, writeFileAtomic, writeJson } from "../util.ts";
import { readIndex } from "./store.ts";

export interface Profile {
  builtAt: string;
  baseCurrency?: string;
  /** `fx`: inferred from the parent's transactions at exchange rate 1 (probe base_currency_fx); needs confirming. */
  baseCurrencySource?: "fx";
  /** Why baseCurrency couldn't be derived, for the card. */
  baseCurrencyWhy?: string;
  /** Subsidiary id → its currency (dominant currency of its rate-1 transactions). */
  subsidiaryCurrencies?: Record<string, string>;
  fiscalYearStartMonth?: string;
  oneWorld?: boolean;
  subsidiaryCount?: number;
  multiBook?: boolean;
  /** transaction type code (e.g. "VendBill") → has an approval workflow */
  approvalWorkflows?: Record<string, boolean>;
  /**
   * One TTM revenue figure: a single-subsidiary account, or (older single-row probe, `ttmRevenueMixed`) a
   * sum across subsidiaries that adds their base currencies together.
   */
  ttmRevenue?: number;
  ttmRevenueMixed?: boolean;
  /** TTM revenue per subsidiary, largest first, eliminations excluded; each in its own base currency. */
  ttmRevenueBySubsidiary?: { id?: string; name: string; amount: number; currency?: string }[];
  /**
   * Group TTM revenue in the base currency: the consolidated Income Statement's Sales line
   * (`nsx profile from-report`), or `ttm_revenue_consolidated` set by the user. Kept across rebuilds.
   */
  ttmRevenueConsolidated?: { amount: number; source: string };
  /** Parent subsidiary id, when known (base-currency probe or a subsidiaries parent column). */
  parentSubsidiaryId?: string;
  /**
   * `basis`: what the amount was derived from, best first: consolidated revenue, the parent
   * subsidiary's revenue, or the largest subsidiary's (currencies may differ). `from`: that subsidiary.
   */
  materiality?: { amount: number; pct: number; from?: string; fromId?: string; basis?: "consolidated" | "parent" | "largest" };
  openPeriods?: string[];
  /** Values set by the user via `nsx profile set` win over derived ones. */
  overrides?: Record<string, string>;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function materialityFor(ttm: number): { amount: number; pct: number } {
  // Rough tiers; users adjust with `nsx profile set materiality_amount=...`.
  const amount = ttm < 1e6 ? 5_000 : ttm < 1e7 ? 25_000 : ttm < 1e8 ? 50_000 : ttm < 1e9 ? 250_000 : 1_000_000;
  return { amount, pct: 5 };
}

function col(ix: { header: string[]; rows: string[][] }, name: string): number {
  return ix.header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
}

/** Elimination subsidiaries (NetSuite names them "… - Elimination"; the connector sends no flag). */
export function isEliminationName(name: string | undefined): boolean {
  return /elimination/i.test(name ?? "");
}

const truthy = (v: string | undefined) => /^(t|true|y|yes|1)$/i.test((v ?? "").trim());

/**
 * SuiteQL returns dates in the user's date-format preference, so the init probe asks for
 * TO_CHAR(…,'YYYY-MM-DD'). The other forms are fallbacks for older caches and other callers:
 * unpadded ISO (`2029-1-1`, seen live), M/D/YYYY (NetSuite's US default) and D.M.YYYY.
 */
export function parseDate(s: string): Date | undefined {
  const t = s.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(t);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return undefined;
}

export function profilePath(acctDir: string): string {
  return path.join(acctDir, "profile.json");
}

export function loadProfile(acctDir: string): Profile | undefined {
  return readJson<Profile | undefined>(profilePath(acctDir), undefined);
}

export function buildProfile(acctDir: string, now = Date.now()): Profile {
  const prev = loadProfile(acctDir);
  const p: Profile = { builtAt: new Date().toISOString(), overrides: prev?.overrides ?? {} };

  const subs = readIndex(acctDir, "subsidiaries");
  const elimIds = new Set<string>();
  if (subs.rows.length) {
    const elim = col(subs, "iselimination");
    const id = col(subs, "id");
    const nm = col(subs, "name");
    // The connector lists the consolidated view (id -1) and elimination subsidiaries as entries.
    // Use the flag when the connector sends one, otherwise the name.
    const isElim = (r: string[]) => (elim >= 0 && r[elim] ? truthy(r[elim]) : isEliminationName(r[nm]));
    for (const r of subs.rows) if (isElim(r) && r[id]) elimIds.add(r[id]);
    const real = subs.rows.filter((r) => !isElim(r) && r[id] !== "-1" && !/\(consolidated\)\s*$/i.test(r[nm] ?? ""));
    p.subsidiaryCount = real.length;
    // A consolidated view (id -1) or an elimination subsidiary exists only on OneWorld accounts,
    // even when there's a single real subsidiary.
    const hasConsolidated = subs.rows.some((r) => r[id] === "-1" || /\(consolidated\)\s*$/i.test(r[nm] ?? ""));
    p.oneWorld = real.length > 1 || hasConsolidated || elimIds.size > 0;
    const parent = col(subs, "parent");
    const cur = col(subs, "currency");
    const root = parent >= 0 ? real.find((r) => !r[parent]) : undefined;
    if (root?.[id]) p.parentSubsidiaryId = root[id];
    // The connector names the parent in its consolidated entry: id -1 "Parent GmbH (Consolidated)".
    const consolidated = subs.rows.map((r) => /^(.*?)\s*\(consolidated\)\s*$/i.exec(r[nm] ?? "")?.[1]).find(Boolean);
    const named = consolidated ? real.find((r) => (r[nm] ?? "").trim().toLowerCase() === consolidated.trim().toLowerCase()) : undefined;
    if (!p.parentSubsidiaryId && named?.[id]) p.parentSubsidiaryId = named[id];
    if (real.length === 1 && real[0][id]) p.parentSubsidiaryId ??= real[0][id];
    const withCur = root ?? real[0];
    if (withCur && cur >= 0 && withCur[cur]) p.baseCurrency = withCur[cur];
  }

  const books = readIndex(acctDir, "books");
  if (books.rows.length) p.multiBook = books.rows.length > 1;

  // By column name, not position: the rows may come keyed {currency, id}.
  const cur = readIndex(acctDir, "probe/base_currency");
  if (cur.rows[0]) {
    const [cc, cid] = [col(cur, "currency"), col(cur, "id")];
    const code = cc >= 0 ? (cur.rows[0][cc] ?? "").trim() : "";
    if (code) p.baseCurrency = code;
    if (cid >= 0 && cur.rows[0][cid]) p.parentSubsidiaryId = cur.rows[0][cid];
  }

  // Fallback when the role can't see `subsidiary`: each subsidiary's dominant currency at rate 1.
  const fx = readIndex(acctDir, "probe/base_currency_fx");
  const [fs_, fc, fn] = [col(fx, "sub"), col(fx, "currency"), col(fx, "n")];
  if (fx.rows.length && fs_ >= 0 && fc >= 0) {
    const best: Record<string, { c: string; n: number }> = {};
    for (const r of fx.rows) {
      const sub = r[fs_];
      const n = fn >= 0 ? Number(r[fn]) || 0 : 1;
      if (sub && r[fc] && (!best[sub] || n > best[sub].n)) best[sub] = { c: r[fc], n };
    }
    p.subsidiaryCurrencies = Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.c]));
    const pc = p.parentSubsidiaryId ? p.subsidiaryCurrencies[p.parentSubsidiaryId] : undefined;
    if (!p.baseCurrency && pc) {
      p.baseCurrency = pc;
      p.baseCurrencySource = "fx";
    }
  }
  if (p.baseCurrency && p.parentSubsidiaryId && !p.subsidiaryCurrencies?.[p.parentSubsidiaryId]) (p.subsidiaryCurrencies ??= {})[p.parentSubsidiaryId] = p.baseCurrency;

  if (!p.baseCurrency) {
    const types = readIndex(acctDir, "recordtypes").rows;
    if (types.length && !types.some((r) => (r[0] ?? "").toLowerCase() === "subsidiary")) p.baseCurrencyWhy = "the connector role can't query the subsidiary table";
    else if (cur.header.length && !cur.rows.length) p.baseCurrencyWhy = "the base-currency probe returned no parent subsidiary";
    else if (cur.rows.length) p.baseCurrencyWhy = "the base-currency probe returned the parent subsidiary without a currency";
    if (p.baseCurrencyWhy && fx.rows.length) p.baseCurrencyWhy += p.parentSubsidiaryId ? `, and the parent subsidiary (${p.parentSubsidiaryId}) has no rate-1 transactions in the last month` : ", and the parent subsidiary isn't known";
  }

  const periods = readIndex(acctDir, "periods");
  if (periods.rows.length) {
    const [name, start, end, closed, isyear, isq, adj] = ["periodname", "startdate", "enddate", "closed", "isyear", "isquarter", "isadjust"].map((c) => col(periods, c));
    const years = periods.rows.filter((r) => isyear >= 0 && truthy(r[isyear]));
    const lastYear = years
      .map((r) => parseDate(r[start] ?? ""))
      .filter((d): d is Date => !!d)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    if (lastYear) p.fiscalYearStartMonth = MONTHS[lastYear.getUTCMonth()];
    // Open month periods, earliest first. Accounts often pre-create open periods years ahead, so
    // "the last six" would be far in the future. Periods that ended over a year ago are leftovers
    // nobody closed; skip them unless nothing else is open.
    const open = periods.rows
      .filter((r) => !truthy(r[closed]) && !truthy(r[isyear]) && !truthy(r[isq]) && !(adj >= 0 && truthy(r[adj])))
      .map((r) => ({ r, s: parseDate(r[start] ?? "")?.getTime(), e: parseDate(r[end] ?? "")?.getTime() }))
      .filter((x) => x.s !== undefined)
      .sort((a, b) => a.s! - b.s!);
    const current = open.filter((x) => (x.e ?? x.s!) >= now - 365 * 86_400_000);
    p.openPeriods = (current.length ? current : open).map((x) => x.r[name]).filter(Boolean).slice(0, 6);
  }

  const fy = readIndex(acctDir, "probe/fiscal_calendar");
  if (!p.fiscalYearStartMonth && fy.rows[0]) {
    const d = fy.rows[0].map((c) => parseDate(c)).find(Boolean);
    if (d) p.fiscalYearStartMonth = MONTHS[d.getUTCMonth()];
  }

  // probe/approval_workflows: rows of (type, with_status_count[, total]) — a type "has a workflow"
  // when any of its transactions carries an approval status.
  const appr = readIndex(acctDir, "probe/approval_workflows");
  if (appr.rows.length) {
    const t = Math.max(0, col(appr, "type"));
    const n = col(appr, "with_status") >= 0 ? col(appr, "with_status") : 1;
    p.approvalWorkflows = Object.fromEntries(appr.rows.map((r) => [r[t], Number(r[n]) > 0]));
  }

  // tal.amount is in each subsidiary's base currency, so revenue is kept per subsidiary and never
  // summed across them. Materiality comes from deriveMateriality.
  const ttm = readIndex(acctDir, "probe/ttm_revenue");
  const rev = col(ttm, "revenue") >= 0 ? col(ttm, "revenue") : ttm.header.length - 1;
  const [sid, sname] = [col(ttm, "subsidiary_id"), col(ttm, "subsidiary")];
  if (sid >= 0 || sname >= 0) {
    const bySub = ttm.rows
      .map((r) => {
        const id = sid >= 0 ? r[sid] || undefined : undefined;
        const currency = id ? p.subsidiaryCurrencies?.[id] : undefined;
        return { id, name: (sname >= 0 ? r[sname] : "") || (sid >= 0 ? `subsidiary ${r[sid]}` : "?"), amount: Number(r[rev]), ...(currency ? { currency } : {}) };
      })
      .filter((x) => Number.isFinite(x.amount) && !(x.id && elimIds.has(x.id)) && !isEliminationName(x.name))
      .sort((a, b) => b.amount - a.amount);
    if (bySub.length) {
      if (!p.oneWorld && bySub.length === 1) p.ttmRevenue = Math.abs(bySub[0].amount);
      else p.ttmRevenueBySubsidiary = bySub;
    }
  } else {
    const ttmVal = Number(ttm.rows[0]?.[rev] ?? NaN);
    if (Number.isFinite(ttmVal)) {
      p.ttmRevenue = Math.abs(ttmVal);
      // The older single-row probe summed every subsidiary's base currency: no currency, no materiality from it.
      if (p.oneWorld) p.ttmRevenueMixed = true;
    }
  }
  if (prev?.ttmRevenueConsolidated) p.ttmRevenueConsolidated = prev.ttmRevenueConsolidated;

  applyOverrides(p);
  writeJson(profilePath(acctDir), p);
  writeFileAtomic(path.join(acctDir, "profile.md"), profileCard(p));
  return p;
}

/**
 * Materiality, best source first: consolidated TTM revenue (in the base currency); the parent
 * subsidiary's TTM revenue (also the base currency); the largest subsidiary's (currencies may
 * differ, so it needs confirming); a single-subsidiary account's one figure.
 */
function deriveMateriality(p: Profile): void {
  delete p.materiality;
  const c = p.ttmRevenueConsolidated;
  if (c && c.amount > 0) {
    p.materiality = { ...materialityFor(c.amount), basis: "consolidated" };
    return;
  }
  const by = p.ttmRevenueBySubsidiary;
  if (by?.length) {
    const parent = p.parentSubsidiaryId ? by.find((x) => x.id === p.parentSubsidiaryId) : undefined;
    const pick = parent && parent.amount > 0 ? parent : by[0];
    if (pick.amount > 0) p.materiality = { ...materialityFor(pick.amount), from: pick.name, ...(pick.id ? { fromId: pick.id } : {}), basis: pick === parent ? "parent" : "largest" };
    return;
  }
  if (p.ttmRevenue !== undefined && p.ttmRevenue > 0 && !p.ttmRevenueMixed && !p.oneWorld) p.materiality = materialityFor(p.ttmRevenue);
}

/** Overrides (which win over derived values), then materiality from the result. */
function applyOverrides(p: Profile): void {
  const o = p.overrides ?? {};
  if (o.base_currency) {
    p.baseCurrency = o.base_currency;
    delete p.baseCurrencySource;
    delete p.baseCurrencyWhy;
    // The base currency is the parent's currency: every fact about the parent must say the same
    // (if fx inferred EUR and the user set USD, the card must not show "Parent GmbH EUR 10.7M").
    if (p.parentSubsidiaryId) {
      (p.subsidiaryCurrencies ??= {})[p.parentSubsidiaryId] = o.base_currency;
      for (const x of p.ttmRevenueBySubsidiary ?? []) if (x.id === p.parentSubsidiaryId) x.currency = o.base_currency;
    }
  }
  if (o.fiscal_year_start) p.fiscalYearStartMonth = o.fiscal_year_start;
  if (o.oneworld) p.oneWorld = truthy(o.oneworld);
  if (o.multibook) p.multiBook = truthy(o.multibook);
  // Values stored before setOverrides validated them ("50k", "abc", "") are ignored, never NaN.
  const ttmc = o.ttm_revenue_consolidated ? parseAmount(o.ttm_revenue_consolidated) : undefined;
  if (ttmc !== undefined && ttmc > 0) p.ttmRevenueConsolidated = { amount: ttmc, source: "set by the user" };
  deriveMateriality(p);
  const amt = o.materiality_amount ? parseAmount(o.materiality_amount) : undefined;
  const pctN = o.materiality_pct ? Number(o.materiality_pct.replace(/%$/, "")) : undefined;
  const userAmount = amt !== undefined && amt > 0 ? amt : undefined;
  const userPct = pctN !== undefined && Number.isFinite(pctN) && pctN > 0 && pctN <= 100 ? pctN : undefined;
  if (userAmount !== undefined || (userPct !== undefined && p.materiality)) {
    // A user-set amount is the user's figure (in the base currency), not one derived from a subsidiary.
    const derived = userAmount !== undefined ? {} : { from: p.materiality?.from, fromId: p.materiality?.fromId, basis: p.materiality?.basis };
    p.materiality = {
      amount: userAmount ?? p.materiality?.amount ?? 0,
      pct: userPct ?? p.materiality?.pct ?? 5,
      ...Object.fromEntries(Object.entries(derived).filter(([, v]) => v !== undefined)),
    };
  }
  for (const [k, v] of Object.entries(o)) {
    const m = /^approval\.(.+)$/.exec(k);
    if (m) (p.approvalWorkflows ??= {})[m[1]] = truthy(v);
  }
}

/** Store the consolidated TTM revenue (from `nsx profile from-report`); it replaces a user-set figure. */
export function setConsolidatedRevenue(acctDir: string, v: { amount: number; source: string }): Profile {
  const p = loadProfile(acctDir) ?? buildProfile(acctDir);
  if (p.overrides?.ttm_revenue_consolidated) delete p.overrides.ttm_revenue_consolidated;
  p.ttmRevenueConsolidated = v;
  applyOverrides(p);
  writeJson(profilePath(acctDir), p);
  writeFileAtomic(path.join(acctDir, "profile.md"), profileCard(p));
  return p;
}

/** Keys `nsx profile set` takes, besides `approval.<TypeCode>`. */
export const OVERRIDE_KEYS = ["base_currency", "fiscal_year_start", "oneworld", "multibook", "ttm_revenue_consolidated", "materiality_amount", "materiality_pct"] as const;

const BOOL = /^(t|true|y|yes|1|f|false|n|no|0)$/i;
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** `50000`, `50,000`, `50 000`, `50k`, `1.5m`, `2b` → the number; undefined when it isn't one. */
export function parseAmount(v: string): number | undefined {
  const m = /^(\d{1,3}(?:[, _]\d{3})+|\d+)(\.\d+)?\s*([kmb])?$/i.exec(v.trim());
  if (!m) return undefined;
  const n = Number(m[1].replace(/[, _]/g, "") + (m[2] ?? "")) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[3] ?? "").toLowerCase() as "k" | "m" | "b"] ?? 1);
  return Number.isFinite(n) ? n : undefined;
}

/** One `key=value` for `nsx profile set` → its stored form, or an Error message. */
function normaliseOverride(key: string, value: string): { value: string } | { error: string } {
  const v = value.trim();
  if (/^approval\./.test(key)) {
    if (!/^approval\.[A-Za-z][A-Za-z0-9_]*$/.test(key)) return { error: "the type code after 'approval.' must be a NetSuite transaction type code, e.g. approval.VendBill" };
    return BOOL.test(v) ? { value: /^(t|true|y|yes|1)$/i.test(v) ? "true" : "false" } : { error: "expected yes or no" };
  }
  switch (key) {
    case "base_currency":
      return /^[A-Za-z]{3}$/.test(v) ? { value: v.toUpperCase() } : { error: "expected a 3-letter currency code, e.g. EUR" };
    case "fiscal_year_start": {
      const i = /^\d{1,2}$/.test(v) ? Number(v) - 1 : MONTH_NAMES.findIndex((m) => v.length >= 3 && m.startsWith(v.toLowerCase()));
      return i >= 0 && i < 12 ? { value: MONTHS[i] } : { error: "expected a month, e.g. Jan, January or 1" };
    }
    case "oneworld":
    case "multibook":
      return BOOL.test(v) ? { value: /^(t|true|y|yes|1)$/i.test(v) ? "true" : "false" } : { error: "expected yes or no" };
    case "ttm_revenue_consolidated":
    case "materiality_amount": {
      const n = parseAmount(v);
      return n !== undefined && n > 0 ? { value: String(n) } : { error: "expected a positive amount, e.g. 50000, 50,000 or 50k" };
    }
    case "materiality_pct": {
      const n = Number(v.replace(/%$/, "").trim());
      return v && Number.isFinite(n) && n > 0 && n <= 100 ? { value: String(n) } : { error: "expected a percentage above 0 and at most 100, e.g. 5" };
    }
    default:
      return { error: `unknown key (known: ${OVERRIDE_KEYS.join(", ")}, approval.<TypeCode>)` };
  }
}

/**
 * `nsx profile set`: validates every pair first and throws one Error listing each bad one
 * (nothing is saved then). An empty value removes that override. The profile is then rebuilt
 * from the cache, so removing an override brings the derived value back.
 */
export function setOverrides(acctDir: string, pairs: Record<string, string>): Profile {
  const problems: string[] = [];
  const set: Record<string, string> = {};
  const unset: string[] = [];
  for (const [rawKey, value] of Object.entries(pairs)) {
    const key = rawKey.trim();
    const known = (OVERRIDE_KEYS as readonly string[]).includes(key) || /^approval\./.test(key);
    if (known && value.trim() === "") {
      unset.push(key);
      continue;
    }
    const r = normaliseOverride(key, value);
    if ("error" in r) problems.push(`- ${key}=${value}: ${r.error}`);
    else set[key] = r.value;
  }
  if (problems.length) throw new Error(`Invalid profile setting${problems.length > 1 ? "s" : ""} (nothing was changed):\n${problems.join("\n")}`);
  const prev = loadProfile(acctDir) ?? { builtAt: new Date().toISOString() };
  const overrides = { ...(prev.overrides ?? {}), ...set };
  for (const k of unset) delete overrides[k];
  // Keys an older version stored with an empty value.
  for (const [k, v] of Object.entries(overrides)) if (v === "") delete overrides[k];
  prev.overrides = overrides;
  if (unset.includes("ttm_revenue_consolidated")) delete prev.ttmRevenueConsolidated;
  writeJson(profilePath(acctDir), prev);
  return buildProfile(acctDir);
}

const yn = (b: boolean | undefined) => (b === undefined ? "?" : b ? "yes" : "no");

/** `$` only for USD (incl. "USD - U.S. Dollar"); other currencies get their code/name; unknown gets no symbol. */
function money(n: number, currency?: string): string {
  const v = n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : `${n}`;
  if (!currency) return v;
  const c = currency.trim();
  if (/^(usd\b|u\.?s\.? dollar)/i.test(c)) return `$${v}`;
  // "EUR - Euro" → "EUR": keep the leading ISO code when NetSuite returns code + name.
  const iso = /^([A-Z]{3})\s*-\s/.exec(c);
  return `${iso ? iso[1] : c} ${v}`;
}

/** 12,345,678 → "12.3M": one decimal, for a list of per-subsidiary figures. */
function compact(n: number): string {
  const a = Math.abs(n);
  const v = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}K` : `${Math.round(a)}`;
  return n < 0 ? `-${v}` : v;
}

/** "EUR - Euro" → "EUR"; other forms as given. */
function ccyCode(c: string): string {
  const t = c.trim();
  return /^([A-Z]{3})\s*-\s/.exec(t)?.[1] ?? t;
}

/** 12,345,678 in EUR → "EUR 12.3M"; no currency → "12.3M". */
function amountIn(n: number, currency?: string): string {
  return currency ? `${ccyCode(currency)} ${compact(n)}` : compact(n);
}

/**
 * The materiality amount with a currency only when it's known: a figure the user set, a
 * single-subsidiary account, or one derived from consolidated or parent revenue (the base currency).
 */
function materialityText(p: Profile, short = false): string | undefined {
  const m = p.materiality;
  if (!m) return undefined;
  const pct = short ? ` / ${m.pct}%` : ` or ${m.pct}%`;
  const confirm = short ? "unconfirmed" : "confirm";
  if (m.basis === "consolidated") return `${money(m.amount, p.baseCurrency)}${pct} (from consolidated TTM revenue)`;
  if (m.basis === "parent") return `${money(m.amount, p.baseCurrency)}${pct} (from the parent subsidiary, ${m.from}; ${confirm})`;
  if (!m.from) {
    // An older profile.json on a OneWorld account derived this from the mixed-currency sum.
    if (p.oneWorld && !p.overrides?.materiality_amount) {
      return `${money(m.amount)}${pct} (derived from a mixed-currency total; refresh the ttm_revenue probe or set materiality_amount)`;
    }
    return `${money(m.amount, p.baseCurrency)}${pct}`;
  }
  // The largest subsidiary (or a profile.json from before `basis`): in that subsidiary's currency.
  const inBase = !!m.fromId && m.fromId === p.parentSubsidiaryId;
  const amount = money(m.amount, inBase ? p.baseCurrency : undefined);
  const curs = new Set((p.ttmRevenueBySubsidiary ?? []).map((x) => x.currency ?? "?"));
  const differ = inBase ? "" : curs.has("?") ? "; currencies may differ" : curs.size > 1 ? "; currencies differ" : "";
  return `${amount}${pct} (from the largest subsidiary, ${m.from}, in its currency${differ}; ${confirm})`;
}

function ttmRows(p: Profile): [string, string][] {
  const out: [string, string][] = [];
  const c = p.ttmRevenueConsolidated;
  // In the base currency; where it came from (c.source) is kept in profile.json.
  if (c) out.push(["TTM revenue (consolidated)", amountIn(c.amount, p.baseCurrency)]);
  const by = p.ttmRevenueBySubsidiary;
  if (by?.length) {
    const shown = by.slice(0, 8).map((x) => `${x.name} ${amountIn(x.amount, x.currency)}`);
    out.push(["TTM revenue by subsidiary (each in its own base currency, not converted)", `${shown.join(" · ")}${by.length > 8 ? ` · +${by.length - 8} more` : ""}`]);
    return out;
  }
  if (c) return out;
  if (p.ttmRevenue === undefined) return [["TTM revenue", "unknown"]];
  // An older profile.json has no ttmRevenueMixed flag; on a OneWorld account its figure is the mixed sum.
  if (p.ttmRevenueMixed || p.oneWorld) {
    return [["TTM revenue", `${compact(p.ttmRevenue)}, a sum of several subsidiaries' base currencies (not a real total); for per-subsidiary figures, run the su-ns-harness:refresh skill (sections: profile)`]];
  }
  return [["TTM revenue", money(p.ttmRevenue, p.baseCurrency)]];
}

function baseCurrencyText(p: Profile): string {
  if (p.baseCurrency) return p.baseCurrencySource === "fx" ? `${p.baseCurrency} (from transactions at rate 1; confirm)` : p.baseCurrency;
  return p.baseCurrencyWhy ? `unknown (${p.baseCurrencyWhy}; set it with ${cliCommand()} profile set base_currency=<code>)` : "unknown";
}

/** Two-line summary used in SessionStart context. */
export function profileLines(p: Profile | undefined): string[] {
  if (!p) return [];
  const subs = p.oneWorld ? `yes (${p.subsidiaryCount} subs)` : yn(p.oneWorld);
  const l1 = `Base currency ${p.baseCurrency ?? "?"}${p.baseCurrency && p.baseCurrencySource === "fx" ? " (inferred, unconfirmed)" : ""} · FY starts ${p.fiscalYearStartMonth ?? "?"} · OneWorld: ${subs} · Multi-book: ${yn(p.multiBook)}`;
  const parts: string[] = [];
  if (p.openPeriods?.length) parts.push(`Open periods: ${p.openPeriods.join(", ")}`);
  if (p.materiality) parts.push(`Materiality tier: ${materialityText(p, true)}`);
  if (p.approvalWorkflows) {
    const on = Object.entries(p.approvalWorkflows).filter(([, v]) => v).map(([k]) => k);
    parts.push(`Approval workflows: ${on.length ? on.join(", ") : "none"}`);
  }
  return parts.length ? [l1, parts.join(" · ")] : [l1];
}

export function profileCard(p: Profile): string {
  const rows: [string, string][] = [
    ["Base currency", baseCurrencyText(p)],
    ["Fiscal year starts", p.fiscalYearStartMonth ?? "unknown"],
    ["OneWorld", p.oneWorld === undefined ? "unknown" : p.oneWorld ? `yes, ${p.subsidiaryCount} subsidiaries` : "no"],
    ["Multi-book", yn(p.multiBook)],
    ["Open periods", p.openPeriods?.join(", ") || "unknown"],
    ...ttmRows(p),
    ["Materiality", materialityText(p) ?? "unknown"],
    [
      "Approval workflows",
      p.approvalWorkflows
        ? Object.entries(p.approvalWorkflows).map(([k, v]) => `${k}: ${v ? "yes" : "no"}`).join(", ") || "none found"
        : "unknown",
    ],
  ];
  const overrides = Object.entries(p.overrides ?? {});
  return [
    "# NetSuite Profile Card",
    "",
    "| | |",
    "|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    "",
    overrides.length ? `User overrides: ${overrides.map(([k, v]) => `${k}=${v}`).join(", ")}` : "No user overrides.",
    `Correct anything with: ${cliCommand()} profile set key=value (base_currency, fiscal_year_start, oneworld, multibook, ttm_revenue_consolidated, materiality_amount, materiality_pct, approval.<TypeCode>)`,
    "",
  ].join("\n");
}
