/** `nsx` — the su-ns-harness CLI (cache lookups, result analysis, SQL lint) and hook entrypoints. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { auditCsv, readAudit } from "./audit.ts";
import { emptyFieldsNote } from "./cache/catalog.ts";
import { buildProfile, loadProfile, parseDate, profileCard, setConsolidatedRevenue, setOverrides } from "./cache/profile.ts";
import { acctDirs, isFresh, loadManifest, markStale, readIndex, readRaw, safeSectionName, staleSections, ttlDaysFor } from "./cache/store.ts";
import { type Ctx, DataDirError, NoDataDirError, DEFAULT_TTL_DAYS, PLUGIN_VERSION, SETTING_KEYS, accountLabel, configSource, context, type DataDirChoice, dataDirChoice, dataDirNotice, describeChoice, lastConnector, loadConfig, markedDataDirs, othersIgnored, saveSettings, statelessContext } from "./config.ts";
import { expandNsx, runHook } from "./hooks/io.ts";
import { handleFailure, handlePost } from "./hooks/post.ts";
import { failClosedForWrites, handlePre, lintContextFor } from "./hooks/pre.ts";
import { cliCommand, handleSessionStart } from "./hooks/session-start.ts";
import { isWriteTool, writePreview } from "./preview.ts";
import { type Heartbeat, sessionDir } from "./session.ts";
import { type AggFn, aggregate, diff, diffChanged, fmtValue, parseWhere, pivot, renderRows, resolveColumn, resolveColumns, sortRows } from "./results/engine.ts";
import { idLikeName, profileColumns } from "./results/profile.ts";
import { acctDirOf, concatResults, dirSize, findResult, listResults, loadRows, reportCurrencyOf, type ResultMeta } from "./results/store.ts";
import { toXlsx } from "./results/xlsx.ts";
import type { Row } from "./rows.ts";
import { fixRownum, formatLint, lintSuiteQL } from "./sql/lint.ts";
import { ageLabel, ensureDir, fmtNum, ignoreEpipe, readJson, textTable, toCsv } from "./util.ts";

class UsageError extends Error {
  override name = "UsageError";
}

export interface Args {
  pos: string[];
  /** Each flag's last value (a repeated flag keeps the last one here; see `multi`). */
  flags: Record<string, string | true>;
  /** Every value of every flag, in order (`--where A --where B` → ["A", "B"]); a bare flag is `true`. */
  multi?: Record<string, (string | true)[]>;
}

/** Flags that never take a value, so `--asc 5` or `--any-account r_x` leave the next word positional. */
const BOOLEAN_FLAGS = new Set(["asc", "any-account", "open", "years", "record", "preflight", "help", "version"]);

export function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  const multi: Record<string, (string | true)[]> = {};
  const set = (k: string, v: string | true) => {
    flags[k] = v;
    (multi[k] ??= []).push(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) set(a.slice(2, eq), a.slice(eq + 1));
      else if (!BOOLEAN_FLAGS.has(a.slice(2)) && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) set(a.slice(2), argv[++i]);
      else set(a.slice(2), true);
    } else pos.push(a);
  }
  return { pos, flags, multi };
}

/**
 * The flags each command reads, keyed "command" or "command subcommand" (the subcommand a bare
 * command defaults to included). Anything else is a UsageError, so a typo (`--col`, `--were`) or a
 * flag a subcommand doesn't have (`--sort` on head) never passes silently. A
 * subcommand not listed here is left to its own usage error.
 */
const WHERE = ["where", "any-account"];
export const COMMAND_FLAGS: Record<string, string[]> = {
  reports: ["max"],
  searches: ["max"],
  recordtypes: ["grep", "max"],
  fields: ["grep", "record", "max"],
  periods: ["open", "years", "grep", "max"],
  "cache status": [],
  "cache show": ["grep", "max"],
  "cache build": [],
  "cache invalidate": [],
  "profile show": [],
  "profile set": [],
  "profile ttm-report": [],
  "profile from-report": [],
  "results list": ["n", "any-account"],
  "results schema": ["any-account"],
  "results head": ["cols", "n", "sort", "asc", "max", ...WHERE],
  "results filter": ["cols", "sort", "asc", "max", ...WHERE],
  "results agg": ["by", "sum", "avg", "min", "max", "count", "top", "sort", "asc", ...WHERE],
  "results pivot": ["rows", "cols", "sum", "avg", "min", "max", "count", ...WHERE],
  "results diff": ["on", "cols", "tolerance", "top", "max", ...WHERE],
  "results concat": ["any-account"],
  "results export": ["csv", "xlsx", "out", "sort", "asc", ...WHERE],
  "results raw": ["grep", "head", "any-account"],
  "results path": ["any-account"],
  sql: [],
  preview: ["before"],
  "audit export": ["session", "days", "out"],
  "audit tail": ["n", "session", "days"],
  "config show": [],
  "config set": [],
  doctor: ["preflight"],
  version: [],
};

const DEFAULT_SUB: Record<string, string> = { cache: "status", profile: "show", results: "list", audit: "export", config: "show" };

/** Every command, and the subcommands of those that have them. */
const COMMANDS = ["reports", "searches", "recordtypes", "fields", "periods", "cache", "profile", "results", "sql", "preview", "audit", "config", "doctor", "version", "help"];
const SUBCOMMANDS: Record<string, string[]> = {
  cache: ["status", "show", "build", "invalidate"],
  profile: ["show", "set", "ttm-report", "from-report"],
  results: ["list", "schema", "head", "filter", "agg", "pivot", "diff", "concat", "export", "raw", "path"],
  audit: ["export", "tail"],
  config: ["show", "set"],
};

/**
 * How many positional arguments each scope takes after its own words, so a stray one (`audit tail 2`,
 * `results list 1`, `cache status extra`) is refused instead of ignored. Absent = no limit.
 */
const MAX_POS: Record<string, number> = {
  periods: 0,
  "cache status": 0,
  "cache show": 1,
  "cache build": 0,
  "cache invalidate": 1,
  "profile show": 0,
  "profile ttm-report": 0,
  "profile from-report": 1,
  "results list": 0,
  "results schema": 1,
  "results head": 2,
  "results filter": 1,
  "results agg": 1,
  "results pivot": 1,
  "results diff": 2,
  "results export": 1,
  "results raw": 1,
  "results path": 1,
  preview: 2,
  "audit export": 0,
  "audit tail": 0,
  "config show": 0,
  doctor: 0,
  version: 0,
  help: 1,
};

/** Where a stray number most likely belonged. */
const NUMBER_FLAG: Record<string, string> = { periods: "--max", "results list": "--n", "audit tail": "--n", "cache show": "--max" };

/** Flags that need a value; a bare one (`--where` with nothing after it) is refused, never ignored. */
const VALUE_HINT: Record<string, string> = {
  where: '--where "amount>10000"',
  cols: "--cols a,b",
  grep: "--grep term",
  by: "--by col",
  rows: "--rows col",
  on: "--on key",
  out: "--out file",
  before: "--before current.json",
  days: "--days 7",
  n: "--n 10",
  head: "--head 40",
  max: "--max 100",
};

/** Numeric flags: `--max abc`, `--n 0`, `--days -1` are refused rather than replaced by the default. */
const NUMERIC: Record<string, "int" | "num"> = { n: "int", max: "int", head: "int", days: "num" };

/** Scopes where --max is an aggregate over a column, not a row cap. */
const MAX_IS_METRIC = new Set(["results agg", "results pivot"]);

const USAGE: Record<string, string> = {
  reports: "nsx reports search <terms…> [--max N]",
  searches: "nsx searches search <terms…> [--max N]",
  recordtypes: "nsx recordtypes [term…] [--grep t|t2] [--max N]",
  fields: "nsx fields <table> [term…] [--grep t] [--record] [--max N]",
  periods: "nsx periods [--open|--years] [--grep t] [--max N]",
  cache: "nsx cache status | cache show <section> [--grep t] [--max N] | cache build | cache invalidate <section|kind|all>",
  profile: "nsx profile show | profile set key=value… | profile ttm-report | profile from-report <result id>",
  results:
    "nsx results list [--n N] | results schema|head|filter|agg|pivot|export|raw|path <id> … | results diff <idA> <idB> --on k --cols c | results concat <id> <id>…\n" +
    '  head <id> [N] [--n N] [--cols a,b] [--where "…"] [--sort col [--asc]]   filter <id> --where "…"\n' +
    "  agg <id> --by col --sum|--avg|--min|--max col [--count] [--top N]   pivot <id> --rows col --cols col (--sum col|--count)\n" +
    "  export <id> --csv [path] | --xlsx [path]   raw <id> [--grep t] [--head N]   path <id>   (--any-account: look in other accounts too)",
  sql: 'nsx sql lint <file|-|"sql"> | sql fix-rownum <file|-|"sql">   (- reads stdin)',
  preview: "echo '<tool input json>' | nsx preview <ns_write_tool> - [--before current.json]   (or a JSON file instead of -)",
  audit: "nsx audit export [--session [id]] [--days N] [--out file] | audit tail [--n N] [--session [id]] [--days N]",
  config: "nsx config show | config set key=value…   (empty value = default; read_only=false only from your own terminal)",
  doctor: "nsx doctor [--preflight]",
  version: "nsx version   (or --version, -v)",
  help: "nsx help [command]   (or <command> --help)",
};

/** The first known word near `w` (edit distance ≤ 2, or a prefix either way). */
function guess(w: string, known: string[]): string | undefined {
  return known.find((k) => k.startsWith(w) || w.startsWith(k)) ?? known.find((k) => near(w, k));
}

/** `-n 5` → `--n 5`; `-h` → `--help`; `-v`/`-V` → `--version`. Other single-dash words are left for checkFlags to refuse. */
export function normalizeArgv(argv: string[]): string[] {
  const short: Record<string, string> = { "-n": "--n", "-h": "--help", "-v": "--version", "-V": "--version" };
  return argv[0] === "hook" ? argv : argv.map((t) => short[t] ?? t);
}

