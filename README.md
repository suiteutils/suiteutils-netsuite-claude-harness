# suiteutils-netsuite-claude-harness

**Ask Claude about your NetSuite numbers without burning your context on raw rows, or trusting a
query that quietly returns the wrong total.**

This is a Claude Code plugin for Oracle's NetSuite AI Connector. It doesn't replace the connector.
It wraps every call Claude makes to it: catalogs are cached on your machine, large results are
saved to a file and summarised, SuiteQL is checked before it runs, errors come back with a next
step, and writes stay off until you turn them on.

Built by [Suite Utils](https://suiteutils.com/open-source/netsuite-claude-harness/). Not affiliated with Oracle or Anthropic.

**Docs:** [install](https://suiteutils.com/docs/netsuite-claude-harness/installation/) · [quickstart](https://suiteutils.com/docs/netsuite-claude-harness/quickstart/) ·
[settings](https://suiteutils.com/docs/netsuite-claude-harness/settings/) · [SuiteQL checker](https://suiteutils.com/docs/netsuite-claude-harness/suiteql-checker/) ·
[troubleshooting](https://suiteutils.com/docs/netsuite-claude-harness/troubleshooting/). The full set is at
[suiteutils.com/docs/netsuite-claude-harness](https://suiteutils.com/docs/netsuite-claude-harness/).

**Oracle:** [NetSuite AI Connector Service](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_7200233106.html) ·
[get started](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_3200541651.html) · [MCP Standard Tools SuiteApp](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_143403258.html)
([tools](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0902023508.html)) · [SuiteQL](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156257770590.html) ·
[Oracle's connector skill](https://github.com/oracle/netsuite-suitecloud-sdk/blob/master/packages/agent-skills/netsuite-ai-connector-instructions/SKILL.md).

## Why not just Oracle's skill?

Oracle publishes a skill for the connector,
[`netsuite-ai-connector-instructions`](https://github.com/oracle/netsuite-suitecloud-sdk/blob/master/packages/agent-skills/netsuite-ai-connector-instructions/SKILL.md). It's a good set
of instructions, and this plugin's `netsuite` skill is derived from it. But a skill is only text:
it can ask Claude to be careful, and it can't change what the connector sends back. This plugin
adds code that runs before and after every connector call, and it fixes the mistakes in Oracle's
templates.

| | Oracle's skill | This plugin |
|---|---|---|
| Report lists, saved searches, field metadata | Fetched from NetSuite whenever Claude needs them | Fetched once, cached locally, searched with `nsx`. A second session answers "which report shows AR aging?" with no connector call |
| A 3,000-row query result | All of it lands in Claude's context | Saved to a local file. Claude gets a summary (under 1,500 characters) and a result id, then totals or filters the file |
| Row caps (`ROWNUM`) | Templates put `ROWNUM` next to `GROUP BY`/`ORDER BY`, which caps rows *before* aggregating or sorting: wrong totals, wrong top-N | The query is blocked and Claude gets it rewritten with `FETCH FIRST`. Moving `ROWNUM` to an outer query doesn't help: on a live account NetSuite still applied it before the inner `GROUP BY`, so that's blocked too |
| `type` vs `recordtype` values | Mixed up in places | Swapped values are blocked, with the right value |
| `approvalstatus` filters | Applied broadly | Allowed only on types where your account uses approvals. Elsewhere the field is empty and the filter returns zero rows |
| Account facts (currency, fiscal year, subsidiaries, open periods) | Looked up again in each new session | A short profile is loaded at the start of every session |
| Rate limits, auth and field errors | General advice in the text; Claude decides what to do | Classified, with a recovery step: sequential retries after about 5s, 10s and 20s, "reconnect via /mcp", stale field cache refreshed |
| Creates and updates | A request in the text to confirm first | Blocked by default. When enabled: preview, exact-input match, your approval prompt, audit log |

## How it works

Take "top 20 customers by open AR". Claude checks the cached field list with `nsx` instead of
calling the metadata tool, then writes SuiteQL. Before the call goes out, the plugin checks the
query. A `ROWNUM <= 20` next to the `GROUP BY` is blocked and sent back rewritten as `ORDER BY …
FETCH FIRST 20 ROWS ONLY`, so the totals are right. When the result arrives, the plugin saves it
to a file and hands Claude the row count, column stats and first rows. If Claude needs other cuts
of the same data, it runs `nsx results agg` on the file instead of querying NetSuite again.

Four Claude Code hooks do the work, all matching the connector's `ns_*` tools under whatever name
you gave the server:

| Hook | What it does |
|---|---|
| SessionStart | Adds the account profile and any stale cache sections to the session context. After `/reload-plugins`, when SessionStart doesn't run, the first NetSuite call carries this context instead |
| PreToolUse | Checks SuiteQL, adds default row caps, blocks writes (or requires a preview and your approval) |
| PostToolUse | Caches catalog results, saves large results to files and replaces them with a summary, writes the audit log |
| PostToolUseFailure | Classifies the error and adds the next step |

If a hook fails for any reason, the call goes through untouched, except writes: a write the plugin
couldn't check is blocked.

## What gets installed

- **Hooks**: the four above, registered by the plugin. They only fire on `ns_*` connector tools.
- **Skills**: `netsuite` (loads automatically for NetSuite questions), plus `/su-ns-harness:init`,
  `/su-ns-harness:refresh` and `/su-ns-harness:doctor`.
- **Agent**: `ns-explorer`, for open-ended "which table holds X?" exploration. It works in its own
  context and returns only the conclusion.
- **CLI**: one bundled Node script, `scripts/nsx.mjs`, with no dependencies. Claude runs it for
  cache lookups and result analysis. It is not added to your PATH.

The plugin adds no MCP server, runs no background process, makes no network calls of its own and
doesn't touch the connector's configuration or OAuth. It writes only to its own data directory
under `~/.claude/plugins/data/`, and to your project only when you export something.

## Install

### Before you start

1. **Claude Code** (the CLI, the desktop app or an IDE extension).
2. **Node.js 18 or newer on your PATH.** The hooks run with `node`. Check with `node --version`.
3. **The NetSuite AI Connector, connected and enabled.** In NetSuite,
   [install the **MCP Standard Tools** SuiteApp](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0902023450.html) and give your role
   the "MCP Server Connection" permission (Oracle's
   [getting-started guide](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_3200541651.html) covers both). Then
   [connect it](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_0714082142.html) one of two ways; the plugin works with either:
   - **As a claude.ai connector** (desktop app, or Claude Code signed in with a claude.ai
     account): Settings → Connectors → NetSuite → Connect. Then make sure it's enabled for the
     session; in the desktop app, open the composer's **+** menu → Connectors.
   - **As a Claude Code MCP server**:
     `claude mcp add --transport http netsuite <MCP server URL>` with the URL from NetSuite's AI
     Connector Service setup page, then `/mcp` → netsuite → Authenticate.

### Steps

1. Add the marketplace and install the plugin:
   ```
   /plugin marketplace add suiteutils/suiteutils-netsuite-claude-harness
   /plugin install su-ns-harness@suiteutils
   ```
2. There's no account id to enter. The harness never connects to NetSuite itself: the connector
   does. Each connector reaches one account, so the harness keys its cache by the connector the
   calls go through.
3. Run `/reload-plugins`, or start a new Claude Code session. Until you do, don't count on any of
   it: a plugin installed mid-session may load late or only partly. The profile context arrives
   with the next session start.
4. Ask Claude a NetSuite question, or run `/su-ns-harness:init`. With an empty cache, Claude runs
   init by itself first. It checks Node and the connector, calls the catalog tools one at a time,
   fetches field metadata for the GL core tables, runs a few small profile queries and the
   consolidated Income Statement, and shows you a Profile Card to confirm. Other tables' fields
   are fetched the first time a query uses them. Init uses very little context, because each
   result is cached and Claude only sees a one-line confirmation. It paces its calls, so expect a
   few minutes, or 10–15 on an account whose integration concurrency is shared with busy
   integrations.
5. If anything looks wrong, run `/su-ns-harness:doctor`.

### Rules worth knowing

- **One cache per connector.** Production and sandbox are separate connectors, so they never
  share data. Switching connectors switches the cache; the other one stays on disk. The CLI and
  the session context use the connector of the most recent NetSuite call.
- **One account through two connectors** (say, the claude.ai connector in the desktop app and a
  Claude Code MCP server) gets two caches. To share one, run
  `nsx config set account_id=… environment=…`: they then key the cache instead of the connector.
- **Remove Oracle's skill if you added it** (Oracle's
  [guide to skills with Claude](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0611102646.html) suggests adding it). Both skills
  would load for the same questions and give Claude conflicting instructions, including the
  `ROWNUM` pattern this plugin blocks.
- **Run `/reload-plugins` (or start a new session) after installing or updating.** A mid-session
  install may load late or only partly.
- **Writes stay off** until you run `nsx config set read_only=false` in your own terminal (Claude
  prints the exact command). Then every create or update needs a preview and your approval.
- **Tables the connector role can't see are skipped, not retried.** A query on a table missing
  from the cached record-type list is denied before the call. Init reports these tables (with no
  access to `subsidiary`, base currency is inferred from transactions at exchange rate 1 and marked
  for you to confirm). After widening the role's permissions, run
  `/su-ns-harness:refresh recordtypes` (or `/su-ns-harness:refresh all`) to fill the gaps.
- **Two Claude apps can mean two caches.** The desktop app and Claude Code may give the plugin
  different data directories (seen live: `su-ns-harness-inline` and `su-ns-harness-suiteutils`).
  `nsx` uses the data directory Claude Code gives its own install (`<plugin>-<marketplace>`, e.g.
  `su-ns-harness-suiteutils`), even before the first NetSuite call creates it; other installs'
  directories are ignored and named once per session on stderr. `nsx doctor` names both. Set
  `NSX_DATA_DIR` to the same dir in every app to share one cache.
- **Cowork and claude.ai don't run plugin hooks yet**, so only the skill's guidance applies there.
  See [Cowork and claude.ai](#cowork-and-claudeai).

### Update and uninstall

- Update: `/plugin marketplace update suiteutils`, then run `/reload-plugins` or start a new session.
- Uninstall: `/plugin uninstall su-ns-harness@suiteutils`. The cache, saved results and audit log
  stay in the plugin's folder under `~/.claude/plugins/data/` until you delete it.

## Commands

| Command | What it does |
|---|---|
| `/su-ns-harness:init` | First-time setup: fill the cache, build the Profile Card |
| `/su-ns-harness:refresh [stale\|all\|reports\|searches\|periods\|subsidiaries\|books\|recordtypes\|fields <table>\|profile]` | Refresh cache sections (stale ones by default). Claude also runs it by itself when a section it needs is stale |
| `/su-ns-harness:doctor` | Check Node, settings, hooks, cache freshness and whether the connector answers. Claude also runs it by itself when the harness looks broken |

Claude drives the `nsx` CLI itself, and you can run it too. It isn't on your PATH, so call it as
`node <plugin dir>/scripts/nsx.mjs` (shortened to `nsx` below). To find the plugin dir, run `ls
-dt ~/.claude/plugins/cache/*/su-ns-harness/*/scripts/nsx.mjs | head -1`. It works on the data the
hooks create, so start one Claude Code session with the plugin enabled first.

```
nsx help
nsx reports search aging
nsx fields transaction --grep amount
nsx results agg r_7f3a2c --by entity --sum amount --top 20
nsx results head r_7f3a2c 10 --sort amount
nsx results export r_7f3a2c --xlsx
nsx sql lint "SELECT entity, SUM(foreigntotal) FROM transaction WHERE ROWNUM <= 100 GROUP BY entity"
nsx audit export
```

The `sql lint` example exits with status 1 on purpose: that query has the `ROWNUM` bug the
checker catches.

## Settings

Nothing needs setting: install, run `/reload-plugins` (or start a new session), and ask Claude a
NetSuite question. Every setting has a working default. To change one, ask Claude, or run `nsx
config set key=value` (`nsx config show` lists them; an empty value resets to the default).
Changes apply to the next NetSuite call, no restart. Turning writes on (`read_only=false`) is left
to you: Claude is told not to do it, and `nsx config set` refuses it without a terminal, which
stops accidental changes. It isn't a hard lock (the setting lives in a plain `settings.json`), but
every write still needs your approval in Claude Code's permission prompt.

| Setting | Default | |
|---|---|---|
| `account_id` | (empty) | Optional. Keys the cache instead of the connector, so one account reached through several connectors shares a cache |
| `environment` | production | `production` or `sandbox`; only used with `account_id` |
| `read_only` | true | Block all creates and updates |
| `inline_max_chars` | 6000 | Results larger than this go to a file |
| `saved_search_default_rows` | 200 | Row cap added to saved searches without `range_end` |
| `suiteql_default_page_size` | 500 | `pageSize` (with `pageIndex: 0`) added to SuiteQL without one, so a query returns one page |
| `results_retention_days` | 7 | Saved results are deleted after this |
| `ttl_overrides` | (none) | Days before a cache section is stale, e.g. `searches=2, periods=0.5` |

## What the checker catches

| Rule | Action |
|---|---|
| `ROWNUM` at the same level as `GROUP BY`/aggregates | Deny, even with `[nolint]`; rewritten with `FETCH FIRST` |
| `ROWNUM` in a subquery that feeds an aggregate | Deny |
| `ROWNUM` at the same level as `ORDER BY` (wrong top-N) | Deny, rewritten with `FETCH FIRST` |
| `SELECT * FROM (<aggregated or sorted query>) WHERE ROWNUM <= N` (NetSuite applies the outer `ROWNUM` first; verified live) | Deny, even with `[nolint]`; rewritten with `FETCH FIRST` |
| `LIMIT n` (not SuiteQL) | Deny, rewritten as `FETCH FIRST n ROWS ONLY` |
| `LIMIT n OFFSET m` | Deny, even with `[nolint]` (the `OFFSET` rule fires too); page with `pageSize` + `pageIndex` and a unique `ORDER BY` |
| `OFFSET n ROWS` with n > 0, e.g. `OFFSET 100 ROWS FETCH NEXT 100 ROWS ONLY` (NetSuite ignores the `OFFSET` and returns the first rows again; verified live) | Deny, even with `[nolint]`. When n is a multiple of m (m ≥ 5), the suggested fix is `pageSize: m, pageIndex: n/m` with both clauses removed; otherwise page with `pageSize` + `pageIndex`, or `WHERE t.id > <last id>` |
| `x.col` where `x` isn't a table or alias in `FROM`/`JOIN` (this query or an enclosing one) | Deny |
| `ROWNUM > n` (n ≥ 1), `ROWNUM = n`, `>= n` or `BETWEEN n AND …` with n > 1, or `ROWNUM <> 1` (never matches a row) | Deny, even with `[nolint]` |
| An incomplete query (`SELECT` with no column list or no `FROM <table>`, e.g. an unquoted query cut short on the command line) | Deny |
| `WITH` / CTEs (Oracle: "You can't use WITH clauses") | Deny; rewrite as a `FROM` subquery |
| Functions SuiteQL doesn't support (`LEFT`, `RIGHT`, `SUBSTRING`, `CHARINDEX`, `CEILING`, `LISTAGG`, `DATEDIFF`, …) | Deny, with the supported alternative (`SUBSTR`, `INSTR`, `CEIL`, …) |
| `DATE '…'` / `TIMESTAMP '…'` literals | Deny; use `TO_DATE(…)` |
| `+` next to a string literal, or next to a column the cached metadata types as string (`a.acctnumber + a.acctname`) | Deny; use `\|\|` |
| More than 1000 items in one `IN (…)` | Deny |
| `(+)` outer joins mixed with ANSI `JOIN … ON` in one query block | Deny |
| `(+)` on the left of `=` (Oracle right outer join) | Deny; swap the operands |
| `[bracketed]` identifiers | Deny |
| Anything but a `SELECT` query (`DELETE`, `UPDATE`, `DROP`…). The connector only runs read-only queries anyway; this fails fast with a clear message naming the statement | Deny, even with `[nolint]` |
| More than one statement (`SELECT …; SELECT …`; a single trailing `;` is fine) | Deny, even with `[nolint]` |
| HTML-escaped operators outside string literals (`&lt;=`, `&gt;`, `&amp;`, `&#60;`) | Deny, even with `[nolint]`, naming the entity |
| `SELECT *` on a table (probes with `FETCH FIRST 1` / `ROWNUM <= 1` are fine) | Deny |
| `type = 'invoice'` or `recordtype = 'CustInvc'` (codes and record ids swapped) | Deny, with the right value |
| A `type` or `recordtype` value the harness doesn't know (its lists aren't complete) | Warn: the value may still be right; check it if the query returns nothing |
| `approvalstatus` filter on a type the account doesn't use approvals for | Deny |
| A table missing from the cached record-type list (the connector role can't see it) | Deny before the call (`[nolint]` overrides, in case the list is out of date) |
| Column missing from the connector's field metadata for a cached table | Warn, with the closest name (`amout` → `amount`). The metadata is incomplete (`transactionline.amount`, for one, works but isn't listed), so it isn't denied. A bad column fails with a generic "unexpected SuiteScript error" that doesn't name the field, so the warning names it |
| Summing `transactionline` amounts without a mainline filter | Warn |
| `SUM(foreigntotal)` / `SUM(foreignamount)` without `currency` in the `GROUP BY` (adds currencies together) | Warn, suggesting a base amount per subsidiary, the consolidated report / `BUILTIN.CONSOLIDATE`, or `BUILTIN.CURRENCY_CONVERT`. Neither SUM rule fires on a count like `SUM(CASE WHEN … THEN 1 ELSE 0 END)` or `SUM(DECODE(…, 1, 0))` |
| A date column compared to a plain string (`trandate >= '2026-01-01'`) | Warn; use `TO_DATE(…)` |
| `status = 'A'` without `BUILTIN.CF` (raw status is only the letter) | Warn; use `BUILTIN.CF(t.status) = 'CustInvc:A'` |
| `pageIndex` > 0 on a detail query without `ORDER BY` (pages can overlap or skip rows) | Warn |
| `SUM` of `transactionaccountingline` `amount`/`debit`/`credit`/`netamount` without grouping or filtering by subsidiary, on an account whose subsidiaries use different currencies | Warn; group or filter by `tl.subsidiary`, or use the consolidated report |
| Budgets and transaction lines joined and aggregated in one query (budget-vs-actual fan-out) | Warn |
| Date filter in `LEFT JOIN … ON` while aggregating (left-side sums inflate) | Warn |
| A date or posting filter on the left table inside `LEFT JOIN … ON` (it removes no rows) | Warn; move it to `WHERE` |
| A double-quoted value (`"CustInvc"`: SuiteQL reads it as a column name) | Warn; use single quotes |
| `ORDER BY` on the alias of an aggregate or expression in a `GROUP BY` query (`ORDER BY n DESC` for `COUNT(*) AS n`; NetSuite answered "Invalid or unsupported search" in a live test) | Warn; order by the full expression (`COUNT(*) DESC`) |

Add `[nolint:<rule>]` (e.g. `[nolint:select-star]`; several rules comma-separated) to a query's
description to override that rule's false positive, or `[nolint]` to override every rule that
can be overridden. Plain `[nolint]` is also how Claude queries a table the cached record-type list
doesn't have yet. The overridden errors are listed in Claude's context so it checks the result
against them. Nothing overrides the rules marked "even with `[nolint]`" above, whose results
would always be wrong. `[nolint]` also doesn't skip the first-use metadata
step: the first query on a table whose fields aren't cached still asks for one
`ns_getSuiteQLMetadata` call, so the columns are checked rather than guessed. `nsx doctor` counts
the guard's denials per rule over the last 7 days with activity.

## Data and privacy

Everything stays on your machine, in the plugin's data directory
(`~/.claude/plugins/data/<plugin>/accounts/conn-<connector>/`, or `<account>-<env>/` when
`account_id` is set):

- the metadata cache and account profile;
- saved results and write previews, deleted after `results_retention_days`;
- an audit log of every NetSuite call, including denied and pending writes. It's kept until you
  delete its `audit/` folder, since it's meant for auditors (`nsx audit export` writes a CSV).

`nsx results` only reads the current account's results; pass `--any-account` to reach another
account or environment. Nothing is written to your project unless you export it (`./exports/` by
default). The export command warns you when the file isn't git-ignored. In CSV exports, text cells
that start with `=`, `+`, `-` or `@` get a leading `'` so spreadsheets don't run them as formulas.

## Cowork and claude.ai

The plugin installs there, but plugin hooks don't run there yet. You get the skill's guidance and
nothing else: no caching, no result shaping, no SuiteQL guard, and **no write protection**. The
`read_only` setting isn't enforced and creates/updates don't go through the preview and approval
step, so control writes through the connector role's permissions instead.

## Development

The plugin runs on Node 18+ on macOS and Linux. The test suite runs
TypeScript directly and needs Node 22.6+.

```
npm ci --include=dev # .npmrc omits dev packages, see below
npm run check        # typecheck, tests, bundle
test/e2e/run.sh      # headless Claude Code session against a fake connector (needs claude login)
```

Source is TypeScript in `src/`, bundled into one dependency-free `scripts/nsx.mjs`, which is
committed because plugins install straight from git. `.npmrc` sets `omit=dev`: Claude Code runs
`npm ci --ignore-scripts` when it installs a plugin, and every package here is a build or test
tool, so that install fetches nothing. Rebuild and commit it with every change; CI
checks it's current.

Versions follow semver, with `package.json` as the source of truth. To release, add a section
to [CHANGELOG.md](CHANGELOG.md), then run `npm version <x.y.z>`: it copies the version into the
plugin manifest, the CLI and the skill, rebuilds the bundle, commits and tags `v<x.y.z>`. A test
fails if any copy drifts.

Working on the code with an AI agent (or without one)? [AGENTS.md](AGENTS.md) has the project's
rules: how to verify NetSuite facts, where live findings go, and what every change needs.

To capture real connector responses for fixtures, start Claude Code with `NSX_CAPTURE_DIR=<dir>`.
Every hook input is saved there. Sanitize before committing.

## License

UPL 1.0. The `netsuite` skill is derived from Oracle's
[`netsuite-ai-connector-instructions`](https://github.com/oracle/netsuite-suitecloud-sdk/blob/master/packages/agent-skills/netsuite-ai-connector-instructions/SKILL.md) skill (UPL 1.0); see [NOTICE](NOTICE).
