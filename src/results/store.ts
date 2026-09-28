import * as fs from "node:fs";
import * as path from "node:path";
import { decodeToolResponse } from "../mcp.ts";
import { extractRows, type ReportColumn, reportInfoOf, type Row } from "../rows.ts";
import { ensureDir, parseCsv, readJson, shortId, toCsv, writeFileAtomic, writeJson } from "../util.ts";
import type { Profile } from "../cache/profile.ts";
import { readIndex } from "../cache/store.ts";
import { type ColType, profileColumns, toNumber } from "./profile.ts";

export interface ResultMeta {
  id: string;
  createdAt: string;
  session: string;
  tool: string;
  /** SQL for SuiteQL, else a compact JSON of the params */
  query: string;
  rowCount: number;
  columns: { name: string; type: ColType }[];
  truncated?: string;
  tookMs?: number;
  files: { raw: string; csv: string; meta: string };
  /**
   * ns_runReport only: each value column's name and the raw `reportColumns` entry (id, path,
   * label) it was read from, the report title, and how inferred names were derived.
   */
  report?: SavedReportInfo;
}

export interface SavedReportInfo {
  title?: string;
  columns: ReportColumn[];
  notes?: string[];
}

/** The report info to keep in a result's meta, from the raw ns_runReport payload. */
function savedReportInfo(raw: string): SavedReportInfo | undefined {
  let info;
  try {
    info = reportInfoOf(decodeToolResponse(raw).json);
  } catch {
    return undefined;
  }
  if (!info?.columns?.length) return undefined;
  return { ...(info.title !== undefined ? { title: info.title } : {}), columns: info.columns, ...(info.notes?.length ? { notes: info.notes } : {}) };
}

/**
 * The currency a saved ns_runReport result is in: consolidated (no subsidiaryId, or -1) → the
 * base currency; subsidiary N → `subsidiaryCurrencies[N]`. Undefined for other tools or when the
 * profile doesn't know it.
 */
export function reportCurrencyOf(meta: ResultMeta, profile: Profile | undefined): string | undefined {
  if (meta.tool !== "ns_runReport" || !profile) return undefined;
  let input: Record<string, unknown> = {};
  try {
    const q = JSON.parse(meta.query) as unknown;
    if (q && typeof q === "object" && !Array.isArray(q)) input = q as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const sub = input.subsidiaryId ?? input.subsidiary;
  const id = sub === undefined || sub === null || String(sub).trim() === "" ? "-1" : String(sub).trim();
  if (id === "-1") return profile.baseCurrency;
  return profile.subsidiaryCurrencies?.[id] ?? (id === profile.parentSubsidiaryId ? profile.baseCurrency : undefined);
}

/**
 * The report currency with a label for the summary: consolidated → `{ code: "EUR", label: "the
 * base currency, consolidated" }`; subsidiary 7 → `{ code: "USD", label: "Example Inc.'s base
 * currency" }` (the name from the cached subsidiaries list, else "subsidiary 7's …"). Undefined
 * when reportCurrencyOf doesn't know the currency.
 */
export function reportCurrencyInfo(meta: ResultMeta, profile: Profile | undefined, acctDir?: string): { code: string; label: string } | undefined {
  const code = reportCurrencyOf(meta, profile);
  if (!code) return undefined;
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(meta.query) as Record<string, unknown>;
  } catch {
    /* reportCurrencyOf already parsed it */
  }
  const sub = input.subsidiaryId ?? input.subsidiary;
  const id = sub === undefined || sub === null || String(sub).trim() === "" ? "-1" : String(sub).trim();
  if (id === "-1") return { code, label: "the base currency, consolidated" };
  let name: string | undefined;
  if (acctDir) {
    const ix = readIndex(acctDir, "subsidiaries");
    const ci = ix.header.findIndex((h) => h.toLowerCase() === "id");
    const ni = ix.header.findIndex((h) => h.toLowerCase() === "name");
    if (ci >= 0 && ni >= 0) name = ix.rows.find((r) => r[ci] === id)?.[ni]?.trim() || undefined;
  }
  return { code, label: `${name ?? `subsidiary ${id}`}'s base currency` };
}

export function resultsRoot(acctDir: string): string {
  return path.join(acctDir, "results");
}