/** Edit distance ≤ 2, for "did you mean". */
function near(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 2) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] <= 2;
}

/**
 * Throws a UsageError for anything the command would otherwise ignore: an unknown command or
 * subcommand, a flag it doesn't read, a value flag with no value, a non-numeric number, a stray
 * positional argument, or a single-dash option.
 */
export function checkFlags(a: Args): void {
  const cmd = a.pos[0];
  if (!cmd || cmd === "hook") return;
  if (!COMMANDS.includes(cmd)) {
    const g = guess(cmd, COMMANDS);
    throw new UsageError(`unknown command '${cmd}'.${g ? ` Did you mean '${g}'?` : ""} Commands: ${COMMANDS.join(", ")} (nsx --help)`);
  }
  const subs = SUBCOMMANDS[cmd];
  if (subs && a.pos[1] !== undefined && !subs.includes(a.pos[1])) {
    const g = guess(a.pos[1], subs);
    throw new UsageError(`unknown ${cmd} subcommand '${a.pos[1]}'.${g ? ` Did you mean '${g}'?` : ""} usage: ${USAGE[cmd]}`);
  }
  const sub = a.pos[1] ?? DEFAULT_SUB[cmd];
  const scope = Object.hasOwn(COMMAND_FLAGS, `${cmd} ${sub}`) ? `${cmd} ${sub}` : Object.hasOwn(COMMAND_FLAGS, cmd) ? cmd : undefined;
  if (!scope) return;
  const dash = a.pos.find((t) => /^-[A-Za-z]/.test(t));
  if (dash) throw new UsageError(`unknown option ${dash}: flags take two dashes (--${dash.replace(/^-+/, "")}). usage: ${USAGE[cmd]}`);
  const allowed = COMMAND_FLAGS[scope];
  const bad = Object.keys(a.flags).filter((f) => !allowed.includes(f));
  if (bad.length) {
    const g = bad.length === 1 ? allowed.find((f) => f.startsWith(bad[0]) || bad[0].startsWith(f) || near(bad[0], f)) : undefined;
    throw new UsageError(
      `unknown flag${bad.length > 1 ? "s" : ""} ${bad.map((f) => `--${f}`).join(", ")} for ${scope} (${allowed.length ? `flags: ${allowed.map((f) => `--${f}`).join(", ")}` : "it takes no flags"})${g ? `. Did you mean --${g}?` : ""}`,
    );
  }
  for (const [f, v] of Object.entries(a.flags)) {
    const metric = f === "max" && MAX_IS_METRIC.has(scope);
    if (Object.hasOwn(VALUE_HINT, f) && !metric && (v === true || v.trim() === "")) throw new UsageError(`--${f} needs a value: ${VALUE_HINT[f]}`);
    const kind = metric ? undefined : NUMERIC[f];
    if (kind && typeof v === "string") {
      const n = Number(v);
      const ok = kind === "int" ? /^\d+$/.test(v.trim()) && n >= 1 : Number.isFinite(n) && n > 0;
      if (!ok) throw new UsageError(`--${f} must be a positive ${kind === "int" ? "whole number" : "number"}, got '${v}'`);
    }
  }
  if (Object.hasOwn(MAX_POS, scope)) {
    const own = scope.includes(" ") && a.pos[1] !== undefined ? 2 : 1;
    const extra = a.pos.slice(own + MAX_POS[scope]);
    if (extra.length) {
      const year = scope === "periods" && /^(19|20)\d\d$/.test(extra[0] ?? "");
      const hint = NUMBER_FLAG[scope] && extra.length === 1 && /^\d+$/.test(extra[0]) ? ` Did you mean ${year ? "--grep" : NUMBER_FLAG[scope]} ${extra[0]}?` : "";
      throw new UsageError(`unexpected argument${extra.length > 1 ? "s" : ""} ${extra.map((x) => `'${x}'`).join(" ")} for ${scope}.${hint} usage: ${USAGE[cmd]}`);
    }
  }
  if (scope === "results head" && a.pos[3] !== undefined && !/^\d+$/.test(a.pos[3])) {
    throw new UsageError(`results head takes a row count after the id, got '${a.pos[3]}'. usage: nsx results head <id> [N] [--where "…"]`);
  }
}

const flag = (a: Args, k: string) => (typeof a.flags[k] === "string" ? (a.flags[k] as string) : undefined);
/** A numeric flag; anything else (e.g. `--max amount` on agg, where max is a metric) → the default. */
const num = (a: Args, k: string, dflt: number) => {
  const v = Number(flag(a, k));
  return flag(a, k) !== undefined && Number.isFinite(v) && v >= 0 ? v : dflt;
};
const list = (s: string | undefined) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : []);

/**
 * `-` = stdin (only when asked for: an open pipe with no data would hang); an existing file path =
 * its contents; otherwise text that can't be a path
 * (JSON, `(…`, or anything with a space: `DELETE FROM x`) is the literal text, so lint can say
 * what's wrong with it instead of "No such file".
 */
