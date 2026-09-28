#!/usr/bin/env bash
# End-to-end check of the hooks inside a real headless Claude Code session, against the fake
# connector in this folder. Needs a logged-in `claude` CLI; costs a few cents (Haiku). Not run in CI.
#
#   test/e2e/run.sh            # run and print what the connector received and what Claude saw
#   KEEP=1 test/e2e/run.sh     # keep the temp dir (hook input captures are in $DIR/capture)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$(mktemp -d "${TMPDIR:-/tmp}/nsx-e2e.XXXXXX")"
[ -z "${KEEP:-}" ] && trap 'rm -rf "$DIR"' EXIT

(cd "$ROOT" && npm run --silent build >/dev/null)
run() {
  cat > "$DIR/mcp.json" <<JSON
{"mcpServers":{"fakens":{"type":"stdio","command":"node","args":["$ROOT/test/e2e/fake-netsuite-mcp.mjs"],"env":{"FAKE_NS_LOG":"$DIR/$2.connector.log"}}}}
JSON
  (cd "$DIR" && NSX_DATA_DIR="$DIR/data" NSX_CAPTURE_DIR="$DIR/capture" CLAUDE_PLUGIN_OPTION_ACCOUNT_ID=1234567 \
    claude -p --model haiku --plugin-dir "$ROOT" --mcp-config "$DIR/mcp.json" --strict-mcp-config \
      --allowedTools "mcp__fakens__ns_runCustomSuiteQL mcp__fakens__ns_listAllReports mcp__fakens__ns_runReport mcp__fakens__ns_runSavedSearch Bash(node:*) Bash(sleep:*)" \
      --output-format stream-json --verbose "$1" < /dev/null > "$DIR/$2.jsonl" 2>/dev/null)
}

echo "== session 1: fill cache, big result, ROWNUM denial, rate limit"
run "Using the NetSuite tools, one call at a time: 1) list all reports. 2) run SuiteQL \"SELECT tranid, trandate, entity, amount, subsidiary, id FROM transaction WHERE memo = 'big'\" and give the total amount per subsidiary. 3) run SuiteQL \"SELECT entity, SUM(amount) FROM transaction WHERE ROWNUM <= 10 GROUP BY entity\". 4) run report 12 and handle errors as the tooling says. Be brief." s1
echo "== session 2: fresh cache, catalog question"
run "Which NetSuite report should I use for receivables aging? Just its name and id." s2

python3 - "$DIR" <<'PY'
import json, sys
d = sys.argv[1]
for s in ("s1", "s2"):
    print(f"\n--- {s}: connector received")
    try:
        print(open(f"{d}/{s}.connector.log").read().strip() or "(none)")
    except FileNotFoundError:
        print("(none)")
    for line in open(f"{d}/{s}.jsonl"):
        o = json.loads(line)
        if o.get("type") == "assistant":
            for c in o["message"]["content"]:
                if c.get("type") == "tool_use":
                    print("TOOL_USE", c["name"], json.dumps(c["input"])[:160])
        elif o.get("type") == "user" and isinstance(o["message"]["content"], list):
            for c in o["message"]["content"]:
                if c.get("type") == "tool_result":
                    t = c["content"] if isinstance(c["content"], str) else " ".join(x.get("text", "") for x in c["content"])
                    print(f"  RESULT {len(t)} chars: {t[:200]!r}")
        elif o.get("type") == "result":
            print("FINAL:", o.get("result", "")[:500], "| cost $%.3f" % (o.get("total_cost_usd") or 0))
PY
