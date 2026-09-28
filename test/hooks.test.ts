import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { readAudit } from "../src/audit.ts";
import { buildProfile, loadProfile, parseDate, profileCard, setOverrides } from "../src/cache/profile.ts";
import { INDEX_VERSION, loadManifest, markStale, staleSections, storeSection } from "../src/cache/store.ts";
import { context } from "../src/config.ts";
import { cmdConfig } from "../src/cli.ts";
import { classifyError, rateLimitWait } from "../src/errors.ts";
import { lintSuiteQL } from "../src/sql/lint.ts";
import { handleFailure, handlePost } from "../src/hooks/post.ts";
import { handlePre } from "../src/hooks/pre.ts";
import { handleSessionStart } from "../src/hooks/session-start.ts";
import { diffLines, writePreview } from "../src/preview.ts";
import { INFLIGHT_STALE_MS, heartbeat, sessionDir } from "../src/session.ts";
import { csvCell, toCsv } from "../src/util.ts";
import { bigRows, fixture, hso, text, tmpCtx } from "./helpers.ts";

const T = (tool: string) => `mcp__netsuite__${tool}`;

/** The canonical tagged query for `tag`, from init's probe table (the hook validates against it). */
function probeSql(tag: string): string {
  const md = fs.readFileSync(path.join(import.meta.dirname, "..", "skills", "init", "SKILL.md"), "utf8");
  for (const m of md.matchAll(/^\| `[^`]*\[su-ns-harness:([^\]]+)\]` \| `([^`]+)` \|$/gm)) if (m[1] === tag) return m[2];
  throw new Error(`no probe ${tag} in skills/init/SKILL.md`);
}
const tagged = (tag: string, body: unknown, extra: Record<string, unknown> = {}) => ({
  tool_name: T("ns_runCustomSuiteQL"),
  tool_input: { sqlQuery: probeSql(tag), description: `[su-ns-harness:${tag}]` },
  tool_response: Array.isArray(body) ? body : text(JSON.stringify(body)),
  ...extra,
});

