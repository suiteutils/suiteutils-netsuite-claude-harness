import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ageLabel, ensureDir, readJson, writeJson } from "./util.ts";

export const PLUGIN_VERSION = "0.5.1";
const MARKER = ".su-ns-harness";

export interface Config {
  account_id: string;
  environment: "production" | "sandbox";
  inline_max_chars: number;
  saved_search_default_rows: number;
  suiteql_default_page_size: number;
  results_retention_days: number;
  read_only: boolean;
  ttl_days: Record<string, number>;
}

export const DEFAULT_TTL_DAYS: Record<string, number> = {
  recordtypes: 30,
  fields: 30,
  recordmeta: 30,
  reports: 7,
  searches: 1,
  subsidiaries: 7,
  books: 30,
  contexts: 30,
  nexus: 30,
  periods: 1,
  profile: 30,
};

export const DEFAULTS: Config = {
  account_id: "",
  environment: "production",
  inline_max_chars: 6000,
  saved_search_default_rows: 200,
  suiteql_default_page_size: 500,
  results_retention_days: 7,
  read_only: true,
  ttl_days: { ...DEFAULT_TTL_DAYS },
};

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

export class NoDataDirError extends Error {
  constructor() {
    super(
      "No su-ns-harness data directory found. Start a Claude Code session with the su-ns-harness plugin enabled first (its hooks create it), or set NSX_DATA_DIR.",
    );
  }
}

/**
 * Where plugin state lives. Hooks get CLAUDE_PLUGIN_DATA; Bash invocations of the CLI
 * usually don't, so we fall back to the plugin data directory a hook marked earlier.
 * There is deliberately no other fallback: a second state root would split the cache.
 */
/** This plugin's install root, from the running script (…/scripts/nsx.mjs or …/src/cli.ts). */
export function ownRoot(): string | undefined {
  const script = process.argv[1];
  return script ? path.resolve(path.dirname(script), "..") : undefined;
}

