/** SessionStart: inject a compact NetSuite context + cache status. Cannot call MCP tools. */
import * as fs from "node:fs";
import * as path from "node:path";
import { reindexOutdated } from "../cache/catalog.ts";
import { buildProfile, loadProfile, profileLines } from "../cache/profile.ts";
import { loadManifest, manifestPath, staleSections } from "../cache/store.ts";
import { type Ctx, accountLabel, context, lastConnector, pluginRootIfOurs } from "../config.ts";
import { cleanupPreviews } from "../preview.ts";
import { cleanupResults } from "../results/store.ts";
import { cleanupSessions, heartbeat } from "../session.ts";
import { ageLabel, isoDate } from "../util.ts";
import type { HookInput, HookOutput } from "./io.ts";

/** The runnable nsx command. CLAUDE_PLUGIN_ROOT only when it's our own install: Bash can carry another plugin's. */
export function cliCommand(): string {
  const root = pluginRootIfOurs();
  const script = root ? path.join(root, "scripts", "nsx.mjs") : path.resolve(process.argv[1] ?? "scripts/nsx.mjs");
  return `node "${script}"`;
}

const CLI_HINT = "<reports search|searches search|fields|periods|results|sql lint|profile> …";

/**
 * SessionStart gets no tool list, so it can't tell whether the connector is enabled in this
 * session: it reports when one was last used and has Claude check its own tool list.
 */
export function connectorLine(ctx: Ctx): string {
  const seen = lastConnector(ctx.data || null);
  const last = seen ? `last used ${isoDate(new Date(seen.lastSeen))} (server ${seen.server})` : "not used yet";
  return `Connector: ${last}. Whether it's enabled in THIS session only shows in your tool list: NetSuite tools end in ns_runCustomSuiteQL, ns_listAllReports, … under any server name. If there are none, it isn't connected or enabled; /su-ns-harness:init step 1 has the fix.`;
}

export function sessionContext(ctx: Ctx, now = Date.now()): string {
  const cli = cliCommand();
  if (!ctx.acct || !ctx.acctDir) {
    return [
      `su-ns-harness (NetSuite): no NetSuite call seen yet, so there's no local cache. When the user first asks about NetSuite, run the su-ns-harness:init skill yourself before answering (it needs nothing from the user; tell them it takes a few minutes).`,
      `Cache CLI (not on PATH — always run it exactly like this): ${cli} ${CLI_HINT}`,
      connectorLine(ctx),
    ].join("\n");
  }
  const label = accountLabel(ctx);
  if (!fs.existsSync(manifestPath(ctx.acctDir))) {
    return [
      `NetSuite (${label}) — local cache is empty.`,
      `→ Before the first NetSuite answer, run the su-ns-harness:init skill yourself (it needs nothing from the user; tell them it takes a few minutes), or at least call the catalog tools you need (results are cached automatically).`,
      `Cache CLI (not on PATH — always run it exactly like this): ${cli} ${CLI_HINT}`,
      connectorLine(ctx),
    ].join("\n");
  }
  const m = loadManifest(ctx.acctDir);
  const times = Object.values(m.sections).map((e) => Date.parse(e.fetchedAt)).filter(Number.isFinite);
  const oldest = times.length ? Math.min(...times) : now;
  const lines: string[] = [];
  lines.push(`NetSuite (${label}) — cache built ${isoDate(new Date(oldest))} (${ageLabel(now - oldest)} ago), ${Object.keys(m.sections).length} sections`);
  lines.push(...profileLines(loadProfile(ctx.acctDir)));
  const stale = staleSections(m, ctx.cfg, now);
  if (stale.length) {
    const shown = stale.slice(0, 8).map((s) => `${s.name} (${s.reason ? s.reason : `${ageLabel(s.ageMs)} > ${s.ttlDays}d TTL`})`);
    lines.push(`Stale: ${shown.join(", ")}${stale.length > 8 ? `, +${stale.length - 8} more` : ""}`);
    lines.push(`→ Before the first NetSuite answer this session, refresh only the stale sections you need: run the su-ns-harness:refresh skill (sections: stale, or just the ones you need), one call at a time.`);
  } else {
    lines.push(`Cache fresh — answer catalog questions from nsx, not from ns_* catalog tools.`);
  }
  const unparsed = Object.entries(m.sections).filter(([, e]) => e.status === "unparsed").map(([n]) => n);
  if (unparsed.length) lines.push(`Unparsed sections (raw only): ${unparsed.slice(0, 5).join(", ")}`);
  lines.push(`Cache CLI (not on PATH — always run it exactly like this): ${cli} ${CLI_HINT}`);
  lines.push(connectorLine(ctx));
  lines.push(`Mode: ${ctx.cfg.read_only ? "read-only (writes blocked)" : "writes allowed with preview + approval"}`);
  return lines.join("\n");
}

export function handleSessionStart(input: HookInput, ctx: Ctx = context()): HookOutput | undefined {
  heartbeat(ctx.data, input.session_id ?? "", "session-start");
  // Every source (startup, resume, clear, compact): a machine that only resumes must still sweep.
  if (ctx.acctDir) {
    // A plugin update may change an index format: re-parse from stored raw payloads, then rebuild the profile.
    if (fs.existsSync(manifestPath(ctx.acctDir)) && reindexOutdated(ctx.acctDir).length && loadProfile(ctx.acctDir)) buildProfile(ctx.acctDir);
    cleanupResults(ctx.acctDir, ctx.cfg.results_retention_days);
    cleanupPreviews(ctx.acctDir, ctx.cfg.results_retention_days);
  }
  cleanupSessions(ctx.data);
  return { text: sessionContext(ctx) };
}
