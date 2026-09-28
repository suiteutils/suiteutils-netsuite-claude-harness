---
name: refresh
description: Refresh su-ns-harness's local NetSuite cache — the stale sections by default, or a named one (periods, reports, searches, fields <table>, profile…). Run it yourself, without asking, when the session context lists Stale sections you need for the answer or a cached lookup says STALE; it only re-reads catalog data and changes nothing in NetSuite.
argument-hint: "[stale|all|reports|searches|periods|subsidiaries|books|recordtypes|fields <table>|profile]"
---

# /su-ns-harness:refresh

**`nsx` is not on PATH.** Run every `nsx …` below with the exact command on the `Cache CLI:` line of the session context (it has the absolute path). Only if that line is missing, use `node "${CLAUDE_PLUGIN_ROOT}/scripts/nsx.mjs" …` (Bash); Claude Code fills in that path when it loads this skill. If that fails too (`Cannot find module`, or the path isn't absolute), find the script with `ls -dt "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/su-ns-harness/*/scripts/nsx.mjs | head -1` (newest install first) and run `node "<the path it prints>" …`; if it prints nothing, the plugin isn't installed. Target: `$ARGUMENTS` (empty = `stale`).

Make NetSuite calls **one at a time**. The hooks re-cache each result automatically. On a rate
limit, follow the `[su-ns-harness]` recovery line (it gives the `sleep`); if `sleep` is refused,
run it in the background or just wait before the next call.

When you run this on your own before answering, refresh only the stale sections the answer needs,
and tell the user in one line what you refreshed.

1. Run `nsx cache status` to see sections, counts, ages and stale flags. Keep this output: step 5
   compares against it.
2. Work out which sections to refresh:
   - `stale` → every section whose status is `stale`
   - `all` → every section in the status list
   - `reports`, `searches`, `subsidiaries`, `books`, `periods`, `recordtypes` → that section
   - `fields <table>` → `fields/<table>`
   - `profile` → the `probe/*` sections and `periods`, then consolidated TTM revenue again (below)
3. Refresh each section with its source call:

| Section | Call |
|---|---|
| reports | `ns_listAllReports` |
| searches | `ns_listSavedSearches` |
| subsidiaries | `ns_getSubsidiaries` |
| books / contexts / nexus | `ns_getAccountingBooks` / `ns_getAccountingContexts` / `ns_getNexusIds` |
| recordtypes | `ns_getSuiteQLMetadata` (no arguments) |
| fields/&lt;table&gt; | `ns_getSuiteQLMetadata` with `recordType: "<table>"` |
| recordmeta/&lt;type&gt; | `ns_getRecordTypeMetadata` for that type |
| periods, probe/&lt;name&gt; | `ns_runCustomSuiteQL` with the description and SQL from the table below |

### periods and probe/* (tagged queries)

Run `ns_runCustomSuiteQL` with the **description exactly as given** and the SQL copied exactly
(spacing and letter case aside), with no `pageSize` or `pageIndex` (the guard leaves these queries
unpaged; a single page isn't cached). The hook caches a tagged result only when its SQL is exactly this
one; anything else, such as an extra filter or other columns, isn't cached (`Tag … ignored: not the
init query`). Section `periods` is the first row; `probe/<name>` is the row tagged
`[su-ns-harness:profile:<name>]`.

| description | sqlQuery |
|---|---|
| `Accounting periods [su-ns-harness:periods]` | `SELECT id, periodname, TO_CHAR(startdate,'YYYY-MM-DD') AS startdate, TO_CHAR(enddate,'YYYY-MM-DD') AS enddate, closed, isyear, isquarter, isadjust FROM accountingperiod ORDER BY startdate` |
| `Base currency [su-ns-harness:profile:base_currency]` | `SELECT s.id, BUILTIN.DF(s.currency) AS currency FROM subsidiary s WHERE s.parent IS NULL` |
| `Subsidiary currencies [su-ns-harness:profile:base_currency_fx]` | `SELECT tl.subsidiary AS sub, BUILTIN.DF(t.currency) AS currency, COUNT(*) AS n FROM transaction t JOIN transactionline tl ON tl.transaction = t.id WHERE tl.mainline = 'T' AND t.exchangerate = 1 AND t.trandate >= ADD_MONTHS(SYSDATE, -1) GROUP BY tl.subsidiary, BUILTIN.DF(t.currency)` |
| `Approval status usage [su-ns-harness:profile:approval_workflows]` | `SELECT t.type, COUNT(t.approvalstatus) AS with_status, COUNT(*) AS total FROM transaction t WHERE t.trandate >= ADD_MONTHS(SYSDATE, -12) AND t.type IN ('VendBill','PurchOrd','Journal','ExpRept','SalesOrd','CustInvc','VendPymt','CustCred') GROUP BY t.type` |
| `TTM revenue [su-ns-harness:profile:ttm_revenue]` | `SELECT tl.subsidiary AS subsidiary_id, BUILTIN.DF(tl.subsidiary) AS subsidiary, SUM(tal.amount) * -1 AS revenue FROM transactionaccountingline tal JOIN transaction t ON t.id = tal.transaction JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline JOIN account a ON a.id = tal.account WHERE UPPER(a.accttype) = 'INCOME' AND tal.posting = 'T' AND t.trandate >= ADD_MONTHS(SYSDATE, -12) GROUP BY tl.subsidiary, BUILTIN.DF(tl.subsidiary)` |

- For `periods`, run `nsx cache invalidate periods` before the query. A result that would empty a
  cached section or shrink it to less than half isn't stored (`periods 319 → 10: not replaced, the
  cached copy was kept`), which protects the cache from a partial result; if a catalog section
  really shrank, run `nsx cache invalidate <section>` and the call again.
- Run **Subsidiary currencies** only if the guard skipped **Base currency** (the role can't see
  `subsidiary`) or it returned no rows, or if `probe/base_currency_fx` is the section being
  refreshed.
- A catalog response the hook can't parse keeps the cached copy (the result shows the response
  text): report it, don't retry in a loop.
- If the guard says to skip a probe (its table isn't visible to the role), or one fails, note it
  and move on.

For `profile`, after the probes get consolidated TTM revenue again (one report call):
1. Run `nsx profile ttm-report`; it prints the `ns_runReport` input.
2. Call `ns_runReport` with exactly that input.
3. Run `nsx profile from-report <result_id>` with the id from the result's summary. If the result
   came back inline with no id, read the Sales amount and run
   `nsx profile set ttm_revenue_consolidated=<amount>`. If the report fails, note it and move on.

4. Run `nsx cache build`, then `nsx cache status`.
5. Compare the new `nsx cache status` with the one from step 1 and tell the user what changed in one
   or two lines: sections refreshed, count differences (e.g. "reports 412 → 415"), and for periods
   the open periods before and after (`nsx periods --open`). There is no automatic diff yet.