describe("PreToolUse guard", () => {
  it("ignores non-NetSuite tools", () => {
    const ctx = tmpCtx();
    assert.equal(handlePre({ tool_name: "Bash", tool_input: { command: "ls" } }, ctx), undefined);
    assert.equal(handlePre({ tool_name: "mcp__other__query", tool_input: {} }, ctx), undefined);
  });

  it("denies ROWNUM with GROUP BY and includes the fixed query", () => {
    const ctx = tmpCtx();
    const out = hso(handlePre({ session_id: "s", tool_use_id: "a", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT entity, SUM(foreigntotal) FROM transaction WHERE ROWNUM <= 100 GROUP BY entity" } }, ctx));
    assert.equal(out.permissionDecision, "deny");
    assert.match(String(out.permissionDecisionReason), /rownum-with-aggregate/);
    assert.match(String(out.permissionDecisionReason), /SELECT entity, SUM\(foreigntotal\) FROM transaction GROUP BY entity FETCH FIRST 100 ROWS ONLY/);
    assert.equal(readAudit(ctx.acctDir!)[0].outcome, "denied");
  });

  it("lets [nolint] through but keeps warnings", () => {
    const ctx = tmpCtx();
    const out = hso(handlePre({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT * FROM transaction", description: "probe [nolint]" } }, ctx));
    assert.equal(out.permissionDecision, undefined);
  });

  it("injects pageSize + pageIndex into SuiteQL and range into saved searches without a decision", () => {
    const ctx = tmpCtx({ suiteql_default_page_size: "250" });
    const q = hso(handlePre({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT id FROM transaction" } }, ctx));
    // Live: pageSize alone returns every page; pageIndex makes it one page.
    assert.deepEqual(q.updatedInput, { sqlQuery: "SELECT id FROM transaction", pageSize: 250, pageIndex: 0 });
    assert.equal(q.permissionDecision, undefined, "must not bypass the user's permission rules");
    const own = hso(handlePre({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT id FROM transaction", pageSize: 50 } }, ctx));
    assert.deepEqual(own.updatedInput, { sqlQuery: "SELECT id FROM transaction", pageSize: 50, pageIndex: 0 });
    assert.equal(hso(handlePre({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT id FROM transaction", pageSize: 50, pageIndex: 3 } }, ctx)).updatedInput, undefined);
    const s = hso(handlePre({ tool_name: T("ns_runSavedSearch"), tool_input: { searchId: "customsearch_x" } }, ctx));
    assert.deepEqual(s.updatedInput, { searchId: "customsearch_x", range_start: 0, range_end: 200 });
    assert.match(String(s.additionalContext), /limited to 200 rows/);
    const explicit = handlePre({ tool_name: T("ns_runSavedSearch"), tool_input: { searchId: "x", range_start: 0, range_end: 5000 } }, ctx);
    assert.equal(hso(explicit).updatedInput, undefined);
  });

  it("requires fields (or an explicit [full]) for large records, every time", () => {
    const ctx = tmpCtx();
    const call = { session_id: "s", tool_name: T("ns_getRecord"), tool_input: { recordType: "salesorder", recordId: "42" } };
    assert.equal(hso(handlePre(call, ctx)).permissionDecision, "deny");
    assert.equal(hso(handlePre(call, ctx)).permissionDecision, "deny", "a repeat is not a silent bypass");
    const full = hso(handlePre({ tool_name: T("ns_getRecord"), tool_input: { recordType: "salesorder", recordId: "1", fields: "[full]" } }, ctx));
    assert.deepEqual(full.updatedInput, { recordType: "salesorder", recordId: "1" });
  });

  it("blocks writes in read-only mode (the default)", () => {
    const ctx = tmpCtx();
    const out = hso(handlePre({ tool_name: T("ns_updateRecord"), tool_input: { recordType: "customer", recordId: "1", values: { phone: "1" } } }, ctx));
    assert.equal(out.permissionDecision, "deny");
    assert.match(String(out.permissionDecisionReason), /read_only/);
  });

  it("requires externalId and a preview, then asks the user", () => {
    const ctx = tmpCtx({ read_only: "false" });
    const noExt = hso(handlePre({ tool_name: T("ns_createRecord"), tool_input: { recordType: "customer", values: { companyname: "A" } } }, ctx));
    assert.match(String(noExt.permissionDecisionReason), /externalId/);
    const input = { recordType: "customer", externalId: "claude-1", values: { companyname: "A" } };
    const noPreview = hso(handlePre({ tool_name: T("ns_createRecord"), tool_input: input }, ctx));
    assert.match(String(noPreview.permissionDecisionReason), /nsx preview/);
    writePreview(ctx.acctDir!, "ns_createRecord", { values: { companyname: "A" }, externalId: "claude-1", recordType: "customer" });
    const ok = hso(handlePre({ tool_name: T("ns_createRecord"), tool_input: input }, ctx));
    assert.equal(ok.permissionDecision, "ask");
    assert.match(String(ok.permissionDecisionReason), /\+ companyname = "A"/);
  });

  it("warns when another NetSuite call is in flight", () => {
    const ctx = tmpCtx();
    handlePre({ session_id: "p", tool_use_id: "1", tool_name: T("ns_listAllReports"), tool_input: {} }, ctx);
    const second = hso(handlePre({ session_id: "p", tool_use_id: "2", tool_name: T("ns_listSavedSearches"), tool_input: {} }, ctx));
    assert.match(String(second.additionalContext), /one at a time/);
  });
});

describe("PostToolUse shaper", () => {
  it("caches catalog responses and replaces them with a one-liner", () => {
    const ctx = tmpCtx();
    const out = hso(handlePost({ tool_name: T("ns_listAllReports"), tool_input: {}, tool_response: fixture("reports_list.json") }, ctx));
    assert.equal(out.updatedMCPToolOutput, '[su-ns-harness] Cached 6 reports → use: nsx reports search "<term>"');
    assert.equal(loadManifest(ctx.acctDir!).sections.reports.count, 6);
  });

  it("caches per-table field metadata", () => {
    const ctx = tmpCtx();
    const out = hso(handlePost({ tool_name: T("ns_getSuiteQLMetadata"), tool_input: { recordType: "Transaction" }, tool_response: fixture("suiteql_metadata_transaction.json") }, ctx));
    assert.match(String(out.updatedMCPToolOutput), /Cached 10 fields for transaction/);
    assert.ok(loadManifest(ctx.acctDir!).sections["fields/transaction"]);
  });

  it("uses the field cache in the checker once cached", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_getSuiteQLMetadata"), tool_input: { recordType: "transaction" }, tool_response: fixture("suiteql_metadata_transaction.json") }, ctx);
    const out = hso(handlePre({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT t.tranid, t.amount FROM transaction t" } }, ctx));
    // The connector's metadata is incomplete: unknown standard columns only warn.
    assert.equal(out.permissionDecision, undefined);
    assert.match(String(out.additionalContext), /transaction\.amount is not in the connector's metadata/);
  });

  it("replaces unparsed catalog payloads with one line and marks them", () => {
    const ctx = tmpCtx();
    const out = hso(handlePost({ tool_name: T("ns_listAllReports"), tool_input: {}, tool_response: text("weird format") }, ctx));
    assert.match(String(out.updatedMCPToolOutput), /couldn't parse it; kept out of context/);
    assert.equal(loadManifest(ctx.acctDir!).sections.reports.status, "unparsed");
  });

  it("offloads large results and passes small ones through with a source footer", () => {
    const ctx = tmpCtx();
    const big = hso(handlePost({ session_id: "s", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT a FROM t" }, tool_response: text(JSON.stringify({ items: bigRows(3000) })) }, ctx));
    assert.ok(String(big.updatedMCPToolOutput).length < 1500);
    const small = hso(handlePost({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT a FROM t" }, tool_response: text(JSON.stringify({ items: bigRows(3) })) }, ctx));
    assert.equal(small.updatedMCPToolOutput, undefined);
    assert.match(String(small.additionalContext), /Source: SuiteQL "SELECT a FROM t".*3 rows/);
  });

  it("flags truncation in the summary", () => {
    const ctx = tmpCtx();
    // Live paging envelope (pageSize + pageIndex): one page plus hasNextPage/totalResults.
    const out = hso(handlePost({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT a FROM t", pageSize: 1000, pageIndex: 0 }, tool_response: text(JSON.stringify({ data: bigRows(1000), hasNextPage: true, hasPreviousPage: false, totalResults: 4011 })) }, ctx));
    assert.match(String(out.updatedMCPToolOutput), /Truncation warning: .*1,000 of 4,011 rows/);
  });

  it("builds the profile from tagged probes and catalog sections", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_getSubsidiaries"), tool_input: {}, tool_response: fixture("subsidiaries.json") }, ctx);
    handlePost(tagged("periods", fixture("periods.json")), ctx);
    handlePost(tagged("profile:approval_workflows", { items: [{ type: "VendBill", with_status: 12 }, { type: "CustInvc", with_status: 0 }] }), ctx);
    handlePost(tagged("profile:ttm_revenue", { items: [{ subsidiary_id: 1, subsidiary: "Parent GmbH", revenue: 42_000_000 }, { subsidiary_id: 5, subsidiary: "xxParent GmbH - Elimination", revenue: -3_000_000 }] }), ctx);
    handlePost(tagged("profile:base_currency", { items: [{ id: 1, currency: "USD" }] }), ctx);
    const p = loadProfile(ctx.acctDir!)!;
    assert.equal(p.baseCurrency, "USD");
    assert.equal(p.oneWorld, true);
    assert.equal(p.subsidiaryCount, 4, "consolidated view and elimination subsidiary are excluded");
    assert.equal(p.fiscalYearStartMonth, "Apr");
    assert.deepEqual(p.openPeriods, ["Sep 2025", "Oct 2025"]);
    assert.deepEqual(p.approvalWorkflows, { VendBill: true, CustInvc: false });
    assert.deepEqual(p.materiality, { amount: 50_000, pct: 5, from: "Parent GmbH", fromId: "1", basis: "parent" });
  });

  it("treats isError results as failures and marks field caches stale", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_getSuiteQLMetadata"), tool_input: { recordType: "transaction" }, tool_response: fixture("suiteql_metadata_transaction.json") }, ctx);
    const out = hso(handlePost({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT t.zzz FROM transaction t" }, tool_response: { content: [{ type: "text", text: "Invalid search query. Unknown identifier 'zzz'" }], isError: true } }, ctx));
    assert.match(String(out.additionalContext), /bad_field/);
    assert.equal(loadManifest(ctx.acctDir!).sections["fields/transaction"].status, "stale");
  });
});

describe("error handling", () => {
  it("drives a bounded, sequential backoff on rate limits and resets on success", () => {
    const ctx = tmpCtx();
    const call = { session_id: "rl", tool_name: T("ns_runReport"), tool_input: { reportId: 12 }, error: "429 Too Many Requests" };
    const msgs = [1, 2, 3, 4].map(() => String(hso(handleFailure(call, ctx)).additionalContext));
    assert.match(msgs[0], /sleep [5-8]`.*attempt 1 of 3/);
    assert.match(msgs[1], /sleep 1[0-3]`.*attempt 2 of 3/);
    assert.match(msgs[2], /sleep 2[0-3]`.*attempt 3 of 3/);
    assert.match(msgs[3], /Stop retrying/);
    for (const m of msgs.slice(0, 3)) assert.match(m, /one at a time/);
    handlePost({ ...call, tool_response: text("{}") }, ctx);
    assert.match(String(hso(handleFailure(call, ctx)).additionalContext), /attempt 1 of 3/);
  });

  it("classifies auth and permission errors as no-retry", () => {
    const ctx = tmpCtx();
    assert.match(String(hso(handleFailure({ tool_name: T("ns_runReport"), tool_input: {}, error: "401 invalid_token" }, ctx)).additionalContext), /reconnect.*\/mcp/);
    assert.match(String(hso(handleFailure({ tool_name: T("ns_getRecord"), tool_input: {}, error: "INSUFFICIENT_PERMISSION" }, ctx)).additionalContext), /Do not retry/);
  });

  it("ignores interrupts", () => {
    const ctx = tmpCtx();
    assert.equal(handleFailure({ tool_name: T("ns_runReport"), tool_input: {}, error: "x", is_interrupt: true }, ctx), undefined);
  });
});

describe("SessionStart", () => {
  it("before any connector call, points to init without asking for an account id", () => {
    const ctx = tmpCtx({ account_id: "" });
    const txt = String(handleSessionStart({ source: "startup" }, ctx)?.text);
    assert.match(txt, /no NetSuite call seen yet.*run the su-ns-harness:init skill yourself.*needs nothing from the user/);
    assert.match(txt, /Connector: not used yet/);
  });

  it("without account_id, the cache is keyed by the connector a call went through", () => {
    tmpCtx({ account_id: "" });
    const A = "mcp__claude_ai_NetSuite__ns_listAllReports";
    const B = "mcp__3f9a1c2e-7b4d-4e8a-9c1f-2a6b8d0e4f13__ns_listAllReports";
    handlePre({ tool_name: A, tool_input: {} });
    handlePost({ tool_name: A, tool_input: {}, tool_response: fixture("reports_list.json") });
    const a = context();
    assert.equal(a.acct, "conn-claude_ai_NetSuite");
    assert.ok(fs.existsSync(path.join(a.acctDir!, "manifest.json")));
    const txt = String(handleSessionStart({ source: "startup" }, a)?.text);
    assert.match(txt, /NetSuite \(connector claude_ai_NetSuite\) — cache built/);
    assert.match(txt, /Connector: last used \d{4}-\d\d-\d\d \(server claude_ai_NetSuite\)/);
    // A second connector (another account) gets its own cache, and the CLI follows the last one used.
    handlePre({ tool_name: B, tool_input: {} });
    handlePost({ tool_name: B, tool_input: {}, tool_response: fixture("reports_list.json") });
    const b = context();
    assert.equal(b.acct, "conn-3f9a1c2e-7b4d-4e8a-9c1f-2a6b8d0e4f13");
    assert.notEqual(b.acctDir, a.acctDir);
    assert.match(String(handleSessionStart({ source: "startup" }, b)?.text), /NetSuite \(connector 3f9a1c2e…\)/);
  });

  it("an explicit account_id still keys the cache, whatever the connector", () => {
    tmpCtx({ account_id: "1234567" });
    handlePre({ tool_name: "mcp__claude_ai_NetSuite__ns_listAllReports", tool_input: {} });
    assert.equal(context("mcp__other__ns_listAllReports").acct, "1234567-production");
  });

  it("says the cache is empty before init", () => {
    const ctx = tmpCtx();
    assert.match(String(handleSessionStart({ source: "startup" }, ctx)?.text), /local cache is empty/);
  });

  it("injects the profile and needs zero catalog calls when fresh", () => {
    const ctx = tmpCtx();
    for (const [tool, fx] of [["ns_getSubsidiaries", "subsidiaries.json"], ["ns_listAllReports", "reports_list.json"], ["ns_listSavedSearches", "searches_list.json"]] as const) {
      handlePost({ tool_name: T(tool), tool_input: {}, tool_response: fixture(fx) }, ctx);
    }
    handlePost(tagged("periods", fixture("periods.json")), ctx);
    handlePost(tagged("profile:base_currency", { items: [{ id: 1, currency: "USD" }] }), ctx);
    const txt = String(handleSessionStart({ source: "startup" }, context())?.text);
    assert.match(txt, /NetSuite \(acct 1234567, production\)/);
    assert.match(txt, /Base currency USD · FY starts Apr · OneWorld: yes \(4 subs\)/);
    assert.match(txt, /Open periods: Sep 2025, Oct 2025/);
    assert.match(txt, /Cache fresh/);
    assert.doesNotMatch(txt, /Stale/);
    assert.ok(txt.split("\n").length <= 15);
  });

  it("re-parses sections indexed by an older format at session start, with no connector call", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_listAllReports"), tool_input: {}, tool_response: fixture("reports_list.json") }, ctx);
    const idx = path.join(ctx.acctDir!, "idx", "reports.tsv");
    const good = fs.readFileSync(idx, "utf8");
    // Simulate a cache written by an older parser: old header, no indexVersion.
    fs.writeFileSync(idx, "name\tcategory\tparams\n");
    const mf = path.join(ctx.acctDir!, "manifest.json");
    const m = JSON.parse(fs.readFileSync(mf, "utf8"));
    delete m.sections.reports.indexVersion;
    const fetchedAt = m.sections.reports.fetchedAt;
    fs.writeFileSync(mf, JSON.stringify(m));
    handleSessionStart({ source: "startup" }, ctx);
    assert.equal(fs.readFileSync(idx, "utf8"), good);
    const after = loadManifest(ctx.acctDir!).sections.reports;
    assert.equal(after.indexVersion, INDEX_VERSION);
    assert.equal(after.fetchedAt, fetchedAt, "freshness is unchanged: same payload");
    // A payload the current parser can't read: the stale-format index is removed, not left behind.
    fs.writeFileSync(path.join(ctx.acctDir!, "raw", "reports.json"), JSON.stringify({ unexpected: true }));
    const m2 = JSON.parse(fs.readFileSync(mf, "utf8"));
    delete m2.sections.reports.indexVersion;
    fs.writeFileSync(mf, JSON.stringify(m2));
    handleSessionStart({ source: "startup" }, ctx);
    assert.equal(fs.existsSync(idx), false);
    assert.equal(loadManifest(ctx.acctDir!).sections.reports.status, "unparsed");
  });

  it("lists stale sections past their TTL", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_listSavedSearches"), tool_input: {}, tool_response: fixture("searches_list.json") }, ctx);
    const mf = path.join(ctx.acctDir!, "manifest.json");
    const m = JSON.parse(fs.readFileSync(mf, "utf8"));
    m.sections.searches.fetchedAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    fs.writeFileSync(mf, JSON.stringify(m));
    const txt = String(handleSessionStart({ source: "resume" }, ctx)?.text);
    assert.match(txt, /Stale: searches \(2d > 1d TTL\)/);
    assert.match(txt, /refresh only the stale sections/);
  });
});

describe("Claude Code integration details (observed in 2.1.282)", () => {
  /** A fake Claude config dir with one project/session laid out like Claude Code 2.1.282. */
  function spillHome() {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-")));
    const proj = path.join(home, "projects", "p");
    const transcript = path.join(proj, "sess.jsonl");
    const results = path.join(proj, "sess", "tool-results");
    fs.mkdirSync(results, { recursive: true });
    fs.writeFileSync(transcript, "");
    return { home, proj, transcript, results };
  }
  const pointer = (file: string) => `Error: result (348,648 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to ${file}.\nFormat: Plain text\nUse offset and limit…`;
  const spillCall = (file: string, transcript: string) => ({
    session_id: "sess", transcript_path: transcript, tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT a FROM t" }, tool_response: pointer(file),
  });

  it("reads results Claude Code spilled to this session's tool-results/ and shapes them", () => {
    const ctx = tmpCtx();
    const h = spillHome();
    process.env.CLAUDE_CONFIG_DIR = h.home;
    try {
      const file = path.join(h.results, "mcp-x-ns_runCustomSuiteQL-1.txt");
      fs.writeFileSync(file, JSON.stringify({ items: bigRows(3000) }));
      const out = hso(handlePost(spillCall(file, h.transcript), ctx));
      assert.match(String(out.updatedMCPToolOutput), /^\[su-ns-harness\] 3,000 rows × 9 cols saved/);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it("refuses spill paths outside the session, other projects' results, and symlinks", () => {
    const ctx = tmpCtx();
    const h = spillHome();
    process.env.CLAUDE_CONFIG_DIR = h.home;
    try {
      const secret = path.join(os.tmpdir(), `secret-${process.pid}.json`);
      fs.writeFileSync(secret, JSON.stringify({ items: bigRows(10) }));
      const link = path.join(h.results, "leak.json");
      fs.symlinkSync(secret, link);
      const other = path.join(h.home, "projects", "other", "s2", "tool-results");
      fs.mkdirSync(other, { recursive: true });
      fs.writeFileSync(path.join(other, "r.txt"), JSON.stringify({ items: bigRows(10) }));
      for (const file of ["/etc/tool-results/passwd", link, path.join(other, "r.txt"), path.join(h.results, "..", "..", "sess.jsonl")]) {
        const out = hso(handlePost(spillCall(file, h.transcript), ctx));
        assert.equal(out.updatedMCPToolOutput, undefined, file);
        assert.match(String(out.additionalContext), /could not read/, file);
      }
      const noTranscript = hso(handlePost({ ...spillCall(path.join(h.results, "x.txt"), h.transcript), transcript_path: undefined }, ctx));
      assert.equal(noTranscript.updatedMCPToolOutput, undefined);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it("warns when the spill message format changes", () => {
    const ctx = tmpCtx();
    const out = hso(handlePost({ session_id: "s", transcript_path: "/x/s.jsonl", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT a FROM t" }, tool_response: "Result exceeds maximum allowed tokens; written to cache." }, ctx));
    assert.match(String(out.additionalContext), /could not read/);
  });

  it("clears the in-flight marker when a call is denied", () => {
    const ctx = tmpCtx();
    heartbeat(ctx.data, "d", "session-start");
    handlePre({ session_id: "d", tool_use_id: "1", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT * FROM transaction" } }, ctx);
    const next = hso(handlePre({ session_id: "d", tool_use_id: "2", tool_name: T("ns_listAllReports"), tool_input: {} }, ctx));
    assert.equal(next.additionalContext, undefined);
  });
});

describe("nsx expansion", () => {
  it("expands nsx commands in hook output but never touches updatedInput", async () => {
    const { expandNsx } = await import("../src/hooks/io.ts");
    const cmd = 'node "/p/scripts/nsx.mjs"';
    const out = expandNsx({ hookSpecificOutput: { additionalContext: "use: nsx reports search x; `nsx fields t`; su-ns-harness nsx", updatedInput: { description: "nsx fields" } } }, cmd);
    assert.equal(out.hookSpecificOutput.additionalContext, `use: ${cmd} reports search x; \`${cmd} fields t\`; su-ns-harness nsx`);
    assert.deepEqual(out.hookSpecificOutput.updatedInput, { description: "nsx fields" });
  });
});

describe("write guard fails closed", () => {
  it("still denies a read-only write when bookkeeping cannot write to the data dir", () => {
    const ctx = tmpCtx();
    const blocker = path.join(ctx.data, "not-a-dir");
    fs.writeFileSync(blocker, "");
    const broken = { ...ctx, data: blocker, acctDir: path.join(blocker, "acct") };
    const out = hso(handlePre({ session_id: "w", tool_use_id: "1", tool_name: T("ns_createRecord"), tool_input: { recordType: "customer" } }, broken));
    assert.equal(out.permissionDecision, "deny");
    assert.match(String(out.permissionDecisionReason), /read_only/);
  });

  it("denies writes (and only writes) when the pre hook crashes", async () => {
    const { failClosedForWrites } = await import("../src/hooks/pre.ts");
    assert.equal(hso(failClosedForWrites({ tool_name: T("ns_updateRecord") })).permissionDecision, "deny");
    assert.equal(failClosedForWrites({ tool_name: T("ns_runCustomSuiteQL") }), undefined);
  });
});

describe("error classification", () => {
  it("routes column errors to bad_field, and not_found only to missing reports/searches/records", async () => {
    const { classifyError } = await import("../src/errors.ts");
    assert.equal(classifyError("Column XYZ does not exist"), "bad_field");
    assert.equal(classifyError("ORA-00904: invalid identifier"), "bad_field");
    assert.equal(classifyError("Report 999 not found"), "not_found");
    assert.equal(classifyError("That record does not exist."), "not_found");
    assert.equal(classifyError("Saved search customsearch_x does not exist"), "not_found");
    assert.equal(classifyError("Table foo does not exist"), "bad_record_type");
    assert.equal(classifyError("Search execution failed: syntax error near FROM"), "bad_syntax");
    assert.equal(classifyError("Saved search failed to run"), "unknown");
  });

  it("bad_record_type advice: REST record types for ns_getRecord, SuiteQL tables otherwise", async () => {
    const { advice } = await import("../src/errors.ts");
    for (const tool of ["ns_getRecord", "ns_getRecordTypeMetadata"]) {
      const a = advice("bad_record_type", { tool, message: "Record type 'nosuchrecordtypexyz' does not exist." });
      assert.match(a, /REST record types are lower-case \(invoice, vendorbill, journalentry, customer\); check the name with ns_getRecordTypeMetadata \(no arguments\)/);
      assert.doesNotMatch(a, /SuiteQL|vendorbill is NOT a table|nsx recordtypes/);
    }
    assert.match(advice("bad_record_type", { tool: "ns_runCustomSuiteQL" }), /SuiteQL table names .*vendorbill is NOT a table/);
  });
});

describe("hooks.json", () => {
  it("matchers catch connector tools under any server name and nothing else", () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "hooks", "hooks.json"), "utf8"));
    for (const ev of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
      const re = new RegExp(`^(?:${cfg.hooks[ev][0].matcher})$`);
      for (const name of ["mcp__netsuite__ns_runCustomSuiteQL", "mcp__ns__ns_createRecord", "mcp__claude_ai_NetSuite__ns_listAllReports"]) assert.ok(re.test(name), `${ev} ${name}`);
      for (const name of ["Bash", "mcp__other__query", "mcp__netsuite__getRecord"]) assert.ok(!re.test(name), `${ev} ${name}`);
    }
  });

  it("TTL overrides from plugin config reach the cache", () => {
    const ctx = tmpCtx({ ttl_overrides: "searches=3" });
    assert.equal(ctx.cfg.ttl_days.searches, 3);
    assert.equal(ctx.cfg.ttl_days.reports, 7);
  });
});

describe("approval prompt, in-flight sweep, TTLs and CSV export", () => {
  it("the approval prompt flags a missing before-state and points at the full preview", () => {
    const ctx = tmpCtx({ read_only: "false" });
    const values: Record<string, string> = {};
    for (let i = 0; i < 20; i++) values[`f${i}`] = String(i);
    const input = { recordType: "customer", recordId: "7", values };
    writePreview(ctx.acctDir!, "ns_updateRecord", input);
    const reason = String(hso(handlePre({ tool_name: T("ns_updateRecord"), tool_input: input }, ctx)).permissionDecisionReason);
    assert.match(reason, /No before-state supplied/);
    assert.match(reason, /5 more changes\. Full input: .*previews.*\.json/);
  });

  it("a write sent to the approval prompt is audited as pending", () => {
    const ctx = tmpCtx({ read_only: "false" });
    const input = { recordType: "customer", recordId: "7", values: { phone: "1" } };
    writePreview(ctx.acctDir!, "ns_updateRecord", input, { values: { phone: "0" } });
    handlePre({ session_id: "w", tool_name: T("ns_updateRecord"), tool_input: input }, ctx);
    handlePost({ session_id: "w", tool_name: T("ns_updateRecord"), tool_input: input, tool_response: text('{"id":"7"}') }, ctx);
    const lines = readAudit(ctx.acctDir!);
    assert.deepEqual(lines.map((e) => e.outcome), ["pending", "ok"]);
    assert.ok(lines[0].preview && lines[0].preview === lines[1].preview, "pending and ok pair by preview hash");
  });

  it("an in-flight entry older than the stale window is swept, not reported", () => {
    const ctx = tmpCtx();
    handlePre({ session_id: "s", tool_use_id: "old", tool_name: T("ns_listAllReports"), tool_input: {} }, ctx);
    const f = path.join(sessionDir(ctx.data, "s"), "inflight", "old.json");
    fs.writeFileSync(f, JSON.stringify({ tool: "ns_listAllReports", startedAt: Date.now() - INFLIGHT_STALE_MS - 1000, inputHash: "x" }));
    const next = hso(handlePre({ session_id: "s", tool_use_id: "new", tool_name: T("ns_listSavedSearches"), tool_input: {} }, ctx));
    assert.equal(next.additionalContext, undefined);
    assert.ok(!fs.existsSync(f));
  });

  it("a lowered TTL applies to sections cached before the change", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_listAllReports"), tool_input: {}, tool_response: fixture("reports_list.json") }, ctx);
    const m = loadManifest(ctx.acctDir!);
    const later = Date.now() + 3_600_000;
    assert.equal(staleSections(m, ctx.cfg, later).length, 0);
    const lowered = { ...ctx.cfg, ttl_days: { ...ctx.cfg.ttl_days, reports: 0.01 } };
    assert.deepEqual(staleSections(m, lowered, later).map((s) => s.name), ["reports"]);
  });

  it("a non-numeric range_start doesn't produce range_end: null", () => {
    const ctx = tmpCtx();
    const out = hso(handlePre({ tool_name: T("ns_runSavedSearch"), tool_input: { searchId: "1", range_start: "abc" } }, ctx));
    const ui = out.updatedInput as Record<string, unknown>;
    assert.equal(ui.range_start, 0);
    assert.equal(ui.range_end, 200);
  });

  it("spreadsheet CSV neutralizes formulas but keeps numbers", () => {
    assert.equal(csvCell("=HYPERLINK(\"x\")", true), '"\'=HYPERLINK(""x"")"');
    assert.equal(csvCell("@SUM(A1)", true), "'@SUM(A1)");
    assert.equal(csvCell("-1234.50", true), "-1234.50");
    assert.equal(csvCell("+1e5", true), "+1e5");
    assert.equal(csvCell("=1+1"), "=1+1", "internal CSV is untouched");
    assert.equal(toCsv(["m"], [{ m: "-cmd" }], true), "m\n'-cmd\n");
  });
});

describe("live account shapes: envelopes, dates, subsidiaries, rate limits, metadata", () => {
  const meta = (table: string, body: unknown) => ({ session_id: "live", tool_name: T("ns_getSuiteQLMetadata"), tool_input: { recordType: table }, tool_response: text(JSON.stringify(body)) });
  const cacheRecordTypes = (ctx: ReturnType<typeof tmpCtx>, names: string[]) =>
    handlePost({ tool_name: T("ns_getSuiteQLMetadata"), tool_input: {}, tool_response: text(JSON.stringify({ success: true, metadata: { items: names.map((n) => ({ name: n, title: n })) } })) }, ctx);

  it("parses the { success, metadata, message } envelope and x-n:recordType joins", () => {
    const ctx = tmpCtx();
    const out = hso(handlePost(meta("department", fixture("fields_envelope_department.json")), ctx));
    assert.match(String(out.updatedMCPToolOutput), /Cached 10 fields for department/);
    const e = loadManifest(ctx.acctDir!).sections["fields/department"];
    assert.equal(e.status, "ok");
    const idx = fs.readFileSync(path.join(ctx.acctDir!, "idx", "fields", "department.tsv"), "utf8");
    assert.match(idx, /^parent\tobject\tParent Department\ttrue\tdepartment$/m);
    assert.doesNotMatch(idx, /long help text/, "descriptions stay in raw, not the index");
  });

  it("an empty schema is status 'empty', blames no one, and isn't used by the checker", () => {
    const ctx = tmpCtx();
    cacheRecordTypes(ctx, ["Transaction", "Account"]);
    const out = hso(handlePost(meta("transaction", { success: true, metadata: { type: "object" }, message: "ok" }), ctx));
    assert.match(String(out.updatedMCPToolOutput), /connector exposes no field metadata for 'transaction'; queries still work, column checks are skipped/);
    assert.doesNotMatch(String(out.updatedMCPToolOutput), /report|role|permission/i);
    // Only a table missing from the record-type list is a visibility gap.
    const gap = hso(handlePost(meta("secretthing", { success: true, metadata: { type: "object" } }), ctx));
    assert.match(String(gap.updatedMCPToolOutput), /isn't in this account's SuiteQL record-type list/);
    assert.equal(loadManifest(ctx.acctDir!).sections["fields/transaction"].status, "empty");
    const q = hso(handlePre({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT t.id FROM transaction t" } }, ctx));
    assert.notEqual(q.permissionDecision, "deny");
  });

  it("an unparsed catalog payload never passes through (≤ 300 chars)", () => {
    const ctx = tmpCtx();
    const big = { success: true, weird: { nested: "x".repeat(50_000) } };
    const out = hso(handlePost(meta("customer", big), ctx));
    const replaced = String(out.updatedMCPToolOutput);
    assert.ok(replaced.length <= 300, `${replaced.length} chars`);
    assert.match(replaced, /couldn't parse.*nsx cache show fields\/customer/);
    assert.equal(loadManifest(ctx.acctDir!).sections["fields/customer"].status, "unparsed");
  });

  it("dates parse in every form NetSuite emits", () => {
    for (const s of ["2029-1-1", "2029-01-01", "1/1/2029", "1.1.2029", "2029-01-01T00:00:00Z"]) {
      assert.equal(parseDate(s)?.toISOString().slice(0, 10), "2029-01-01", s);
    }
    assert.equal(parseDate("31.12.2029")?.toISOString().slice(0, 10), "2029-12-31");
    assert.equal(parseDate("not a date"), undefined);
  });

  it("FY start from unpadded dates; open periods start at the earliest open month", () => {
    const ctx = tmpCtx();
    const rows: Record<string, string>[] = [];
    let id = 1;
    for (let y = 2025; y <= 2030; y++) {
      rows.push({ id: String(id++), periodname: `FY ${y}`, startdate: `${y}-1-1`, enddate: `${y}-12-31`, closed: "F", isyear: "T", isquarter: "F", isadjust: "F" });
      for (let mo = 1; mo <= 12; mo++) {
        const closed = y < 2027 || (y === 2027 && mo <= 8) ? "T" : "F";
        rows.push({ id: String(id++), periodname: `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][mo - 1]} ${y}`, startdate: `${y}-${mo}-1`, enddate: `${y}-${mo}-28`, closed, isyear: "F", isquarter: "F", isadjust: "F" });
      }
    }
    handlePost(tagged("periods", { data: rows }), ctx);
    const p = buildProfile(ctx.acctDir!, Date.parse("2026-09-27"));
    assert.equal(p.fiscalYearStartMonth, "Jan");
    assert.deepEqual(p.openPeriods, ["Sep 2027", "Oct 2027", "Nov 2027", "Dec 2027", "Jan 2028", "Feb 2028"]);
  });

  it("counts real subsidiaries only (no consolidated view, no elimination)", () => {
    const ctx = tmpCtx();
    const subs = [{ id: "1", name: "Parent GmbH" }, { id: "2", name: "Sub Pty" }, { id: "5", name: "xxParent - Elimination" }, { id: "-1", name: "Parent GmbH (Consolidated)" }];
    handlePost({ tool_name: T("ns_getSubsidiaries"), tool_input: {}, tool_response: text(JSON.stringify(subs)) }, ctx);
    assert.equal(loadProfile(ctx.acctDir!)?.subsidiaryCount, 2);
  });

  it("money shows the base currency, and no $ when it's unknown", () => {
    const card = (cur?: string) => profileCard({ builtAt: "", baseCurrency: cur, ttmRevenue: 23e6, materiality: { amount: 50_000, pct: 5 } });
    assert.match(card(), /\| TTM revenue \| 23M \|/);
    assert.match(card("EUR"), /\| TTM revenue \| EUR 23M \|/);
    assert.match(card("USD"), /\| TTM revenue \| \$23M \|/);
    assert.match(card("USD - U.S. Dollar"), /\| TTM revenue \| \$23M \|/);
    assert.match(card("US Dollar"), /\| TTM revenue \| \$23M \|/);
    assert.match(card("EUR - Euro"), /\| TTM revenue \| EUR 23M \|/);
  });

  it("settings need no /plugin configure: nsx config set applies to the next call", () => {
    const ctx = tmpCtx({ account_id: "" });
    assert.equal(context().cfg.inline_max_chars, 6000);
    const out = cmdConfig(ctx, ["config", "set", "inline_max_chars=9000", "ttl_overrides=searches=2"]);
    assert.match(out, /inline_max_chars\s+9000\s+nsx config/);
    assert.match(out, /ttl_overrides\s+searches=2/);
    assert.equal(context().cfg.inline_max_chars, 9000);
    assert.equal(context().cfg.ttl_days.searches, 2);
    cmdConfig(ctx, ["config", "set", "inline_max_chars="]);
    assert.equal(context().cfg.inline_max_chars, 6000, "empty value resets to default");
    assert.throws(() => cmdConfig(ctx, ["config", "set", "nope=1"]), /Unknown setting 'nope'/);
    assert.throws(() => cmdConfig(ctx, ["config", "set", "inline_max_chars=-3"]), /positive number/);
  });

  it("only the user, at a terminal, can turn writes on", () => {
    const ctx = tmpCtx({ account_id: "" });
    assert.throws(() => cmdConfig(ctx, ["config", "set", "read_only=false"], false), /has to be done by the user, in their own terminal/);
    assert.equal(context().cfg.read_only, true);
    cmdConfig(ctx, ["config", "set", "read_only=false"], true);
    assert.equal(context().cfg.read_only, false);
    cmdConfig(ctx, ["config", "set", "read_only=true"], false);
    assert.equal(context().cfg.read_only, true, "turning writes off works from anywhere");
    const denied = hso(handlePre({ tool_name: T("ns_updateRecord"), tool_input: { recordType: "customer", id: 1 } }));
    assert.match(String(denied.permissionDecisionReason), /config set read_only=false/);
  });

  it("both 429 forms are rate limits, with a 5/10/20s backoff plus jitter", () => {
    const http = 'HTTP 429: {"status":429,"o:errorDetails":[{"detail":"Concurrent request limit exceeded. Request blocked."}]}';
    assert.equal(classifyError(http), "rate_limit");
    assert.equal(classifyError("The connector's server is rate-limiting requests. You can try again."), "rate_limit");
    assert.deepEqual([1, 2, 3].map((a) => rateLimitWait(a, () => 0)), [5, 10, 20]);
    assert.deepEqual([1, 2, 3].map((a) => rateLimitWait(a, () => 0.99)), [8, 13, 23]);
    const ctx = tmpCtx();
    const body = hso(handlePost({ session_id: "b", tool_name: T("ns_listAllReports"), tool_input: {}, tool_response: text(JSON.stringify({ success: false, error: http })) }, ctx));
    // The ~500-char payload is replaced by the one-line recovery.
    assert.match(String(body.updatedMCPToolOutput), /^\[su-ns-harness\] Error class: rate_limit.*sleep [5-8]`/);
    assert.doesNotMatch(String(body.updatedMCPToolOutput), /errorDetails/);
  });

  it("a SuiteQL table the role can't see gets a role hint, not 'refresh reports'", () => {
    const ctx = tmpCtx();
    const out = hso(handleFailure({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT id FROM subsidiary" }, error: "Error executing SuiteQL query: Search error occurred: Record 'subsidiary' was not found." }, ctx));
    const msg = String(out.additionalContext);
    assert.match(msg, /'subsidiary' isn't exposed to the connector role/);
    assert.doesNotMatch(msg, /ns_listAllReports/);
  });

  it("profile probes on tables missing from the record-type list are skipped", () => {
    const ctx = tmpCtx();
    cacheRecordTypes(ctx, ["transaction", "account"]);
    const probe = hso(handlePre({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { description: "Base currency [su-ns-harness:profile:base_currency]", sqlQuery: probeSql("profile:base_currency") } }, ctx));
    assert.equal(probe.permissionDecision, "deny");
    assert.match(String(probe.permissionDecisionReason), /Skip this profile probe: 'subsidiary'/);
    const user = hso(handlePre({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { description: "[nolint]", sqlQuery: "SELECT id FROM subsidiary" } }, ctx));
    assert.notEqual(user.permissionDecision, "deny", "[nolint] overrides the hidden-table check");
  });

  it("first query on an uncached table asks for its metadata once, then runs", () => {
    const ctx = tmpCtx();
    cacheRecordTypes(ctx, ["customer", "transaction"]);
    const call = { session_id: "lazy", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT c.id, c.name FROM customer c" } };
    const first = hso(handlePre(call, ctx));
    assert.equal(first.permissionDecision, "deny");
    assert.match(String(first.permissionDecisionReason), /ns_getSuiteQLMetadata with recordType "customer"/);
    assert.notEqual(hso(handlePre(call, ctx)).permissionDecision, "deny", "asked once per table per session");
    handlePost(meta("customer", fixture("fields_envelope_department.json")), ctx);
    const other = hso(handlePre({ ...call, session_id: "lazy2" }, ctx));
    assert.notEqual(other.permissionDecision, "deny", "cached tables don't trigger it");
  });

  it("session context tells Claude how to spot a missing connector", () => {
    const ctx = tmpCtx();
    const txt = String(handleSessionStart({ source: "startup" }, ctx)?.text);
    assert.match(txt, /Connector: not used yet\. Whether it's enabled in THIS session only shows in your tool list: .*ns_runCustomSuiteQL.*init step 1/);
  });
});

describe("CLI listings, table caps, doctor and error text", () => {
  const nsx = async (...argv: string[]) => String((await import("../src/cli.ts")).main(argv));
  const cacheRecordTypes = (ctx: ReturnType<typeof tmpCtx>, names: string[]) =>
    handlePost({ tool_name: T("ns_getSuiteQLMetadata"), tool_input: {}, tool_response: text(JSON.stringify({ success: true, metadata: { items: names.map((n) => ({ name: n, title: n })) } })) }, ctx);

  it("periods --open lists the earliest open months, not the last ones", async () => {
    const ctx = tmpCtx();
    const rows: Record<string, string>[] = [];
    const y0 = new Date().getUTCFullYear();
    let id = 1;
    for (let y = y0 - 1; y <= y0 + 4; y++) {
      for (let mo = 1; mo <= 12; mo++) {
        const closed = y < y0 || (y === y0 && mo < new Date().getUTCMonth() + 1) ? "T" : "F";
        rows.push({ id: String(id++), periodname: `P${y}-${mo}`, startdate: `${y}-${mo}-1`, enddate: `${y}-${mo}-28`, closed, isyear: "F", isquarter: "F", isadjust: "F" });
      }
    }
    handlePost(tagged("periods", { data: rows }), ctx);
    const out = await nsx("periods", "--open");
    const cur = `P${y0}-${new Date().getUTCMonth() + 1}`;
    assert.match(out, new RegExp(`showing the earliest 6`));
    assert.match(out.split("\n")[2], new RegExp(`\\b${cur}\\b`), "first data row is the current period");
    assert.equal(out.split("\n").slice(2).filter((l) => /^\d/.test(l)).length, 6);
  });

  it("reports search shows id and params so duplicate titles can be told apart", async () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_listAllReports"), tool_input: {}, tool_response: fixture("reports_list.json") }, ctx);
    const out = await nsx("reports", "search", "income", "statement");
    assert.match(out, /^3 of 6 reports match/);
    assert.match(out, /-200\s+Income Statement\s+from\+to · sub\(consol\)/);
    assert.match(out, /110\s+Income Statement\s+from\+to · book/);
    assert.match(await nsx("cache", "show", "reports", "--grep", "sales orders"), /148\s+Sales Orders Pending Fulfillment\s+as-of · sub\(consol\)/);
  });

  it("recordtypes --grep ranks exact, then prefix, then substring, and supports a|b", async () => {
    const ctx = tmpCtx();
    cacheRecordTypes(ctx, ["CashSaleItemTransactionLineChargeMap", "TransactionLineBook", "TransactionLine", "Account"]);
    const out = (await nsx("recordtypes", "--grep", "transactionline")).split("\n");
    assert.match(out[0], /3 of 4 recordtypes match "transactionline" \(substring; a\|b = either\)/);
    assert.deepEqual(out.slice(2, 5).map((l) => l.split(/\s+/)[0]), ["TransactionLine", "TransactionLineBook", "CashSaleItemTransactionLineChargeMap"]);
    assert.match(await nsx("recordtypes", "--grep", "account|transactionline"), /^4 of 4/);
  });

  it("table caps count rows, not lines; --max as an agg metric doesn't hide rows", async () => {
    const { textTable } = await import("../src/util.ts");
    assert.equal(textTable(["a"], [["1"], ["2"], ["3"]], 1), "a\n1\n… 2 more rows");
    assert.equal(textTable(["a"], [["1"]], 1), "a\n1");
    assert.equal(textTable(["a"], [["1"], ["2"], ["3"]], Infinity), "a\n1\n2\n3", "Infinity = no cap");
    const ctx = tmpCtx();
    const res = hso(handlePost({ session_id: "s", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT a FROM t" }, tool_response: text(JSON.stringify({ items: bigRows(3000) })) }, ctx));
    const id = /\b(r_[0-9a-f]{6})\b/.exec(String(res.updatedMCPToolOutput))![1];
    const head = (await nsx("results", "head", id, "1")).split("\n");
    assert.equal(head.length, 2, "header + 1 row");
    const agg = (await nsx("results", "agg", id, "--by", "status", "--avg", "amount", "--min", "amount", "--max", "amount", "--top", "3")).split("\n");
    assert.ok(agg.slice(1).filter((l) => /^(Open|Paid)/.test(l)).length === 2, agg.join("\n"));
  });

  it("doctor's hook note looks at all four heartbeats", async () => {
    const { hookStatusNote } = await import("../src/cli.ts");
    const at = { at: new Date().toISOString() };
    assert.match(hookStatusNote({ pre: at, post: at }), /Tool hooks have fired but SessionStart hasn't.*\/reload-plugins or start a new session/);
    assert.match(hookStatusNote({}), /Hooks have not fired.*\/reload-plugins/);
    assert.equal(hookStatusNote({ "session-start": at, pre: at }), "");
  });

  it("unreachable server, bad_field table from the error text, generic line for unknown errors", () => {
    const ctx = tmpCtx();
    assert.equal(classifyError("Error: couldn't reach the MCP server"), "unreachable");
    const un = String(hso(handleFailure({ tool_name: T("ns_runReport"), tool_input: {}, error: "couldn't reach the MCP server" }, ctx)).additionalContext);
    assert.match(un, /Error class: unreachable.*Don't retry in a loop.*\/mcp/);
    for (const t of ["transaction", "transactionline"]) handlePost({ tool_name: T("ns_getSuiteQLMetadata"), tool_input: { recordType: t }, tool_response: fixture("suiteql_metadata_transaction.json") }, ctx);
    const bf = String(hso(handleFailure({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT tl.amout FROM transaction t JOIN transactionline tl ON tl.transaction = t.id" }, error: "Search error occurred: Field 'amout' for record 'transactionLine' was not found." }, ctx)).additionalContext);
    assert.match(bf, /bad_field.*'transactionline'/);
    const m = loadManifest(ctx.acctDir!);
    assert.equal(m.sections["fields/transactionline"].status, "stale");
    assert.equal(m.sections["fields/transaction"].status, "ok", "only the table the error names");
    assert.match(String(hso(handleFailure({ tool_name: T("ns_runSavedSearch"), tool_input: {}, error: "Saved search failed to run" }, ctx)).additionalContext), /Error class: unknown\. .*Don't retry blindly.*error text/);
  });

  it("a SuiteQL call with `query` instead of `sqlQuery` says so", () => {
    const ctx = tmpCtx();
    const out = hso(handlePre({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { query: "SELECT id FROM transaction" } }, ctx));
    assert.equal(out.permissionDecision, "deny");
    assert.match(String(out.permissionDecisionReason), /No `sqlQuery` in the input \(got: query\)/);
  });

  it("the card says why the base currency is unknown when subsidiary isn't visible", () => {
    const ctx = tmpCtx();
    cacheRecordTypes(ctx, ["Transaction", "Account"]);
    handlePost({ tool_name: T("ns_getSubsidiaries"), tool_input: {}, tool_response: fixture("subsidiaries.json") }, ctx);
    const card = profileCard(buildProfile(ctx.acctDir!));
    assert.match(card, /\| Base currency \| unknown \(the connector role can't query the subsidiary table; set it with node "[^"]+" profile set base_currency=<code>\) \|/);
    assert.match(card, /Correct anything with: node "[^"]+" profile set key=value/);
  });

  it("fields for a table with empty metadata: no permissions blame", async () => {
    const ctx = tmpCtx();
    cacheRecordTypes(ctx, ["Transaction"]);
    handlePost({ tool_name: T("ns_getSuiteQLMetadata"), tool_input: { recordType: "transaction" }, tool_response: text(JSON.stringify({ success: true, metadata: { type: "object", $schema: "x" } })) }, ctx);
    const out = await nsx("fields", "transaction");
    assert.match(out, /connector exposes no field metadata for 'transaction'; queries still work, column checks are skipped/);
    assert.doesNotMatch(out, /permission|role/);
  });
});

describe("TTM revenue, tagged results, error classes and heartbeats", () => {
  const nsx = async (...argv: string[]) => String((await import("../src/cli.ts")).main(argv));
  const subs = () => text(JSON.stringify([{ id: "1", name: "Parent GmbH" }, { id: "2", name: "Example Australia Pty Ltd" }, { id: "3", name: "Example Canada Inc" }, { id: "5", name: "xxParent GmbH - Elimination" }, { id: "7", name: "Example Inc." }, { id: "-1", name: "Parent GmbH (Consolidated)" }]));
  const ttmRows = [
    { subsidiary_id: 1, subsidiary: "Parent GmbH", revenue: 10_700_000 },
    { subsidiary_id: 7, subsidiary: "Example Inc.", revenue: 10_000_000 },
    { subsidiary_id: 2, subsidiary: "Example Australia Pty Ltd", revenue: 6_100_000 },
    { subsidiary_id: 3, subsidiary: "Example Canada Inc", revenue: 3_000_000 },
    { subsidiary_id: 5, subsidiary: "xxParent GmbH - Elimination", revenue: -7_100_000 },
  ];

  it("TTM revenue is per subsidiary, never one mixed-currency total", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_getSubsidiaries"), tool_input: {}, tool_response: subs() }, ctx);
    const out = hso(handlePost(tagged("profile:ttm_revenue", { data: ttmRows }), ctx));
    assert.match(String(out.updatedMCPToolOutput), /Cached profile probe 'ttm_revenue' \(5 rows\)/);
    const p = setOverridesAndLoad(ctx.acctDir!, { base_currency: "EUR" });
    assert.deepEqual(p.ttmRevenueBySubsidiary?.map((x) => x.name), ["Parent GmbH", "Example Inc.", "Example Australia Pty Ltd", "Example Canada Inc"], "elimination excluded, largest first");
    assert.equal(p.ttmRevenue, undefined);
    const card = profileCard(p);
    assert.match(card, /\| TTM revenue by subsidiary \(each in its own base currency, not converted\) \| Parent GmbH EUR 10\.7M · Example Inc\. 10\.0M · Example Australia Pty Ltd 6\.1M · Example Canada Inc 3\.0M \|/, "the parent's figure takes the base currency set by the user");
    assert.doesNotMatch(card, /EUR 2\dM/, "no currency on a cross-subsidiary figure");
    // The parent is named by the "(Consolidated)" entry, so materiality comes from it, in the base currency.
    assert.match(card, /\| Materiality \| EUR 50K or 5% \(from the parent subsidiary, Parent GmbH; confirm\) \|/);
    // Without a consolidated entry, the parent is unknown: the largest, with a currency caveat.
    const noParent = tmpCtx();
    handlePost({ tool_name: T("ns_getSubsidiaries"), tool_input: {}, tool_response: text(JSON.stringify([{ id: "1", name: "Parent GmbH" }, { id: "7", name: "Example Inc." }])) }, noParent);
    handlePost(tagged("profile:ttm_revenue", { data: ttmRows }), noParent);
    assert.match(profileCard(loadProfile(noParent.acctDir!)!), /\| Materiality \| 50K or 5% \(from the largest subsidiary, Parent GmbH, in its currency; currencies may differ; confirm\) \|/);
    // Overrides still win, and a user-set amount is in the base currency.
    const o = setOverridesAndLoad(ctx.acctDir!, { materiality_amount: "40000" });
    assert.match(profileCard(o), /\| Materiality \| EUR 40K or 5% \|/);
  });

  it("the parent's currency applies when the largest subsidiary is the parent", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_getSubsidiaries"), tool_input: {}, tool_response: subs() }, ctx);
    handlePost(tagged("profile:base_currency", { items: [{ id: 1, currency: "EUR" }] }), ctx);
    handlePost(tagged("profile:ttm_revenue", { data: ttmRows }), ctx);
    const p = loadProfile(ctx.acctDir!)!;
    assert.match(profileCard(p), /\| Materiality \| EUR 50K or 5% \(from the parent subsidiary, Parent GmbH/);
    // Only the parent's figure carries a currency: the others' aren't known.
    assert.match(profileCard(p), /by subsidiary[^|]*\| Parent GmbH EUR 10\.7M · Example Inc\. 10\.0M · /);
  });

  it("single-subsidiary accounts get one figure in the base currency; older single-row payloads still read", () => {
    const one = tmpCtx();
    handlePost({ tool_name: T("ns_getSubsidiaries"), tool_input: {}, tool_response: text(JSON.stringify([{ id: "1", name: "Solo Inc" }])) }, one);
    handlePost(tagged("profile:base_currency", { items: [{ id: 1, currency: "USD" }] }), one);
    handlePost(tagged("profile:ttm_revenue", { data: [{ subsidiary_id: 1, subsidiary: "Solo Inc", revenue: 4_200_000 }] }), one);
    const card = profileCard(loadProfile(one.acctDir!)!);
    assert.match(card, /\| TTM revenue \| \$4\.2M \|/);
    assert.match(card, /\| Materiality \| \$25K or 5% \|/);
    // Old single-row probe on a OneWorld account: shown as a mixed sum, no currency, no materiality.
    const old = tmpCtx();
    handlePost({ tool_name: T("ns_getSubsidiaries"), tool_input: {}, tool_response: subs() }, old);
    // Cached by the older single-row probe (its SQL isn't today's canonical probe, so it's stored directly).
    storeSection(old.acctDir!, old.cfg, "probe/ttm_revenue", "ns_runCustomSuiteQL", JSON.stringify({ data: [{ revenue: 22_800_000 }] }), { header: ["revenue"], rows: [["22800000"]] });
    buildProfile(old.acctDir!);
    const p = setOverridesAndLoad(old.acctDir!, { base_currency: "EUR" });
    assert.equal(p.ttmRevenueMixed, true);
    assert.equal(p.materiality, undefined);
    assert.match(profileCard(p), /\| TTM revenue \| 22\.8M, a sum of several subsidiaries' base currencies \(not a real total\)/);
    // An older profile.json read as is (no rebuild): no currency on the sum or on its materiality.
    const legacy = profileCard({ builtAt: "", baseCurrency: "EUR", oneWorld: true, subsidiaryCount: 4, ttmRevenue: 22_800_000, materiality: { amount: 50_000, pct: 5 } });
    assert.doesNotMatch(legacy, /EUR 2\dM|EUR 50K/);
  });

  it("a tagged result whose columns don't match is not cached and leaves the section alone", () => {
    const ctx = tmpCtx();
    handlePost(tagged("periods", fixture("periods.json")), ctx);
    const before = fs.readFileSync(path.join(ctx.acctDir!, "manifest.json"), "utf8");
    const customers = { data: [{ id: 1328, companyname: "Jane Doe Travel", currency: "USD" }] };
    const out = hso(handlePost({ session_id: "s", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT id, companyname, currency FROM customer", description: "Accounting periods [su-ns-harness:periods]" }, tool_response: text(JSON.stringify(customers)) }, ctx));
    assert.match(String(out.additionalContext), /Tag \[su-ns-harness:periods\] ignored: .*expected id, periodname, startdate, enddate, closed, isyear, isquarter, isadjust/);
    assert.match(String(out.additionalContext), /Source: SuiteQL/, "the result goes through normal shaping");
    assert.equal(fs.readFileSync(path.join(ctx.acctDir!, "manifest.json"), "utf8"), before);
    assert.doesNotMatch(fs.readFileSync(path.join(ctx.acctDir!, "raw", "periods.json"), "utf8"), /Jane Doe/);
    // Right table, wrong columns; and an unknown probe name.
    const cols = hso(handlePost(tagged("periods", { data: [{ id: 1, periodname: "x" }] }), ctx));
    assert.match(String(cols.additionalContext), /ignored: columns don't match/);
    const unk = hso(handlePost({ ...tagged("periods", {}), tool_input: { sqlQuery: "SELECT id FROM customer", description: "[su-ns-harness:profile:customers]" }, tool_response: text(JSON.stringify(customers)) }, ctx));
    assert.match(String(unk.additionalContext), /ignored: not a query su-ns-harness runs/);
    assert.equal(loadManifest(ctx.acctDir!).sections["probe/customers"], undefined);
  });

  it("every probe in init's table passes its own check", async () => {
    const { TAG_SPECS, tagMismatch } = await import("../src/cache/catalog.ts");
    for (const [tag, spec] of Object.entries(TAG_SPECS)) {
      const row = Object.fromEntries(spec.required.map((c) => [c, "1"]));
      assert.equal(tagMismatch(tag, probeSql(tag), { data: [row] }), undefined, tag);
      // The SQL's own aliases must be exactly the spec's columns (required + optional).
      const select = /^SELECT\s+(.*?)\s+FROM\s/i.exec(probeSql(tag))![1];
      const aliases = select.split(/,(?![^(]*\))/).map((c) => (/\bAS\s+(\w+)\s*$/i.exec(c.trim())?.[1] ?? c.trim().split(".").pop()!).toLowerCase());
      assert.deepEqual(aliases.sort(), [...spec.required, ...(spec.optional ?? [])].filter((c) => aliases.includes(c)).sort(), tag);
      for (const c of spec.required) assert.ok(aliases.includes(c), `${tag}: ${c} not in the SQL`);
    }
  });

  it("a generic error on a call the guard flagged a column in is bad_field_likely", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_getSuiteQLMetadata"), tool_input: { recordType: "transactionline" }, tool_response: fixture("suiteql_metadata_transaction.json") }, ctx);
    const sql = "SELECT tl.amout FROM transactionline tl";
    const pre = hso(handlePre({ session_id: "h2", tool_use_id: "tu1", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: sql } }, ctx));
    assert.match(String(pre.additionalContext), /transactionline\.amout/);
    const generic = "Error executing SuiteQL query: An unexpected SuiteScript error has occurred";
    const fail = String(hso(handleFailure({ session_id: "h2", tool_use_id: "tu1", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: sql }, error: generic }, ctx)).additionalContext);
    assert.match(fail, /Error class: bad_field_likely\. The guard flagged transactionline\.amout \(not in the connector's metadata\) before this call; that's the likely cause.*nsx fields transactionline --grep amou/);
    // Cleaned up: the same id again is just unknown (with the generic-error hint).
    const again = String(hso(handleFailure({ session_id: "h2", tool_use_id: "tu1", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: sql }, error: generic }, ctx)).additionalContext);
    assert.match(again, /Error class: unknown\..*misspelled column/);
    // The isError path of PostToolUse does the same.
    handlePre({ session_id: "h2", tool_use_id: "tu2", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: sql } }, ctx);
    const post = hso(handlePost({ session_id: "h2", tool_use_id: "tu2", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: sql }, tool_response: text(JSON.stringify({ error: generic })) }, ctx));
    assert.match(String(post.additionalContext), /bad_field_likely/);
    // A successful call drops its entry too.
    handlePre({ session_id: "h2", tool_use_id: "tu3", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: sql } }, ctx);
    handlePost({ session_id: "h2", tool_use_id: "tu3", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: sql }, tool_response: text(JSON.stringify({ data: [{ amout: 1 }] })) }, ctx);
    const st = JSON.parse(fs.readFileSync(path.join(sessionDir(ctx.data, "h2"), "state.json"), "utf8"));
    assert.deepEqual(st.unknownCols, {});
  });

  it("the remembered columns are bounded in count and age", async () => {
    const { rememberUnknownCols, takeUnknownCols, UNKNOWN_COLS_MAX, UNKNOWN_COLS_MS } = await import("../src/session.ts");
    const st = { retries: {} } as Parameters<typeof rememberUnknownCols>[0];
    const t0 = 1_000_000_000;
    for (let i = 0; i < 30; i++) rememberUnknownCols(st, `t${i}`, ["a.b"], t0 + i);
    assert.equal(Object.keys(st.unknownCols!).length, UNKNOWN_COLS_MAX);
    assert.equal(st.unknownCols!.t0, undefined, "oldest dropped");
    rememberUnknownCols(st, "late", ["a.c"], t0 + UNKNOWN_COLS_MS + 100);
    assert.deepEqual(Object.keys(st.unknownCols!), ["late"], "entries past 30 min dropped");
    assert.equal(takeUnknownCols(st, "late", t0 + 2 * UNKNOWN_COLS_MS + 200), undefined, "an expired entry isn't used");
  });

  it("live error strings: syntax, hidden table, generic", () => {
    assert.equal(classifyError("Error executing SuiteQL query: Failed to parse SQL [SELECT id FROM transaction WHERE ROWNUM =(1,45) AND concurrency_limit_exceeded = 1]: syntax error, state:1108(10102) near: =(1,45)"), "bad_syntax");
    assert.equal(classifyError("Error executing SuiteQL query: Search error occurred: Record 'subsidiary' was not found."), "not_found");
    assert.equal(classifyError("Error executing SuiteQL query: An unexpected SuiteScript error has occurred"), "unknown");
  });

  it("heartbeats record the session; doctor says when several sessions fired", async () => {
    const { heartbeat } = await import("../src/session.ts");
    const { heartbeatLines, heartbeatSessions } = await import("../src/cli.ts");
    const ctx = tmpCtx();
    const now = Date.now();
    heartbeat(ctx.data, "headless-0000-9f3c", "session-start", new Date(now - 13 * 60_000));
    heartbeat(ctx.data, "desktop-1111-a1b2", "pre", new Date(now - 60_000));
    const hb = JSON.parse(fs.readFileSync(path.join(ctx.data, "heartbeat.json"), "utf8"));
    assert.deepEqual(heartbeatSessions(hb, now), ["desktop-1111-a1b2", "headless-0000-9f3c"]);
    const lines = heartbeatLines(hb, now, undefined).join("\n");
    assert.match(lines, /hook session-start: last fired 13m ago in session …9f3c/);
    assert.match(lines, /hook pre: last fired 1m ago in session …a1b2/);
    assert.match(lines, /Hooks fired in 2 sessions .*nsx can't tell which one is this session/);
    assert.match(heartbeatLines(hb, now, "desktop-1111-a1b2").join("\n"), /pre: .*…a1b2 \(this session\)[\s\S]*This session is …a1b2/);
    // One session only: no ambiguity note. Old heartbeat files ({at, session}) still read.
    assert.doesNotMatch(heartbeatLines({ pre: { at: new Date(now).toISOString(), session: "x-1234" } }, now, undefined).join("\n"), /sessions/);
  });

  it("preflight without a data dir says it's normal and what to do after an install", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nsx-nodata-"));
    const r = (await import("node:child_process")).spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", path.join(import.meta.dirname, "..", "src", "cli.ts"), "doctor", "--preflight"], {
      env: { ...process.env, NSX_DATA_DIR: "", CLAUDE_PLUGIN_DATA: "", CLAUDE_CONFIG_DIR: dir },
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /data dir none yet: normal before the first NetSuite call in a session where the plugin's hooks are loaded.*\/reload-plugins or start a new session/);
  });

  it("every skill and agent this plugin ships has a working last-resort path to nsx", () => {
    for (const f of ["skills/init/SKILL.md", "skills/refresh/SKILL.md", "skills/doctor/SKILL.md", "agents/ns-explorer.md"]) {
      const md = fs.readFileSync(path.join(import.meta.dirname, "..", f), "utf8");
      assert.ok(md.includes('`ls -dt "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/su-ns-harness/*/scripts/nsx.mjs | head -1`'), f);
    }
  });

  it("quoted SQL that isn't a SELECT is linted, not taken for a file name", async () => {
    tmpCtx();
    assert.match(await nsx("sql", "lint", "DELETE FROM customer WHERE id = 1"), /not-select/);
    assert.match(await nsx("sql", "lint", "UPDATE customer SET x = 1"), /not-select/);
    assert.doesNotMatch(await nsx("sql", "lint", "(SELECT 1 FROM dual)"), /No such file/);
    process.exitCode = 0;
    await assert.rejects(async () => nsx("sql", "lint", "missing.sql"), /No such file: missing\.sql/);
  });

  it("reports search: full params column and a 'showing N' note", async () => {
    const ctx = tmpCtx();
    const reports = Array.from({ length: 12 }, (_, i) => ({ id: 100 + i, title: `Income Statement ${i}`, as_of_format: false, has_subsidiary_filter: true, supports_consolidation: true, supports_book: true, supports_range: true, supports_accounting_context: true, supports_nexus: true }));
    handlePost({ tool_name: T("ns_listAllReports"), tool_input: {}, tool_response: text(JSON.stringify(reports)) }, ctx);
    const out = await nsx("reports", "search", "income", "--max", "10");
    assert.match(out.split("\n")[0], /^12 of 12 reports match "income" .*\(showing 10; --max N for more\)/);
    assert.match(out, /from\+to · sub\(consol\) · book · range · acct-ctx · nexus/);
    assert.doesNotMatch(out, /…/);
    assert.doesNotMatch(await nsx("reports", "search", "income"), /showing/);
  });
});

describe("canonical probes, saved-search errors, base currency and SuiteQL guards", () => {
  const nsx = async (...argv: string[]) => String((await import("../src/cli.ts")).main(argv));
  const periodRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: String(i + 1), periodname: `P${i + 1}`, startdate: `2026-${(i % 12) + 1}-1`, enddate: `2026-${(i % 12) + 1}-28`, closed: "F", isyear: "F", isquarter: "F", isadjust: "F" }));
  const suiteql = (sqlQuery: string, description: string, body: unknown) => ({ session_id: "r4", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery, description }, tool_response: text(JSON.stringify(body)) });
  const cacheRecordTypes = (ctx: ReturnType<typeof tmpCtx>, names: string[]) =>
    handlePost({ tool_name: T("ns_getSuiteQLMetadata"), tool_input: {}, tool_response: text(JSON.stringify({ success: true, metadata: { items: names.map((n) => ({ name: n, title: n })) } })) }, ctx);

  it("init's probe table and the code's canonical SQL are the same", async () => {
    const { PROBES } = await import("../src/cache/probes.ts");
    const md = fs.readFileSync(path.join(import.meta.dirname, "..", "skills", "init", "SKILL.md"), "utf8");
    const table = [...md.matchAll(/^\| `([^`]*\[su-ns-harness:([^\]]+)\])` \| `([^`]+)` \|$/gm)].map((m) => ({ tag: m[2], description: m[1], sql: m[3] }));
    assert.deepEqual(table, PROBES.map((p) => ({ tag: p.tag, description: p.description, sql: p.sql })));
    for (const p of PROBES) assert.deepEqual(lintSuiteQL(p.sql).errors, [], p.tag);
  });

  it("only the canonical SQL fills a tagged section; spacing, case and a trailing ; don't matter", async () => {
    const { isCanonicalProbe } = await import("../src/cache/probes.ts");
    const sql = probeSql("periods");
    assert.ok(isCanonicalProbe("periods", `  ${sql.replace(/\b(SELECT|FROM|ORDER BY|AS|TO_CHAR)\b/g, (m) => m.toLowerCase()).replace(/ /g, "\n  ")} ;`));
    assert.ok(!isCanonicalProbe("periods", sql.replace("ORDER BY", "WHERE id < 0 ORDER BY")));
    assert.ok(!isCanonicalProbe("periods", sql.replace("'YYYY-MM-DD'", "'yyyy-mm-dd'")), "string literals compare exactly");
    const ctx = tmpCtx();
    handlePost(tagged("periods", { data: periodRows(319) }), ctx);
    const before = fs.readFileSync(path.join(ctx.acctDir!, "idx", "periods.tsv"), "utf8");
    // Seen live: neither of these may replace the cache.
    for (const where of ["WHERE id < 0", "WHERE closed = 'T' AND startdate >= TO_DATE('2026-01-01','YYYY-MM-DD')"]) {
      const out = hso(handlePost(suiteql(sql.replace("ORDER BY", `${where} ORDER BY`), "Accounting periods [su-ns-harness:periods]", { data: periodRows(where.includes("id < 0") ? 0 : 10) }), ctx));
      assert.match(String(out.additionalContext), /Tag \[su-ns-harness:periods\] ignored: not the init query/);
    }
    // Aliased columns from another table.
    const alias = hso(handlePost(suiteql("SELECT a.id, a.acctname AS periodname FROM account a JOIN accountingperiod ap ON ap.id = a.id", "[su-ns-harness:periods]", { data: [{ id: 1, periodname: "x" }] }), ctx));
    assert.match(String(alias.additionalContext), /ignored: not the init query/);
    // The canonical query with an empty result.
    const empty = hso(handlePost(tagged("periods", { data: [] }), ctx));
    assert.match(String(empty.additionalContext), /ignored: the result is empty/);
    assert.equal(fs.readFileSync(path.join(ctx.acctDir!, "idx", "periods.tsv"), "utf8"), before);
    assert.equal(loadManifest(ctx.acctDir!).sections.periods.count, 319);
  });

  it("a periods refresh that shrinks by more than half is refused until the section is invalidated", async () => {
    const ctx = tmpCtx();
    handlePost(tagged("periods", { data: periodRows(319) }), ctx);
    const out = hso(handlePost(tagged("periods", { data: periodRows(10) }), ctx));
    assert.match(String(out.additionalContext), /periods 319 → 10: not replaced, the cached copy was kept\. If that's intended, run `nsx cache invalidate periods` and the call again \(or run the su-ns-harness:refresh skill \(sections: periods\)/);
    assert.equal(out.updatedMCPToolOutput, undefined, "shown as an ordinary result");
    assert.equal(loadManifest(ctx.acctDir!).sections.periods.count, 319);
    assert.match(String(hso(handlePost(tagged("periods", { data: periodRows(200) }), ctx)).updatedMCPToolOutput), /Cached 200 accounting periods/, "a smaller shrink is fine");
    await nsx("cache", "invalidate", "periods");
    assert.match(String(hso(handlePost(tagged("periods", { data: periodRows(10) }), ctx)).updatedMCPToolOutput), /Cached 10 accounting periods/);
  });

  it("only the canonical tagged SQL skips paging injection", () => {
    const ctx = tmpCtx();
    const canon = hso(handlePre({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: probeSql("periods"), description: "Accounting periods [su-ns-harness:periods]" } }, ctx));
    assert.equal(canon.updatedInput, undefined);
    const other = hso(handlePre({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT a.id, a.acctname FROM account a", description: "[su-ns-harness:periods]" } }, ctx));
    assert.deepEqual([(other.updatedInput as Record<string, unknown>).pageSize, (other.updatedInput as Record<string, unknown>).pageIndex], [500, 0]);
  });

  it("saved-search errors in a successful string result are errors, classified, and audited", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_listSavedSearches"), tool_input: {}, tool_response: text(JSON.stringify([{ id: "customsearch42", title: "Example notes", recordtype: "System Note", public: true }, { id: "customsearch43", title: "Example tasks", recordtype: "Task", public: true }])) }, ctx);
    const run = (searchId: string, msg: string) => hso(handlePost({ session_id: "ss", tool_name: T("ns_runSavedSearch"), tool_input: { searchId, range_start: 0, range_end: 100 }, tool_response: text(JSON.stringify(msg)) }, ctx));
    const perm = run("customsearch_example", `Error loading saved search with params {"searchId":"customsearch_example"}. Error: Permission Violation: You need  the 'Lists -> Subsidiaries' permission to access this page.`);
    assert.match(String(perm.additionalContext), /Error class: permission\..*Do not retry/);
    assert.doesNotMatch(String(perm.additionalContext), /Source:/);
    const type = run("customsearch42", `Error loading saved search with params {"searchId":"customsearch42"}. Error: Unable to determine record type for saved search id 42`);
    assert.match(String(type.additionalContext), /Error class: bad_record_type\. .*'System Note' search .*Call again with type: "SystemNote"/);
    const other = run("customsearch43", `Error loading saved search with params {}. Error: Unable to determine record type for saved search id 43`);
    assert.match(String(other.additionalContext), /'Task' search: if ns_runSavedSearch's `type` parameter accepts it, call again with type: "Task"/);
    const audit = readAudit(ctx.acctDir!, {}).filter((e) => e.tool === "ns_runSavedSearch");
    assert.deepEqual(audit.map((e) => `${e.outcome}:${e.errorClass}`), ["error:permission", "error:bad_record_type", "error:bad_record_type"]);
    // A successful string result that isn't an error is left alone.
    const ok = hso(handlePost({ tool_name: T("ns_runSavedSearch"), tool_input: { searchId: "customsearch43" }, tool_response: text(JSON.stringify("No results")) }, ctx));
    assert.doesNotMatch(String(ok.additionalContext), /Error class/);
  });

  it("an inline saved-search result with 12-hour, unpadded dates says how to read them", () => {
    const ctx = tmpCtx();
    const rows = [{ Date: "2026-5-13", Field: "Memo" }, { Date: "2026-5-3 1:11 pm", Field: "Status" }];
    const out = hso(handlePost({ tool_name: T("ns_runSavedSearch"), tool_input: { searchId: "customsearch900", type: "SystemNote" }, tool_response: text(JSON.stringify({ success: true, data: rows })) }, ctx));
    assert.match(String(out.additionalContext), /Dates are 12-hour, unpadded \(2026-5-3 1:11 pm = 2026-05-03 13:11\)/);
    assert.equal(out.updatedMCPToolOutput, undefined, "the inline payload itself is unchanged");
    // Padded dates, or a SuiteQL result, get no note.
    const padded = hso(handlePost({ tool_name: T("ns_runSavedSearch"), tool_input: { searchId: "customsearch900", type: "SystemNote" }, tool_response: text(JSON.stringify({ success: true, data: [{ Date: "2026-05-03 13:11" }] })) }, ctx));
    assert.doesNotMatch(String(padded.additionalContext ?? ""), /Dates are/);
    const sql = hso(handlePost({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT 1 FROM dual" }, tool_response: text(JSON.stringify({ success: true, data: rows })) }, ctx));
    assert.doesNotMatch(String(sql.additionalContext ?? ""), /Dates are/);
  });

  it("a cached System Note search gets type: \"SystemNote\" before the call", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_listSavedSearches"), tool_input: {}, tool_response: text(JSON.stringify([{ id: "customsearch42", title: "Example notes", recordtype: "System Note", public: true }])) }, ctx);
    const out = hso(handlePre({ tool_name: T("ns_runSavedSearch"), tool_input: { searchId: "customsearch42", range_start: 0, range_end: 50 } }, ctx));
    assert.deepEqual(out.updatedInput, { searchId: "customsearch42", range_start: 0, range_end: 50, type: "SystemNote" });
    assert.match(String(out.additionalContext), /type: "SystemNote" added/);
    const given = hso(handlePre({ tool_name: T("ns_runSavedSearch"), tool_input: { searchId: "customsearch42", type: "SystemNote", range_end: 50 } }, ctx));
    assert.equal(given.updatedInput, undefined);
  });

  it("ns_getRecord fields are normalised before the call; missing ones are named after it", () => {
    const ctx = tmpCtx();
    const pre = (fields: unknown) => (hso(handlePre({ tool_name: T("ns_getRecord"), tool_input: { recordType: "invoice", recordId: "1", fields } }, ctx)).updatedInput as Record<string, unknown> | undefined)?.fields;
    assert.equal(pre("tranid, trandate, total , ,currency"), "tranid,trandate,total,currency");
    assert.equal(pre(["tranid", " total"]), "tranid,total");
    assert.equal(pre("tranid,total"), undefined, "already clean: untouched");
    const post = hso(handlePost({ tool_name: T("ns_getRecord"), tool_input: { recordType: "invoice", recordId: "1", fields: "tranid,trandate,total" }, tool_response: text(JSON.stringify({ data: { tranId: "INV-1" } })) }, ctx));
    assert.match(String(post.additionalContext), /Requested but not in the record: trandate, total\./);
    const full = hso(handlePost({ tool_name: T("ns_getRecord"), tool_input: { recordType: "invoice", recordId: "1", fields: "tranid,total" }, tool_response: text(JSON.stringify({ data: { tranId: "INV-1", total: 1 } })) }, ctx));
    assert.doesNotMatch(String(full.additionalContext), /Requested but not/);
  });

  it("base currency from rate-1 transactions, currency-labelled subsidiaries, consolidated revenue from the report", async () => {
    const ctx = tmpCtx({ inline_max_chars: "2000" });
    handlePost({ tool_name: T("ns_getSubsidiaries"), tool_input: {}, tool_response: text(JSON.stringify([{ id: "1", name: "Parent GmbH" }, { id: "2", name: "Example Australia Pty Ltd" }, { id: "7", name: "Example Inc." }, { id: "5", name: "xxParent GmbH - Elimination" }, { id: "-1", name: "Parent GmbH (Consolidated)" }])) }, ctx);
    cacheRecordTypes(ctx, ["transaction", "transactionline", "transactionaccountingline", "account", "accountingperiod"]);
    const fx = [
      { sub: 1, currency: "EUR", n: 5517 }, { sub: 1, currency: "USD", n: 6 },
      { sub: 2, currency: "AUD", n: 3852 }, { sub: 7, currency: "USD", n: 9643 }, { sub: 7, currency: "EUR", n: 10 },
    ];
    assert.match(String(hso(handlePost(tagged("profile:base_currency_fx", { data: fx }), ctx)).updatedMCPToolOutput), /Cached profile probe 'base_currency_fx' \(5 rows\)/);
    handlePost(tagged("profile:ttm_revenue", { data: [{ subsidiary_id: 7, subsidiary: "Example Inc.", revenue: 11_000_000 }, { subsidiary_id: 1, subsidiary: "Parent GmbH", revenue: 10_700_000 }, { subsidiary_id: 2, subsidiary: "Example Australia Pty Ltd", revenue: 6_100_000 }] }), ctx);
    let card = profileCard(loadProfile(ctx.acctDir!)!);
    assert.match(card, /\| Base currency \| EUR \(from transactions at rate 1; confirm\) \|/);
    assert.match(card, /Example Inc\. USD 11\.0M · Parent GmbH EUR 10\.7M · Example Australia Pty Ltd AUD 6\.1M/);
    assert.match(card, /\| Materiality \| EUR 50K or 5% \(from the parent subsidiary, Parent GmbH; confirm\) \|/, "the parent, not the largest raw number");
    // The consolidated Income Statement: ttm-report prints its input, from-report stores Sales.
    handlePost({ tool_name: T("ns_listAllReports"), tool_input: {}, tool_response: fixture("reports_list.json") }, ctx);
    // The fixture lists two non-consolidated "Income Statement" reports first; the consolidated one wins.
    assert.match(await nsx("profile", "ttm-report"), /\{"reportId":-200,"subsidiaryId":-1,"dateFrom":"\d{4}-\d\d-\d\d","dateTo":"\d{4}-\d\d-\d\d"\}/);
    const input = { reportId: -200, subsidiaryId: -1, dateFrom: "2025-09-27", dateTo: "2026-09-27" };
    const rep = hso(handlePost({ session_id: "r4", tool_name: T("ns_runReport"), tool_input: input, tool_response: fixture("report_income_statement.json") }, ctx));
    const id = /\b(r_[0-9a-f]{6})\b/.exec(String(rep.updatedMCPToolOutput))![1];
    const out = await nsx("profile", "from-report", id);
    assert.match(out, /Stored consolidated TTM revenue 747,900\.5 \(r_[0-9a-f]{6}: Sales 2025-09-27 to 2026-09-27\)/);
    card = profileCard(loadProfile(ctx.acctDir!)!);
    assert.match(card, /\| TTM revenue \(consolidated\) \| EUR 748K \|/);
    assert.match(card, /\| TTM revenue by subsidiary \(each in its own base currency, not converted\) \| Example Inc\. USD 11\.0M/, "kept as detail");
    assert.match(card, /\| Materiality \| EUR 5K or 5% \(from consolidated TTM revenue\) \|/);
    // Kept across rebuilds; a user-set figure works the same way.
    assert.match(profileCard(buildProfile(ctx.acctDir!)), /TTM revenue \(consolidated\) \| EUR 748K/);
    assert.match(profileCard(setOverridesAndLoad(ctx.acctDir!, { ttm_revenue_consolidated: "17700000" })), /\| TTM revenue \(consolidated\) \| EUR 17\.7M \|[\s\S]*\| Materiality \| EUR 50K or 5% \(from consolidated TTM revenue\)/);
    // A single-subsidiary report run isn't consolidated.
    const sub1 = hso(handlePost({ session_id: "r4", tool_name: T("ns_runReport"), tool_input: { ...input, subsidiaryId: 1 }, tool_response: fixture("report_income_statement.json") }, ctx));
    const id1 = /\b(r_[0-9a-f]{6})\b/.exec(String(sub1.updatedMCPToolOutput))![1];
    await assert.rejects(async () => nsx("profile", "from-report", id1), /is for subsidiary 1, not consolidated/);
  });

  it("[nolint] doesn't let OFFSET through", () => {
    const ctx = tmpCtx();
    const out = hso(handlePre({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT t.id FROM transaction t ORDER BY t.id OFFSET 5 ROWS FETCH NEXT 5 ROWS ONLY", description: "[nolint]" } }, ctx));
    assert.equal(out.permissionDecision, "deny");
    assert.match(String(out.permissionDecisionReason), /offset-ignored[\s\S]*\[nolint\] doesn't apply to this rule/);
  });

  it("lint: + on two string columns (typed by cached metadata) is denied", () => {
    const ctx = tmpCtx();
    cacheRecordTypes(ctx, ["account"]);
    handlePost({ tool_name: T("ns_getSuiteQLMetadata"), tool_input: { recordType: "account" }, tool_response: text(JSON.stringify({ success: true, metadata: { type: "object", properties: { id: { type: "integer", title: "Internal ID" }, acctNumber: { type: "string", title: "Number" }, acctName: { type: "string", title: "Name" } } } })) }, ctx);
    const out = hso(handlePre({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT a.acctnumber + a.acctname FROM account a" } }, ctx));
    assert.equal(out.permissionDecision, "deny");
    assert.match(String(out.permissionDecisionReason), /string-plus-concat/);
  });

  it("the Cache CLI line is there before the first NetSuite call", () => {
    const ctx = tmpCtx({ account_id: "" });
    assert.match(String(handleSessionStart({ source: "startup" }, ctx)?.text), /no NetSuite call seen yet[\s\S]*Cache CLI \(not on PATH — always run it exactly like this\): node "/);
  });

  it("a table missing from the record-type list is denied before the call; [nolint] overrides", () => {
    const ctx = tmpCtx();
    cacheRecordTypes(ctx, ["transaction", "account"]);
    const out = hso(handlePre({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT s.id, s.name FROM subsidiary s" } }, ctx));
    assert.equal(out.permissionDecision, "deny");
    assert.match(String(out.permissionDecisionReason), /'subsidiary' isn't in this account's SuiteQL record-type list, so it isn't exposed to the connector role .*Don't retry/);
    // Not tables: EXTRACT(… FROM col), dual, string literals, subqueries.
    const fine = hso(handlePre({ session_id: "x", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT EXTRACT(YEAR FROM t.trandate) AS y, 'from subsidiary' AS s FROM (SELECT t.trandate FROM transaction t) t" } }, ctx));
    assert.doesNotMatch(String(fine.permissionDecisionReason), /record-type list/);
    assert.notEqual(hso(handlePre({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT 1 FROM dual" } }, ctx)).permissionDecision, "deny");
    assert.notEqual(hso(handlePre({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT s.id FROM subsidiary s", description: "[nolint]" } }, ctx)).permissionDecision, "deny");
  });

  it("tablesInSql reads comma joins and every subquery, not function arguments", async () => {
    const { tablesInSql } = await import("../src/errors.ts");
    assert.deepEqual(tablesInSql("SELECT t.id FROM transaction t, transactionline tl WHERE tl.transaction = t.id AND EXISTS (SELECT 1 FROM account a WHERE a.id = tl.account)").sort(), ["account", "transaction", "transactionline"]);
    assert.deepEqual(tablesInSql("SELECT TRIM(BOTH ' ' FROM t.memo) FROM transaction t LEFT JOIN customer c ON c.id = t.entity"), ["transaction", "customer"]);
  });

  it("pageSize below 5 is raised to 5 with a note", () => {
    const ctx = tmpCtx();
    const out = hso(handlePre({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT t.id FROM transaction t ORDER BY t.id", pageSize: 3 } }, ctx));
    assert.deepEqual([(out.updatedInput as Record<string, unknown>).pageSize, (out.updatedInput as Record<string, unknown>).pageIndex], [5, 0]);
    assert.match(String(out.additionalContext), /the connector's minimum page size is 5/);
    assert.equal(hso(handlePre({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT t.id FROM transaction t ORDER BY t.id", pageSize: 50, pageIndex: 1 } }, ctx)).updatedInput, undefined);
  });

  it("syntax advice quotes NetSuite's position and explains 'Invalid or unsupported search'", () => {
    const ctx = tmpCtx();
    const sql = "SELECT id FROM transaction WHERE ROWNUM =(1,45) AND x = 1";
    const f = String(hso(handleFailure({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: sql }, error: `Error executing SuiteQL query: Failed to parse SQL [${sql}]: syntax error, state:1224(10102) near: =(1,45, token code:0)` }, ctx)).additionalContext);
    assert.match(f, /Error class: bad_syntax\. SuiteQL syntax error\. NetSuite points near column 45 \("="\): …/);
    const u = String(hso(handleFailure({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT tl.subsidiary, COUNT(*) AS n FROM transactionline tl GROUP BY tl.subsidiary ORDER BY n DESC" }, error: "Error executing SuiteQL query: Invalid or unsupported search" }, ctx)).additionalContext);
    assert.match(u, /bad_syntax\. .*ORDER BY on a column alias or a non-grouped expression with GROUP BY: order by the full expression \(e\.g\. COUNT\(\*\) DESC\) or drop ORDER BY/);
  });

  it("doctor warns when su-ns-harness data dirs are split", async () => {
    const { splitDataDirNote } = await import("../src/cli.ts");
    const { markedDataDirs } = await import("../src/config.ts");
    tmpCtx();
    const base = path.join(process.env.CLAUDE_CONFIG_DIR!, "plugins", "data");
    for (const n of ["su-ns-harness-inline", "su-ns-harness-suiteutils", "other-plugin"]) {
      fs.mkdirSync(path.join(base, n), { recursive: true });
      if (n.startsWith("su-ns")) fs.writeFileSync(path.join(base, n, ".su-ns-harness"), "0.0.0");
    }
    const dirs = markedDataDirs();
    assert.deepEqual(dirs.map((d) => path.basename(d)), ["su-ns-harness-inline", "su-ns-harness-suiteutils"]);
    const note = splitDataDirNote(dirs[0], dirs)!;
    assert.match(note, /⚠ 2 su-ns-harness data dirs: .*su-ns-harness-inline \(in use\), .*su-ns-harness-suiteutils\. The cache is split/);
    assert.equal(splitDataDirNote(dirs[0], [dirs[0]]), undefined);
  });
});

describe("data dir choice, saved-search types and the TTM window", () => {
  const T = (n: string) => `mcp__netsuite__${n}`;
  const cacheRecordTypes = (ctx: ReturnType<typeof tmpCtx>, names: string[]) =>
    handlePost({ tool_name: T("ns_getSuiteQLMetadata"), tool_input: {}, tool_response: text(JSON.stringify({ success: true, metadata: { items: names.map((n) => ({ name: n, title: n })) } })) }, ctx);
  const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");

  /** A plugins/data tree with an unmarked dir, a populated dir and an empty sibling with a newer marker. */
  function splitHome() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nsx-split-"));
    const base = path.join(home, "plugins", "data");
    const mk = (name: string, opts: { cache?: boolean; firedAgoMs?: number; markerAgoMs: number }) => {
      const dir = path.join(base, name);
      fs.mkdirSync(dir, { recursive: true });
      const marker = path.join(dir, ".su-ns-harness");
      fs.writeFileSync(marker, "0.0.0");
      const t = new Date(Date.now() - opts.markerAgoMs);
      fs.utimesSync(marker, t, t);
      if (opts.cache) {
        fs.mkdirSync(path.join(dir, "accounts", "conn-x"), { recursive: true });
        fs.writeFileSync(path.join(dir, "accounts", "conn-x", "manifest.json"), JSON.stringify({ account: "conn-x", createdAt: "", sections: {} }));
      }
      if (opts.firedAgoMs !== undefined) heartbeat(dir, "sess-1234", "post", new Date(Date.now() - opts.firedAgoMs));
      return dir;
    };
    return { home, base, mk };
  }

  function withAutoDir<T>(home: string, fn: () => T): T {
    const saved = { d: process.env.NSX_DATA_DIR, h: process.env.CLAUDE_CONFIG_DIR, pd: process.env.CLAUDE_PLUGIN_DATA };
    delete process.env.NSX_DATA_DIR;
    delete process.env.CLAUDE_PLUGIN_DATA;
    process.env.CLAUDE_CONFIG_DIR = home;
    try {
      return fn();
    } finally {
      for (const [k, v] of [["NSX_DATA_DIR", saved.d], ["CLAUDE_CONFIG_DIR", saved.h], ["CLAUDE_PLUGIN_DATA", saved.pd]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("an empty sibling dir with a newer marker doesn't take the CLI away from the used cache", async () => {
    const { dataDir, dataDirNotice, pickDataDir } = await import("../src/config.ts");
    const h = splitHome();
    const inline = h.mk("su-ns-harness-inline", { cache: true, firedAgoMs: 60_000, markerAgoMs: 86_400_000 });
    const scratch = h.mk("su-ns-harness-zzscratch", { markerAgoMs: 0 });
    fs.mkdirSync(path.join(h.base, "other-plugin"));
    withAutoDir(h.home, () => {
      assert.equal(dataDir(), inline);
      assert.match(dataDirNotice()!, /^nsx: using su-ns-harness-inline \(hooks last fired 1m ago\); su-ns-harness-zzscratch also exists\. Set NSX_DATA_DIR/);
    });
    // Both have a cache: the one whose hooks fired last wins, whatever the markers say.
    const other = h.mk("su-ns-harness-other", { cache: true, firedAgoMs: 5_000, markerAgoMs: 0 });
    assert.equal(pickDataDir([inline, scratch, other])!.dir, other);
    heartbeat(inline, "sess-9999", "pre");
    assert.equal(pickDataDir([inline, scratch, other])!.dir, inline);
    // No cache and no heartbeat anywhere: the newest marker, as before.
    const a = h.mk("su-ns-harness-a", { markerAgoMs: 10_000 });
    const b = h.mk("su-ns-harness-b", { markerAgoMs: 0 });
    assert.equal(pickDataDir([a, b])!.dir, b);
    // One dir, or an explicit one: nothing to say.
    const solo = splitHome();
    solo.mk("su-ns-harness-inline", { cache: true, markerAgoMs: 0 });
    withAutoDir(solo.home, () => assert.equal(dataDirNotice(), undefined));
    tmpCtx();
    assert.equal(dataDirNotice(), undefined, "NSX_DATA_DIR set");
  });

  it("CLI commands print the choice on stderr; hooks stay silent; doctor explains it", async () => {
    const { spawnSync } = await import("node:child_process");
    const h = splitHome();
    h.mk("su-ns-harness-inline", { cache: true, firedAgoMs: 60_000, markerAgoMs: 86_400_000 });
    h.mk("su-ns-harness-zzscratch", { markerAgoMs: 0 });
    // The CLI runs from this checkout, whose marketplace.json makes its data dir su-ns-harness-suiteutils.
    h.mk("su-ns-harness-suiteutils", { firedAgoMs: 60_000, markerAgoMs: 0 });
    const env = { ...process.env, NSX_DATA_DIR: "", CLAUDE_PLUGIN_DATA: "", CLAUDE_PLUGIN_ROOT: "", CLAUDE_CONFIG_DIR: h.home, CLAUDE_PLUGIN_OPTION_ACCOUNT_ID: "1", CLAUDE_CODE_SESSION_ID: "m4-sess-a" };
    // (the chosen dir exists, so the once-per-session flag lives in this temp home: fresh on every run)
    const run = (args: string[], input = "", extra: Record<string, string> = {}) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], { env: { ...env, ...extra }, input, encoding: "utf8" });
    const status = run(["cache", "status"]);
    assert.match(status.stderr, /^nsx: using su-ns-harness-suiteutils \(this install's data dir, hooks last fired 1m ago, no cache yet\); su-ns-harness-inline, su-ns-harness-zzscratch are other installs' caches and are ignored\./);
    assert.equal(status.stderr.trim().split("\n").length, 1, "one line");
    // Once per session, not on every command; a new session sees it again.
    assert.equal(run(["cache", "status"]).stderr, "");
    assert.match(run(["cache", "status"], "", { CLAUDE_CODE_SESSION_ID: "m4-sess-b" }).stderr, /^nsx: using su-ns-harness-suiteutils/);
    const hook = run(["hook", "post"], JSON.stringify({ session_id: "s", tool_name: T("ns_listAllReports"), tool_input: {}, tool_response: "[]" }));
    assert.equal(hook.stderr, "");
    const doc = run(["doctor"]);
    assert.equal(doc.stderr, "");
    assert.match(doc.stdout, /data dir .*su-ns-harness-suiteutils \(this install's\); su-ns-harness-inline, su-ns-harness-zzscratch are other installs' caches and are ignored\n/);
    assert.doesNotMatch(doc.stdout, /The cache is split/);
  });

  it("a cached Saved Search search gets type: \"SavedSearch\" before the call", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_listSavedSearches"), tool_input: {}, tool_response: text(JSON.stringify([{ id: "customsearch_example_list", title: "Searches", recordtype: "Saved Search", public: true }])) }, ctx);
    const out = hso(handlePre({ tool_name: T("ns_runSavedSearch"), tool_input: { searchId: "customsearch_example_list", range_start: 0, range_end: 50 } }, ctx));
    assert.deepEqual(out.updatedInput, { searchId: "customsearch_example_list", range_start: 0, range_end: 50, type: "SavedSearch" });
  });

  it("[nolint] overrides the hidden-table deny but not the first-use metadata gate", () => {
    const ctx = tmpCtx();
    cacheRecordTypes(ctx, ["customer", "transaction"]);
    const call = { session_id: "nl", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT c.id, c.companyname FROM customer c", description: "[nolint]" } };
    const first = hso(handlePre(call, ctx));
    assert.equal(first.permissionDecision, "deny");
    assert.match(String(first.permissionDecisionReason), /Field metadata for 'customer' isn't cached yet/);
    assert.notEqual(hso(handlePre(call, ctx)).permissionDecision, "deny", "asked once per table per session");
    // A hidden table with [nolint] runs, and isn't gated (there's no metadata to fetch for it).
    assert.notEqual(hso(handlePre({ session_id: "nl2", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT s.id FROM subsidiary s", description: "[nolint]" } }, ctx)).permissionDecision, "deny");
  });

  it("getRecord's missing-field note tells misspelled names from empty fields when record metadata is cached", () => {
    const ctx = tmpCtx();
    const call = { tool_name: T("ns_getRecord"), tool_input: { recordType: "invoice", recordId: "1", fields: "tranid,memo,nosuchfield" }, tool_response: text(JSON.stringify({ data: { tranId: "INV-1" } })) };
    assert.match(String(hso(handlePost(call, ctx)).additionalContext), /Requested but not in the record: memo, nosuchfield\. NetSuite leaves out empty fields.*nsx fields invoice --record/);
    const header = ["field", "type", "label", "nullable", "joinTarget"];
    storeSection(ctx.acctDir!, ctx.cfg, "recordmeta/invoice", "ns_getRecordTypeMetadata", "{}", { header, rows: [["tranid", "string", "Number", "", ""], ["memo", "string", "Memo", "", ""]] });
    const note = String(hso(handlePost(call, ctx)).additionalContext);
    assert.match(note, /nosuchfield: not a field of invoice \(check the name: nsx fields invoice --record/);
    assert.match(note, /memo: a field of invoice, empty on this record/);
  });

  it("the TTM window is the last 12 complete periods, or 12 months to today", async () => {
    const { ttmWindow } = await import("../src/cli.ts");
    const ctx = tmpCtx();
    const now = new Date(Date.UTC(2026, 8, 27));
    assert.deepEqual(ttmWindow(ctx.acctDir!, now).from + ".." + ttmWindow(ctx.acctDir!, now).to, "2025-09-28..2026-09-27");
    const header = ["id", "periodname", "startdate", "enddate", "closed", "isyear", "isquarter", "isadjust"];
    const rows: string[][] = [];
    const pad = (n: number) => String(n).padStart(2, "0");
    for (let y = 2025; y <= 2027; y++) {
      rows.push([`y${y}`, `FY ${y}`, `${y}-01-01`, `${y}-12-31`, y < 2026 ? "T" : "F", "T", "F", "F"]);
      rows.push([`q${y}`, `Q3 ${y}`, `${y}-07-01`, `${y}-09-30`, "F", "F", "T", "F"]);
      for (let m = 1; m <= 12; m++) {
        const end = new Date(Date.UTC(y, m, 0)).getUTCDate();
        // Closed through Jul 2026; Aug 2026 ended but isn't closed yet; Sep 2026 is the open month.
        rows.push([`${y}${m}`, `${y}-${m}`, `${y}-${pad(m)}-01`, `${y}-${pad(m)}-${end}`, y < 2026 || (y === 2026 && m <= 7) ? "T" : "F", "F", "F", "F"]);
      }
    }
    rows.push(["adj", "Adjust 2026", "2026-09-01", "2026-09-30", "T", "F", "F", "T"]);
    storeSection(ctx.acctDir!, ctx.cfg, "periods", "ns_runCustomSuiteQL", "{}", { header, rows });
    const w = ttmWindow(ctx.acctDir!, now);
    assert.deepEqual([w.from, w.to], ["2025-09-01", "2026-08-31"]);
    assert.match(w.label, /last 12 complete periods, Sep 2025 – Aug 2026/);
  });
});

describe("result sorting, flag checks, documented examples and diffs", () => {
  const T = (n: string) => `mcp__netsuite__${n}`;
  const nsx = async (...argv: string[]) => String((await import("../src/cli.ts")).main(argv));
  const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
  const ROOT = path.join(import.meta.dirname, "..");
  /** A saved (large) result like customsearch_example_list: loose datetimes, some blank. */
  function runsResult() {
    const ctx = tmpCtx();
    const stamps = ["2024-3-27 5:33 am", "2026-3-11 10:29 am", "2026-9-10 6:19 am", "", "2026-9-25 10:50 pm", "2026-9-27 10:05 pm", "2018-9-6 4:46 pm"];
    const rows = Array.from({ length: 700 }, (_, i) => ({ "Internal ID": 550 + i, "Last Run On": stamps[i % stamps.length], Type: i % 2 ? "Transaction" : "Vendor", memo: `padding ${"x".repeat(40)} ${i}` }));
    const res = hso(handlePost({ session_id: "r6", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT 1 FROM dual" }, tool_response: text(JSON.stringify({ items: rows })) }, ctx));
    const id = /\b(r_[0-9a-f]{6})\b/.exec(String(res.updatedMCPToolOutput))![1];
    return { ctx, id };
  }
  const col = (out: string, skip = 1) => out.split("\n").slice(skip).map((l) => l.trim().split(/\s{2,}/)[0]);

  it("results head/filter/export --sort sort by the column's type, blanks last; --asc inverts", async () => {
    const { id } = runsResult();
    const head = await nsx("results", "head", id, "5", "--sort", "Last Run On", "--cols", "Last Run On,Internal ID");
    assert.deepEqual(col(head), ["2026-09-27 22:05", "2026-09-27 22:05", "2026-09-27 22:05", "2026-09-27 22:05", "2026-09-27 22:05"]);
    assert.deepEqual(col(await nsx("results", "head", id, "1", "--sort", "last_run_on", "--asc", "--cols", "Last Run On")), ["2018-09-06 16:46"], "resolved like --where; --asc = earliest first");
    assert.deepEqual(col(await nsx("results", "head", id, "1", "--sort", '"Internal ID"', "--cols", "Internal ID")), ["1249"], "numbers largest first");
    const f = await nsx("results", "filter", id, "--where", "\"Last Run On\" >= '2026-09-10'", "--sort", "Last Run On", "--asc", "--cols", "Last Run On");
    assert.match(f, /^300 of 700 rows match\n/);
    assert.deepEqual(col(f, 2).slice(0, 1), ["2026-09-10 06:19"]);
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nsx-exp-")), "runs.csv");
    await nsx("results", "export", id, "--csv", out, "--sort", "Last Run On");
    const lines = fs.readFileSync(out, "utf8").trim().split(/\r?\n/);
    assert.match(lines[1], /2026-09-27 22:05/);
    assert.match(lines[lines.length - 1], /^\d+,,/, "blank dates last");
    await assert.rejects(nsx("results", "head", id, "--sort", "Last Ran"), /Unknown column for --sort: Last Ran\. Available: Internal ID, Last Run On/);
    await assert.rejects(nsx("results", "head", id, "--asc"), /--asc only applies with --sort/);
    // Through the CLI: agg gets the column types from the result meta.
    assert.match(await nsx("results", "agg", id, "--max", "Last Run On"), /TOTAL \(700 rows\): max_Last Run On=2026-09-27 22:05/);
    await assert.rejects(nsx("results", "agg", id, "--sum", "Last Run On"), (e: Error) => e.constructor.name === "UsageError");
  });

  it("unknown flags are refused per subcommand (exit 2), naming the flag and the ones it takes", async () => {
    const { checkFlags, parseArgs } = await import("../src/cli.ts");
    const check = (...argv: string[]) => checkFlags(parseArgs(argv));
    assert.throws(() => check("results", "head", "r_1", "--bogus", "1"), /unknown flag --bogus for results head \(flags: --cols, --n, --sort, --asc, --max, --where, --any-account\)/);
    assert.throws(() => check("results", "filter", "r_1", "--were", "a=1"), /unknown flag --were for results filter .*Did you mean --where\?/);
    assert.throws(() => check("results", "head", "r_1", "--col", "a"), /Did you mean --cols\?/);
    assert.throws(() => check("cache", "--grep", "x"), /unknown flag --grep for cache status \(it takes no flags\)/);
    assert.throws(() => check("results", "list", "--where", "a=1"), /for results list/);
    check("results", "agg", "r_1", "--by", "Type", "--max", "Last Run On", "--count", "--sort", "max_Last Run On", "--top", "3");
    check("results", "diff", "r_1", "r_2", "--on", "type", "--cols", "amount", "--tolerance", "0.01", "--any-account");
    check("sql", "SELECT 1 FROM dual");
    check("hook", "pre", "--anything"); // hooks aren't validated here (main returns before)
    // Hints the hooks and the CLI print.
    for (const hint of [
      "results agg r_1 --by type --count --top 20",
      "results agg r_1 --by type --sum amount --top 20",
      "results filter r_1 --where kind=section",
      "results raw r_1 --grep x",
      "results raw r_1 --head 40",
      "fields invoice --record --grep x",
      "cache show fields/x --grep y --max 5",
      "audit tail --n 15",
      "audit export --session s --days 7 --out f.csv",
      "periods --open --max 12",
      "reports search income statement --max 50",
      "preview ns_updateRecord - --before current.json",
      "results pivot r_1 --rows a --cols b --count",
    ]) check(...hint.split(" "));
    // --asc and --any-account never swallow the next word.
    assert.deepEqual(parseArgs(["results", "head", "--any-account", "r_1", "--asc", "5"]).pos, ["results", "head", "r_1", "5"]);
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, "results", "head", "r_8aeb62", "--bogus", "1"], { env: { ...process.env, NSX_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "nsx-flags-")) }, encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /nsx: unknown flag --bogus for results head/);
  });

  it("every documented nsx example still parses (skills, references, agents, README)", async () => {
    const { checkFlags, parseArgs, COMMAND_FLAGS } = await import("../src/cli.ts");
    const files = [
      ...["skills", "agents"].flatMap((d) => fs.readdirSync(path.join(ROOT, d), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".md")).map((f) => path.join(ROOT, d, f))),
      path.join(ROOT, "README.md"),
    ];
    const examples: string[] = [];
    for (const f of files) {
      const md = fs.readFileSync(f, "utf8");
      // `nsx …` anywhere (inline code, code blocks, after a pipe); stop at a closing backtick, an arrow or a column gap.
      for (const m of md.matchAll(/(?:node "[^"]*nsx\.mjs"|(?<![\w./-])nsx) ([^`\n]*?)(?=`|\s+→|\s{3,}|$)/gm)) examples.push(m[1].trim());
    }
    assert.ok(examples.length > 25, `found ${examples.length} examples`);
    // A `<result id>` placeholder is one argument (positional counts are checked too).
    const split = (s: string) => [...s.matchAll(/"([^"]*)"|'([^']*)'|(<[^>]*>)|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
    let flagged = 0;
    for (const ex of examples) {
      // Usage notation (`[--grep t]`, `a|b` alternatives, `…`) is not an invocation.
      if (/[\[\]…]|--\w+\|/.test(ex)) continue;
      const argv = split(ex);
      if (!Object.hasOwn(COMMAND_FLAGS, argv[0]) && !Object.keys(COMMAND_FLAGS).some((k) => k.startsWith(`${argv[0]} `))) continue;
      if (argv.some((t) => t.startsWith("--"))) flagged++;
      assert.doesNotThrow(() => checkFlags(parseArgs(argv)), ex);
    }
    assert.ok(flagged >= 10, `checked ${flagged} examples with flags`);
  });

  it("a self-diff never reports a difference; n/a keys are counted apart and still listed", async () => {
    const ctx = tmpCtx();
    const types = ["CustInvc", "VendBill", "Journal", "CustPymt", "VendPymt", "CashSale", "Check", "Deposit", "ItemRcpt"];
    const rows = Array.from({ length: 900 }, (_, i) => ({ id: i + 1, type: types[i % 9], foreigntotal: (i % 17) * 10.5, memo: `row ${"y".repeat(30)} ${i}` }));
    const res = hso(handlePost({ session_id: "r6d", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT t.id, t.type, t.foreigntotal FROM transaction t" }, tool_response: text(JSON.stringify({ items: rows })) }, ctx));
    const id = /\b(r_[0-9a-f]{6})\b/.exec(String(res.updatedMCPToolOutput))![1];
    const out = await nsx("results", "diff", id, id, "--on", "type", "--cols", "foreigntotal");
    const head = out.split("\n")[0];
    assert.match(head, new RegExp(`^0 of 9 keys differ on type \\(a=${id}, b=${id}\\); 9 can't be compared \\(n/a: currency unknown\\)$`));
    assert.equal(out.split("\n").filter((l) => /n\/a \(currency unknown\)/.test(l)).length, 9, "n/a rows are still listed");
    const byId = await nsx("results", "diff", id, id, "--on", "id", "--cols", "foreigntotal");
    assert.match(byId, /^0 of 900 keys differ on id/);
    await assert.rejects(nsx("results", "diff", id, id, "--on", "type"), /results diff is missing --cols \(the value column\(s\) to compare\)/);
    await assert.rejects(nsx("results", "diff", id, id), /missing --on \(the key column\(s\) to match rows on\) and --cols/);
  });

  it("hints use the full CLI command; record metadata is 'fields (record metadata)'", async () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_listAllReports"), tool_input: {}, tool_response: text(JSON.stringify([{ id: -200, title: "Income Statement" }])) }, ctx);
    const out = await nsx("profile", "ttm-report");
    assert.match(out, /Then run: node "[^"]+" profile from-report <the result id/);
    assert.match(out, /no id: node "[^"]+" profile set ttm_revenue_consolidated=/);
    assert.doesNotMatch(out, /\bnsx profile/);
    const { catalogTarget } = await import("../src/cache/catalog.ts");
    assert.equal(catalogTarget("ns_getRecordTypeMetadata", { recordType: "journalentry" }, undefined)?.label, "fields (record metadata) for journalentry");
  });
});

describe("hook, cache and profile safeguards", () => {
  const T = (n: string) => `mcp__netsuite__${n}`;
  const upd = { recordType: "vendorbill", recordId: "123" };

  it("the preview compares exact paths, never a field with the same leaf name", async () => {
    const { diffLines } = await import("../src/preview.ts");
    const before = { id: "123", entity: { id: "77", refName: "Vendor A" }, subsidiary: { id: "5" } };
    assert.deepEqual(diffLines("ns_updateRecord", { ...upd, subsidiary: { id: "77" } }, before), ['~ subsidiary.id: "5" → "77"']);
    // Wrappers are stripped on both sides; the record id is never an "old value".
    assert.deepEqual(diffLines("ns_updateRecord", { ...upd, data: { approvalStatus: { id: "1" } } }, { id: "123", approvalStatus: { id: "2" } }), ['~ approvalStatus.id: "2" → "1"']);
    assert.deepEqual(diffLines("ns_updateRecord", { ...upd, values: { memo: "new", phone: "1" } }, { data: { id: "123", memo: "old memo", phone: "1" } }), ['~ memo: "old memo" → "new"']);
    assert.deepEqual(diffLines("ns_updateRecord", { ...upd, values: { custbody_x: "a" } }, { memo: "m" }), ['~ custbody_x: (not in the before-record) → "a"']);
    assert.deepEqual(diffLines("ns_updateRecord", { ...upd, values: { memo: "m" } }, { memo: "m" }), ["(no field changes detected: every field in the input already has that value in the before-record)"]);
    // The prompt shows the diff of the input being sent, even if the stored preview file was edited.
    const ctx = tmpCtx({ read_only: "false" });
    const input = { ...upd, subsidiary: { id: "77" } };
    const { file } = writePreview(ctx.acctDir!, "ns_updateRecord", input, before);
    const pv = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...pv, diff: [] }));
    const reason = String(hso(handlePre({ tool_name: T("ns_updateRecord"), tool_input: input }, ctx)).permissionDecisionReason);
    assert.match(reason, /NetSuite WRITE: updateRecord vendorbill #123\n~ subsidiary\.id: "5" → "77"/);
  });

  it("a recordType with ../ is never cached and nothing is written outside the account dir", async () => {
    const ctx = tmpCtx();
    const victim = path.join(ctx.data, "victim");
    fs.mkdirSync(victim);
    for (const tool of ["ns_getRecordTypeMetadata", "ns_getSuiteQLMetadata"]) {
      for (const rt of [path.relative(path.join(ctx.acctDir!, "raw", "fields"), path.join(victim, "settings")), "..", ".", "a/b"]) {
        const out = hso(handlePost({ tool_name: T(tool), tool_input: { recordType: rt }, tool_response: text('{"success":true,"metadata":{"type":"object"}}') }, ctx));
        assert.match(String(out.additionalContext), /Not cached: /, `${tool} ${rt}`);
        assert.equal(out.updatedMCPToolOutput, undefined);
      }
    }
    assert.deepEqual(fs.readdirSync(victim), []);
    assert.deepEqual((fs.readdirSync(ctx.data, { recursive: true, encoding: "utf8" }) as string[]).filter((f) => /settings\.(json|tsv)$|\/x\.(json|tsv)$/.test(f)), [], "no file named after the recordType anywhere");
    // Defence in depth in the store itself.
    const { safeSectionName, sectionFile } = await import("../src/cache/store.ts");
    assert.equal(safeSectionName("fields/../../x"), "fields/_./_./x");
    storeSection(ctx.acctDir!, ctx.cfg, "fields/../../../victim/x", "t", "{}", { header: ["field"], rows: [["a"]] });
    assert.deepEqual(fs.readdirSync(victim), []);
    assert.ok(sectionFile(ctx.acctDir!, "raw", "../../x", ".json").startsWith(path.join(ctx.acctDir!, "raw") + path.sep));
  });

  it("every ns_ tool not known to only read is guarded as a write, underscores included", async () => {
    const { isWriteTool } = await import("../src/preview.ts");
    const { nsToolName } = await import("../src/mcp.ts");
    assert.equal(nsToolName("mcp__ns__ns_create_record"), "ns_create_record");
    assert.equal(nsToolName("mcp__claude_ai_NetSuite__ns_selector_app"), "ns_selector_app");
    assert.equal(nsToolName("mcp__ns__ns_updateRecord_v2"), "ns_updateRecord_v2");
    const ctx = tmpCtx();
    for (const t of ["ns_removeRecord", "ns_patchRecord", "ns_saveRecord", "ns_submitRecord", "ns_voidTransaction", "ns_approveRecord", "ns_copyRecord", "ns_setFieldValue", "ns_executeScript", "ns_recordCreate", "ns_bulkUpdate", "ns_mergeRecords", "ns_sendEmail", "ns_initializeRecord", "ns_create_record", "ns_updateRecord_v2"]) {
      assert.ok(isWriteTool(t), t);
      const out = hso(handlePre({ tool_name: T(t), tool_input: { recordType: "x" } }, ctx));
      assert.equal(out.permissionDecision, "deny", t);
      assert.match(String(out.permissionDecisionReason), /read_only/, t);
    }
    assert.match(String(hso(handlePre({ tool_name: T("ns_voidTransaction"), tool_input: {} }, ctx)).permissionDecisionReason), /ns_voidTransaction is an unknown NetSuite tool: treated as a write/);
    for (const t of ["ns_runCustomSuiteQL", "ns_runReport", "ns_runSavedSearch", "ns_getRecord", "ns_listAllReports", "ns_getSubsidiaries", "ns_selector_app", "ns_report_filters_app", "ns_prompt_library_app"]) assert.ok(!isWriteTool(t), t);
    const { failClosedForWrites } = await import("../src/hooks/pre.ts");
    assert.equal(hso(failClosedForWrites({ tool_name: T("ns_removeRecord") })).permissionDecision, "deny");
  });

  it("a write is 'succeeded' only with a record id or success:true", () => {
    const ctx = tmpCtx({ read_only: "false" });
    for (const body of ['"Error updating record: Invalid field value"', "Record could not be saved", '"HTTP 400: {}"', '{"status":400,"title":"Bad Request"}', '{"message":"done?"}']) {
      const out = String(hso(handlePost({ tool_name: T("ns_updateRecord"), tool_input: upd, tool_response: text(body) }, ctx)).additionalContext);
      assert.doesNotMatch(out, /Write succeeded/, body);
      assert.match(out, /Error class|Write outcome unknown: .*ns_getRecord .*before telling the user it worked/, body);
    }
    assert.match(String(hso(handlePost({ tool_name: T("ns_updateRecord"), tool_input: upd, tool_response: text('{"id":"123"}') }, ctx)).additionalContext), /Write succeeded \(record id 123\)/);
    assert.match(String(hso(handlePost({ tool_name: T("ns_updateRecord"), tool_input: upd, tool_response: text('{"success":true}') }, ctx)).additionalContext), /Write succeeded\. Verify/);
    const outcomes = readAudit(ctx.acctDir!).map((e) => e.outcome);
    assert.ok(outcomes.includes("unknown") && outcomes.at(-1) === "ok");
  });

  it("error strings and problem objects in a successful result are errors", () => {
    const ctx = tmpCtx();
    const cases: [string, RegExp][] = [
      ['"Failed to parse SQL [x]: syntax error"', /bad_syntax/],
      ["Search error occurred: Record 'subsidiary' was not found.", /not_found/],
      ['"Error executing SuiteQL query: An unexpected SuiteScript error has occurred"', /Error class/],
      ["HTTP 403: INSUFFICIENT_PERMISSION", /permission/],
      ['{"status":429,"title":"Too Many Requests"}', /rate_limit/],
      ['{"status":400,"detail":"bad"}', /Error class/],
    ];
    for (const [body, re] of cases) {
      const o = hso(handlePost({ tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT id FROM transaction" }, tool_response: text(body) }, ctx));
      assert.match(String(o.additionalContext ?? o.updatedMCPToolOutput), re, body);
    }
    // A record that happens to carry status/title fields isn't an error.
    const rec = hso(handlePost({ tool_name: T("ns_getRecord"), tool_input: { recordType: "task", recordId: "1", fields: "status,title" }, tool_response: text('{"id":"1","status":404,"title":"Call back"}') }, ctx));
    assert.doesNotMatch(String(rec.additionalContext), /Error class/);
  });

  it("[], an error body or unparseable text never replaces a good catalog section", () => {
    const ctx = tmpCtx();
    const call = (body: string) => hso(handlePost({ tool_name: T("ns_listSavedSearches"), tool_input: {}, tool_response: text(body) }, ctx));
    const good = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ id: `customsearch${i}`, title: `S${i}`, recordType: "Transaction" })));
    call(good);
    assert.match(String(call("[]").updatedMCPToolOutput), /searches 10 → 0: not replaced, the cached copy was kept/);
    assert.match(String(call('{"status":429,"title":"Too Many Requests"}').updatedMCPToolOutput), /rate_limit/);
    assert.match(String(call("Service temporarily unavailable").updatedMCPToolOutput), /couldn't be parsed, so the cached copy \(10 rows, fetched .*\) was kept\. Response: Service temporarily unavailable/);
    const m = loadManifest(ctx.acctDir!);
    assert.equal(m.sections.searches.count, 10);
    assert.equal(m.sections.searches.status, "ok");
    assert.equal(fs.readFileSync(path.join(ctx.acctDir!, "raw", "searches.json"), "utf8"), good);
    // Small sections too: subsidiaries 2 → 0 is refused, so OneWorld stays known.
    handlePost({ tool_name: T("ns_getSubsidiaries"), tool_input: {}, tool_response: text(JSON.stringify([{ id: "1", name: "A" }, { id: "2", name: "B" }])) }, ctx);
    handlePost({ tool_name: T("ns_getSubsidiaries"), tool_input: {}, tool_response: text("[]") }, ctx);
    assert.equal(loadProfile(ctx.acctDir!)?.oneWorld, true);
    // A first-time unparsed text is stored raw but shown to Claude.
    const fresh = tmpCtx();
    assert.match(String(hso(handlePost({ tool_name: T("ns_listAllReports"), tool_input: {}, tool_response: text("Service temporarily unavailable") }, fresh)).updatedMCPToolOutput), /Response: Service temporarily unavailable/);
  });

  it("one page of a paged tagged query is not cached as the whole list", () => {
    const ctx = tmpCtx();
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, periodname: `P${i}`, startdate: "2026-01-01", enddate: "2026-01-31", closed: "F", isyear: "F", isquarter: "F", isadjust: "F" }));
    const out = hso(handlePost(tagged("periods", { items: rows, hasMore: true, totalResults: 40 }, { tool_input: { sqlQuery: probeSql("periods"), description: "[su-ns-harness:periods]", pageSize: 5, pageIndex: 0 } }), ctx));
    assert.match(String(out.additionalContext), /ignored: the result is one page \(5 of 40 rows\)/);
    assert.equal(loadManifest(ctx.acctDir!).sections.periods, undefined);
  });

  it("the base currency is read by column name", () => {
    const ctx = tmpCtx();
    storeSection(ctx.acctDir!, ctx.cfg, "probe/base_currency", "t", "{}", { header: ["currency", "id"], rows: [["EUR", "1"]] });
    assert.equal(buildProfile(ctx.acctDir!).baseCurrency, "EUR");
    storeSection(ctx.acctDir!, ctx.cfg, "probe/base_currency", "t", "{}", { header: ["id", "currency"], rows: [["1", ""]] });
    const p = buildProfile(ctx.acctDir!);
    assert.equal(p.baseCurrency, undefined, "never the id");
    assert.doesNotMatch(profileCard(p), /Base currency \| 1 \|/);
  });

  it("the rate-limit count decays after 5 quiet minutes; wording is consistent", async () => {
    const ctx = tmpCtx();
    const call = { session_id: "rl", tool_name: T("ns_runReport"), tool_input: { reportId: 1 }, error: "HTTP 429 Too Many Requests" };
    const msgs = [1, 2, 3, 4].map(() => String(hso(handleFailure(call, ctx)).additionalContext));
    assert.match(msgs[0], /\(hit 1 time in a row\)\. .*attempt 1 of 3/);
    assert.match(msgs[3], /\(hit 4 times in a row\)\. NetSuite rate limit \(concurrency\) hit 4 times in a row on this call\. Stop retrying/);
    const { loadState, saveState } = await import("../src/session.ts");
    const st = loadState(ctx.data, "rl");
    for (const v of Object.values(st.rateLimits!)) v.at -= 6 * 60_000;
    saveState(ctx.data, "rl", st);
    assert.match(String(hso(handleFailure(call, ctx)).additionalContext), /\(hit 1 time in a row\)\. .*attempt 1 of 3/);
  });

  it("usage-limit governance errors aren't rate limits; an echoed 429 isn't one either", async () => {
    const { advice } = await import("../src/errors.ts");
    assert.equal(classifyError("SSS_USAGE_LIMIT_EXCEEDED: Script Execution Usage Limit Exceeded"), "timeout");
    assert.match(advice("timeout", { message: "SSS_USAGE_LIMIT_EXCEEDED" }), /governance .*not a rate limit.*Narrow it/);
    assert.equal(classifyError("Error loading saved search with params {searchId: 429}. Error: boom"), "unknown");
    for (const m of ["HTTP 429: {}", "Too Many Requests", "status: 429", "The connector's server is rate-limiting requests. You can try again.", "SSS_REQUEST_LIMIT_EXCEEDED", "Concurrent request limit exceeded"]) assert.equal(classifyError(m), "rate_limit", m);
  });

  it("a base_currency override applies to the parent's facts too", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_getSubsidiaries"), tool_input: {}, tool_response: text(JSON.stringify([{ id: "1", name: "Parent GmbH" }, { id: "2", name: "Sub Inc" }, { id: "-1", name: "Parent GmbH (Consolidated)" }])) }, ctx);
    storeSection(ctx.acctDir!, ctx.cfg, "probe/base_currency_fx", "t", "{}", { header: ["sub", "currency", "n"], rows: [["1", "EUR", "10"], ["2", "USD", "5"]] });
    storeSection(ctx.acctDir!, ctx.cfg, "probe/ttm_revenue", "t", "{}", { header: ["subsidiary_id", "subsidiary", "revenue"], rows: [["1", "Parent GmbH", "10700000"], ["2", "Sub Inc", "3000000"]] });
    buildProfile(ctx.acctDir!);
    const p = setOverrides(ctx.acctDir!, { base_currency: "usd" });
    assert.equal(p.subsidiaryCurrencies?.["1"], "USD");
    const card = profileCard(p);
    assert.match(card, /Parent GmbH USD 10\.7M/);
    assert.match(card, /\| Materiality \| \$50K or 5% \(from the parent subsidiary/);
    assert.doesNotMatch(card, /EUR 10\.7M/);
  });

  it("profile set validates keys and values, and an empty value removes an override", () => {
    const ctx = tmpCtx();
    storeSection(ctx.acctDir!, ctx.cfg, "probe/base_currency", "t", "{}", { header: ["id", "currency"], rows: [["1", "EUR"]] });
    buildProfile(ctx.acctDir!);
    assert.equal(setOverrides(ctx.acctDir!, { materiality_amount: "50k" }).materiality?.amount, 50_000);
    assert.equal(setOverrides(ctx.acctDir!, { materiality_amount: "50,000", materiality_pct: "2.5%" }).materiality?.pct, 2.5);
    for (const [k, v, re] of [
      ["materiality_amount", "abc", /materiality_amount=abc: expected a positive amount/],
      ["materiality_amount", "1e999", /expected a positive amount/],
      ["materiality_pct", "abc", /materiality_pct=abc: expected a percentage/],
      ["bogus_key", "1", /bogus_key=1: unknown key \(known: base_currency, .*approval\.<TypeCode>\)/],
      ["oneworld", "maybe", /expected yes or no/],
      ["base_currency", "Euro", /3-letter currency code/],
    ] as [string, string, RegExp][]) {
      assert.throws(() => setOverrides(ctx.acctDir!, { [k]: v }), (e: Error) => /^Invalid profile setting \(nothing was changed\):\n- /.test(e.message) && re.test(e.message), `${k}=${v}`);
    }
    assert.equal(loadProfile(ctx.acctDir!)?.materiality?.amount, 50_000, "a rejected call changes nothing");
    const set = setOverrides(ctx.acctDir!, { ttm_revenue_consolidated: "17.7m", base_currency: "usd" });
    assert.equal(set.ttmRevenueConsolidated?.amount, 17_700_000);
    assert.equal(set.baseCurrency, "USD");
    const unset = setOverrides(ctx.acctDir!, { ttm_revenue_consolidated: "", base_currency: "" });
    assert.equal(unset.ttmRevenueConsolidated, undefined);
    assert.equal(unset.baseCurrency, "EUR", "the derived value comes back");
    assert.deepEqual(Object.keys(unset.overrides ?? {}).sort(), ["materiality_amount", "materiality_pct"]);
    assert.doesNotMatch(profileCard(unset), /NaN|null%|Infinity/);
  });

  it("not-found advice fits the tool", async () => {
    const { advice } = await import("../src/errors.ts");
    assert.match(advice("not_found", { tool: "ns_getRecord" }), /Record not found.*SuiteQL lookup/);
    assert.doesNotMatch(advice("not_found", { tool: "ns_getRecord" }), /ns_listAllReports|ns_listSavedSearches/);
    assert.match(advice("not_found", { tool: "ns_getSuiteQLMetadata" }), /nsx recordtypes/);
    assert.match(advice("not_found", { tool: "ns_runReport" }), /ns_listAllReports/);
    assert.match(advice("not_found", { tool: "ns_runSavedSearch" }), /ns_listSavedSearches/);
  });

  it("an empty record-metadata schema isn't judged against the SuiteQL table list", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_getSuiteQLMetadata"), tool_input: {}, tool_response: text(JSON.stringify([{ id: "transaction" }, { id: "account" }])) }, ctx);
    const out = String(hso(handlePost({ tool_name: T("ns_getRecordTypeMetadata"), tool_input: { recordType: "vendorbill" }, tool_response: text('{"success":true,"metadata":{"type":"object"}}') }, ctx)).updatedMCPToolOutput);
    assert.match(out, /no record metadata for 'vendorbill' \(REST record API\)/);
    assert.doesNotMatch(out, /can't see this table|record-type list/);
  });

  it("parallel hook processes don't lose each other's session-state updates", async () => {
    const { spawn } = await import("node:child_process");
    const ctx = tmpCtx();
    const code = (i: number) =>
      `import {loadState, saveState} from ${JSON.stringify(path.join(import.meta.dirname, "..", "src", "session.ts"))};` +
      ` const s = loadState(${JSON.stringify(ctx.data)}, "par"); s.retries["k${i}"] = ${i}; (s.metadataAsked ??= []).push("t${i}"); saveState(${JSON.stringify(ctx.data)}, "par", s);`;
    await Promise.all(Array.from({ length: 8 }, (_, i) => new Promise((r) => spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code(i)], { stdio: "ignore" }).on("exit", r))));
    const st = JSON.parse(fs.readFileSync(path.join(sessionDir(ctx.data, "par"), "state.json"), "utf8"));
    assert.equal(Object.keys(st.retries).length, 8);
    assert.equal(st.metadataAsked.length, 8);
  });

  it("one real subsidiary plus a consolidated view or an elimination is OneWorld", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_getSubsidiaries"), tool_input: {}, tool_response: text(JSON.stringify([{ id: "1", name: "Solo GmbH" }, { id: "-1", name: "Solo GmbH (Consolidated)" }])) }, ctx);
    const p = loadProfile(ctx.acctDir!)!;
    assert.equal(p.oneWorld, true);
    assert.equal(p.subsidiaryCount, 1);
    assert.equal(p.parentSubsidiaryId, "1");
    const solo = tmpCtx();
    handlePost({ tool_name: T("ns_getSubsidiaries"), tool_input: {}, tool_response: text(JSON.stringify([{ id: "1", name: "Solo Inc" }])) }, solo);
    assert.equal(loadProfile(solo.acctDir!)?.oneWorld, false);
  });

  it("a spilled content-block array is decoded; catalog spills get no 'aggregate' advice", async () => {
    const { resolveSpilled, decodeToolResponse } = await import("../src/mcp.ts");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nsx-home-"));
    const proj = path.join(home, "projects", "p");
    const dir = path.join(proj, "sess", "tool-results");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "x.txt");
    fs.writeFileSync(file, JSON.stringify([{ type: "text", text: JSON.stringify({ items: [{ id: 1 }] }) }]));
    const r = resolveSpilled(decodeToolResponse(`Error: result exceeds maximum allowed tokens. Output has been saved to ${file}\n`), { transcriptPath: path.join(proj, "sess.jsonl"), claudeHome: home });
    assert.deepEqual(r.json, { items: [{ id: 1 }] });
    const ctx = tmpCtx();
    const out = String(hso(handlePost({ tool_name: T("ns_listAllReports"), tool_input: {}, tool_response: text("Error: result exceeds maximum allowed tokens. Output has been saved to /nowhere/tool-results/x.txt\n") }, ctx)).additionalContext);
    assert.match(out, /grep it for the entry you need/);
    assert.doesNotMatch(out, /aggregate/);
  });

  it("audit logs are kept (no retention sweep)", async () => {
    const ctx = tmpCtx();
    const { appendAudit, auditDir } = await import("../src/audit.ts");
    appendAudit(ctx.acctDir!, { ts: new Date().toISOString(), session: "a", tool: "ns_runReport", input: {}, outcome: "ok" });
    const f = fs.readdirSync(auditDir(ctx.acctDir!)).map((n) => path.join(auditDir(ctx.acctDir!), n))[0];
    const old = new Date(Date.now() - 400 * 86_400_000);
    fs.utimesSync(f, old, old);
    handleSessionStart({ session_id: "a" }, ctx);
    assert.ok(fs.existsSync(f));
  });

  it("unparseable stdin for a write is denied; the message promises no log file", async () => {
    const { processHook } = await import("../src/hooks/io.ts");
    const { failClosedForWrites } = await import("../src/hooks/pre.ts");
    tmpCtx({ read_only: "false" });
    const broken = '{"tool_name":"mcp__netsuite__ns_deleteRecord","tool_input":{"recordType":"customer",';
    const out = JSON.parse(processHook("pre", broken, (i) => handlePre(i), failClosedForWrites));
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /hook\.log/);
    assert.equal(processHook("pre", '{"tool_name":"mcp__netsuite__ns_runCustomSuiteQL",', (i) => handlePre(i), failClosedForWrites), "", "reads still pass through");
  });

  it("a blank externalId doesn't pass the create check", () => {
    const ctx = tmpCtx({ read_only: "false" });
    for (const input of [{ recordType: "customer", externalId: " " }, { recordType: "customer", values: { externalId: "" } }]) {
      assert.match(String(hso(handlePre({ tool_name: T("ns_createRecord"), tool_input: input }, ctx)).permissionDecisionReason), /Set externalId/);
    }
  });

  it("post and failure hooks record the connector too", async () => {
    const { lastConnector } = await import("../src/config.ts");
    const ctx = tmpCtx();
    handlePost({ tool_name: "mcp__nsprod__ns_runReport", tool_input: {}, tool_response: text("{}") }, ctx);
    assert.equal(lastConnector(ctx.data)?.server, "nsprod");
    handleFailure({ tool_name: "mcp__nsother__ns_runReport", tool_input: {}, error: "x" }, ctx);
    assert.equal(lastConnector(ctx.data)?.server, "nsother");
  });

  it("hook messages name the refresh skill so Claude can run it", () => {
    const ctx = tmpCtx();
    storeSection(ctx.acctDir!, ctx.cfg, "reports", "t", "[]", { header: ["id"], rows: [["1"]] });
    const m = loadManifest(ctx.acctDir!);
    m.sections.reports.fetchedAt = "2000-01-01T00:00:00Z";
    fs.writeFileSync(path.join(ctx.acctDir!, "manifest.json"), JSON.stringify(m));
    assert.match(String(handleSessionStart({ session_id: "r" }, ctx)?.text), /run the su-ns-harness:refresh skill \(sections: stale/);
    assert.match(profileCard({ builtAt: "", oneWorld: true, ttmRevenue: 1e7, ttmRevenueMixed: true }), /run the su-ns-harness:refresh skill \(sections: profile\)/);
  });
});

describe("hook, cache and profile safeguards (claude.ai connector tool names)", () => {
  const W = (tool: string) => `mcp__claude_ai_NetSuite__${tool}`;
  const reason = (o: ReturnType<typeof handlePre>) => String(hso(o).permissionDecisionReason ?? "");
  const approve = (ctx: ReturnType<typeof tmpCtx>, input: Record<string, unknown>, before?: Record<string, unknown>) => {
    writePreview(ctx.acctDir!, "ns_updateRecord", input, before);
    return reason(handlePre({ tool_name: T("ns_updateRecord"), tool_input: input }, ctx));
  };

  it("the approval prompt compares exact field paths and never hides a change", () => {
    const ctx = tmpCtx({ read_only: "false" });
    // subsidiary.id must never pair with entity.id (same leaf), which would show no diff at all.
    const r1 = approve(ctx, { recordType: "vendorbill", recordId: "123", subsidiary: { id: "77" } }, { id: "123", entity: { id: "77", refName: "Vendor A" }, subsidiary: { id: "5" } });
    assert.match(r1, /~ subsidiary\.id: "5" → "77"/);
    // A {data:…} wrapper: approvalStatus.id is compared with approvalStatus.id, not the record id.
    const r2 = approve(ctx, { recordType: "vendorbill", recordId: "123", data: { approvalStatus: { id: "1" } } }, { id: "123", approvalStatus: { id: "2" } });
    assert.match(r2, /~ approvalStatus\.id: "2" → "1"/);
    assert.doesNotMatch(r2, /"123"/);
    // values wrapper + flat before-record: the old value is found; unchanged fields aren't listed.
    const r3 = approve(ctx, { recordType: "vendorbill", recordId: "123", values: { memo: "new", tranid: "B-1" } }, { success: true, data: { id: "123", memo: "old memo", tranid: "B-1" } });
    assert.match(r3, /~ memo: "old memo" → "new"/);
    assert.doesNotMatch(r3, /tranid|∅/);
    // A field missing from the before-record says so; no change at all says so.
    assert.match(approve(ctx, { recordType: "vendorbill", recordId: "123", values: { duedate: "2026-10-01" } }, { id: "123", memo: "m" }), /~ duedate: \(not in the before-record\) → "2026-10-01"/);
    assert.match(approve(ctx, { recordType: "vendorbill", recordId: "123", values: { memo: "m" } }, { id: "123", memo: "m" }), /no field changes detected/);
    // Inside a wrapper, `id`/`type` are fields being written, not the target.
    assert.deepEqual(diffLines("ns_createRecord", { recordType: "customer", values: { type: "x", id: "9" } }), ['+ type = "x"', '+ id = "9"']);
    // The prompt is built from the input being sent, not from the stored (editable) preview file.
    const input = { recordType: "vendorbill", recordId: "9", values: { memo: "sneaky" } };
    const { file } = writePreview(ctx.acctDir!, "ns_updateRecord", input, { id: "9", memo: "old" });
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...stored, diff: ["nothing to see"] }));
    const r4 = reason(handlePre({ tool_name: T("ns_updateRecord"), tool_input: input }, ctx));
    assert.match(r4, /~ memo: "old" → "sneaky"/);
    assert.doesNotMatch(r4, /nothing to see/);
  });

  it("a recordType with ../ never writes outside the cache", () => {
    const ctx = tmpCtx();
    const victim = path.join(ctx.data, "victim");
    fs.mkdirSync(victim);
    for (const [tool, sub] of [["ns_getRecordTypeMetadata", "recordmeta"], ["ns_getSuiteQLMetadata", "fields"]] as const) {
      const rel = path.relative(path.join(ctx.acctDir!, "raw", sub), path.join(victim, "settings"));
      assert.match(rel, /^\.\.\//);
      const out = hso(handlePost({ tool_name: T(tool), tool_input: { recordType: rel }, tool_response: text('{"success":true,"metadata":{"type":"object"}}') }, ctx));
      assert.match(String(out.additionalContext), /Not cached: .* Record type and table names are plain lower-case ids/);
      assert.equal(out.updatedMCPToolOutput, undefined);
    }
    assert.deepEqual(fs.readdirSync(victim), [], "nothing written outside the account dir");
    assert.equal(fs.existsSync(path.join(ctx.data, "settings.json")), false);
    assert.deepEqual(Object.keys(loadManifest(ctx.acctDir!).sections), []);
  });

  it("every NetSuite tool not known to only read is guarded as a write", async () => {
    const { nsToolName } = await import("../src/mcp.ts");
    const { failClosedForWrites } = await import("../src/hooks/pre.ts");
    assert.equal(nsToolName("mcp__ns__ns_create_record"), "ns_create_record");
    assert.equal(nsToolName("mcp__my_ns_server__ns_updateRecord_v2"), "ns_updateRecord_v2");
    assert.equal(nsToolName("mcp__netsuite__ns_runCustomSuiteQL"), "ns_runCustomSuiteQL");
    const ctx = tmpCtx();
    for (const t of ["ns_removeRecord", "ns_patchRecord", "ns_saveRecord", "ns_submitRecord", "ns_voidTransaction", "ns_approveRecord", "ns_copyRecord", "ns_setFieldValue", "ns_executeScript", "ns_bulkUpdate", "ns_mergeRecords", "ns_sendEmail", "ns_initializeRecord", "ns_something_app"]) {
      const r = reason(handlePre({ tool_name: W(t), tool_input: { recordType: "vendorbill", recordId: "1" } }, ctx));
      assert.match(r, new RegExp(`${t} is an unknown NetSuite tool: treated as a write\\. Writes are disabled \\(read_only = true\\)`), t);
      assert.equal(hso(failClosedForWrites({ tool_name: W(t) })).permissionDecision, "deny", t);
    }
    for (const t of ["ns_create_record", "ns_updateRecord_v2", "ns_recordCreate"]) assert.match(reason(handlePre({ tool_name: W(t), tool_input: {} }, ctx)), /read_only = true/, t);
    // Reads still pass untouched.
    for (const t of ["ns_getSubsidiaries", "ns_listAllReports", "ns_getRecordTypeMetadata", "ns_prompt_library_app", "ns_report_filters_app", "ns_selector_app"]) assert.equal(hso(handlePre({ tool_name: W(t), tool_input: {} }, ctx)).permissionDecision, undefined, t);
    // With writes on, an unknown tool needs a preview and says it's unknown in the prompt.
    const on = tmpCtx({ read_only: "false" });
    const input = { recordType: "vendorbill", recordId: "5" };
    assert.match(reason(handlePre({ tool_name: W("ns_voidTransaction"), tool_input: input }, on)), /Writes need a preview first/);
    writePreview(on.acctDir!, "ns_voidTransaction", input);
    assert.match(reason(handlePre({ tool_name: W("ns_voidTransaction"), tool_input: input }, on)), /ns_voidTransaction isn't a tool su-ns-harness knows: check what it does before approving/);
  });

  it("a write is only 'succeeded' with a record id or success:true", () => {
    const ctx = tmpCtx({ read_only: "false" });
    const post = (body: string, s = "h2") => hso(handlePost({ session_id: s, tool_name: T("ns_updateRecord"), tool_input: { recordType: "vendorbill", recordId: "1", values: { memo: "x" } }, tool_response: text(body) }, ctx));
    for (const body of ['"Error updating record: Invalid field value"', "Error updating record: Invalid field value", '"HTTP 400: {\\"title\\":\\"Bad\\"}"', '{"status":400,"title":"Bad Request"}']) {
      const c = String(post(body).additionalContext);
      assert.match(c, /Error class: /, body);
      assert.doesNotMatch(c, /Write succeeded/, body);
    }
    assert.match(String(post("Done.").additionalContext), /Write outcome unknown: NetSuite's response has no record id and no success flag.*Read the record back with ns_getRecord .*before telling the user it worked/);
    assert.match(String(post('{"id":"1"}').additionalContext), /Write succeeded \(record id 1\)/);
    assert.match(String(post('{"success":true,"data":{"id":42}}').additionalContext), /Write succeeded \(record id 42\)/);
    assert.match(String(post('{"success":true}').additionalContext), /Write succeeded\. Verify/);
    const outcomes = readAudit(ctx.acctDir!).map((e) => e.outcome);
    assert.deepEqual(outcomes, ["error", "error", "error", "error", "unknown", "ok", "ok", "ok"]);
  });

  it("live error strings and problem-detail bodies are errors on every shaped tool", () => {
    const ctx = tmpCtx();
    const inputs: Record<string, Record<string, unknown>> = {
      ns_runCustomSuiteQL: { sqlQuery: "SELECT id FROM transaction" },
      ns_runSavedSearch: { searchId: "customsearch1", range_start: 0, range_end: 10 },
      ns_runReport: { reportId: -200 },
      ns_getRecord: { recordType: "customer", recordId: "1", fields: "id" },
    };
    const bodies: [string, string][] = [
      ['"Failed to parse SQL [SELECT]: syntax error near: FROM(1,8, token code:0)"', "bad_syntax"],
      ["Search error occurred: Record 'subsidiary' was not found.", "not_found"],
      ["Error executing SuiteQL query: An unexpected SuiteScript error has occurred", "unknown"],
      ['"HTTP 403: {\\"o:errorDetails\\":[{\\"o:errorCode\\":\\"INSUFFICIENT_PERMISSION\\"}]}"', "permission"],
      ['{"status":429,"title":"Too Many Requests"}', "rate_limit"],
      ['{"status":"404","detail":"Not Found"}', "not_found"],
    ];
    let n = 0;
    for (const [tool, ti] of Object.entries(inputs)) {
      for (const [body, cls] of bodies) {
        const out = hso(handlePost({ session_id: `m1-${n++}`, tool_name: T(tool), tool_input: ti, tool_response: text(body) }, ctx));
        assert.match(String(out.additionalContext ?? out.updatedMCPToolOutput), new RegExp(`Error class: ${cls}`), `${tool}: ${body}`);
      }
    }
    assert.ok(readAudit(ctx.acctDir!).every((e) => e.outcome === "error"));
    // A record that happens to have status/title fields is not an error.
    assert.doesNotMatch(String(hso(handlePost({ tool_name: T("ns_getRecord"), tool_input: inputs.ns_getRecord, tool_response: text('{"id":"1","status":500,"title":"Mr"}') }, ctx)).additionalContext), /Error class/);
  });

  it("an empty list, an error body or plain text never replaces a good catalog", () => {
    const ctx = tmpCtx();
    const call = (body: string, tool = "ns_listSavedSearches") => hso(handlePost({ session_id: "m2", tool_name: T(tool), tool_input: {}, tool_response: text(body) }, ctx));
    const good = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({ id: `customsearch${i}`, title: `S${i}`, recordType: "Transaction" })));
    call(good);
    const raw = fs.readFileSync(path.join(ctx.acctDir!, "raw", "searches.json"), "utf8");
    assert.match(String(call("[]").updatedMCPToolOutput), /searches 10 → 0: not replaced, the cached copy was kept\. If that's intended, run `nsx cache invalidate searches`/);
    assert.match(String(call('{"status":429,"title":"Too Many Requests"}').updatedMCPToolOutput), /Error class: rate_limit/);
    const plain = String(call("Service temporarily unavailable").updatedMCPToolOutput);
    assert.match(plain, /The saved searches response couldn't be parsed, so the cached copy \(10 rows, fetched \d{4}-\d\d-\d\d\) was kept\. Response: Service temporarily unavailable/);
    const e = loadManifest(ctx.acctDir!).sections.searches;
    assert.equal(e.count, 10);
    assert.equal(e.status, "ok");
    assert.equal(fs.readFileSync(path.join(ctx.acctDir!, "raw", "searches.json"), "utf8"), raw, "the good raw payload is kept");
    // Subsidiaries: `[]` after one entry is refused too (the card must not lose OneWorld).
    call(JSON.stringify([{ id: "1", name: "Parent" }, { id: "2", name: "Sub" }]), "ns_getSubsidiaries");
    assert.match(String(call("[]", "ns_getSubsidiaries").updatedMCPToolOutput), /subsidiaries 2 → 0: not replaced/);
    assert.equal(loadProfile(ctx.acctDir!)?.oneWorld, true);
    // First fetch with nothing cached: stored raw, and short text is shown so Claude can report it.
    assert.match(String(call("Something odd happened", "ns_listAllReports").updatedMCPToolOutput), /couldn't parse it.*Response: Something odd happened/);
    // A stale section is replaced as usual.
    markStale(ctx.acctDir!, "searches", "test");
    assert.match(String(call("[]").updatedMCPToolOutput), /Cached 0 saved searches/);
  });

  it("one page of a tagged probe is not cached as the whole list", () => {
    const ctx = tmpCtx();
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, periodname: `P${i}`, startdate: "2026-01-01", enddate: "2026-01-31", closed: "F", isyear: "F", isquarter: "F", isadjust: "F" }));
    for (const env of [{ items: rows, hasMore: true }, { items: rows, totalResults: 40 }, { data: rows, hasNextPage: true }]) {
      const out = hso(handlePost(tagged("periods", env), ctx));
      assert.match(String(out.additionalContext), /Tag \[su-ns-harness:periods\] ignored: the result is one page \(5 of (40|more) rows\); a tagged query must return every row/);
    }
    assert.equal(loadManifest(ctx.acctDir!).sections.periods, undefined);
    assert.match(String(hso(handlePost(tagged("periods", { items: rows, hasMore: false, totalResults: 5 }), ctx)).updatedMCPToolOutput), /Cached 5 accounting periods/);
  });

  it("the base currency is read by column name, never the id", () => {
    const ctx = tmpCtx();
    handlePost(tagged("profile:base_currency", { items: [{ currency: "EUR", id: 1 }] }), ctx);
    assert.equal(loadProfile(ctx.acctDir!)?.baseCurrency, "EUR");
    assert.equal(loadProfile(ctx.acctDir!)?.parentSubsidiaryId, "1");
    const empty = tmpCtx();
    handlePost(tagged("profile:base_currency", { items: [{ id: 1, currency: "" }] }), empty);
    const p = loadProfile(empty.acctDir!)!;
    assert.equal(p.baseCurrency, undefined);
    assert.doesNotMatch(profileCard(p), /\| Base currency \| 1 \|/);
  });

  it("the rate-limit counter resets after 5 quiet minutes and says 'hit N times' throughout", () => {
    const ctx = tmpCtx();
    const call = { session_id: "m5", tool_name: T("ns_runReport"), tool_input: { reportId: 1 }, error: "HTTP 429 Too Many Requests" };
    const texts = [1, 2, 3, 4].map(() => String(hso(handleFailure(call, ctx)).additionalContext));
    assert.match(texts[0], /rate_limit \(hit 1 time in a row\)\..*attempt 1 of 3/);
    assert.match(texts[3], /rate_limit \(hit 4 times in a row\)\. NetSuite rate limit \(concurrency\) hit 4 times in a row on this call\. Stop retrying/);
    // Five minutes later it's a new episode.
    const f = path.join(sessionDir(ctx.data, "m5"), "state.json");
    const st = JSON.parse(fs.readFileSync(f, "utf8"));
    for (const v of Object.values(st.rateLimits) as { at: number }[]) v.at -= 5 * 60_000 + 1000;
    fs.writeFileSync(f, JSON.stringify(st));
    assert.match(String(hso(handleFailure(call, ctx)).additionalContext), /rate_limit \(hit 1 time in a row\)/);
    // A success clears it.
    handlePost({ session_id: "m5", tool_name: T("ns_runReport"), tool_input: { reportId: 1 }, tool_response: text('{"data":[]}') }, ctx);
    assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")).rateLimits, {});
  });

  it("governance limits get narrow-the-query advice; a 429 in echoed params isn't a rate limit", async () => {
    const { advice } = await import("../src/errors.ts");
    assert.equal(classifyError("SSS_USAGE_LIMIT_EXCEEDED: Script Execution Usage Limit Exceeded"), "timeout");
    assert.match(advice("timeout", { message: "SSS_USAGE_LIMIT_EXCEEDED" }), /governance \(script usage\) limit.*it's not a rate limit.*Narrow it/);
    assert.notEqual(classifyError("Error loading saved search with params {searchId: 429}. Error: Invalid search"), "rate_limit");
    assert.notEqual(classifyError("Record 429 does not exist"), "rate_limit");
    for (const m of ["HTTP 429: {}", '{"status":429}', "Too Many Requests", "Concurrent request limit exceeded", "The connector's server is rate-limiting requests. You can try again.", "SSS_REQUEST_LIMIT_EXCEEDED"]) assert.equal(classifyError(m), "rate_limit", m);
  });

  it("a base_currency override applies to the parent's own facts too", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_getSubsidiaries"), tool_input: {}, tool_response: text(JSON.stringify([{ id: "1", name: "Parent GmbH" }, { id: "7", name: "Example Inc." }, { id: "-1", name: "Parent GmbH (Consolidated)" }])) }, ctx);
    handlePost(tagged("profile:base_currency_fx", { items: [{ sub: 1, currency: "EUR", n: 100 }, { sub: 7, currency: "USD", n: 50 }] }), ctx);
    handlePost(tagged("profile:ttm_revenue", { data: [{ subsidiary_id: 1, subsidiary: "Parent GmbH", revenue: 10_700_000 }, { subsidiary_id: 7, subsidiary: "Example Inc.", revenue: 9_000_000 }] }), ctx);
    assert.equal(loadProfile(ctx.acctDir!)?.baseCurrency, "EUR");
    const p = setOverrides(ctx.acctDir!, { base_currency: "USD" });
    assert.equal(p.subsidiaryCurrencies?.["1"], "USD");
    const card = profileCard(p);
    assert.match(card, /Parent GmbH USD 10\.7M/);
    assert.match(card, /\| Materiality \| \$50K or 5% \(from the parent subsidiary, Parent GmbH/);
    assert.doesNotMatch(card, /EUR/);
  });

  it("profile set validates keys and values, and an empty value removes an override", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_getSubsidiaries"), tool_input: {}, tool_response: text(JSON.stringify([{ id: "1", name: "Solo Inc" }])) }, ctx);
    handlePost(tagged("profile:base_currency", { items: [{ id: 1, currency: "USD" }] }), ctx);
    for (const [v, n] of [["50k", 50_000], ["50,000", 50_000], ["1.5m", 1_500_000], ["40000", 40_000]] as const) assert.equal(setOverrides(ctx.acctDir!, { materiality_amount: v }).materiality?.amount, n, v);
    const bad: [Record<string, string>, RegExp][] = [
      [{ materiality_amount: "abc" }, /- materiality_amount=abc: expected a positive amount, e\.g\. 50000, 50,000 or 50k/],
      [{ materiality_amount: "1e999" }, /materiality_amount=1e999: expected a positive amount/],
      [{ materiality_amount: "-5" }, /expected a positive amount/],
      [{ materiality_pct: "abc" }, /- materiality_pct=abc: expected a percentage above 0 and at most 100/],
      [{ bogus_key: "1" }, /- bogus_key=1: unknown key \(known: base_currency, fiscal_year_start, oneworld, multibook, ttm_revenue_consolidated, materiality_amount, materiality_pct, approval\.<TypeCode>\)/],
      [{ base_currency: "Euro" }, /expected a 3-letter currency code/],
      [{ oneworld: "maybe" }, /oneworld=maybe: expected yes or no/],
      [{ fiscal_year_start: "13" }, /expected a month/],
    ];
    for (const [pairs, re] of bad) {
      assert.throws(() => setOverrides(ctx.acctDir!, pairs), (e: Error) => /^Invalid profile setting \(nothing was changed\):\n/.test(e.message) && re.test(e.message), JSON.stringify(pairs));
    }
    // One bad pair: nothing is saved.
    assert.throws(() => setOverrides(ctx.acctDir!, { base_currency: "EUR", materiality_pct: "x" }), /Invalid profile setting/);
    assert.equal(loadProfile(ctx.acctDir!)?.baseCurrency, "USD");
    // Normalised forms, and unset brings the derived value back.
    const p = setOverrides(ctx.acctDir!, { base_currency: "eur", fiscal_year_start: "april", ttm_revenue_consolidated: "4,200,000", materiality_pct: "3%" });
    assert.deepEqual([p.baseCurrency, p.fiscalYearStartMonth, p.ttmRevenueConsolidated?.amount, p.materiality?.pct], ["EUR", "Apr", 4_200_000, 3]);
    const u = setOverrides(ctx.acctDir!, { base_currency: "", ttm_revenue_consolidated: "" });
    assert.equal(u.baseCurrency, "USD");
    assert.equal(u.ttmRevenueConsolidated, undefined);
    assert.equal("base_currency" in (u.overrides ?? {}), false);
    assert.equal("ttm_revenue_consolidated" in (u.overrides ?? {}), false);
    assert.doesNotMatch(profileCard(u), /NaN|null%|Infinity/);
  });

  it("not-found advice fits the tool", async () => {
    const { advice } = await import("../src/errors.ts");
    const rec = advice("not_found", { tool: "ns_getRecord", message: "HTTP 404 record instance does not exist" });
    assert.match(rec, /Record not found.*confirm the internal id with a SuiteQL lookup/);
    assert.doesNotMatch(rec, /ns_listAllReports|ns_listSavedSearches/);
    assert.doesNotMatch(advice("not_found", { tool: "ns_getSuiteQLMetadata" }), /ns_listAllReports/);
    assert.match(advice("not_found", { tool: "ns_runReport" }), /Call ns_listAllReports/);
    assert.match(advice("not_found", { tool: "ns_runSavedSearch" }), /Call ns_listSavedSearches/);
  });

  it("empty REST record metadata isn't judged against the SuiteQL table list", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_getSuiteQLMetadata"), tool_input: {}, tool_response: text(JSON.stringify([{ id: "transaction" }, { id: "customer" }])) }, ctx);
    const out = String(hso(handlePost({ tool_name: T("ns_getRecordTypeMetadata"), tool_input: { recordType: "vendorbill" }, tool_response: text('{"success":true,"metadata":{"type":"object"}}') }, ctx)).updatedMCPToolOutput);
    assert.match(out, /no record metadata for 'vendorbill' \(REST record API\)/);
    assert.doesNotMatch(out, /can't see this table|record-type list/);
  });

  it("a single real subsidiary with a consolidated view or an elimination is OneWorld", () => {
    for (const extra of [{ id: "-1", name: "Solo GmbH (Consolidated)" }, { id: "9", name: "Solo - Elimination" }]) {
      const ctx = tmpCtx();
      handlePost({ tool_name: T("ns_getSubsidiaries"), tool_input: {}, tool_response: text(JSON.stringify([{ id: "1", name: "Solo GmbH" }, extra])) }, ctx);
      const p = loadProfile(ctx.acctDir!)!;
      assert.equal(p.oneWorld, true, extra.name);
      assert.equal(p.subsidiaryCount, 1);
      assert.equal(p.parentSubsidiaryId, "1");
    }
    const plain = tmpCtx();
    handlePost({ tool_name: T("ns_getSubsidiaries"), tool_input: {}, tool_response: text(JSON.stringify([{ id: "1", name: "Solo Inc" }])) }, plain);
    assert.equal(loadProfile(plain.acctDir!)?.oneWorld, false);
  });

  it("a spilled content-block array is unwrapped; catalog spill advice doesn't say 'aggregate'", async () => {
    const { resolveSpilled } = await import("../src/mcp.ts");
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-")));
    const results = path.join(home, "projects", "p", "sess", "tool-results");
    fs.mkdirSync(results, { recursive: true });
    const transcript = path.join(home, "projects", "p", "sess.jsonl");
    fs.writeFileSync(transcript, "");
    const file = path.join(results, "x.txt");
    fs.writeFileSync(file, JSON.stringify([{ type: "text", text: JSON.stringify({ items: [{ a: 1 }, { a: 2 }] }) }]));
    const d = resolveSpilled({ text: `Error: result exceeds maximum allowed tokens. Output has been saved to ${file}.\nFormat`, json: undefined, isError: false }, { transcriptPath: transcript, claudeHome: home });
    assert.deepEqual(d.json, { items: [{ a: 1 }, { a: 2 }] });
    const ctx = tmpCtx();
    const out = String(hso(handlePost({ tool_name: T("ns_listSavedSearches"), tool_input: {}, tool_response: "Error: result exceeds maximum allowed tokens. has been saved to /nowhere/tool-results/x.txt" }, ctx)).additionalContext);
    assert.match(out, /It was not cached either\. .*grep it for the entry you need/);
    assert.doesNotMatch(out, /aggregate/);
  });

  it("audit logs are kept (never swept at session start)", () => {
    const ctx = tmpCtx();
    handlePost({ tool_name: T("ns_listAllReports"), tool_input: {}, tool_response: text("[]") }, ctx);
    const dir = path.join(ctx.acctDir!, "audit");
    const f = path.join(dir, fs.readdirSync(dir)[0]);
    const old = new Date(Date.now() - 400 * 86_400_000);
    fs.utimesSync(f, old, old);
    handleSessionStart({ session_id: "l6" }, ctx);
    assert.ok(fs.existsSync(f));
    assert.match(fs.readFileSync(path.join(import.meta.dirname, "..", "README.md"), "utf8"), /kept until you\s+delete its `audit\/` folder/);
  });

  it("unparseable stdin naming a write tool is denied; the message promises no log file", async () => {
    const { processHook } = await import("../src/hooks/io.ts");
    const { failClosedForWrites } = await import("../src/hooks/pre.ts");
    const pre = (i: Parameters<typeof handlePre>[0]) => handlePre(i);
    for (const raw of ['{"tool_name":"mcp__x__ns_deleteRecord","tool_input":{', '{"tool_name": "mcp__x__ns_voidTransaction", oops', 'garbage mcp__x__ns_updateRecord garbage']) {
      const out = JSON.parse(processHook("pre", raw, pre, failClosedForWrites));
      assert.equal(out.hookSpecificOutput.permissionDecision, "deny", raw);
      assert.match(out.hookSpecificOutput.permissionDecisionReason, /run the su-ns-harness:doctor skill/);
      assert.doesNotMatch(out.hookSpecificOutput.permissionDecisionReason, /see the plugin's logs\/hook\.log/);
    }
    assert.equal(processHook("pre", '{"tool_name":"mcp__x__ns_runCustomSuiteQL",', pre, failClosedForWrites), "");
  });

  it("a blank externalId doesn't pass the create check", () => {
    const ctx = tmpCtx({ read_only: "false" });
    for (const ti of [{ recordType: "customer", externalId: " " }, { recordType: "customer", values: { externalId: "\t" } }, { recordType: "customer", externalId: "" }]) {
      assert.match(reason(handlePre({ tool_name: T("ns_createRecord"), tool_input: ti }, ctx)), /Set externalId on every create/, JSON.stringify(ti));
    }
    assert.match(reason(handlePre({ tool_name: T("ns_createRecord"), tool_input: { recordType: "customer", externalId: "claude-1" } }, ctx)), /Writes need a preview first/);
  });

  it("post and failure hooks record the connector too", async () => {
    const { lastConnector } = await import("../src/config.ts");
    const a = tmpCtx();
    handlePost({ tool_name: "mcp__acme__ns_listAllReports", tool_input: {}, tool_response: text("[]") }, a);
    assert.equal(lastConnector(a.data)?.server, "acme");
    const b = tmpCtx();
    handleFailure({ tool_name: "mcp__beta__ns_runReport", tool_input: {}, error: "boom" }, b);
    assert.equal(lastConnector(b.data)?.server, "beta");
  });
});

function setOverridesAndLoad(acctDir: string, pairs: Record<string, string>) {
  setOverrides(acctDir, pairs);
  return buildProfile(acctDir);
}

describe("report range, session context and data dir per install", () => {
  const T = (n: string) => `mcp__netsuite__${n}`;
  const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");
  const report = (reportId: unknown, range: unknown) => ({ session_id: "r7", tool_name: T("ns_runReport"), tool_input: { reportId, subsidiaryId: -1, dateFrom: "2026-01-01", dateTo: "2026-06-30", range } });
  const cacheReports = (ctx: ReturnType<typeof tmpCtx>) =>
    handlePost({
      tool_name: T("ns_listAllReports"),
      tool_input: {},
      tool_response: text(JSON.stringify([
        { id: -200, title: "Income Statement", as_of_format: false, has_subsidiary_filter: true, supports_consolidation: true, supports_range: true },
        { id: 286, title: "A/P Aging Summary", as_of_format: true, has_subsidiary_filter: true, supports_consolidation: true, supports_range: false },
      ])),
    }, ctx);

  it("range MONTH/Month/QUARTER is lowercased before the call, with a note", () => {
    const ctx = tmpCtx();
    heartbeat(ctx.data, "r7", "session-start");
    for (const [v, want] of [["MONTH", "month"], ["Month", "month"], ["QUARTER", "quarter"], [" Year ", "year"], ["WEEK", "week"], ["Day", "day"]]) {
      const out = hso(handlePre(report(-200, v), ctx));
      assert.equal((out.updatedInput as Record<string, unknown>).range, want, v);
      assert.equal((out.updatedInput as Record<string, unknown>).reportId, -200);
      assert.equal(out.permissionDecision, undefined);
      assert.ok(String(out.additionalContext).includes(`range ${JSON.stringify(v)} → "${want}" (the connector only accepts lowercase)`), String(out.additionalContext));
    }
    // Already lowercase, or not a known value: passed through untouched (the Post note covers unknown values).
    for (const v of ["month", "quarter", "period", "Accounting Period", 3]) assert.equal(handlePre(report(-200, v), ctx), undefined, String(v));
  });

  it("range is dropped for a report whose cached supports_range is false", () => {
    const ctx = tmpCtx();
    heartbeat(ctx.data, "r7", "session-start");
    cacheReports(ctx);
    const out = hso(handlePre(report(286, "MONTH"), ctx));
    assert.deepEqual(out.updatedInput, { reportId: 286, subsidiaryId: -1, dateFrom: "2026-01-01", dateTo: "2026-06-30" });
    assert.match(String(out.additionalContext), /report 286 doesn't support range \(column grouping\); removed/);
    assert.doesNotMatch(String(out.additionalContext), /lowercase/);
    // Supported, or not in the cache: kept (and lowercased).
    assert.equal((hso(handlePre(report(-200, "MONTH"), ctx)).updatedInput as Record<string, unknown>).range, "month");
    assert.equal((hso(handlePre(report("-200", "MONTH"), ctx)).updatedInput as Record<string, unknown>).range, "month", "string id");
    assert.equal((hso(handlePre(report(999, "QUARTER"), ctx)).updatedInput as Record<string, unknown>).range, "quarter");
    assert.equal(handlePre(report(-200, "month"), ctx), undefined);
  });

  it("without a SessionStart heartbeat, the first NetSuite call carries the session context once", () => {
    const ctx = tmpCtx();
    const call = (_id: string, session = "reload-1") => ({ session_id: session, tool_name: T("ns_getSubsidiaries"), tool_input: {} });
    const first = String(hso(handlePre(call("1"), ctx)).additionalContext);
    assert.match(first, /SessionStart didn't run in this session.*\/reload-plugins/);
    assert.match(first, /NetSuite \(acct 1234567, production\) — local cache is empty/);
    assert.match(first, /Cache CLI \(not on PATH — always run it exactly like this\): node ".*" <reports search/);
    assert.equal(hso(handlePre(call("2"), ctx)).additionalContext, undefined, "once per session");
    // Merged with the call's own updatedInput and notes.
    const other = hso(handlePre({ ...report(-200, "MONTH"), session_id: "reload-2" }, ctx));
    assert.equal((other.updatedInput as Record<string, unknown>).range, "month");
    assert.match(String(other.additionalContext), /SessionStart didn't run[\s\S]*range "MONTH" → "month"/);
    // A session whose SessionStart fired gets nothing extra.
    heartbeat(ctx.data, "normal", "session-start");
    assert.equal(hso(handlePre(call("3", "normal"), ctx)).additionalContext, undefined);
    // A denied first call doesn't use it up: the next call carries it.
    const denied = hso(handlePre({ session_id: "reload-3", tool_name: T("ns_runCustomSuiteQL"), tool_input: {} }, ctx));
    assert.equal(denied.permissionDecision, "deny");
    assert.doesNotMatch(String(denied.additionalContext ?? ""), /SessionStart/);
    assert.match(String(hso(handlePre(call("4", "reload-3"), ctx)).additionalContext), /SessionStart didn't run/);
    // No session id: nothing to key the flag on, so nothing is injected.
    assert.equal(handlePre({ tool_name: T("ns_getSubsidiaries"), tool_input: {} }, ctx), undefined);
  });

  it("this install's data dir name comes from the cache path or the checkout's marketplace.json", async () => {
    const { ownDataDirName, cliRoot } = await import("../src/config.ts");
    assert.equal(ownDataDirName(path.join(import.meta.dirname, "..")), "su-ns-harness-suiteutils");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nsx-own-"));
    const cached = path.join(tmp, "plugins", "cache", "acme.tools", "su-ns-harness", "0.5.0");
    fs.mkdirSync(path.join(cached, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(cached, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "su-ns-harness" }));
    assert.equal(ownDataDirName(cached), "su-ns-harness-acme-tools");
    const bare = path.join(tmp, "checkout");
    fs.mkdirSync(path.join(bare, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(bare, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "su-ns-harness" }));
    assert.equal(ownDataDirName(bare), undefined, "no marketplace: unknown");
    fs.writeFileSync(path.join(bare, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "other", plugins: [{ name: "something-else" }] }));
    assert.equal(ownDataDirName(bare), undefined, "a marketplace that doesn't list the plugin");
    assert.equal(cliRoot("/p/su-ns-harness/0.5.0/scripts/nsx.mjs"), "/p/su-ns-harness/0.5.0");
    assert.equal(cliRoot("/repo/test/hooks.test.ts"), undefined, "not the CLI");
  });

  it("the CLI prefers this session's dir, then this install's (even before it exists), then the same install root, then the ranking", async () => {
    const { autoDataDirChoice, dataDirChoice } = await import("../src/config.ts");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nsx-r7-"));
    const base = path.join(home, "plugins", "data");
    const mk = (name: string, cache = false) => {
      const dir = path.join(base, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, ".su-ns-harness"), "0.5.0");
      if (cache) {
        fs.mkdirSync(path.join(dir, "accounts", "conn-x"), { recursive: true });
        fs.writeFileSync(path.join(dir, "accounts", "conn-x", "manifest.json"), JSON.stringify({ account: "conn-x", createdAt: "", sections: {} }));
      }
      return dir;
    };
    const saved = { h: process.env.CLAUDE_CONFIG_DIR, d: process.env.NSX_DATA_DIR };
    process.env.CLAUDE_CONFIG_DIR = home;
    try {
      const inline = mk("su-ns-harness-inline", true);
      heartbeat(inline, "old-session", "post");
      const root = path.join(import.meta.dirname, "..");
      // Only the other install's dir exists; this install's is chosen as new, the other is ignored.
      const fresh = autoDataDirChoice([inline], { root })!;
      assert.deepEqual([path.basename(fresh.dir), fresh.reason, fresh.exists, fresh.others], ["su-ns-harness-suiteutils", "install", false, [inline]]);
      assert.equal(fs.existsSync(fresh.dir), false, "choosing it doesn't create it");
      // Its dir exists (even with no cache): chosen over the other install's cache.
      const own = mk("su-ns-harness-suiteutils");
      const c = autoDataDirChoice([inline, own], { root })!;
      assert.deepEqual([c.dir, c.reason, c.exists, c.others], [own, "install", true, [inline]]);
      // This session's hooks wrote to inline: that wins over the install name.
      heartbeat(inline, "sess-now", "pre");
      assert.deepEqual([autoDataDirChoice([inline, own], { root, session: "sess-now" })!.dir, autoDataDirChoice([inline, own], { root, session: "sess-now" })!.reason], [inline, "session"]);
      // Another app of this same install root (install.json, written by the hooks) is used before a new dir.
      fs.rmSync(own, { recursive: true });
      const hooksEnv = { r: process.env.CLAUDE_PLUGIN_ROOT, p: process.env.CLAUDE_PLUGIN_DATA };
      delete process.env.NSX_DATA_DIR;
      process.env.CLAUDE_PLUGIN_ROOT = root;
      process.env.CLAUDE_PLUGIN_DATA = inline;
      try {
        assert.equal(dataDirChoice().dir, inline);
      } finally {
        for (const [k, v] of [["CLAUDE_PLUGIN_ROOT", hooksEnv.r], ["CLAUDE_PLUGIN_DATA", hooksEnv.p]] as const) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
      assert.equal(JSON.parse(fs.readFileSync(path.join(inline, "install.json"), "utf8")).root, fs.realpathSync(root));
      const same = autoDataDirChoice([inline], { root })!;
      assert.deepEqual([same.dir, same.reason], [inline, "same-install"]);
      // Nothing known about this install (not the CLI, no marketplace): the old ranking.
      const other = mk("su-ns-harness-other");
      const ranked = autoDataDirChoice([inline, other], {})!;
      assert.deepEqual([ranked.dir, ranked.reason], [inline, "ranked"]);
    } finally {
      for (const [k, v] of [["CLAUDE_CONFIG_DIR", saved.h], ["NSX_DATA_DIR", saved.d]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("the two-dir notice is due once per session, or once a day without a session id; a changed notice again", async () => {
    const { noticeDue } = await import("../src/cli.ts");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nsx-notice-"));
    const choice = { dir, auto: true, hasCache: false, others: [] };
    assert.equal(noticeDue("a", choice, "s1"), true);
    assert.equal(noticeDue("a", choice, "s1"), false);
    assert.equal(noticeDue("a", choice, "s2"), true);
    assert.equal(noticeDue("b", choice, "s1"), true, "changed");
    const day = new Date("2026-09-28T10:00:00Z");
    assert.equal(noticeDue("a", choice, "", day), true);
    assert.equal(noticeDue("a", choice, "", day), false);
    assert.equal(noticeDue("a", choice, "", new Date("2026-09-29T10:00:00Z")), true, "next day");
  });

  it("preflight before the first hook call names this install's new dir and ignores the other install's cache", async () => {
    const { spawnSync } = await import("node:child_process");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nsx-r7pf-"));
    const inline = path.join(home, "plugins", "data", "su-ns-harness-inline");
    fs.mkdirSync(path.join(inline, "accounts", "conn-d63e"), { recursive: true });
    fs.writeFileSync(path.join(inline, ".su-ns-harness"), "0.0.0");
    fs.writeFileSync(path.join(inline, "accounts", "conn-d63e", "manifest.json"), JSON.stringify({ account: "conn-d63e", createdAt: "", sections: {} }));
    fs.writeFileSync(path.join(inline, "connector.json"), JSON.stringify({ server: "d63e", lastSeen: "2026-09-27T10:00:00Z" }));
    heartbeat(inline, "yesterday", "post");
    const env = { ...process.env, NSX_DATA_DIR: "", CLAUDE_PLUGIN_DATA: "", CLAUDE_PLUGIN_ROOT: "", CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_SESSION_ID: `r7-pf-${path.basename(home)}` };
    for (const k of Object.keys(env)) if (k.startsWith("CLAUDE_PLUGIN_OPTION_")) delete (env as Record<string, string | undefined>)[k];
    const run = (args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], { env, encoding: "utf8" });
    const pf = run(["doctor", "--preflight"]);
    assert.match(pf.stdout, /✓ data dir su-ns-harness-suiteutils \(new, created on the first NetSuite call\) at .*su-ns-harness-suiteutils; su-ns-harness-inline is another install's cache and is ignored\n/);
    assert.doesNotMatch(pf.stdout, /cache keyed by connector d63e/, "the other install's connector isn't reported as this one's");
    assert.match(pf.stdout, /no NetSuite call seen yet/);
    assert.doesNotMatch(pf.stdout, /The cache is split/);
    const st = run(["cache", "status"]);
    assert.match(st.stderr, /^nsx: using su-ns-harness-suiteutils \(this install's data dir; new, created on the first NetSuite call\); su-ns-harness-inline is another install's cache and is ignored/);
    assert.equal(fs.existsSync(path.join(home, "plugins", "data", "su-ns-harness-suiteutils")), false, "read commands don't create it");
  });
});