/** The account dir a saved result belongs to (its files live in resultsRoot(acctDir)/<session>/). */
export function acctDirOf(meta: ResultMeta): string | undefined {
  const root = path.dirname(path.dirname(meta.files.meta));
  if (path.basename(root) !== path.basename(resultsRoot(""))) return undefined;
  return path.dirname(root);
}

export function saveResult(opts: {
  acctDir: string;
  session: string;
  tool: string;
  query: string;
  columns: string[];
  rows: Row[];
  raw: string;
  truncated?: string;
  tookMs?: number;
  /** Report column info; for ns_runReport it is read from `raw` when not given. */
  report?: SavedReportInfo;
}): ResultMeta {
  const id = shortId("r_");
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const session = (opts.session || "nosession").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "nosession";
  const dir = ensureDir(path.join(resultsRoot(opts.acctDir), session));
  const base = path.join(dir, `${ts}_${opts.tool}_${id}`);
  const files = { raw: `${base}.raw.json`, csv: `${base}.csv`, meta: `${base}.meta.json` };
  writeFileAtomic(files.raw, opts.raw);
  writeFileAtomic(files.csv, toCsv(opts.columns, opts.rows));
  const profiles = profileColumns(opts.columns, opts.rows);
  const meta: ResultMeta = {
    id,
    createdAt: new Date().toISOString(),
    session,
    tool: opts.tool,
    query: opts.query,
    rowCount: opts.rows.length,
    columns: profiles.map((p) => ({ name: p.name, type: p.type })),
    truncated: opts.truncated,
    tookMs: opts.tookMs,
    files,
  };
  const report = opts.report ?? (opts.tool === "ns_runReport" ? savedReportInfo(opts.raw) : undefined);
  if (report) meta.report = report;
  writeJson(files.meta, meta);
  fs.appendFileSync(path.join(resultsRoot(opts.acctDir), "index.jsonl"), JSON.stringify({ id, meta: files.meta }) + "\n");
  return meta;
}

