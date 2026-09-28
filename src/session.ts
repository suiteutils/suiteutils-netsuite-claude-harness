/** Per-session scratch state for hooks: in-flight calls, retry counters, heartbeats. Best effort. */
import * as fs from "node:fs";
import * as path from "node:path";
import { withFileLock } from "./cache/store.ts";
import { ensureDir, readJson, writeJson } from "./util.ts";

export interface Inflight {
  tool: string;
  startedAt: number;
  inputHash: string;
}

export interface SessionState {
  /** rate-limit attempt counters per call-input hash (legacy; see rateLimits) */
  retries: Record<string, number>;
  /** rate-limit hits per call-input hash, with the last hit's time: a counter older than RATE_LIMIT_RESET_MS starts over */
  rateLimits?: Record<string, { n: number; at: number }>;
  /** tables whose field metadata the guard already asked for this session (asked once each) */
  metadataAsked?: string[];
  /**
   * tool_use_id → columns the guard flagged as missing from the metadata ("table.column"), so a
   * generic NetSuite error on that call can name the likely cause. Bounded by UNKNOWN_COLS_MAX/_MS.
   */
  unknownCols?: Record<string, { cols: string[]; at: number }>;
}

export const UNKNOWN_COLS_MAX = 20;
/** A rate-limit episode ends after 5 quiet minutes, so the counter decays. */
export const RATE_LIMIT_RESET_MS = 5 * 60_000;
export const UNKNOWN_COLS_MS = 30 * 60_000;

/** Remember the unknown columns of one call; drops entries older than 30 min and keeps the newest 20. */
export function rememberUnknownCols(s: SessionState, toolUseId: string, cols: string[], now = Date.now()): void {
  const all = { ...(s.unknownCols ?? {}), [toolUseId]: { cols, at: now } };
  const kept = Object.entries(all)
    .filter(([, e]) => e && Array.isArray(e.cols) && now - e.at <= UNKNOWN_COLS_MS)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, UNKNOWN_COLS_MAX);
  s.unknownCols = Object.fromEntries(kept);
}

/** The unknown columns remembered for a call (removed from the state; the caller saves it). */
export function takeUnknownCols(s: SessionState, toolUseId: string, now = Date.now()): string[] | undefined {
  const e = s.unknownCols?.[toolUseId];
  if (!e) return undefined;
  delete s.unknownCols![toolUseId];
  return now - e.at <= UNKNOWN_COLS_MS && Array.isArray(e.cols) ? e.cols : undefined;
}

export const INFLIGHT_STALE_MS = 120_000;

const safe = (s: string) => (s || "nosession").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || "nosession";

export function sessionDir(data: string, session: string): string {
  return path.join(data, "sessions", safe(session));
}

export function beginCall(data: string, session: string, toolUseId: string, info: Inflight): string[] {
  const dir = ensureDir(path.join(sessionDir(data, session), "inflight"));
  const others: string[] = [];
  const now = Date.now();
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const e = readJson<Inflight | undefined>(p, undefined);
    // Older than 2 minutes: a leftover from a crashed call, or one the user rejected at the
    // permission prompt (no Post hook fires then). Connector calls don't run that long.
    if (!e || now - e.startedAt > INFLIGHT_STALE_MS) {
      try {
        fs.unlinkSync(p);
      } catch {
        /* ignore */
      }
      continue;
    }
    if (f !== `${safe(toolUseId)}.json`) others.push(e.tool);
  }
  writeJson(path.join(dir, `${safe(toolUseId)}.json`), info);
  return others;
}