export function samePath(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

/**
 * CLAUDE_PLUGIN_DATA is only ours when CLAUDE_PLUGIN_ROOT is set and is our own install (true in
 * our hooks). Claude Code's Bash environment can carry another plugin's CLAUDE_PLUGIN_DATA, and
 * trusting that would read and write inside a foreign plugin's data dir.
 */
function pluginDataIfOurs(): string | undefined {
  const data = process.env.CLAUDE_PLUGIN_DATA;
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const own = ownRoot();
  if (!data || !root || !own) return undefined;
  return samePath(root, own) ? data : undefined;
}

/** CLAUDE_PLUGIN_ROOT when it is this plugin's own install; another plugin's root (Bash can carry one) → undefined. */
export function pluginRootIfOurs(): string | undefined {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const own = ownRoot();
  return root && own && samePath(root, own) ? root : undefined;
}

/** A data dir that can't be used (a file, or not creatable): a clear message instead of a raw EEXIST/EACCES. */
export class DataDirError extends Error {}

function usableDir(dir: string, why: string): string {
  const abs = path.resolve(dir);
  let st: fs.Stats | undefined;
  try {
    st = fs.statSync(abs);
  } catch {
    /* missing: created below */
  }
  if (st && !st.isDirectory()) throw new DataDirError(`${why} is ${abs}, which is a file, not a directory. Point it at a directory.`);
  if (!st) {
    try {
      ensureDir(abs);
    } catch (e) {
      throw new DataDirError(`${why} is ${abs}, which can't be created (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}).`);
    }
  }
  return abs;
}

/**
 * Why the CLI picked a dir on its own: `session` = this session's hooks wrote there (its heartbeat
 * names CLAUDE_CODE_SESSION_ID); `install` = the dir Claude Code gives this install
 * (<plugin>-<marketplace>), existing or not yet; `same-install` = hooks of this same install root
 * (another Claude app) wrote there; `ranked` = none of these known, best of the marked dirs.
 */
export type ChoiceReason = "session" | "install" | "same-install" | "ranked";

/** What `dataDir()` chose and why; `auto` is false when NSX_DATA_DIR or our CLAUDE_PLUGIN_DATA named it. */
export interface DataDirChoice {
  dir: string;
  auto: boolean;
  /** auto choice only; undefined = ranked */
  reason?: ChoiceReason;
  /** false: the dir doesn't exist yet (this install's hooks create it on the first NetSuite call) */
  exists?: boolean;
  /** latest heartbeat `at` across hooks, ms since epoch */
  lastFired?: number;
  hasCache: boolean;
  /** the other marked dirs (auto choice only) */
  others: string[];
}

/** Latest firing of any hook in this dir, from heartbeat.json (written on every hook call). */
export function lastHookFired(dir: string): number | undefined {
  const hb = readJson<Record<string, { at?: unknown } | undefined>>(path.join(dir, "heartbeat.json"), {});
  let best: number | undefined;
  for (const e of Object.values(hb && typeof hb === "object" ? hb : {})) {
    const t = typeof e?.at === "string" ? Date.parse(e.at) : NaN;
    if (Number.isFinite(t) && (best === undefined || t > best)) best = t;
  }
  return best;
}

/** True when some account under accounts/ has a manifest, i.e. something was cached. */
export function hasAccountCache(dir: string): boolean {
  try {
    return fs.readdirSync(path.join(dir, "accounts")).some((n) => fs.existsSync(path.join(dir, "accounts", n, "manifest.json")));
  } catch {
    return false;
  }
}

/**
 * Pick among marked dirs: one with a cache beats one without; then the one whose hooks fired
 * last; the marker's mtime only breaks ties when neither has a heartbeat. The marker is written
 * once, so "newest marker" means "newest dir", and an empty sibling (another Claude app's first
 * SessionStart) must not take the CLI away from the dir this session's hooks write to.
 */
export function pickDataDir(dirs: string[]): DataDirChoice | undefined {
  const scored = dirs.map((dir) => {
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(dir, MARKER)).mtimeMs;
    } catch {
      /* raced away */
    }
    return { dir, hasCache: hasAccountCache(dir), lastFired: lastHookFired(dir), mtime };
  });
  // Each term is 0 (a tie, falls through) or a signed difference. Two dirs without heartbeats give
  // -Infinity - -Infinity = NaN, which is falsy too, so they fall through to marker mtime as intended.
  scored.sort(
    (a, b) =>
      Number(b.hasCache) - Number(a.hasCache) ||
      (b.lastFired ?? -Infinity) - (a.lastFired ?? -Infinity) ||
      b.mtime - a.mtime ||
      a.dir.localeCompare(b.dir),
  );
  const top = scored[0];
  if (!top) return undefined;
  return { dir: top.dir, auto: true, lastFired: top.lastFired, hasCache: top.hasCache, others: scored.slice(1).map((s) => s.dir) };
}

/** Our CLI's install root, only when this process is the CLI (…/scripts/nsx.mjs, or src/cli.ts in a checkout). */
export function cliRoot(argv1 = process.argv[1]): string | undefined {
  if (!argv1 || !/(^|[/\\])(scripts[/\\]nsx\.mjs|src[/\\]cli\.ts)$/.test(argv1)) return undefined;
  return path.resolve(path.dirname(argv1), "..");
}

const realOr = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/**
 * The plugin data dir name Claude Code gives this install: the plugin id `<plugin>@<marketplace>`
 * with every character outside A-Z a-z 0-9 _ - replaced by `-` (live: su-ns-harness-suiteutils,
 * su-ns-harness-inline). A marketplace install runs from
 * <claude home>/plugins/cache/<marketplace>/<plugin>/<version>/; a local checkout names its
 * marketplace in .claude-plugin/marketplace.json. undefined when neither says.
 */
export function ownDataDirName(root = cliRoot()): string | undefined {
  if (!root) return undefined;
  const abs = realOr(root);
  const plugin = readJson<{ name?: unknown }>(path.join(abs, ".claude-plugin", "plugin.json"), {})?.name;
  if (typeof plugin !== "string" || !plugin) return undefined;
  let market = /[/\\]plugins[/\\]cache[/\\]([^/\\]+)[/\\][^/\\]+[/\\][^/\\]+$/.exec(abs)?.[1];
  if (!market) {
    const m = readJson<{ name?: unknown; plugins?: unknown }>(path.join(abs, ".claude-plugin", "marketplace.json"), {});
    const listed = Array.isArray(m?.plugins) && m.plugins.some((p) => (p as { name?: unknown } | null)?.name === plugin);
    if (typeof m?.name === "string" && m.name && listed) market = m.name;
  }
  return market ? `${plugin}@${market}`.replace(/[^A-Za-z0-9_-]/g, "-") : undefined;
}

