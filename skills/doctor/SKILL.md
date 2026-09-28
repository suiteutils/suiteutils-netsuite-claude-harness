---
name: doctor
description: Diagnose su-ns-harness — connector reachability, hooks, cache freshness, disk usage, Node. Run it yourself, without asking, when the harness looks broken — NetSuite results come back raw with no [su-ns-harness] line, nsx can't find its data dir or cache, the connector keeps failing, or the user asks what's wrong; it only reads (one ns_getSubsidiaries call) and changes nothing in NetSuite.
---

# /su-ns-harness:doctor

**`nsx` is not on PATH.** Run every `nsx …` below with the exact command on the `Cache CLI:` line of the session context (it has the absolute path). Only if that line is missing, use `node "${CLAUDE_PLUGIN_ROOT}/scripts/nsx.mjs" …` (Bash); Claude Code fills in that path when it loads this skill. If that fails too (`Cannot find module`, or the path isn't absolute), find the script with `ls -dt "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/su-ns-harness/*/scripts/nsx.mjs | head -1` (newest install first) and run `node "<the path it prints>" …`; if it prints nothing, the plugin isn't installed.

1. Run `nsx doctor`. It checks Node, which connector (or account_id) keys the cache, data dir, cache sections and staleness, profile,
   results disk usage, when each hook last fired, and logged hook errors. A `⚠ … su-ns-harness data
   dirs` line means two Claude apps (e.g. the desktop app and the CLI) keep separate caches, so each
   ran its own init. Report it as ✗, name the dir in use and why doctor picked it (the line says:
   a dir with a cache beats one without, then the one whose hooks fired last), and suggest setting
   `NSX_DATA_DIR` to one of them in both apps. Other `nsx` commands print the same choice as one
   `nsx: using …` line on stderr; that line is informational, not an error.
2. Check your tool list for NetSuite tools (`…ns_*`). Report which ones are exposed. Writes
   (`ns_createRecord`, `ns_updateRecord`) may be missing if the role lacks permissions.
3. Make one cheap call to prove the connector works: `ns_getSubsidiaries`. If the cache has a
   `subsidiaries` section, run `nsx cache show subsidiaries` first and keep the output: the call
   re-caches the section. If it fails, report
   the `[su-ns-harness]` error class and recovery step. An auth error, or "couldn't reach the MCP
   server", means the user should re-authenticate via `/mcp`.
   If it succeeds, the hook replies `Cached N subsidiaries`: run `nsx cache show subsidiaries`
   again and check the count and names match what was cached before. A mismatch
   means `account_id`/`environment` (`nsx config show`) don't match the connected account
   (e.g. a sandbox id saved as production). Report it as ✗; the fix is usually to clear
   `account_id` so the cache follows the connector. Cached facts are otherwise attributed to the
   wrong account.
4. If the doctor output says hooks never fired: in Cowork/claude.ai this is expected (plugin
   hooks don't run there: no caching, shaping, SuiteQL guard, read_only block or write approval).
   In Claude Code, if the plugin was installed or updated during this session, ask the user to run
   `/reload-plugins` (or start a new session): a mid-session install may load late or only
   partly, so don't rely on any of it until then. Otherwise ask them to check `/hooks` and
   `/plugin` to see that su-ns-harness is enabled.
   If it says tool hooks fired but SessionStart hasn't, the plugin was probably installed
   mid-session: same fix, `/reload-plugins` or a new session. The profile context arrives with the
   next session start.
   The heartbeat file is shared by all sessions on this machine. When doctor says hooks fired in
   several sessions, a "last fired" line may come from another session: the step-3 call is the
   real test. Its result must carry a `[su-ns-harness]` line (a `Cached …` line, since
   `ns_getSubsidiaries` is cached). A raw subsidiary list means the hooks don't run in this session.
5. Summarise in a short checklist (✓/✗) with one fix per ✗. Don't paste the full output.