export function endCall(data: string, session: string, toolUseId: string): Inflight | undefined {
  const p = path.join(sessionDir(data, session), "inflight", `${safe(toolUseId)}.json`);
  const e = readJson<Inflight | undefined>(p, undefined);
  try {
    fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
  return e;
}

/** What each loaded state looked like on disk, so saveState can apply only this process's changes. */
const loaded = new WeakMap<SessionState, string>();

const statePath = (data: string, session: string) => path.join(sessionDir(data, session), "state.json");

function readState(file: string): SessionState {
  const s = readJson<SessionState>(file, { retries: {} });
  if (!s || typeof s !== "object" || Array.isArray(s)) return { retries: {} };
  if (!s.retries || typeof s.retries !== "object") s.retries = {};
  return s;
}

export function loadState(data: string, session: string): SessionState {
  const s = readState(statePath(data, session));
  loaded.set(s, JSON.stringify(s));
  return s;
}

const recOf = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Per-key changes from `base` to `mine`, applied onto `disk` (added, changed, deleted keys). */
function mergeRecord(base: unknown, mine: unknown, disk: unknown): Record<string, unknown> {
  const [b, m, out] = [recOf(base), recOf(mine), { ...recOf(disk) }];
  for (const k of new Set([...Object.keys(b), ...Object.keys(m)])) {
    if (!(k in m)) delete out[k];
    else if (JSON.stringify(b[k]) !== JSON.stringify(m[k])) out[k] = m[k];
  }
  return out;
}

/**
 * Parallel hook processes share state.json; a plain load/save would lose one of two concurrent
 * updates. Under a lock, this process's changes since loadState (per key for the
 * object fields, added entries for the arrays, e.g. metadataAsked) are merged onto what's on disk now.
 */
export function saveState(data: string, session: string, s: SessionState): void {
  const file = statePath(data, session);
  const base = JSON.parse(loaded.get(s) ?? '{"retries":{}}') as SessionState;
  withFileLock(`${file}.lock`, () => {
    const disk = readState(file) as unknown as Record<string, unknown>;
    const [b, m] = [base as unknown as Record<string, unknown>, s as unknown as Record<string, unknown>];
    const next: Record<string, unknown> = { ...disk };
    for (const k of new Set([...Object.keys(b), ...Object.keys(m)])) {
      if (Array.isArray(m[k]) || Array.isArray(disk[k])) {
        const added = (Array.isArray(m[k]) ? (m[k] as unknown[]) : []).filter((x) => !(Array.isArray(b[k]) && (b[k] as unknown[]).includes(x)));
        next[k] = [...new Set([...(Array.isArray(disk[k]) ? (disk[k] as unknown[]) : []), ...added])];
      } else if (recOf(m[k]) === m[k] || recOf(disk[k]) === disk[k] || recOf(b[k]) === b[k]) {
        next[k] = mergeRecord(b[k], m[k], disk[k]);
      } else if (!(k in m)) delete next[k];
      else if (JSON.stringify(b[k]) !== JSON.stringify(m[k])) next[k] = m[k];
    }
    writeJson(file, next);
    loaded.set(s, JSON.stringify(next));
  });
}

/** One hook's heartbeat: the last firing, plus the last firing per session (newest few). */
export interface Heartbeat {
  at: string;
  session?: string;
  sessions?: Record<string, string>;
}

const HEARTBEAT_SESSIONS = 5;

/**
 * heartbeat.json is shared by every session on the machine (the data dir is per plugin, not per
 * session), so each hook records which session fired it: doctor can't otherwise tell this
 * session's hooks from another's.
 */
export function heartbeat(data: string, session: string, event: string, now = new Date()): void {
  const p = path.join(data, "heartbeat.json");
  const hb = readJson<Record<string, Heartbeat | undefined>>(p, {});
  const at = now.toISOString();
  const sid = typeof session === "string" ? session : String(session ?? "");
  const prev = hb[event];
  const sessions = { ...(prev && typeof prev.sessions === "object" ? prev.sessions : {}), [sid]: at };
  const recent = Object.entries(sessions)
    .sort((a, b) => b[1].localeCompare(a[1]))
    .slice(0, HEARTBEAT_SESSIONS);
  hb[event] = { at, session: sid, sessions: Object.fromEntries(recent) };
  writeJson(p, hb);
}

export function cleanupSessions(data: string, maxAgeDays = 2): void {
  const root = path.join(data, "sessions");
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  try {
    for (const s of fs.readdirSync(root)) {
      const p = path.join(root, s);
      if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch {
    /* ignore */
  }
}
