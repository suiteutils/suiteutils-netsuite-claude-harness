# AGENTS.md

Instructions for AI coding agents (and people) changing this repo. The user-facing overview is
[README.md](README.md). Live-verified NetSuite behaviour is recorded in the skill references
(`skills/netsuite/references/`) and in code comments, marked "live-verified <date>".

## What this is

A Claude Code plugin (`su-ns-harness`) around Oracle's
[NetSuite AI Connector Service](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_7200233106.html).
It never talks to NetSuite itself. Hooks run before and after every `mcp__<server>__ns_*` tool call
that the [MCP Standard Tools SuiteApp](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_143403258.html)
exposes: they check SuiteQL, cache catalogs, save and summarise large results, classify errors and
guard writes. The `netsuite` skill is derived from Oracle's
[`netsuite-ai-connector-instructions`](https://github.com/oracle/netsuite-suitecloud-sdk/blob/master/packages/agent-skills/netsuite-ai-connector-instructions/SKILL.md)
skill (UPL 1.0, see [NOTICE](NOTICE)).

## Layout

| Path | What |
|---|---|
| `src/cli.ts` | `nsx` CLI entry, argument/flag validation (`COMMAND_FLAGS`), all commands |
| `src/hooks/` | `pre.ts` (SuiteQL guard, injection, write guard), `post.ts` (cache, shaping, errors), `session-start.ts`, `io.ts` (hook plumbing) |
| `src/sql/` | `tokenize.ts` and `lint.ts`: the SuiteQL rules, fixes, `HARD_RULES` |
| `src/cache/` | `catalog.ts` (catalog parsers, tag checks), `store.ts` (manifest, section files), `profile.ts` (Profile Card), `probes.ts` (canonical init SQL) |
| `src/results/`, `src/rows.ts` | Result extraction (incl. report flattening), summaries, `nsx results` engine, xlsx |
| `src/config.ts`, `src/mcp.ts`, `src/errors.ts`, `src/preview.ts` | Data dir choice and settings, response decoding, error classes and advice, write previews and write-tool detection |
| `scripts/nsx.mjs` | The bundle the plugin runs. Generated, but committed (plugins install from git) |
| `skills/`, `agents/` | What Claude reads in a live session |
| `test/` | Node test runner suites; `test/fixtures/` are hook `tool_response` payloads (see its README) |

## Commands

```
npm ci --include=dev   # .npmrc omits dev packages for plugin installs
npm run check          # typecheck, tests, bundle; run before you finish
npm test               # needs Node 22.6+ (type stripping); the bundle itself runs on Node 18+
```

After any change under `src/`, run `npm run build` and commit `scripts/nsx.mjs`; CI fails on a
stale bundle. Tests run the TypeScript source, so also smoke-test the bundle for hook changes
(`echo '<hook input json>' | node scripts/nsx.mjs hook pre`).

## Rules

**NetSuite facts come from evidence, never memory.** A table, column, type code, parameter value
or error string may be added only if it is in Oracle's docs (cite the page in a comment), already
recorded as live-verified in the skill references or code, or in a live connector response. Oracle's public records
browser stops at 2021.1; the account's Records Catalog (via `ns_getSuiteQLMetadata`) is newer but
incomplete (`transactionline.amount` works yet isn't listed). When the docs and a live test
disagree, the live test wins; record it where it's used, marked live-verified. Useful Oracle pages:
[SuiteQL](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156257770590.html),
[syntax](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_156257790831.html),
[supported functions](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_158513731864.html),
[performance](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0824094533.html),
[available tools](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0902023508.html),
[ns_runReport](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0905091732.html),
[ns_runCustomSuiteQL](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_0905091645.html).

**Never print a number that could be wrong without saying so.** This is the bug class live data
keeps exposing: sums across currencies or subsidiaries, nested report rows added up, a header
amount counted once per line, ids summed, values silently skipped, pages or buckets misread. If a
figure can't be trusted, show `n/a (<reason>)` or refuse with the fix. Don't weaken a test that
guards against this; update it only when the new output is more correct.

**Every bug fix gets a regression test** that names the behaviour it protects
(`"aging buckets keep their own values when columns share a path"`). Reproduce the bug first.

**Fixtures are sanitized.** Keep the exact keys, nesting and order of the live payload; replace
names, ids and amounts with made-up values that keep signs and subtotals consistent. Never commit
real customer, vendor or employee names or real amounts. Document each fixture in
`test/fixtures/README.md`.

**Hooks must never break a session.** No throws, no stderr, valid hook JSON on stdout
(`test/fuzz.test.ts`). The one exception is writes: when the pre hook can't check a write, it
denies it (fail closed). Any `ns_*` tool not known to be read-only is guarded as a write.

**Treat tool input as untrusted.** Record types and table names become file names: validate them
(`sectionNameProblem`) and keep every path inside the account dir. The write preview must show
exactly what will be sent.

**Guard rules:** an ERROR must be something NetSuite rejects or answers wrongly; everything else is
a WARN. Put a rule in `HARD_RULES` (not overridable by `[nolint]`) only when its result is always
wrong. Every suggested fix must lint clean and mean the same thing as the input. Run realistic
queries against a rule for false positives before adding it.

**Skills are context, not documentation.** `skills/netsuite/SKILL.md` loads into every NetSuite
conversation; keep it short (about 1,700 words) and put detail in `skills/netsuite/references/`.
Every SQL block in the skills must lint clean (`test/skills.test.ts`), and the probe tables in
`skills/init` and `skills/refresh` must match `src/cache/probes.ts` exactly. Messages the skills
quote (hook notes, CLI output) are tested; change both together. Every `nsx …` example in
the docs must parse (`test/hooks.test.ts`, `test/cli.test.ts`).

**Live findings are recorded where they're used**: in the skill reference Claude reads
(`skills/netsuite/references/`), in the code comment next to the rule, and in a test. Mark them
"live-verified <date>" and replace an outdated statement instead of keeping both.

## Releasing

`package.json` holds the version. Add a CHANGELOG section, then `npm version <x.y.z>`: it syncs the
version into `.claude-plugin/plugin.json`, `src/config.ts` and the skill, rebuilds, commits and
tags. Bump the version for every build someone will install: Claude Code caches installed plugins
by version, so a same-version reinstall can keep a stale copy.

## Commit hygiene

Don't commit captured payloads, exports, `.env` files or anything from
`~/.claude/plugins/data/`. Hook inputs captured with `NSX_CAPTURE_DIR` contain real account data.