const INSTALL_FILE = "install.json";

/** Hooks note which install root writes a dir, so the CLI of that install can find it under another name. */
function recordInstall(dir: string, root: string): void {
  const file = path.join(dir, INSTALL_FILE);
  const want = realOr(root);
  if (readJson<{ root?: unknown }>(file, {})?.root === want) return;
  try {
    writeJson(file, { root: want, at: new Date().toISOString() });
  } catch {
    /* read-only dir: the CLI falls back to the other signals */
  }
}

function installRootOf(dir: string): string | undefined {
  const r = readJson<{ root?: unknown }>(path.join(dir, INSTALL_FILE), {})?.root;
  return typeof r === "string" ? r : undefined;
}

/** Did this session's hooks fire in `dir`? heartbeat.json lists the sessions each hook fired in. */
function firedInSession(dir: string, session: string): boolean {
  const hb = readJson<Record<string, { session?: unknown; sessions?: Record<string, unknown> } | undefined>>(path.join(dir, "heartbeat.json"), {});
  return Object.values(hb && typeof hb === "object" ? hb : {}).some((e) => !!e && (e.session === session || (!!e.sessions && typeof e.sessions === "object" && session in e.sessions)));
}

function pluginsDataBase(): string {
  return path.join(claudeHome(), "plugins", "data");
}

/**
 * The CLI's pick among the marked dirs, most certain first: the dir this session's hooks write to;
 * the dir named for this install (even before its first hook call: another install's cache must
 * never stand in for it); a dir this same install root wrote from another Claude app;
 * else the ranking of pickDataDir. `root`/`session`/`name` are injectable for tests.
 */
export function autoDataDirChoice(
  dirs = markedDataDirs(),
  opts: { session?: string; root?: string; name?: string } = { session: process.env.CLAUDE_CODE_SESSION_ID, root: cliRoot() },
): DataDirChoice | undefined {
  const same = (a: string, b: string) => path.resolve(a) === path.resolve(b);
  const withOthers = (c: DataDirChoice | undefined, reason: ChoiceReason): DataDirChoice | undefined =>
    c && { ...c, reason, exists: true, others: dirs.filter((d) => !same(d, c.dir)) };
  if (opts.session) {
    const mine = dirs.filter((d) => firedInSession(d, opts.session!));
    if (mine.length) return withOthers(pickDataDir(mine), "session");
  }
  const name = opts.name ?? ownDataDirName(opts.root);
  const ownDir = name ? path.join(pluginsDataBase(), name) : undefined;
  let isDir = false;
  try {
    isDir = !!ownDir && fs.statSync(ownDir).isDirectory();
  } catch {
    /* not created yet */
  }
  if (ownDir && isDir) {
    return { dir: ownDir, auto: true, reason: "install", exists: true, hasCache: hasAccountCache(ownDir), lastFired: lastHookFired(ownDir), others: dirs.filter((d) => !same(d, ownDir)) };
  }
  if (opts.root) {
    const root = realOr(opts.root);
    const sameRoot = dirs.filter((d) => installRootOf(d) === root);
    if (sameRoot.length) return withOthers(pickDataDir(sameRoot), "same-install");
  }
  // Only other installs' dirs exist: this install's own dir is the one its hooks will create.
  if (ownDir && dirs.length) return { dir: ownDir, auto: true, reason: "install", exists: false, hasCache: false, others: dirs };
  const ranked = pickDataDir(dirs);
  return ranked && { ...ranked, reason: "ranked", exists: true };
}