export function readInput(src: string | undefined): string {
  if (!src) throw new UsageError('no input given: pass a file, - to read stdin, or the text itself ("SELECT …" / \'{"…": …}\')');
  if (src === "-") return fs.readFileSync(0, "utf8");
  if (fs.existsSync(src) && fs.statSync(src).isFile()) return fs.readFileSync(src, "utf8");
  if (/^\s*[\[{(]|^\s*(select|with)\b/i.test(src) || /\s/.test(src.trim())) return src;
  throw new UsageError(`No such file: ${src}`);
}

function needAcct(ctx: Ctx): string {
  if (!ctx.acctDir) throw new UsageError("No NetSuite connector call seen yet, so there is no cache to read. Run the su-ns-harness:init skill yourself (it needs nothing from the user), or make any ns_* call, first.");
  return ctx.acctDir;
}

// ---------------- cache lookups ----------------

function freshness(ctx: Ctx, acctDir: string, section: string): string {
  const e = loadManifest(acctDir).sections[safeSectionName(section)];
  if (!e) return "";
  const age = ageLabel(Date.now() - Date.parse(e.fetchedAt));
  return isFresh(e, ctx.cfg, section) ? `(cached ${age} ago)` : `(STALE: cached ${age} ago${e.staleReason ? `, ${e.staleReason}` : ""} — refresh before relying on it)`;
}

/**
 * Case-insensitive substring search: every term must match somewhere in the row; `a|b` in a term
 * matches either. Exact cell matches rank first, then prefix, then substring.
 */
export function searchRows(header: string[], rows: string[][], terms: string[]): string[][] {
  const want = terms.map((t) => t.toLowerCase().split("|").map((x) => x.trim()).filter(Boolean)).filter((alts) => alts.length);
  const hits = rows.filter((r) => {
    const line = r.join(" ").toLowerCase();
    return want.every((alts) => alts.some((w) => line.includes(w)));
  });
  // Ranked on the whole phrase for multi-word searches ("income statement"), else on the alternatives.
  const phrase = want.length === 1 ? want[0] : want.length ? [terms.join(" ").toLowerCase()] : [];
  const rank = (r: string[]) => {
    let best = 3;
    for (const cell of r) {
      const c = cell.toLowerCase();
      for (const w of phrase) best = Math.min(best, c === w ? 0 : c.startsWith(w) ? 1 : c.includes(w) ? 2 : 3);
    }
    return best;
  };
  const nameCol = ["title", "name", "recordtype", "field"].map((n) => header.indexOf(n)).find((i) => i >= 0) ?? 0;
  const ranked = hits.map((r) => ({ r, k: rank(r) }));
  ranked.sort((a, b) => a.k - b.k || (a.r[nameCol] ?? "").length - (b.r[nameCol] ?? "").length || (a.r[nameCol] ?? "").localeCompare(b.r[nameCol] ?? ""));
  return ranked.map((x) => x.r);
}

function search(ctx: Ctx, acctDir: string, section: string, terms: string[], max: number, missHint: string): string {
  const ix = readIndex(acctDir, section);
  if (!ix.header.length) return `No ${section} cached. ${missHint}`;
  const hits = searchRows(ix.header, ix.rows, terms);
  const shown = hits.slice(0, max);
  const note = shown.length < hits.length ? ` (showing ${shown.length}; --max N for more)` : "";
  const head = `${hits.length} of ${ix.rows.length} ${section} match ${terms.length ? `"${terms.join(" ")}" (substring; a|b = either)` : "(all)"}${note} ${freshness(ctx, acctDir, section)}`;
  if (!hits.length) return `${head}\nNo match. Try fewer/other terms; if it should exist, the cache may be outdated: ${missHint}`;
  return `${head}\n${textTable(ix.header, shown, shown.length, { full: ["params"] })}`;
}

function cmdFields(ctx: Ctx, a: Args): string {
  const acctDir = needAcct(ctx);
  const table = (a.pos[1] ?? "").toLowerCase();
  if (!table) throw new UsageError(`usage: ${USAGE.fields}`);
  const section = a.flags.record ? `recordmeta/${table}` : `fields/${table}`;
  if (loadManifest(acctDir).sections[safeSectionName(section)]?.status === "empty") return `${emptyFieldsNote(acctDir, table)} ${freshness(ctx, acctDir, section)}`;
  const ix = readIndex(acctDir, section);
  if (!ix.header.length) {
    return `Fields for '${table}' not cached. Call ${a.flags.record ? `ns_getRecordTypeMetadata with recordType "${table}"` : `ns_getSuiteQLMetadata with recordType "${table}"`} once — the result is cached automatically — then re-run this.`;
  }
  // `nsx fields transaction amount` = `--grep amount`; every term must match.
  const terms = [flag(a, "grep"), ...a.pos.slice(2)].filter((t): t is string => !!t);
  const rows = terms.length ? searchRows(ix.header, ix.rows, terms) : ix.rows;
  return `${rows.length} of ${ix.rows.length} fields in ${table}${terms.length ? ` matching "${terms.join(" ")}"` : ""} ${freshness(ctx, acctDir, section)}\n${textTable(ix.header, rows, num(a, "max", 60))}`;
}

function cmdPeriods(ctx: Ctx, a: Args): string {
  const acctDir = needAcct(ctx);
  const ix = readIndex(acctDir, "periods");
  if (!ix.header.length) return "Periods not cached. Run the su-ns-harness:refresh skill yourself (sections: periods); it has the exact tagged query.";
  const c = (n: string) => ix.header.indexOf(n);
  const yes = (r: string[], n: string) => /^(t|true|y|1)$/i.test(r[c(n)] ?? "");
  let rows = ix.rows;
  if (a.flags.open) {
    // Same rule as the Profile Card: months only, earliest first, skipping leftovers that ended over a year ago.
    const open = rows
      .filter((r) => !yes(r, "closed") && !yes(r, "isyear") && !yes(r, "isquarter") && !yes(r, "isadjust"))
      .map((r) => ({ r, s: parseDate(r[c("startdate")] ?? "")?.getTime() ?? Infinity, e: parseDate(r[c("enddate")] ?? "")?.getTime() }))
      .sort((x, y) => x.s - y.s);
    const current = open.filter((x) => (x.e ?? x.s) >= Date.now() - 365 * 86_400_000);
    rows = (current.length ? current : open).map((x) => x.r);
  }
  if (a.flags.years) rows = rows.filter((r) => yes(r, "isyear"));
  const g = flag(a, "grep")?.toLowerCase();
  if (g) rows = rows.filter((r) => r.join(" ").toLowerCase().includes(g));
  // Open periods: the earliest N (accounts pre-create years of open periods, so the current one is
  // near the start). The full list: the latest N.
  const max = num(a, "max", a.flags.open ? 6 : 40);
  const shown = a.flags.open ? rows.slice(0, max) : rows.slice(-max);
  const note = shown.length < rows.length ? ` (showing the ${a.flags.open ? "earliest" : "latest"} ${shown.length}; --max N for more)` : "";
  return `${rows.length} period${rows.length === 1 ? "" : "s"}${note} ${freshness(ctx, acctDir, "periods")}\n${textTable(ix.header, shown, shown.length)}`;
}

function cmdCache(ctx: Ctx, a: Args): string {
  const sub = a.pos[1] ?? "status";
  const acctDir = needAcct(ctx);
  if (sub === "status") {
    const m = loadManifest(acctDir);
    const rows = Object.entries(m.sections)
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([n, e]) => [n, String(e.count), e.status === "ok" && !isFresh(e, ctx.cfg, n) ? "stale" : e.status, ageLabel(Date.now() - Date.parse(e.fetchedAt)), `${ttlDaysFor(ctx.cfg, n)}d`, e.sourceTool]);
    if (!rows.length) return `Cache for ${accountLabel(ctx)} is empty. Run the su-ns-harness:init skill yourself (it needs nothing from the user).`;
    const stale = staleSections(m, ctx.cfg).length;
    return `Cache ${accountLabel(ctx)}: ${rows.length} sections, ${stale} stale\n${textTable(["section", "count", "status", "age", "ttl", "source"], rows, 500)}`;
  }
  if (sub === "show") {
    const name = a.pos[2];
    if (!name) throw new UsageError("usage: nsx cache show <section> [--grep term]");
    if (loadManifest(acctDir).sections[safeSectionName(name)]?.status === "empty") {
      const [kind, table] = name.split("/");
      return (kind === "fields" || kind === "recordmeta") && table ? emptyFieldsNote(acctDir, table) : `Section '${name}' is empty: the call worked but returned nothing.`;
    }
    const ix = readIndex(acctDir, name);
    if (!ix.header.length) {
      const raw = readRaw(acctDir, name);
      if (raw === undefined) {
        const have = Object.keys(loadManifest(acctDir).sections).sort();
        const kind = name.split("/")[0];
        const alike = have.filter((n) => n.split("/")[0] === kind);
        const listed = (alike.length ? alike : have).slice(0, 30);
        return `Section '${name}' not cached.${have.length ? ` Cached${alike.length ? ` ${kind} sections` : ""}: ${listed.join(", ")}${(alike.length || have.length) > listed.length ? ", …" : ""} (nsx cache status lists all)` : " Nothing is cached yet."}`;
      }
      const s = typeof raw === "string" ? raw : JSON.stringify(raw);
      return `Section '${name}' is unparsed; raw (first 3000 chars):\n${s.slice(0, 3000)}`;
    }
    const g = flag(a, "grep");
    const rows = g ? searchRows(ix.header, ix.rows, [g]) : ix.rows;
    return `${rows.length} rows in ${name} ${freshness(ctx, acctDir, name)}\n${textTable(ix.header, rows, num(a, "max", 60))}`;
  }
  if (sub === "build") {
    const p = buildProfile(acctDir);
    const m = loadManifest(acctDir);
    return `Rebuilt profile from ${Object.keys(m.sections).length} cached sections.\n\n${profileCard(p)}`;
  }
  if (sub === "invalidate") {
    const target = a.pos[2];
    if (!target) throw new UsageError("usage: nsx cache invalidate <section|kind|all>");
    const m = loadManifest(acctDir);
    const names = Object.keys(m.sections).filter((n) => target === "all" || n === safeSectionName(target) || n.split("/")[0] === target);
    for (const n of names) markStale(acctDir, n, "invalidated by user");
    return names.length ? `Marked stale: ${names.join(", ")}` : `No cached section matches '${target}'.`;
  }
  throw new UsageError("usage: nsx cache status|show <section>|build|invalidate <section>");
}

function cmdProfile(ctx: Ctx, a: Args): string {
  const acctDir = needAcct(ctx);
  const sub = a.pos[1] ?? "show";
  if (sub === "show") {
    const p = loadProfile(acctDir);
    return p ? profileCard(p) : "No profile yet. Run the su-ns-harness:init skill yourself (it needs nothing from the user).";
  }
  if (sub === "set") {
    const pairs: Record<string, string> = {};
    for (const kv of a.pos.slice(2)) {
      const i = kv.indexOf("=");
      if (i <= 0) throw new UsageError(`Expected key=value, got '${kv}'`);
      pairs[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
    if (!Object.keys(pairs).length) throw new UsageError("usage: nsx profile set key=value [key=value…]");
    try {
      return profileCard(setOverrides(acctDir, pairs));
    } catch (e) {
      // A rejected key/value is a usage problem (exit 2); a disk error stays one.
      if ((e as NodeJS.ErrnoException).code) throw e;
      throw new UsageError((e as Error).message);
    }
  }
  if (sub === "ttm-report") return ttmReportInput(acctDir);
  if (sub === "from-report") {
    const meta = findResult([acctDir], a.pos[2] ?? "");
    if (!meta) throw new UsageError(`usage: nsx profile from-report <result id>   (${a.pos[2] ? `result ${a.pos[2]} not found; see nsx results list` : "missing result id"}). If the report came back inline, read its Sales line and run: nsx profile set ttm_revenue_consolidated=<amount>`);
    const r = consolidatedRevenue(meta, loadRows(meta));
    return `Stored consolidated TTM revenue ${fmtNum(r.amount)} (${r.source}).\n\n${profileCard(setConsolidatedRevenue(acctDir, r))}`;
  }
  throw new UsageError("usage: nsx profile show|set key=value|ttm-report|from-report <result id>");
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const truthyCell = (v: string | undefined) => /^(t|true|y|yes|1)$/i.test((v ?? "").trim());
const monthLabel = (d: Date) => d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/**
 * The TTM window: the last 12 complete accounting periods from the periods cache (month periods,
 * not year/quarter/adjustment; complete = closed, or ended before today), which is how finance
 * reads "TTM". Without usable periods: 12 months ending today, i.e. dateTo − 12 months + 1 day.
 */
export function ttmWindow(acctDir: string, now = new Date()): { from: string; to: string; label: string } {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ix = readIndex(acctDir, "periods");
  const c = (n: string) => ix.header.indexOf(n);
  if (c("startdate") >= 0 && c("enddate") >= 0) {
    const seen = new Set<number>();
    const done = ix.rows
      .filter((r) => !truthyCell(r[c("isyear")]) && !truthyCell(r[c("isquarter")]) && !truthyCell(r[c("isadjust")]))
      .map((r) => ({ s: parseDate(r[c("startdate")] ?? "")?.getTime(), e: parseDate(r[c("enddate")] ?? "")?.getTime(), closed: truthyCell(r[c("closed")]) }))
      .filter((p): p is { s: number; e: number; closed: boolean } => p.s !== undefined && p.e !== undefined && p.s <= p.e)
      .filter((p) => p.e < today || (p.closed && p.s <= today))
      .sort((x, y) => x.s - y.s)
      // Several calendars can repeat a month; one row per start date.
      .filter((p) => (seen.has(p.s) ? false : (seen.add(p.s), true)));
    const last = done.slice(-12);
    const span = last.length === 12 ? (last[11].e - last[0].s) / 86_400_000 : 0;
    // 12 monthly periods span ~365 days; anything else (13-period years, gaps) falls back.
    if (span >= 330 && span <= 380) {
      const [a, b] = [new Date(last[0].s), new Date(last[11].e)];
      return { from: isoDay(a), to: isoDay(b), label: `last 12 complete periods, ${monthLabel(a)} – ${monthLabel(b)}` };
    }
  }
  const from = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate() + 1));
  return { from: isoDay(from), to: isoDay(now), label: "the 12 months to today (no 12 complete periods in the periods cache)" };
}

/**
 * The ns_runReport input for consolidated TTM revenue: the standard "Income Statement" that takes a
 * consolidated subsidiary (live: report -200, subsidiary -1 "<parent> (Consolidated)"), last 12 months.
 */
export function ttmReportInput(acctDir: string, now = new Date()): string {
  const reports = readIndex(acctDir, "reports");
  const [id, title, params] = ["id", "title", "params"].map((c) => reports.header.indexOf(c));
  if (id < 0 || title < 0) throw new UsageError("No reports cached. Call ns_listAllReports once (it's cached automatically), then run this again.");
  const is = reports.rows.filter((r) => (r[title] ?? "").trim().toLowerCase() === "income statement");
  const consol = is.find((r) => /\bconsol\b|sub\(consol\)/.test(r[params] ?? ""));
  const pick = consol ?? is[0];
  if (!pick) throw new UsageError('No report titled "Income Statement" in the cache. Find one with nsx reports search "income statement", run it for the last 12 months, then nsx profile from-report <result id>.');
  const subs = readIndex(acctDir, "subsidiaries");
  const [sid, sname] = [subs.header.indexOf("id"), subs.header.indexOf("name")];
  const consolSub = consol && sid >= 0 && sname >= 0 ? subs.rows.find((r) => /\(consolidated\)\s*$/i.test(r[sname] ?? "")) : undefined;
  const w = ttmWindow(acctDir, now);
  const input: Record<string, unknown> = { reportId: Number(pick[id]), ...(consolSub ? { subsidiaryId: Number(consolSub[sid]) } : {}), dateFrom: w.from, dateTo: w.to };
  return [
    `Call ns_runReport with exactly this input (${pick[title]}${consolSub ? `, ${consolSub[sname]}` : ""}, ${w.label}):`,
    JSON.stringify(input),
    `Then run: ${cliCommand()} profile from-report <the result id from its summary>   (inline result, no id: ${cliCommand()} profile set ttm_revenue_consolidated=<its Sales amount>)`,
  ].join("\n");
}

const REVENUE_LINES = ["sales", "total income", "income", "revenue", "total revenue"];

/** The Sales / Total Income section of a saved Income Statement result, for the Profile Card. */
export function consolidatedRevenue(meta: ResultMeta, rows: Row[]): { amount: number; source: string } {
  if (meta.tool !== "ns_runReport") throw new UsageError(`${meta.id} is a ${meta.tool} result, not a report. Run the report from nsx profile ttm-report first.`);
  let q: Record<string, unknown> = {};
  try {
    q = JSON.parse(meta.query) as Record<string, unknown>;
  } catch {
    /* older result: no input recorded */
  }
  const sub = Number(q.subsidiaryId);
  if (q.subsidiaryId !== undefined && Number.isFinite(sub) && sub >= 0) {
    throw new UsageError(`${meta.id} is for subsidiary ${sub}, not consolidated. Run the report with the consolidated subsidiary (nsx profile ttm-report prints the input).`);
  }
  const values = meta.columns.filter((c) => c.type === "num" && !["depth", "is_detail"].includes(c.name)).map((c) => c.name);
  if (values.length !== 1) throw new UsageError(`${meta.id} has ${values.length} amount columns (${values.join(", ") || "none"}); expected one. Run the report without column grouping.`);
  const isSection = (r: Row) => (r.kind === undefined ? r.is_detail !== true : r.kind === "section");
  for (const name of REVENUE_LINES) {
    const r = rows.find((x) => isSection(x) && String(x.line ?? "").trim().toLowerCase() === name);
    const n = Number(r?.[values[0]]);
    if (r && Number.isFinite(n)) {
      const period = q.dateFrom && q.dateTo ? ` ${q.dateFrom} to ${q.dateTo}` : "";
      return { amount: Math.abs(n), source: `${meta.id}: ${String(r.line)}${period}` };
    }
  }
  throw new UsageError(`No Sales or Total Income line in ${meta.id}. Check: nsx results filter ${meta.id} --where "kind=section". Then set it: nsx profile set ttm_revenue_consolidated=<amount>`);
}

// ---------------- config ----------------

/**
 * Only a person at a terminal: Claude's Bash tool has no TTY, and a TTY faked with `script` still
 * carries Claude Code's environment (CLAUDECODE, CLAUDE_CODE_SESSION_ID), so that is refused too.
 */
export function interactive(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID) return false;
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

function showConfig(ctx: Ctx): string {
  const cfg = loadConfig(ctx.data);
  const val = (k: (typeof SETTING_KEYS)[number]) =>
    k === "ttl_overrides" ? Object.entries(cfg.ttl_days).filter(([n, d]) => DEFAULT_TTL_DAYS[n] !== d).map(([n, d]) => `${n}=${d}`).join(", ") || "(none)" : String(cfg[k] === "" ? "(empty)" : cfg[k]);
  return textTable(["setting", "value", "from"], SETTING_KEYS.map((k) => [k, val(k), configSource(k, ctx.data)]), SETTING_KEYS.length);
}

export function cmdConfig(ctx: Ctx, argv: string[], isTty = interactive()): string {
  const a = parseArgs(argv);
  if (!ctx.data) throw new UsageError("No data dir yet: start a Claude Code session with su-ns-harness enabled first.");
  const sub = a.pos[1] ?? "show";
  if (sub === "show") return showConfig(ctx);
  if (sub !== "set") throw new UsageError(`usage: ${USAGE.config}\nSettings: ${SETTING_KEYS.join(", ")}`);
  const pairs: Record<string, string> = {};
  for (const kv of a.pos.slice(2)) {
    const i = kv.indexOf("=");
    if (i <= 0) throw new UsageError(`Expected key=value, got '${kv}'`);
    pairs[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  if (!Object.keys(pairs).length) throw new UsageError("usage: nsx config set key=value [key=value…]");
  // Turning writes on is the user's call, never Claude's.
  // An empty value resets read_only to its default (true), so it isn't gated.
  if (pairs.read_only !== undefined && /^(false|no|off|0)$/i.test(pairs.read_only) && !isTty) {
    throw new UsageError(
      `Turning NetSuite writes on has to be done by the user, in their own terminal, outside Claude Code (this is refused from Claude's Bash tool, a ! command, or anything else run by Claude Code):\n  ${cliCommand()} config set read_only=false\nIt applies to the next NetSuite call; no restart needed.`,
    );
  }
  try {
    saveSettings(ctx.data, pairs);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  return `Saved. Applies to the next NetSuite call (no restart).\n${showConfig(ctx)}`;
}

// ---------------- results ----------------

/** Results are looked up in the current account only; --any-account opts into the others. */
function getResult(ctx: Ctx, id: string | undefined, anyAccount = false): ResultMeta {
  if (!id) throw new UsageError("missing result id (see: nsx results list)");
  const dirs = anyAccount ? acctDirs(ctx.data) : [needAcct(ctx)];
  const m = findResult(dirs, id);
  if (!m) {
    throw new UsageError(
      `Result ${id} not found in ${anyAccount ? "any account" : ctx.acct} (expired after ${ctx.cfg.results_retention_days}d?). See: nsx results list${anyAccount ? "" : "   (other accounts/environments: add --any-account)"}`,
    );
  }
  return m;
}

/** Every value a flag was given (`--where A --where B` → both), strings only. */
const flagValues = (a: Args, k: string): string[] =>
  (a.multi?.[k] ?? (a.flags[k] === undefined ? [] : [a.flags[k]])).filter((v): v is string => typeof v === "string");

/** Flags that may repeat: --where (ANDed) and the agg/pivot metrics (lists joined). */
const REPEATABLE = new Set(["where", "sum", "avg", "min", "max", "count"]);

/** A flag given twice is refused unless it can repeat, rather than silently keeping the last value. */
function refuseRepeats(a: Args): void {
  for (const [k, vs] of Object.entries(a.multi ?? {})) {
    if (vs.length < 2 || REPEATABLE.has(k)) continue;
    // `--max 20 --max amount` on head etc.: --max is a row cap there.
    throw new UsageError(`--${k} given ${vs.length} times (${vs.map((v) => (v === true ? `--${k}` : `'${v}'`)).join(", ")}): give it once${["cols", "by", "on"].includes(k) ? `, with a comma list: --${k} a,b` : ""}`);
  }
}

function filtered(meta: ResultMeta, a: Args): Row[] {
  let rows = loadRows(meta);
  // Repeated --where flags all apply (AND). parseWhere resolves (and rejects) column names itself.
  for (const w of flagValues(a, "where")) {
    let pred: ReturnType<typeof parseWhere>;
    try {
      pred = parseWhere(w, meta.columns.map((c) => c.name));
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    rows = rows.filter(pred);
  }
  return rows;
}

/** Column names from a flag, resolved like --where's (case-insensitive, spaces as `_`); unknown ones are a UsageError. */
function columnsOf(meta: ResultMeta, names: string[], side?: string): string[] {
  try {
    return resolveColumns(meta.columns.map((c) => c.name), names, side);
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
}

/** Engine errors (sum of a date, report levels, bad --sort) are usage problems, not crashes. */
function usage<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError((e as Error).message);
  }
}

/**
 * `--sort col [--asc]` for head/filter/export, after --where: by the column's profiled type
 * (numbers largest first, dates latest first, text A→Z; --asc inverts; blanks last). The column is
 * resolved like --where's: quoted, case-insensitive, or with spaces as `_`.
 */
function sortedRows(meta: ResultMeta, a: Args, rows: Row[]): Row[] {
  const s = a.flags.sort;
  if (s === undefined) {
    if (a.flags.asc) throw new UsageError('--asc only applies with --sort: --sort "<column>" --asc');
    return rows;
  }
  if (s === true || !s.trim()) throw new UsageError('--sort needs a column: --sort "Last Run On" [--asc]');
  const cols = meta.columns.map((c) => c.name);
  const name = s.trim().replace(/^(["`])(.*)\1$/, "$2");
  const col = resolveColumn(cols, name);
  if (!col) throw new UsageError(`Unknown column for --sort: ${name}. Available: ${cols.join(", ")}`);
  return sortRows(rows, col, meta.columns.find((c) => c.name === col)?.type, !!a.flags.asc);
}

/** Exports land in the user's project by default; warn if git would pick them up. */
function gitignoreNote(file: string): string {
  try {
    const r = spawnSync("git", ["check-ignore", "-q", file], { cwd: path.dirname(file), stdio: "ignore", timeout: 3000 });
    // 0 = ignored, 1 = inside a repo and not ignored, 128 = not a repo / no git.
    if (r.status === 1) return `\nNote: this file is inside a git repository and not ignored. Add ${path.basename(path.dirname(file))}/ to .gitignore so NetSuite data isn't committed.`;
  } catch {
    /* no git */
  }
  return "";
}

function exportPath(meta: ResultMeta, a: Args, ext: string): string {
  const explicit = flag(a, ext) ?? flag(a, "out");
  const p = explicit ?? path.join(process.cwd(), "exports", `${meta.id}.${ext}`);
  ensureDir(path.dirname(path.resolve(p)));
  return path.resolve(p);
}

/** Why deltas are n/a, from the cells: "currency unknown", "EUR vs USD", "4 currencies". */
export function naReasons(rows: Row[], cols: string | string[]): string {
  const seen = new Set<string>();
  for (const r of rows) {
    for (const v of (Array.isArray(cols) ? cols : [cols]).flatMap((col) => [r[`${col}_delta`], r[`${col}_a`], r[`${col}_b`]])) {
      const m = typeof v === "string" ? /^n\/a \((.*)\)$/.exec(v.trim()) : null;
      if (m) seen.add(m[1]);
    }
  }
  const all = [...seen];
  return all.length ? all.slice(0, 3).join("; ") + (all.length > 3 ? "; …" : "") : "no numeric delta";
}

const RESULTS_SUBS = ["list", "schema", "head", "filter", "agg", "pivot", "diff", "concat", "export", "raw", "path"];

/** `--top N`: a positive whole number, or nothing. */
function topFlag(a: Args): number | undefined {
  const t = flag(a, "top");
  if (t === undefined) {
    if (a.flags.top === true) throw new UsageError("--top needs a number: --top 20");
    return undefined;
  }
  if (!/^\d+$/.test(t.trim()) || Number(t) < 1) throw new UsageError(`--top must be a positive whole number, got '${t}'`);
  return Number(t);
}

const noRows = (meta: ResultMeta, a: Args) =>
  `No rows match (0 of ${fmtNum(meta.rowCount)} rows${flagValues(a, "where").length ? ` after --where ${flagValues(a, "where").map((w) => `"${w}"`).join(" and ")}` : ""}): nothing to aggregate.`;

function cmdResults(ctx: Ctx, a: Args): string {
  const sub = a.pos[1] ?? "list";
  if (!RESULTS_SUBS.includes(sub)) {
    // `nsx results r_491bfd`: an id where the subcommand goes.
    if (/^r_[0-9a-f]+$/i.test(sub)) throw new UsageError(`missing subcommand before ${sub}: nsx results schema|head|filter|agg|pivot|export|raw|path ${sub} …`);
    throw new UsageError(`unknown results subcommand '${sub}'. usage: nsx results list|schema|head|filter|agg|pivot|diff|concat|export|raw|path <id> …`);
  }
  refuseRepeats(a);
  // `--max` is also an agg metric (--max amount); only a number sets the display cap.
  const max = num(a, "max", 60);
  const anyAccount = !!a.flags["any-account"];
  if (sub === "list") {
    const dirs = anyAccount ? acctDirs(ctx.data) : [needAcct(ctx)];
    const all = dirs
      .flatMap((d) => listResults(d).map((m) => ({ m, acct: path.basename(d) })))
      .sort((x, y) => x.m.createdAt.localeCompare(y.m.createdAt))
      .slice(-num(a, "n", 20))
      .reverse();
    if (!all.length) return anyAccount ? "No saved results in any account." : "No saved results.   (other accounts/environments: add --any-account)";
    const head = ["id", ...(anyAccount ? ["account"] : []), "created", "tool", "rows", "cols", "query"];
    return textTable(
      head,
      all.map(({ m, acct }) => [m.id, ...(anyAccount ? [acct] : []), m.createdAt.slice(5, 16).replace("T", " "), m.tool.replace(/^ns_/, ""), String(m.rowCount), String(m.columns.length), m.query.replace(/\s+/g, " ").slice(0, 60)]),
      all.length,
    );
  }
  const meta = getResult(ctx, a.pos[2], anyAccount);
  const cols = meta.columns.map((c) => c.name);
  const types = Object.fromEntries(meta.columns.map((c) => [c.name, c.type]));
  switch (sub) {
    case "schema": {
      const rows = loadRows(meta);
      const prof = profileColumns(cols, rows);
      const n = (v: number | string | undefined, c: string) => (v === undefined ? "" : typeof v === "number" ? fmtValue(v, c) : String(v));
      return [
        `${meta.id}: ${fmtNum(meta.rowCount)} rows · ${meta.tool} · ${meta.createdAt}${meta.truncated ? `\n⚠ ${meta.truncated}` : ""}`,
        `Query: ${meta.query.slice(0, 500)}`,
        textTable(
          ["column", "type", "distinct", "nulls", "sum", "min", "max"],
          prof.map((p) => [p.name, p.type, String(p.distinct), String(p.nulls), p.sum === undefined ? (p.sumNa ? `n/a (${p.sumNa})` : "") : fmtValue(p.sum, p.name), n(p.min, p.name), n(p.max, p.name)]),
          prof.length,
        ),
        ...prof.filter((p) => p.note).map((p) => `⚠ ${p.name}: ${p.note}`),
      ].join("\n");
    }
    case "head": {
      const n = a.pos[3] !== undefined && Number.isFinite(Number(a.pos[3])) ? Number(a.pos[3]) : num(a, "n", 10);
      const show = columnsOf(meta, list(flag(a, "cols")));
      const rows = sortedRows(meta, a, filtered(meta, a));
      return renderRows(show.length ? show : cols, rows.slice(0, n), Math.min(max, n));
    }
    case "filter": {
      if (!flagValues(a, "where").length) throw new UsageError('usage: nsx results filter <id> --where "amount>10000" [--cols a,b] [--sort col [--asc]]');
      const show = columnsOf(meta, list(flag(a, "cols")));
      const rows = sortedRows(meta, a, filtered(meta, a));
      return `${fmtNum(rows.length)} of ${fmtNum(meta.rowCount)} rows match\n${renderRows(show.length ? show : cols, rows, max)}`;
    }
    case "agg": {
      const by = columnsOf(meta, list(flag(a, "by")));
      const metrics: { fn: AggFn; col?: string }[] = [];
      const seen = new Set<string>();
      const add = (fn: AggFn, col?: string) => {
        const k = `${fn}\u0000${col ?? ""}`;
        if (!seen.has(k)) seen.add(k), metrics.push(col === undefined ? { fn } : { fn, col });
      };
      // Repeated metric flags add up: --sum a --sum b = --sum a,b.
      for (const fn of ["sum", "avg", "min", "max", "count"] as AggFn[]) {
        for (const v of a.multi?.[fn] ?? (a.flags[fn] === undefined ? [] : [a.flags[fn]])) {
          if (v === true) add(fn);
          else for (const c of columnsOf(meta, list(v))) add(fn, c);
        }
      }
      const top = topFlag(a);
      const rows = filtered(meta, a);
      if (!rows.length) return noRows(meta, a);
      const res = usage(() => aggregate(rows, { by, metrics, top, sort: flag(a, "sort"), asc: !!a.flags.asc, types }));
      const totalLine = `TOTAL (${fmtNum(rows.length)} rows): ${Object.entries(res.totals).map(([k, v]) => `${k}=${typeof v === "number" && !idLikeName(k) ? fmtValue(v, k) : v}`).join("  ")}`;
      const groups = new Set(rows.map((r) => JSON.stringify(by.map((b) => r[b])))).size;
      return `${renderRows(res.columns, res.rows, max)}\n${groups > res.rows.length ? `(showing ${res.rows.length} of ${groups} groups)\n` : ""}${totalLine}${res.warnings.map((w) => `\n⚠ ${w}`).join("")}${meta.truncated ? `\n⚠ source result is incomplete: ${meta.truncated}` : ""}`;
    }
    case "pivot": {
      const r = flag(a, "rows");
      const c = flag(a, "cols");
      if (!r || !c) throw new UsageError("usage: nsx results pivot <id> --rows col --cols col (--sum col|--avg col|--min col|--max col|--count [col])");
      const given = (["sum", "avg", "min", "max"] as AggFn[]).flatMap((f) => flagValues(a, f).map((v) => ({ fn: f, v })));
      const counts = a.multi?.count ?? (a.flags.count === undefined ? [] : [a.flags.count]);
      const all = [...given.map((g) => `--${g.fn} ${g.v}`), ...counts.map((v) => (v === true ? "--count" : `--count ${v}`))];
      if (all.length > 1 || given.some((g) => list(g.v).length > 1)) throw new UsageError(`pivot takes one metric, got ${all.join(", ")}: run one pivot per metric, or use results agg --by ${r},${c} for several`);
      const fn: AggFn = given[0]?.fn ?? "count";
      const rawVal = given[0]?.v ?? (typeof counts[0] === "string" ? counts[0] : undefined);
      const [rc, cc, val] = [...columnsOf(meta, [r, c]), ...(rawVal ? columnsOf(meta, [rawVal]) : [undefined])];
      const rows = filtered(meta, a);
      if (!rows.length) return noRows(meta, a);
      const p = usage(() => pivot(rows, rc!, cc!, fn, val, 12, types));
      const what = fn === "count" && val ? `(count of non-empty ${val})\n` : "";
      return what + renderRows(p.columns, p.rows, max) + p.warnings.map((w) => `\n⚠ ${w}`).join("") + (meta.truncated ? `\n⚠ source result is incomplete: ${meta.truncated}` : "");
    }
    case "diff": {
      const other = getResult(ctx, a.pos[3], anyAccount);
      const onRaw = list(flag(a, "on"));
      const valsRaw = list(flag(a, "cols"));
      if (!onRaw.length || !valsRaw.length) {
        const missing = [!onRaw.length && "--on (the key column(s) to match rows on)", !valsRaw.length && "--cols (the value column(s) to compare)"].filter(Boolean).join(" and ");
        throw new UsageError(`results diff is missing ${missing}. usage: nsx results diff <idA> <idB> --on key[,key] --cols amount[,col]`);
      }
      const tolRaw = flag(a, "tolerance");
      if (a.flags.tolerance === true) throw new UsageError("--tolerance needs an amount: --tolerance 0.01");
      const tol = tolRaw === undefined ? 0 : Number(tolRaw.trim());
      if (tolRaw !== undefined && (!/^\d*\.?\d+$/.test(tolRaw.trim()) || !Number.isFinite(tol) || tol < 0)) {
        throw new UsageError(`--tolerance takes an absolute amount ≥ 0 in the value column's units (e.g. --tolerance 0.01), not '${tolRaw}'`);
      }
      const onA = columnsOf(meta, onRaw, `a (${meta.id})`);
      const valsA = columnsOf(meta, valsRaw, `a (${meta.id})`);
      const onB = columnsOf(other, onRaw, `b (${other.id})`);
      const valsB = columnsOf(other, valsRaw, `b (${other.id})`);
      const differs = [...onA, ...valsA].filter((x, i) => x !== [...onB, ...valsB][i]);
      if (differs.length) throw new UsageError(`the columns are named differently in a (${meta.id}: ${[...onA, ...valsA].join(", ")}) and b (${other.id}: ${[...onB, ...valsB].join(", ")}); diff needs the same names on both sides`);
      const [on, vals] = [onA, valsA];
      // --where applies to both sides, so a filtered diff compares like with like.
      // Each result's profile lives in its own account dir, so --any-account works.
      const profOf = (m: ResultMeta) => {
        const dir = acctDirOf(m);
        return dir ? loadProfile(dir) : undefined;
      };
      const d = usage(() => diff(filtered(meta, a), filtered(other, a), on, vals, { reportCurrency: { a: reportCurrencyOf(meta, profOf(meta)), b: reportCurrencyOf(other, profOf(other)) }, tolerance: tol }));
      // Listed: keys changed in any value column, and n/a ones (a tolerance never hides those); a column blank on both sides is the same.
      const rows = d.rows.filter((r) => diffChanged(r, vals, tol));
      const na = d.counts.incomparable ? `; ${fmtNum(d.counts.incomparable)} can't be compared (n/a: ${naReasons(d.rows, vals)})` : "";
      return `${fmtNum(d.counts.changed)} of ${fmtNum(d.rows.length)} keys differ on ${d.on.join(",")} (a=${meta.id}, b=${other.id}${tol ? `, tolerance ${tol}` : ""})${na}\n${renderRows(d.columns, rows, Math.min(max, num(a, "top", 40)))}${d.notes.map((n) => `\nNote: ${n}`).join("")}${d.warnings.map((w) => `\n⚠ ${w}`).join("")}`;
    }
    case "concat": {
      const ids = a.pos.slice(2);
      if (ids.length < 2) throw new UsageError("usage: nsx results concat <id> <id> [<id>…]");
      const r = concatResults(ids.map((id) => getResult(ctx, id, anyAccount)));
      return [`Combined ${ids.length} results → ${r.meta.id} (${fmtNum(r.meta.rowCount)} rows × ${r.meta.columns.length} cols)`, ...r.notes.map((n) => `· ${n}`), ...(r.meta.truncated ? [`⚠ ${r.meta.truncated}`] : []), `Next: ${cliCommand()} results schema ${r.meta.id}`].join("\n");
    }
    case "export": {
      const rows = sortedRows(meta, a, filtered(meta, a));
      if (a.flags.xlsx !== undefined) {
        const p = exportPath(meta, a, "xlsx");
        const num = new Set(meta.columns.filter((c) => c.type === "num").map((c) => c.name));
        fs.writeFileSync(p, toXlsx(cols, rows, num));
        return `Exported ${fmtNum(rows.length)} rows → ${p}${gitignoreNote(p)}`;
      }
      const p = exportPath(meta, a, "csv");
      fs.writeFileSync(p, toCsv(cols, rows, true));
      return `Exported ${fmtNum(rows.length)} rows → ${p}${gitignoreNote(p)}`;
    }
    case "raw": {
      const raw = fs.readFileSync(meta.files.raw, "utf8");
      const g = flag(a, "grep");
      if (g) {
        const lines = raw.split(/\n|(?<=\},)/).filter((l) => l.toLowerCase().includes(g.toLowerCase()));
        return `${lines.length} matching chunks\n${lines.slice(0, 40).map((l) => l.slice(0, 300)).join("\n")}`;
      }
      const head = Number(flag(a, "head") ?? 40);
      return raw.slice(0, head * 100);
    }
    case "path":
      return `${meta.files.csv}\n${meta.files.raw}`;
    default:
      throw new UsageError("usage: nsx results list|schema|head|filter|agg|pivot|diff|concat|export|raw|path <id> …");
  }
}

// ---------------- sql / preview / audit ----------------

function cmdSql(ctx: Ctx, a: Args): string {
  let sub = a.pos[1];
  // An unquoted query arrives as several words: `nsx sql lint SELECT a, b FROM t`.
  let src = a.pos.length > 3 ? a.pos.slice(2).join(" ") : a.pos[2];
  // `nsx sql "<query>"` → lint it
  if (sub && sub !== "lint" && sub !== "fix-rownum") {
    src = a.pos.slice(1).join(" ");
    sub = "lint";
  }
  const sql = readInput(src);
  if (sub === "lint") {
    const r = lintSuiteQL(sql, lintContextFor(ctx));
    if (r.errors.length) process.exitCode = 1;
    return formatLint(r);
  }
  if (sub === "fix-rownum") {
    const fixed = fixRownum(sql);
    if (fixed !== sql) return fixed;
    const rownum = lintSuiteQL(sql).errors.some((e) => e.rule.startsWith("rownum-"));
    if (!rownum) return "No ROWNUM placement problem found; nothing to rewrite.";
    process.exitCode = 1;
    return "No safe automatic rewrite. Remove the ROWNUM condition and end the query with ORDER BY … FETCH FIRST N ROWS ONLY (never an outer ROWNUM: NetSuite applies it before the inner GROUP BY).";
  }
  throw new UsageError("usage: nsx sql lint <file|-|\"query\"> | nsx sql fix-rownum <file|-|\"query\">");
}

function cmdPreview(ctx: Ctx, a: Args): string {
  const tool = a.pos[1];
  const usage = `usage: ${USAGE.preview}`;
  if (!tool || !/^ns_/.test(tool)) throw new UsageError(usage);
  // Only writes are gated by a preview; a read tool (ns_runCustomSuiteQL) or a typo gets none.
  if (!isWriteTool(tool)) throw new UsageError(`${tool} is not a NetSuite write tool, so it needs no preview (previews are for ns_createRecord, ns_updateRecord, … before the user approves the write). ${usage}`);
  if (a.pos[2] === undefined) throw new UsageError(`${usage}\n(give - to read the JSON from stdin)`);
  const input = parseJsonInput(readInput(a.pos[2]), "the tool input");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new UsageError(`The tool input must be a JSON object ({"recordType": …}). ${usage}`);
  const beforeFile = flag(a, "before");
  let before: Record<string, unknown> | undefined;
  if (beforeFile) {
    if (!fs.existsSync(beforeFile)) throw new UsageError(`No such file: ${beforeFile}`);
    before = parseJsonInput(fs.readFileSync(beforeFile, "utf8"), beforeFile) as Record<string, unknown>;
  }
  const { file, preview } = writePreview(ctx.acctDir ?? ctx.data, tool, input as Record<string, unknown>, before);
  return [
    `Preview saved (${path.basename(file)}). Show this to the user before calling ${tool}:`,
    // diffLines says "(no field changes detected …)" itself for a no-op.
    ...preview.diff.slice(0, 60),
    preview.diff.length > 60 ? `… ${preview.diff.length - 60} more` : "",
    tool.includes("update") && !before ? "(No --before given: showing new values only. For updates, pass the current record from ns_getRecord.)" : "",
    `Then call ${tool} with exactly the same input; the user will be asked to approve.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** JSON the user passed in; a parse error is a usage problem (exit 2), not a crash. */
function parseJsonInput(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`Could not read JSON from ${what}: ${(e as Error).message}`);
  }
}

function cmdAudit(ctx: Ctx, a: Args): string {
  const acctDir = needAcct(ctx);
  const sub = a.pos[1] ?? "export";
  // Bare --session = this session; outside Claude Code there is none to default to.
  const session = flag(a, "session") ?? (a.flags.session === true ? currentSession() : undefined);
  if (a.flags.session !== undefined && !session) throw new UsageError("--session needs an id: this shell has no CLAUDE_CODE_SESSION_ID (it is set in Claude Code's Bash tool). Use --session <id>.");
  const entries = readAudit(acctDir, { session, days: flag(a, "days") ? Number(flag(a, "days")) : undefined });
  if (sub === "export") {
    const out = path.resolve(flag(a, "out") ?? path.join(process.cwd(), "exports", `netsuite-audit-${new Date().toISOString().slice(0, 10)}.csv`));
    ensureDir(path.dirname(out));
    fs.writeFileSync(out, auditCsv(entries));
    return `Wrote ${entries.length} audit entries → ${out}${gitignoreNote(out)}`;
  }
  if (sub === "tail") {
    const n = num(a, "n", 15);
    return textTable(
      ["ts", "tool", "outcome", "rows", "ms", "result", "note"],
      (n > 0 ? entries.slice(-n) : []).map((e) => [e.ts.slice(11, 19), e.tool, e.outcome + (e.errorClass ? `:${e.errorClass}` : ""), String(e.rows ?? ""), String(e.durationMs ?? ""), e.resultId ?? "", (e.note ?? "").slice(0, 50)]),
      n,
    );
  }
  throw new UsageError(`usage: ${USAGE.audit}`);
}

// ---------------- doctor ----------------

type Beats = Record<string, Heartbeat | undefined>;

/** Claude Code's Bash tool sets CLAUDE_CODE_SESSION_ID (CLAUDE_SESSION_ID was never set). */
export function currentSession(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || undefined;
}

/** "…a1b2": enough of a session id to tell sessions apart. */
const shortSession = (id: string | undefined) => (id ? `…${id.slice(-4)}` : "unknown session");

/** What the four heartbeats say together. SessionStart doesn't fire for a plugin installed mid-session. */
export function hookStatusNote(hb: Beats): string {
  const tool = ["pre", "post", "failure"].some((e) => hb[e]?.at);
  if (hb["session-start"]?.at) return tool ? "" : "No NetSuite tool call seen yet, so the tool hooks haven't had a chance to fire.";
  if (tool) return "Tool hooks have fired but SessionStart hasn't (the plugin was probably installed or enabled mid-session). Run /reload-plugins or start a new session before relying on it; the profile context arrives with the next session start.";
  return "Hooks have not fired. In Cowork/claude.ai this is expected (plugin hooks don't run there). In Claude Code: if the plugin was just installed, run /reload-plugins or start a new session; otherwise check /hooks and that the plugin is enabled.";
}

/**
 * heartbeat.json is shared by every session on this machine. Sessions seen in the last day, newest
 * first; with more than one, nsx can't tell which is the session it runs in.
 */
export function heartbeatSessions(hb: Beats, now = Date.now()): string[] {
  const seen = new Map<string, number>();
  for (const e of Object.values(hb)) {
    if (!e?.at) continue;
    const all = e.sessions && typeof e.sessions === "object" ? Object.entries(e.sessions) : [[e.session ?? "", e.at]];
    for (const [id, at] of all) {
      const t = Date.parse(at);
      if (Number.isFinite(t) && now - t <= 86_400_000) seen.set(id, Math.max(seen.get(id) ?? 0, t));
    }
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/** `current`: this session's id (doctor passes currentSession()); undefined = unknown. */
export function heartbeatLines(hb: Beats, now = Date.now(), current?: string): string[] {
  const ok = (b: boolean) => (b ? "✓" : "✗");
  const lines: string[] = [];
  for (const ev of ["session-start", "pre", "post", "failure"]) {
    const e = hb[ev];
    const where = e?.at ? ` in session ${shortSession(e.session)}${current && e.session === current ? " (this session)" : ""}` : "";
    lines.push(`${ev === "failure" ? " " : ok(!!e?.at)} hook ${ev}: ${e?.at ? `last fired ${ageLabel(now - Date.parse(e.at))} ago${where}` : "never fired"}`);
  }
  const sessions = heartbeatSessions(hb, now);
  if (sessions.length > 1) {
    const cur = current && sessions.includes(current) ? ` This session is ${shortSession(current)}.` : current ? ` This session (${shortSession(current)}) has no heartbeat: its hooks haven't fired.` : " nsx can't tell which one is this session, so these lines don't prove this session's hooks run; a `[su-ns-harness]` line on the next NetSuite result does.";
    lines.push(`  Hooks fired in ${sessions.length} sessions in the last day (${sessions.map(shortSession).join(", ")}).${cur}`);
  }
  return lines;
}

/** Warns when more than one su-ns-harness data dir exists: the cache is split between them. */
export function splitDataDirNote(inUse: string | undefined, dirs = markedDataDirs(), why?: string, explicitEnv = process.env.NSX_DATA_DIR): string | undefined {
  if (dirs.length < 2) return undefined;
  const same = (d: string) => !!inUse && path.resolve(d) === path.resolve(inUse);
  const named = dirs.map((d) => `${d}${same(d) ? " (in use)" : ""}`).join(", ");
  const picked = why ? ` nsx CLI commands use ${why}: a dir with a cache beats one without, then the one whose hooks fired last.` : "";
  return `⚠ ${dirs.length} su-ns-harness data dirs: ${named}. The cache is split between them (different Claude apps can give the plugin different data dirs), so init and refreshes run once per dir.${inUse && !dirs.some(same) ? ` In use: ${inUse}.` : ""}${picked} ${explicitEnv ? `NSX_DATA_DIR is set here, so this nsx uses it; apps without it keep their own dir. To share one cache, set NSX_DATA_DIR to ${path.resolve(explicitEnv)} in every app.` : "To share one cache, set NSX_DATA_DIR to the same dir in every app."}`;
}

/**
 * The two-dir notice goes to stderr once per session (a flag under sessions/<CLAUDE_CODE_SESSION_ID>/
 * of the chosen dir), or once a day without a session id, not on every command. A
 * changed notice (another dir appeared) is shown again. A dir that doesn't exist yet isn't created
 * for this: its flag lives in the temp dir.
 */
export function noticeDue(note: string, choice: DataDirChoice, session = currentSession(), now = new Date()): boolean {
  let base = choice.dir;
  try {
    if (!fs.statSync(base).isDirectory()) throw new Error("not a dir");
  } catch {
    base = path.join(os.tmpdir(), `su-ns-harness-notices-${createHash("sha256").update(path.resolve(choice.dir)).digest("hex").slice(0, 12)}`);
  }
  const file = session ? path.join(sessionDir(base, session), "data-dir-notice") : path.join(base, "notices", `data-dir-notice-${now.toISOString().slice(0, 10)}`);
  try {
    if (fs.readFileSync(file, "utf8") === note) return false;
  } catch {
    /* not shown yet */
  }
  try {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, note);
  } catch {
    /* can't remember it: show it every time rather than never */
  }
  return true;
}

/** The auto-chosen dir, described, when it's the one in use (doctor explains its pick). */
function choiceWhy(inUse: string | undefined): string | undefined {
  if (!inUse) return undefined;
  try {
    const c = dataDirChoice();
    return c.auto && path.resolve(c.dir) === path.resolve(inUse) ? describeChoice(c) : undefined;
  } catch {
    return undefined;
  }
}

function cmdDoctor(ctx: Ctx, a: Args, dataDirError?: Error): string {
  const lines: string[] = [`nsx ${PLUGIN_VERSION} at ${path.resolve(process.argv[1] ?? "scripts/nsx.mjs")}`];
  const ok = (b: boolean) => (b ? "✓" : "✗");
  const major = Number(process.versions.node.split(".")[0]);
  lines.push(`${ok(major >= 18)} Node ${process.versions.node}${major < 18 ? " — su-ns-harness needs Node ≥ 18 (https://nodejs.org or `brew install node`)" : ""}`);
  const seen = lastConnector(ctx.data || null);
  if (ctx.cfg.account_id) lines.push(`✓ account_id ${ctx.cfg.account_id} (${ctx.cfg.environment}) from ${configSource("account_id", ctx.data || null)}; it keys the cache instead of the connector`);
  else if (ctx.server) lines.push(`✓ cache keyed by connector ${ctx.server}${seen ? ` (last NetSuite call ${seen.lastSeen.slice(0, 10)})` : ""}`);
  else lines.push("– no NetSuite call seen yet: the first ns_* call picks the cache (no account_id needed)");
  let writable = !!ctx.data;
  let why = "";
  try {
    if (ctx.data) fs.accessSync(ctx.data, fs.constants.W_OK);
  } catch (e) {
    writable = false;
    why = ` — not writable (${(e as NodeJS.ErrnoException).code ?? "access denied"}): the cache and results can't be saved. Fix its permissions or point NSX_DATA_DIR elsewhere.`;
  }
  // The CLI's own pick, when it picked (no NSX_DATA_DIR): this install's dir may not exist yet.
  let choice: DataDirChoice | undefined;
  try {
    const c = dataDirChoice();
    if (c.auto && ctx.data && path.resolve(c.dir) === path.resolve(ctx.data)) choice = c;
  } catch {
    /* no dir: said below */
  }
  const fresh = choice?.exists === false;
  if (fresh) {
    writable = true;
    why = "";
  }
  const ignored = choice && othersIgnored(choice);
  lines.push(
    dataDirError
      ? `✗ data dir: ${dataDirError.message}`
      : fresh
      ? `✓ data dir ${path.basename(ctx.data)} (new, created on the first NetSuite call) at ${ctx.data}${ignored ? `; ${ignored}` : ""}`
      : ctx.data
      ? `${ok(writable)} data dir ${ctx.data}${why}${choice?.reason === "install" || choice?.reason === "same-install" ? ` (this install's)` : choice?.reason === "session" ? " (this session's hooks write here)" : ""}${ignored ? `; ${ignored}` : ""}`
      : "– data dir none yet: normal before the first NetSuite call in a session where the plugin's hooks are loaded (the hooks create it). If you just installed the plugin, run /reload-plugins or start a new session first.",
  );
  // Dirs of other installs aren't a split cache; dirs of one install in several apps are.
  const split = ignored && choice?.reason !== "session" ? undefined : splitDataDirNote(ctx.data || undefined, markedDataDirs(), choiceWhy(ctx.data || undefined));
  if (split) lines.push(split);
  if (a.flags.preflight || !ctx.data) return lines.join("\n");

  lines.push(`  mode: ${ctx.cfg.read_only ? "read-only" : "writes allowed (preview + approval)"} · inline_max_chars ${ctx.cfg.inline_max_chars}`);
  if (ctx.acctDir) {
    const m = loadManifest(ctx.acctDir);
    const n = Object.keys(m.sections).length;
    const stale = staleSections(m, ctx.cfg);
    const unparsed = Object.entries(m.sections).filter(([, e]) => e.status === "unparsed").map(([k]) => k);
    lines.push(`${ok(n > 0)} cache: ${n} sections, ${stale.length} stale${stale.length ? ` (${stale.slice(0, 6).map((s) => s.name).join(", ")})` : ""}${unparsed.length ? `, unparsed: ${unparsed.join(", ")}` : ""}`);
    lines.push(`  profile: ${loadProfile(ctx.acctDir) ? "built" : "missing (run the su-ns-harness:init skill yourself; it needs nothing from the user)"}`);
    const size = dirSize(path.join(ctx.acctDir, "results"));
    lines.push(`  results: ${listResults(ctx.acctDir).length} saved, ${(size / 1e6).toFixed(1)} MB, retention ${ctx.cfg.results_retention_days}d`);
    // Every denial costs a blocked call and a retry; a rule that fires often may be a false positive.
    const byRule: Record<string, number> = {};
    for (const e of readAudit(ctx.acctDir, { days: 7 })) {
      if (e.outcome === "denied") for (const r of (e.note ?? "other").split(",")) byRule[r] = (byRule[r] ?? 0) + 1;
    }
    const denials = Object.entries(byRule).sort((x, y) => y[1] - x[1]);
    lines.push(`  guard denials (last 7 days with activity): ${denials.length ? denials.map(([r, n]) => `${r} ${n}`).join(", ") : "none"}`);
  }
  const hb = readJson<Beats>(path.join(ctx.data, "heartbeat.json"), {});
  lines.push(...heartbeatLines(hb, Date.now(), currentSession()));
  const hbNote = hookStatusNote(hb);
  if (hbNote) lines.push(`  ${hbNote}`);
  try {
    const log = fs.readFileSync(path.join(ctx.data, "logs", "hook.log"), "utf8").trim().split("\n").filter((l) => /^\d{4}-/.test(l));
    if (log.length) lines.push(`  hook errors logged: ${log.length}; last: ${log[log.length - 1].slice(0, 200)}`);
  } catch {
    lines.push("  hook errors logged: none");
  }
  lines.push(`  Connector: ${seen ? `last used ${seen.lastSeen.slice(0, 10)} via ${seen.server}. ` : ""}Only Claude's tool list shows whether it's enabled in this session (tools ending in ns_*); if a call fails with 'couldn't reach the MCP server', re-authenticate via /mcp.`);
  return lines.join("\n");
}

const HELP = `nsx ${PLUGIN_VERSION} — su-ns-harness CLI
  reports search <terms…>          searches search <terms…>        recordtypes [--grep t|t2]   (--max N)
  fields <table> [term…] [--grep t] [--record] [--max N]           periods [--open|--years] [--grep t] [--max N]
  cache status|show <section>|build|invalidate <section|all>       profile show|set k=v…|ttm-report|from-report <id>
  results list [--n N] | schema|head|filter|agg|pivot|export|raw|path <id> …   results diff <idA> <idB> --on k --cols c   results concat <id> <id>…
      head:   <id> [N] [--cols a,b] [--max N]      agg: --by col[,col] --sum|--avg|--min|--max col[,col] [--count] [--top N]
      filter: --where "amount>10000 and status~open"   export: --csv [path] | --xlsx [path]   raw: [--grep t] [--head N]
      head/filter/export: --sort col [--asc] (numbers largest first, dates latest first, text A→Z)
  sql lint <file|-|\"sql\">         sql fix-rownum <file|-|\"sql\">   (- reads stdin)
  preview <ns_write_tool> <file|-> [--before current.json]
  audit export [--session [id]] [--days N] [--out file]            audit tail [--n N] [--session [id]] [--days N]
  config show | config set key=value…  (read_only=false only from your own terminal)
  doctor [--preflight]      version (--version, -v)      <command> --help`;

type Handler = Parameters<typeof runHook>[1];

/** `nsx hook <name>` wiring: the handler and, for pre, the fail-closed fallback. */
export const HOOKS: Record<string, [Handler, Handler?]> = {
  "session-start": [(i) => handleSessionStart(i)],
  pre: [(i) => handlePre(i), failClosedForWrites],
  post: [(i) => handlePost(i)],
  failure: [(i) => handleFailure(i)],
};

/** `nsx help <cmd>` / `nsx <cmd> --help`: that command's usage; otherwise the full help. */
function helpFor(cmd: string | undefined): string {
  return cmd && Object.hasOwn(USAGE, cmd) && cmd !== "help" ? `usage: ${USAGE[cmd]}` : HELP;
}

/** Commands that work without the data dir. */
const STATELESS = ["sql", "version", "doctor", "help"];

export function main(rawArgv: string[]): string | Promise<void> {
  const argv = normalizeArgv(rawArgv);
  const a = parseArgs(argv);
  const cmd = a.pos[0];
  if (cmd === "hook") {
    const which = a.pos[1] ?? "";
    const h = Object.hasOwn(HOOKS, which) ? HOOKS[which] : undefined;
    return h ? runHook(which, h[0], h[1]) : Promise.resolve();
  }
  // Before any validation or data dir lookup: these must work everywhere.
  if (a.flags.help || cmd === "help") {
    const topic = cmd === "help" ? a.pos[1] : cmd;
    if (topic && !COMMANDS.includes(topic)) checkFlags({ pos: [topic], flags: {} });
    return helpFor(topic);
  }
  if (a.flags.version && (!cmd || cmd === "version")) return PLUGIN_VERSION;
  if (!cmd) {
    if (Object.keys(a.flags).length) throw new UsageError(`unknown flag${Object.keys(a.flags).length > 1 ? "s" : ""} ${Object.keys(a.flags).map((f) => `--${f}`).join(", ")} (no command given). ${HELP}`);
    return HELP;
  }
  checkFlags(a);
  let ctx: Ctx;
  let dataDirError: Error | undefined;
  try {
    ctx = context();
  } catch (e) {
    // These work without any cached state; everything else needs the plugin's data dir.
    if ((e instanceof NoDataDirError || e instanceof DataDirError) && STATELESS.includes(cmd)) {
      ctx = statelessContext();
      if (e instanceof DataDirError) dataDirError = e;
    } else throw e;
  }
  switch (cmd) {
    case "reports":
      return search(ctx, needAcct(ctx), "reports", a.pos.slice(a.pos[1] === "search" ? 2 : 1), num(a, "max", 30), "call ns_listAllReports once (it is cached automatically).");
    case "searches":
      return search(ctx, needAcct(ctx), "searches", a.pos.slice(a.pos[1] === "search" ? 2 : 1), num(a, "max", 30), "call ns_listSavedSearches once (it is cached automatically).");
    case "recordtypes":
      return search(ctx, needAcct(ctx), "recordtypes", [flag(a, "grep"), ...a.pos.slice(1)].filter((t): t is string => !!t), num(a, "max", 60), "call ns_getSuiteQLMetadata with no arguments once.");
    case "fields":
      return cmdFields(ctx, a);
    case "periods":
      return cmdPeriods(ctx, a);
    case "cache":
      return cmdCache(ctx, a);
    case "profile":
      return cmdProfile(ctx, a);
    case "results":
      return cmdResults(ctx, a);
    case "sql":
      return cmdSql(ctx, a);
    case "preview":
      return cmdPreview(ctx, a);
    case "audit":
      return cmdAudit(ctx, a);
    case "config":
      return cmdConfig(ctx, argv);
    case "doctor":
      return cmdDoctor(ctx, a, dataDirError);
    case "version":
      return PLUGIN_VERSION;
    default:
      // checkFlags refuses unknown commands, so this is only reached for a command added to COMMANDS without a case.
      throw new UsageError(`unknown command '${cmd}' (nsx --help)`);
  }
}

/** A raw permission error from a write in the data dir, said plainly. */
function errorMessage(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  if (err && (err.code === "EACCES" || err.code === "EPERM" || err.code === "EROFS")) {
    return `can't write ${err.path ?? "a file"} (${err.code}: permission denied). Check the data dir's permissions (nsx doctor shows it) or set NSX_DATA_DIR to a writable dir.`;
  }
  return e instanceof Error ? e.message : String(e);
}

const isEntry = (() => {
  try {
    return !!process.argv[1] && /nsx(\.mjs)?$|cli\.ts$/.test(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isEntry) {
  ignoreEpipe();
  try {
    const argv = process.argv.slice(2);
    // Hooks stay silent on stderr; doctor prints the same choice in its own output.
    if (argv[0] !== "hook" && argv[0] !== "doctor") {
      const note = dataDirNotice();
      let due = !!note;
      try {
        if (note) due = noticeDue(note, dataDirChoice());
      } catch {
        /* keep showing it */
      }
      if (note && due) process.stderr.write(`${note}\n`);
    }
    const r = main(argv);
    // `nsx` isn't on PATH: every `nsx <cmd>` hint in the output becomes the runnable command.
    if (typeof r === "string") process.stdout.write(expandNsx(r.endsWith("\n") ? r : `${r}\n`, cliCommand()));
  } catch (e) {
    process.stderr.write(`nsx: ${expandNsx(errorMessage(e), cliCommand())}\n`);
    // Bad input (usage, unreadable JSON the user passed) is exit 2, like any usage error.
    process.exitCode = e instanceof UsageError || (e as Error)?.name === "UsageError" || e instanceof SyntaxError ? 2 : 1;
  }
}