export function listResults(acctDir: string): ResultMeta[] {
  const idx = path.join(resultsRoot(acctDir), "index.jsonl");
  let lines: string[] = [];
  try {
    lines = fs.readFileSync(idx, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const out: ResultMeta[] = [];
  for (const l of lines) {
    try {
      const { meta } = JSON.parse(l) as { meta: string };
      const m = readJson<ResultMeta | undefined>(meta, undefined);
      if (m) out.push(m);
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

export function findResult(acctDirs: string[], id: string): ResultMeta | undefined {
  const want = id.startsWith("r_") ? id : `r_${id}`;
  for (const dir of acctDirs) {
    const hit = listResults(dir).find((m) => m.id === want);
    if (hit) return hit;
  }
  return undefined;
}

/** `id` columns stay strings so they print and export as identifiers, not quantities. */
export function parseValue(v: string, type: ColType): unknown {
  // Saved searches send blank cells as " ".
  if (v.trim() === "") return null;
  if (type === "num") {
    // `$1,234.00`, `(1,234.00)`, `EUR 5` as toNumber reads them; anything else stays text.
    const n = toNumber(v);
    return n === undefined ? v : n;
  }
  return v;
}

export function loadRows(meta: ResultMeta): Row[] {
  const grid = parseCsv(fs.readFileSync(meta.files.csv, "utf8"));
  const header = grid[0] ?? [];
  const types = new Map(meta.columns.map((c) => [c.name, c.type]));
  return grid.slice(1).map((cells) => {
    const r: Row = {};
    header.forEach((h, i) => (r[h] = parseValue(cells[i] ?? "", types.get(h) ?? "str")));
    return r;
  });
}

/** Delete result sessions older than the retention window. Returns number of files removed. */
export function cleanupResults(acctDir: string, retentionDays: number, now = Date.now()): number {
  const root = resultsRoot(acctDir);
  let removed = 0;
  let sessions: string[] = [];
  try {
    sessions = fs.readdirSync(root);
  } catch {
    return 0;
  }
  const cutoff = now - retentionDays * 86_400_000;
  for (const s of sessions) {
    const dir = path.join(root, s);
    let st: fs.Stats;
    try {
      st = fs.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          removed++;
        }
      } catch {
        /* ignore */
      }
    }
    try {
      if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
    } catch {
      /* ignore */
    }
  }
  if (removed) {
    // Drop index lines whose files are gone.
    const idx = path.join(root, "index.jsonl");
    try {
      const keep = fs
        .readFileSync(idx, "utf8")
        .split("\n")
        .filter((l) => {
          try {
            return l && fs.existsSync((JSON.parse(l) as { meta: string }).meta);
          } catch {
            return false;
          }
        });
      writeFileAtomic(idx, keep.length ? keep.join("\n") + "\n" : "");
    } catch {
      /* ignore */
    }
  }
  return removed;
}

export function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch {
    /* ignore */
  }
  return total;
}

/** Input keys that only pick the page or slice of an otherwise identical call. */
const PAGE_KEYS = ["pageIndex", "range_start", "range_end"];

interface PagePos {
  meta: ResultMeta;
  /** SuiteQL page number (0-based), from the saved response's list envelope. */
  pageIndex?: number;
  pageSize?: number;
  totalResults?: number;
  numberOfPages?: number;
  /** Saved-search slice, from the call input. */
  rangeStart?: number;
  rangeEnd?: number;
}

const finite = (v: unknown): number | undefined => (v === null || v === undefined || v === "" ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);

/** `meta.query` minus the paging keys: SQL (whitespace-collapsed) for SuiteQL, canonical JSON otherwise. */
function queryIdentity(meta: ResultMeta): { same: string; input: Record<string, unknown> } {
  if (meta.tool === "ns_runCustomSuiteQL") return { same: meta.query.replace(/\s+/g, " ").trim(), input: {} };
  try {
    const q = JSON.parse(meta.query) as unknown;
    if (q && typeof q === "object" && !Array.isArray(q)) {
      const input = q as Record<string, unknown>;
      const rest = Object.fromEntries(Object.entries(input).filter(([k]) => !PAGE_KEYS.includes(k)).sort(([x], [y]) => x.localeCompare(y)));
      return { same: JSON.stringify(rest), input };
    }
  } catch {
    /* not JSON: compare as text */
  }
  return { same: meta.query, input: {} };
}

function pagePos(meta: ResultMeta, input: Record<string, unknown>): PagePos {
  const pos: PagePos = { meta, rangeStart: finite(input.range_start), rangeEnd: finite(input.range_end) };
  if (meta.tool === "ns_runCustomSuiteQL") {
    try {
      const ex = extractRows(JSON.parse(fs.readFileSync(meta.files.raw, "utf8")));
      if (ex) Object.assign(pos, { pageIndex: ex.pageIndex, pageSize: ex.pageSize, totalResults: ex.totalResults, numberOfPages: ex.numberOfPages });
    } catch {
      /* raw missing or not JSON: page position unknown */
    }
  }
  if (pos.pageIndex === undefined) pos.pageIndex = finite(input.pageIndex);
  return pos;
}

export interface ConcatResult {
  meta: ResultMeta;
  /** Page order, gaps, overlaps: what was checked and what couldn't be. */
  notes: string[];
}

/**
 * Stack pages or slices of one query into a new saved result: same tool, same columns, and the same
 * query apart from `pageIndex`/`range_start`/`range_end` (SuiteQL: the same SQL; its page number
 * comes from the saved list envelope). Pages are put in order and must be contiguous with no
 * repeats; a result without page information is appended in the given order, with a note.
 */
export function concatResults(metas: ResultMeta[], opts: { session?: string } = {}): ConcatResult {
  if (metas.length < 2) throw new Error("results concat needs at least two result ids");
  const ids = metas.map((m) => m.id);
  if (new Set(ids).size !== ids.length) throw new Error(`the same result is listed twice: ${ids.join(", ")}`);
  const first = metas[0];
  const acctOf = (m: ResultMeta) => path.dirname(path.dirname(path.dirname(m.files.meta)));
  const acctDir = acctOf(first);
  const cols = first.columns.map((c) => c.name);
  const idOf = queryIdentity(first);
  for (const m of metas.slice(1)) {
    if (acctOf(m) !== acctDir) throw new Error(`${m.id} belongs to another account than ${first.id}`);
    if (m.tool !== first.tool) throw new Error(`${m.id} comes from ${m.tool}, ${first.id} from ${first.tool}: only pages of one query can be combined`);
    const mc = m.columns.map((c) => c.name);
    if (mc.length !== cols.length || mc.some((c, i) => c !== cols[i])) throw new Error(`${m.id} has different columns (${mc.join(", ")}) from ${first.id} (${cols.join(", ")})`);
    if (queryIdentity(m).same !== idOf.same) throw new Error(`${m.id} ran a different query from ${first.id}; only pages of the same query (differing in pageIndex or range_start/range_end) can be combined`);
  }
  const notes: string[] = [];
  let pos = metas.map((m) => pagePos(m, queryIdentity(m).input));
  const byPage = pos.every((p) => p.pageIndex !== undefined);
  const byRange = !byPage && pos.every((p) => p.rangeStart !== undefined || p.rangeEnd !== undefined);
  let complete: string | undefined;
  if (byPage) {
    pos = [...pos].sort((x, y) => x.pageIndex! - y.pageIndex!);
    for (let i = 1; i < pos.length; i++) {
      const [p, q] = [pos[i - 1], pos[i]];
      if (q.pageIndex === p.pageIndex) throw new Error(`${p.meta.id} and ${q.meta.id} are both page ${p.pageIndex! + 1}`);
      if (q.pageIndex !== p.pageIndex! + 1) {
        // Page numbers are 1-based: the gap after page p (index i) is pages i+2 … j (index j-1).
        const [from, to] = [p.pageIndex! + 2, q.pageIndex!];
        notes.push(`${from === to ? `page ${from} is` : `pages ${from}–${to} are`} missing (between ${p.meta.id} and ${q.meta.id})`);
      }
      if (p.pageSize !== undefined && q.pageSize !== undefined && p.pageSize !== q.pageSize) throw new Error(`${p.meta.id} and ${q.meta.id} use different page sizes (${p.pageSize}, ${q.pageSize}): the pages don't line up`);
    }
    const total = pos.find((p) => p.totalResults !== undefined)?.totalResults;
    const n = pos.find((p) => p.numberOfPages !== undefined)?.numberOfPages;
    const pages = `pages ${pos.map((p) => p.pageIndex! + 1).join(", ")}${n !== undefined ? ` of ${n}` : ""}`;
    const rows = pos.reduce((s, p) => s + p.meta.rowCount, 0);
    notes.unshift(`in page order: ${pages}`);
    if (total !== undefined && rows < total) complete = `combined ${pages} (${rows} of ${total} rows): still not the full result`;
  } else if (byRange) {
    pos = [...pos].sort((x, y) => (x.rangeStart ?? 0) - (y.rangeStart ?? 0));
    for (let i = 1; i < pos.length; i++) {
      const [p, q] = [pos[i - 1], pos[i]];
      const pEnd = (p.rangeStart ?? 0) + p.meta.rowCount;
      const qStart = q.rangeStart ?? 0;
      if (qStart < pEnd) throw new Error(`${p.meta.id} (rows ${p.rangeStart ?? 0}–${pEnd}) and ${q.meta.id} (from ${qStart}) overlap`);
      if (qStart > pEnd) notes.push(`rows ${pEnd}–${qStart} are missing (between ${p.meta.id} and ${q.meta.id})`);
    }
    notes.unshift(`in slice order: ${pos.map((p) => `${p.rangeStart ?? 0}–${(p.rangeStart ?? 0) + p.meta.rowCount}`).join(", ")}`);
  } else {
    notes.push("no page or slice position recorded: combined in the order given, and contiguity wasn't checked");
  }
  const last = pos[pos.length - 1].meta;
  // The last page's truncation note still applies unless page counts say it's complete.
  if (!complete && last.truncated && !(byPage && pos.some((p) => p.totalResults !== undefined))) complete = `the last part (${last.id}) was itself incomplete: ${last.truncated}`;
  if (notes.some((n) => n.includes("missing"))) complete = [complete, "some pages/slices in between are missing"].filter(Boolean).join("; ");
  const rows = pos.flatMap((p) => loadRows(p.meta));
  const query = first.tool === "ns_runCustomSuiteQL" ? first.query : idOf.same;
  const meta = saveResult({
    acctDir,
    session: opts.session ?? first.session,
    tool: first.tool,
    query,
    columns: cols,
    rows,
    raw: JSON.stringify({ concatOf: pos.map((p) => p.meta.id), notes }),
    truncated: complete,
    report: first.report,
  });
  return { meta, notes };
}