export function dataDirChoice(): DataDirChoice {
  const env = process.env.NSX_DATA_DIR;
  const ours = env ? undefined : pluginDataIfOurs();
  const named = env || ours;
  if (named) {
    // Relative NSX_DATA_DIR would follow the cwd, so every project would get its own cache.
    const explicit = usableDir(named, env ? "NSX_DATA_DIR" : "CLAUDE_PLUGIN_DATA");
    const marker = path.join(explicit, MARKER);
    // Written once: the marker only says "this dir is ours". Choosing between dirs uses heartbeats.
    if (!fs.existsSync(marker)) {
      try {
        fs.writeFileSync(marker, PLUGIN_VERSION);
      } catch {
        /* read-only dir: still usable for reads */
      }
    }
    const root = ours && pluginRootIfOurs();
    if (root) recordInstall(explicit, root);
    return { dir: explicit, auto: false, hasCache: hasAccountCache(explicit), lastFired: lastHookFired(explicit), others: [] };
  }
  const choice = autoDataDirChoice();
  if (!choice) throw new NoDataDirError();
  return choice;
}

export function dataDir(): string {
  return dataDirChoice().dir;
}

/** "su-ns-harness-inline (hooks last fired 1m ago)": the chosen dir and why, for CLI notices. */
export function describeChoice(c: DataDirChoice, now = Date.now()): string {
  if (c.exists === false) return `${path.basename(c.dir)} (this install's data dir; new, created on the first NetSuite call)`;
  const why = c.lastFired !== undefined ? `hooks last fired ${ageLabel(Math.max(0, now - c.lastFired))} ago` : "hooks never fired";
  const reason = c.reason === "session" ? "this session's hooks write here, " : c.reason === "install" ? "this install's data dir, " : c.reason === "same-install" ? "written by this install's hooks, " : "";
  return `${path.basename(c.dir)} (${reason}${why}${c.hasCache ? "" : ", no cache yet"})`;
}

/** "su-ns-harness-inline is another install's cache and is ignored": the other dirs of an install/session choice. */
export function othersIgnored(c: DataDirChoice): string | undefined {
  if (!c.others.length || !c.reason || c.reason === "ranked") return undefined;
  const names = c.others.map((d) => path.basename(d)).join(", ");
  const one = c.others.length === 1;
  if (c.reason === "session") return `${names} ${one ? "is" : "are"} ignored (this session's hooks don't write there)`;
  return `${names} ${one ? "is another install's cache" : "are other installs' caches"} and ${one ? "is" : "are"} ignored`;
}

/**
 * One stderr line for CLI commands when the data dir was picked among several, so a split cache
 * never goes unnoticed. undefined when there's nothing to say (one dir, or an explicit dir).
 */
export function dataDirNotice(now = Date.now()): string | undefined {
  let c: DataDirChoice;
  try {
    c = dataDirChoice();
  } catch {
    return undefined;
  }
  if (!c.auto || !c.others.length) return undefined;
  const ignored = othersIgnored(c);
  if (ignored) return `nsx: using ${describeChoice(c, now)}; ${ignored}. Set NSX_DATA_DIR to pick another.`;
  const others = c.others.map((d) => path.basename(d)).join(", ");
  return `nsx: using ${describeChoice(c, now)}; ${others} also exist${c.others.length === 1 ? "s" : ""}. Set NSX_DATA_DIR to pick one.`;
}

/**
 * Every plugin data dir carrying our marker under <claude home>/plugins/data. More than one means a
 * split cache: live, the desktop app used su-ns-harness-inline and the CLI su-ns-harness-suiteutils
 * for the same install, so each ran its own init.
 */
export function markedDataDirs(): string[] {
  const base = path.join(claudeHome(), "plugins", "data");
  try {
    return fs
      .readdirSync(base)
      .map((n) => path.join(base, n))
      .filter((d) => fs.existsSync(path.join(d, MARKER)))
      .sort();
  } catch {
    return [];
  }
}

