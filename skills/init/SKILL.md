---
name: init
description: Set up su-ns-harness for a NetSuite account — preflight checks, fill the local metadata cache, build the account Profile Card. Run it yourself before the first NetSuite answer when the session context says the local cache is empty; it needs nothing from the user.
argument-hint: "[--skip-probes]"
---

# /su-ns-harness:init

**`nsx` is not on PATH.** Run every `nsx …` below with the exact command on the `Cache CLI:` line of the session context (it has the absolute path). Only if that line is missing, use `node "${CLAUDE_PLUGIN_ROOT}/scripts/nsx.mjs" …` (Bash); Claude Code fills in that path when it loads this skill. If that fails too (`Cannot find module`, or the path isn't absolute), find the script with `ls -dt "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/su-ns-harness/*/scripts/nsx.mjs | head -1` (newest install first) and run `node "<the path it prints>" …`; if it prints nothing, the plugin isn't installed.

Work through the steps in order. Make **every NetSuite call sequentially — never in parallel**,
and run `sleep 5` between NetSuite calls: the account's integration concurrency is shared with its
other integrations. If `sleep` is refused, run it in the background or just wait before the next
call. Tell the user up front that init can take 10–15 minutes on a busy account.
The hooks cache each catalog result and return a one-line `Cached …` confirmation, so these calls
cost almost no context. Tell the user briefly what you're doing at each step.

## 1. Preflight

Run `nsx doctor --preflight`.

- Node missing or < 18 → stop; show the install hint it prints.
- `data dir none yet` is normal before the first NetSuite call: the hooks create it. Continue.
  Step 2's first call shows whether the hooks run.
- Check your own tool list for NetSuite tools. Match on the **end of the name**
  (`ns_runCustomSuiteQL`, `ns_listAllReports`, …); the prefix differs per install
  (`mcp__netsuite__…`, or `mcp__<id>__…` for a claude.ai connector). If there are none, stop and
  show the user how to connect Oracle's NetSuite AI Connector. First, in NetSuite: install the
  **MCP Standard Tools** SuiteApp and give the user's role the "MCP Server Connection" permission.
  Then one of:
  - **claude.ai connector** (Claude desktop app, claude.ai, or Claude Code signed in with a
    claude.ai account): Settings → Connectors → NetSuite → Connect, then enable it for this
    session (in the Claude desktop app: the composer's **+** menu → Connectors → NetSuite).
    If it's already connected but no tools show, it's most likely disabled for the session.
  - **Claude Code MCP server**: `claude mcp add --transport http netsuite <MCP server URL>`, using
    the server URL on NetSuite's AI Connector Service setup page, then `/mcp` → netsuite →
    Authenticate.

  Then re-run `/su-ns-harness:init`.

No account id is needed: the harness keys its cache by the connector these calls go through.
Tell the user which connector you're using (the server part of the tool names).

## 2. Catalog calls (one at a time)

The first call is also the hook check: its result must come back as one
`[su-ns-harness] Cached … subsidiaries` line. If it comes back as the raw subsidiary list, the
plugin's hooks aren't running in this session, so nothing would be cached. Stop and tell the user:
"su-ns-harness isn't active in this session yet. Run /reload-plugins (or start a new session),
then run /su-ns-harness:init again." This is typical right after installing the plugin mid-session.

1. `ns_getSubsidiaries`
2. `ns_getAccountingBooks`
3. `ns_listAllReports`
4. `ns_listSavedSearches`
5. `ns_getSuiteQLMetadata` with no arguments (record type list)
6. `ns_getSuiteQLMetadata` with `recordType` set to each of the GL core: transaction,
   transactionline, transactionaccountingline, account, accountingperiod. Skip any not in the
   record type list (`nsx recordtypes --grep <name>`). Other tables are fetched on first use: when
   a query touches a table whose fields aren't cached, the guard asks for its metadata first.

`The connector exposes no field metadata for '<table>'` is normal for some tables (on many
accounts `transaction` always comes back empty). It is not a failure: the table still works in
SuiteQL, the harness just can't check its column names. Don't retry, and don't list it as a
failure in the report. Only a table missing from the record type list is a real visibility gap.

If a call fails, follow the `[su-ns-harness]` recovery line and continue with the next one.

## 3. Profile probes

Skip this step if init was started with `--skip-probes` (init arguments, if any: $ARGUMENTS).
Otherwise run each query with `ns_runCustomSuiteQL`, **with the description exactly as given**
(the tag tells the hook to cache it) and no `pageSize` or `pageIndex` (a single page isn't cached). If the guard says to skip a
probe (its table isn't visible to the role), or one fails, note it and move on; the user can fill
gaps in step 5.

| description | sqlQuery |
|---|---|
| `Accounting periods [su-ns-harness:periods]` | `SELECT id, periodname, TO_CHAR(startdate,'YYYY-MM-DD') AS startdate, TO_CHAR(enddate,'YYYY-MM-DD') AS enddate, closed, isyear, isquarter, isadjust FROM accountingperiod ORDER BY startdate` |
| `Base currency [su-ns-harness:profile:base_currency]` | `SELECT s.id, BUILTIN.DF(s.currency) AS currency FROM subsidiary s WHERE s.parent IS NULL` |
| `Subsidiary currencies [su-ns-harness:profile:base_currency_fx]` | `SELECT tl.subsidiary AS sub, BUILTIN.DF(t.currency) AS currency, COUNT(*) AS n FROM transaction t JOIN transactionline tl ON tl.transaction = t.id WHERE tl.mainline = 'T' AND t.exchangerate = 1 AND t.trandate >= ADD_MONTHS(SYSDATE, -1) GROUP BY tl.subsidiary, BUILTIN.DF(t.currency)` |
| `Approval status usage [su-ns-harness:profile:approval_workflows]` | `SELECT t.type, COUNT(t.approvalstatus) AS with_status, COUNT(*) AS total FROM transaction t WHERE t.trandate >= ADD_MONTHS(SYSDATE, -12) AND t.type IN ('VendBill','PurchOrd','Journal','ExpRept','SalesOrd','CustInvc','VendPymt','CustCred') GROUP BY t.type` |
| `TTM revenue [su-ns-harness:profile:ttm_revenue]` | `SELECT tl.subsidiary AS subsidiary_id, BUILTIN.DF(tl.subsidiary) AS subsidiary, SUM(tal.amount) * -1 AS revenue FROM transactionaccountingline tal JOIN transaction t ON t.id = tal.transaction JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline JOIN account a ON a.id = tal.account WHERE UPPER(a.accttype) = 'INCOME' AND tal.posting = 'T' AND t.trandate >= ADD_MONTHS(SYSDATE, -12) GROUP BY tl.subsidiary, BUILTIN.DF(tl.subsidiary)` |

Run **Subsidiary currencies** only if the guard skipped **Base currency** or it returned no rows
(on many accounts the role can't see `subsidiary`). It reads each subsidiary's currency from its
own transactions at exchange rate 1; the parent is the subsidiary named in the `(Consolidated)`
entry of the subsidiary list.

The hook caches a tagged result only when its SQL is exactly the one above (spacing and letter
case aside), so copy it as is. Anything else, such as an extra filter or other columns, isn't
cached (`Tag … ignored: not the init query`). An empty periods result, or one less than half the
size of the cached list, never replaces it.

TTM revenue is grouped by subsidiary on purpose: `transactionaccountingline.amount` is in each
subsidiary's base currency, so one total would add EUR, USD, AUD… together. There's no
`tal.accountingbook` filter because the connector's book list (`ns_getAccountingBooks`) sends only
id and name, with no primary-book flag; on the live multi-book account tested, only primary-book
rows came back without the filter.

(Non-OneWorld accounts, or roles that can't see `subsidiary`: the base-currency probe returns
nothing or is skipped, and Subsidiary currencies fills in; if the card still says unknown, step 5
asks the user. Custom fields need no probe: they're in the cached
field metadata, e.g. `nsx fields transaction --grep custbody`.)

Then get the group's revenue from the consolidated Income Statement (one report call):

1. Run `nsx profile ttm-report`. It prints the `ns_runReport` input: the standard Income Statement,
   the consolidated subsidiary, and the last 12 complete accounting periods from the periods cache
   (e.g. Sep 2025 – Aug 2026), or the 12 months to today if periods aren't cached.
2. Call `ns_runReport` with exactly that input.
3. Run `nsx profile from-report <result_id>` with the id from the result's summary. It stores the
   Sales line as consolidated TTM revenue. If the result came back inline with no id, read the Sales
   amount and run `nsx profile set ttm_revenue_consolidated=<amount>`. If the report fails or
   `ttm-report` finds no Income Statement, note it and move on.

## 4. Build

Run `nsx cache build`. It rebuilds the profile and prints the Profile Card.

## 5. Confirm the Profile Card

Show the user the Profile Card and ask them to confirm or correct it. If **Base currency** is
unknown, ask for it directly (e.g. "What's the parent subsidiary's currency: EUR, USD, …?"). If it
says "from transactions at rate 1; confirm", ask the user to confirm it.

The card shows consolidated TTM revenue (in the base currency) when the report step worked, and
TTM revenue per subsidiary as detail, each in its own currency and not converted. Materiality comes
from the consolidated figure; without one, from the parent subsidiary's revenue; failing that, from
the largest subsidiary's, marked "currencies differ" or "may differ". Ask the user to confirm the
materiality amount, in the base currency (e.g. "Materiality is EUR 50K, derived from consolidated
revenue. Is that right for the group?"), and set what they answer with `materiality_amount`. Apply
corrections with `nsx profile set key=value …` (keys: `base_currency`, `fiscal_year_start` (e.g.
Apr), `oneworld`, `multibook`, `ttm_revenue_consolidated`, `materiality_amount`, `materiality_pct`,
`approval.<TypeCode>=yes|no`). Values are checked: amounts like `50000`, `50,000`, `50k`, `1.5m`;
`materiality_pct` 0–100 (a trailing `%` is fine); `base_currency` a 3-letter code; `fiscal_year_start`
a month (`Apr`, `April` or `4`); yes/no for the flags. An empty value (`key=`) removes the override.
If any pair is rejected, nothing is saved: fix it and run the whole command again.

## 6. Report

Run `nsx cache status` and tell the user in a few lines: sections cached (with counts), anything
unparsed or failed, how long init took, and that future sessions start with this context
automatically. Mention `/su-ns-harness:refresh` for updates, and the write setting
(`nsx config show`; writes are off by default, and the user turns them on themselves: they run
`node "<the nsx.mjs path on the Cache CLI: line>" config set read_only=false` in their own
terminal, the same command the write guard prints when it blocks a write; never do it for them). Other settings: `nsx config set key=value`.
