import * as fs from "node:fs";
import * as path from "node:path";
import { type Config, PLUGIN_VERSION } from "../config.ts";
import { ensureDir, readJson, readTsv, sha256, tsvCell, writeFileAtomic, writeJson } from "../util.ts";

/**
 * Bump when a catalog parser's index format changes. Sections indexed by an older format are
 * re-parsed from their stored raw payload at session start (reindexOutdated), with no connector call.
 */
export const INDEX_VERSION = 2;

/** `empty`: the call worked but returned nothing the role can see (e.g. a field schema with no fields). */
export type SectionStatus = "ok" | "empty" | "unparsed" | "stale";

export interface SectionEntry {
  fetchedAt: string;
  ttlDays: number;
  count: number;
  sha256: string;
  sourceTool: string;
  pluginVersion: string;
  /** Index format; missing = 1 (before INDEX_VERSION existed). */
  indexVersion?: number;
  status: SectionStatus;
  staleReason?: string;
}

export interface Manifest {
  account: string;
  createdAt: string;
  sections: Record<string, SectionEntry>;
}

/** `fields/transaction` → `fields`; used for TTL lookup. */
export function sectionKind(name: string): string {
  return name.split("/")[0];
}

/** One section-name part as it may appear on disk: no `.`/`..`, no separators, no leading dot. */
export const SECTION_PART = /^[a-z0-9_-][a-z0-9_.-]*$/;

/**
 * Why `name` can't be a cache section (undefined = it can). Section names come from tool inputs
 * (`fields/<recordType>`), so a recordType like `../../x` must never be cached.
 */
export function sectionNameProblem(name: string): string | undefined {
  const parts = name.split("/");
  if (parts.length > 2) return `'${name}' has more than one '/'`;
  for (const p of parts) {
    if (!SECTION_PART.test(p.toLowerCase())) return `'${p}' isn't a valid name (letters, digits, _ . - only, not starting with '.')`;
  }
  return undefined;
}

/**
 * Section names become file paths; keep them tame. Every part is reduced to [a-z0-9_.-] and can't
 * be `.`/`..` or start with a dot, so the result always stays inside the account dir.
 */
export function safeSectionName(name: string): string {
  return name
    .split("/")
    .filter((p) => p !== "")
    .map((p) => p.toLowerCase().replace(/[^a-z0-9_.-]/g, "_").replace(/^\./, "_"))
    .join("/");
}

/**
 * `<acctDir>/<kind>/<section><ext>`, refusing any path that would leave `<acctDir>/<kind>/`
 * (defence in depth behind safeSectionName).
 */
export function sectionFile(acctDir: string, kind: "raw" | "idx", name: string, ext: ".json" | ".tsv"): string {
  const base = path.resolve(acctDir, kind);
  const file = path.resolve(base, `${safeSectionName(name)}${ext}`);
  if (!file.startsWith(base + path.sep)) throw new Error(`su-ns-harness: cache section '${name}' resolves outside the cache directory; refused`);
  return file;
}

export function manifestPath(acctDir: string): string {
  return path.join(acctDir, "manifest.json");
}

export function loadManifest(acctDir: string, account = path.basename(acctDir)): Manifest {
  return readJson<Manifest>(manifestPath(acctDir), { account, createdAt: new Date().toISOString(), sections: {} });
}

function saveManifest(acctDir: string, m: Manifest): void {
  writeJson(manifestPath(acctDir), m);
}

const sleepMs = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Serialize manifest read-modify-write across parallel hook processes. Waits up to ~1s; a lock
 * older than 5s is a leftover from a crashed hook and is taken over. If the lock can't be had,
 * the update still runs (a lost manifest entry only means that section gets re-fetched).
 */
function withManifestLock<T>(acctDir: string, fn: () => T): T {
  return withFileLock(path.join(acctDir, "manifest.lock"), fn);
}

/** The lock behind withManifestLock, for any read-modify-write of a small shared JSON file. */
export function withFileLock<T>(lock: string, fn: () => T): T {
  ensureDir(path.dirname(lock));
  let fd: number | undefined;
  for (let i = 0; i < 100 && fd === undefined; i++) {
    try {
      fd = fs.openSync(lock, "wx");
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.unlinkSync(lock);
      } catch {
        /* raced with the holder releasing it */
      }
      sleepMs(10);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
      try {
        fs.unlinkSync(lock);
      } catch {
        /* ignore */
      }
    }
  }
}

export function ttlDaysFor(cfg: Config, name: string): number {
  return cfg.ttl_days[sectionKind(name)] ?? 30;
}