/** Env override (tests, automation). Claude Code doesn't set these: the plugin has no userConfig. */
function envOption(key: string): string | undefined {
  const v = process.env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`];
  return v === undefined || v === "" ? undefined : v;
}

export const SETTINGS_FILE = "settings.json";

/** Settings `nsx config set` accepts. Every one has a working default; none is needed to start. */
export const SETTING_KEYS = [
  "read_only",
  "inline_max_chars",
  "saved_search_default_rows",
  "suiteql_default_page_size",
  "results_retention_days",
  "ttl_overrides",
  "account_id",
  "environment",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Settings saved with `nsx config set`, in the plugin data dir (no /plugin configure needed). */
export function savedSettings(dir: string | null): Partial<Record<SettingKey, string>> {
  return dir ? readJson<Partial<Record<SettingKey, string>>>(path.join(dir, SETTINGS_FILE), {}) : {};
}

/** Bounds for the numeric settings: a page size NetSuite accepts, a retention of at least a day, an inline limit that still shows something. */
const NUMERIC_RANGES: Partial<Record<SettingKey, [number, number]>> = {
  inline_max_chars: [500, 200_000],
  saved_search_default_rows: [1, 1000],
  suiteql_default_page_size: [5, 1000],
  results_retention_days: [1, 3650],
};

const TTL_HINT = `ttl_overrides looks like "searches=2, periods=0.5" (sections: ${Object.keys(DEFAULT_TTL_DAYS).join(", ")})`;

/** Every part must be a known section with a positive number of days; nothing is dropped silently. */
function ttlOverridesOrThrow(v: string): void {
  const parts = v.split(/[,;\s]+/).filter(Boolean);
  const bad = parts.filter((p) => !Object.keys(parseTtlOverrides(p)).length);
  if (!parts.length || bad.length) throw new Error(`${bad.length ? `can't use ${bad.map((b) => `'${b}'`).join(", ")}: ` : ""}${TTL_HINT}`);
}

/** Validate and save; an empty value resets the key to its default. Returns the saved map. */
export function saveSettings(dir: string, pairs: Record<string, string>): Partial<Record<SettingKey, string>> {
  const cur = savedSettings(dir);
  for (const [k, v] of Object.entries(pairs)) {
    if (!(SETTING_KEYS as readonly string[]).includes(k)) throw new Error(`Unknown setting '${k}'. Settings: ${SETTING_KEYS.join(", ")}`);
    const key = k as SettingKey;
    if (v === "") {
      delete cur[key];
      continue;
    }
    if (key === "read_only" && !/^(true|false|yes|no|on|off|1|0)$/i.test(v)) throw new Error("read_only must be true or false");
    if (key === "environment" && !/^(production|sandbox)$/i.test(v)) throw new Error("environment must be production or sandbox");
    const range = NUMERIC_RANGES[key];
    if (range) {
      const n = Number(v);
      if (!/^\d+$/.test(v) || n < range[0] || n > range[1]) throw new Error(`${key} must be a positive number: a whole number from ${range[0]} to ${range[1]}`);
    }
    if (key === "ttl_overrides") ttlOverridesOrThrow(v);
    if (key === "account_id" && !/^[A-Za-z0-9_-]+$/.test(v)) throw new Error("account_id looks like 1234567 or 1234567_SB1");
    cur[key] = v;
  }
  writeJson(path.join(dir, SETTINGS_FILE), cur);
  return cur;
}

/** Where a setting's effective value comes from, for `nsx doctor` / `nsx config`. */
export function configSource(key: SettingKey, dir: string | null): string {
  if (envOption(key) !== undefined) return "env override";
  if (savedSettings(dir)[key] !== undefined) return "nsx config";
  return "default";
}

/** read_only fails closed: anything but a clear "false" (false/no/off/0) keeps writes off. */
function readOnly(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && v.trim() !== "") return !/^(false|no|off|0)$/i.test(v.trim());
  return DEFAULTS.read_only;
}

function asNum(v: unknown, d: number, range?: [number, number]): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!(Number.isFinite(n) && n > 0)) return d;
  // A value saved before the bounds existed (or an env override) is clamped, never sent as is.
  return range ? Math.min(range[1], Math.max(range[0], n)) : n;
}

/**
 * Resolve config: env override, then settings saved with `nsx config set`, then defaults. Hooks
 * and the CLI read the same file, so a change applies to the next call without a restart.
 */
export function loadConfig(dir: string | null = dataDir()): Config {
  const saved = savedSettings(dir);
  const pick = (k: SettingKey) => envOption(k) ?? saved[k];
  const ttl = { ...DEFAULT_TTL_DAYS };
  // ttl_overrides: "searches=2, periods=0.5" (days per cache section kind)
  const overrides = pick("ttl_overrides");
  if (overrides) Object.assign(ttl, parseTtlOverrides(overrides));
  const env = String(pick("environment") ?? DEFAULTS.environment).toLowerCase();
  return {
    account_id: String(pick("account_id") ?? "").trim(),
    environment: env === "sandbox" ? "sandbox" : "production",
    inline_max_chars: asNum(pick("inline_max_chars"), DEFAULTS.inline_max_chars, NUMERIC_RANGES.inline_max_chars),
    saved_search_default_rows: asNum(pick("saved_search_default_rows"), DEFAULTS.saved_search_default_rows, NUMERIC_RANGES.saved_search_default_rows),
    suiteql_default_page_size: asNum(pick("suiteql_default_page_size"), DEFAULTS.suiteql_default_page_size, NUMERIC_RANGES.suiteql_default_page_size),
    results_retention_days: asNum(pick("results_retention_days"), DEFAULTS.results_retention_days, NUMERIC_RANGES.results_retention_days),
    read_only: readOnly(pick("read_only")),
    ttl_days: ttl,
  };
}

export function parseTtlOverrides(s: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of s.split(/[,;\s]+/)) {
    const m = /^([a-z]+)=(\d+(?:\.\d+)?)$/i.exec(part.trim());
    if (m && m[1].toLowerCase() in DEFAULT_TTL_DAYS && Number(m[2]) > 0) out[m[1].toLowerCase()] = Number(m[2]);
  }
  return out;
}

/** The MCP server segment of a connector tool name: `mcp__<server>__ns_runCustomSuiteQL` → `<server>`. */
export function connectorServer(toolName: string | undefined): string | undefined {
  return /^mcp__(.+?)__ns_[A-Za-z0-9_]+$/.exec(toolName ?? "")?.[1];
}

export interface ConnectorSeen {
  server: string;
  lastSeen: string;
}

const CONNECTOR_FILE = "connector.json";

/** The connector the last NetSuite call went through (written by the PreToolUse hook). */
export function lastConnector(dir: string | null): ConnectorSeen | undefined {
  if (!dir) return undefined;
  const c = readJson<Partial<ConnectorSeen>>(path.join(dir, CONNECTOR_FILE), {});
  return typeof c.server === "string" && c.server ? { server: c.server, lastSeen: String(c.lastSeen ?? "") } : undefined;
}

/** Rewritten only when the server or the day changes, so every call isn't a disk write. */
export function recordConnector(dir: string, server: string, now = new Date()): void {
  const prev = lastConnector(dir);
  const day = now.toISOString().slice(0, 10);
  if (prev?.server === server && prev.lastSeen.slice(0, 10) === day) return;
  writeJson(path.join(dir, CONNECTOR_FILE), { server, lastSeen: now.toISOString() });
}

/**
 * Cache key. The harness never connects to NetSuite itself, so it doesn't need the account id:
 * each connector (MCP server) is one account, and its name keys the cache. An explicit
 * account_id still wins, for setups where one account is reachable through several servers.
 */
export function accountKey(cfg: Config, server?: string): string | undefined {
  const id = cfg.account_id.replace(/[^A-Za-z0-9_-]/g, "");
  if (id) return `${id}-${cfg.environment}`;
  const conn = (server ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  return conn ? `conn-${conn}` : undefined;
}

export interface Ctx {
  cfg: Config;
  data: string;
  /** undefined until a connector call has been seen (or account_id is set) */
  acct?: string;
  acctDir?: string;
  /** MCP server the cache is keyed by, when account_id isn't set */
  server?: string;
}

/** How the account is shown in session context and CLI output. */
export function accountLabel(ctx: Ctx): string {
  if (ctx.cfg.account_id) return `acct ${ctx.cfg.account_id}, ${ctx.cfg.environment}`;
  const s = ctx.server ?? "";
  return `connector ${s.length > 20 ? `${s.slice(0, 8)}…` : s}`;
}

/** Config from env only, no state directory: for commands that don't touch the cache. */
export function statelessContext(): Ctx {
  return { cfg: loadConfig(null), data: "" };
}

/** Hooks pass the tool name so the cache follows the connector of that call; the CLI and
 * SessionStart fall back to the connector used last. */
export function context(toolName?: string): Ctx {
  const data = dataDir();
  const cfg = loadConfig(data);
  const server = cfg.account_id ? undefined : (connectorServer(toolName) ?? lastConnector(data)?.server);
  const acct = accountKey(cfg, server);
  return { cfg, data, acct, acctDir: acct ? path.join(data, "accounts", acct) : undefined, server };
}