export interface Index {
  header: string[];
  rows: unknown[][];
}

/**
 * Store one cache section: raw JSON always (so upgrades can re-parse), plus a grep-able
 * TSV index when the parser understood the payload.
 */
export function storeSection(
  acctDir: string,
  cfg: Config,
  name: string,
  sourceTool: string,
  raw: string,
  index: Index | undefined,
  status: SectionStatus = index ? "ok" : "unparsed",
): SectionEntry {
  name = safeSectionName(name);
  writeFileAtomic(sectionFile(acctDir, "raw", name, ".json"), raw);
  if (index) writeIndex(acctDir, name, index);
  const entry: SectionEntry = {
    fetchedAt: new Date().toISOString(),
    ttlDays: ttlDaysFor(cfg, name),
    count: index?.rows.length ?? 0,
    sha256: sha256(raw),
    sourceTool,
    pluginVersion: PLUGIN_VERSION,
    indexVersion: INDEX_VERSION,
    status,
  };
  withManifestLock(acctDir, () => {
    const m = loadManifest(acctDir);
    m.sections[name] = entry;
    saveManifest(acctDir, m);
  });
  return entry;
}

function writeIndex(acctDir: string, name: string, index: Index): void {
  const lines = [index.header.join("\t"), ...index.rows.map((r) => r.map(tsvCell).join("\t"))];
  writeFileAtomic(sectionFile(acctDir, "idx", name, ".tsv"), lines.join("\n") + "\n");
}

/** Replace a section's index in place (same raw payload and fetchedAt), at the current format. */
export function rewriteIndex(acctDir: string, name: string, index: Index | undefined): void {
  name = safeSectionName(name);
  // A parser that can no longer read the payload must not leave the old-format index behind.
  if (index) writeIndex(acctDir, name, index);
  else fs.rmSync(sectionFile(acctDir, "idx", name, ".tsv"), { force: true });
  withManifestLock(acctDir, () => {
    const m = loadManifest(acctDir);
    const e = m.sections[name];
    if (!e) return;
    e.count = index?.rows.length ?? 0;
    if (e.status !== "stale") e.status = index ? "ok" : "unparsed";
    e.indexVersion = INDEX_VERSION;
    e.pluginVersion = PLUGIN_VERSION;
    saveManifest(acctDir, m);
  });
}

export function markStale(acctDir: string, name: string, reason: string): boolean {
  name = safeSectionName(name);
  return withManifestLock(acctDir, () => {
    const m = loadManifest(acctDir);
    const e = m.sections[name];
    if (!e) return false;
    e.status = "stale";
    e.staleReason = reason;
    saveManifest(acctDir, m);
    return true;
  });
}

/**
 * Freshness always uses the current config TTL, so a changed ttl_overrides applies to sections
 * already cached. The stored ttlDays only records what the TTL was when the section was fetched.
 */
export function isFresh(e: SectionEntry | undefined, cfg: Config, name: string, now = Date.now()): boolean {
  if (!e || e.status === "stale") return false;
  return now - Date.parse(e.fetchedAt) < ttlDaysFor(cfg, name) * 86_400_000;
}

export interface StaleInfo {
  name: string;
  ageMs: number;
  ttlDays: number;
  reason?: string;
}

export function staleSections(m: Manifest, cfg: Config, now = Date.now()): StaleInfo[] {
  const out: StaleInfo[] = [];
  for (const [name, e] of Object.entries(m.sections)) {
    if (!isFresh(e, cfg, name, now)) {
      out.push({ name, ageMs: now - Date.parse(e.fetchedAt), ttlDays: ttlDaysFor(cfg, name), reason: e.staleReason });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readIndex(acctDir: string, name: string): { header: string[]; rows: string[][] } {
  const all = readTsv(sectionFile(acctDir, "idx", name, ".tsv"));
  return { header: all[0] ?? [], rows: all.slice(1) };
}

export function readRaw(acctDir: string, name: string): unknown {
  return readJson<unknown>(sectionFile(acctDir, "raw", name, ".json"), undefined);
}

export function hasSection(acctDir: string, name: string): boolean {
  return fs.existsSync(sectionFile(acctDir, "raw", name, ".json"));
}

export function listSections(acctDir: string): string[] {
  return Object.keys(loadManifest(acctDir).sections).sort();
}

export function acctDirs(dataDir: string): string[] {
  const base = path.join(dataDir, "accounts");
  try {
    return fs.readdirSync(base).map((n) => path.join(base, n));
  } catch {
    return [];
  }
}

export function ensureAcctDir(acctDir: string): string {
  return ensureDir(acctDir);
}
