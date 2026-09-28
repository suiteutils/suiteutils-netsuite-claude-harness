/** CLI and config behaviour: argument checks, settings, output. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { checkFlags, cmdConfig, currentSession, interactive, main, parseArgs, splitDataDirNote } from "../src/cli.ts";
import { DataDirError, connectorServer, dataDirChoice, loadConfig, saveSettings } from "../src/config.ts";
import { nsxCommand } from "../src/hooks/io.ts";
import { handlePost } from "../src/hooks/post.ts";
import { cliCommand } from "../src/hooks/session-start.ts";
import { hso, text, tmpCtx } from "./helpers.ts";

const ROOT = path.join(import.meta.dirname, "..");
const CLI = path.join(ROOT, "src", "cli.ts");
const T = (tool: string) => `mcp__netsuite__${tool}`;

/** The environment of a shell outside Claude Code: no CLAUDE_* / NSX_* leaking in from the test runner. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|NSX_)/.test(k)) env[k] = v;
  env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nsx-cli-home-"));
  return { ...env, ...extra };
}

function run(args: string[], extra: Record<string, string> = {}, input = "") {
  return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...args], { env: cleanEnv(extra), input, encoding: "utf8" });
}

/** A data dir with one saved 300-row result (session s1). */
function withResult() {
  const ctx = tmpCtx({ account_id: "1" });
  const rows = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, amount: i * 3.5, type: i % 2 ? "A" : "B", memo: "x".repeat(40) }));
  const res = hso(handlePost({ session_id: "s1", tool_name: T("ns_runCustomSuiteQL"), tool_input: { sqlQuery: "SELECT id, amount, type FROM transaction" }, tool_response: text(JSON.stringify({ items: rows })) }, ctx));
  const id = /\b(r_[0-9a-f]{6})\b/.exec(String(res.updatedMCPToolOutput))![1];
  return { ctx, id, env: { NSX_DATA_DIR: ctx.data, CLAUDE_PLUGIN_OPTION_ACCOUNT_ID: "1" } };
}

/** An empty data dir (preview saves the preview there). */
const dataEnv = () => ({ NSX_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "nsx-cli-data-")) });

const check = (...argv: string[]) => checkFlags(parseArgs(argv));
const isUsage = (want: RegExp) => (e: Error) => e.name === "UsageError" && want.test(e.message);

describe("CLI arguments, config and output", () => {
  it("--version/-v print the version, -h/--help and <cmd> --help print usage, unknown commands exit 2, all without a data dir", () => {
    for (const v of ["--version", "-v", "-V", "version"]) {
      const r = run([v]);
      assert.equal(r.status, 0, `${v}: ${r.stderr}`);
      assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/, v);
    }
    for (const h of ["-h", "--help", "help"]) {
      const r = run([h]);
      assert.equal(r.status, 0, `${h}: ${r.stderr}`);
      assert.match(r.stdout, /su-ns-harness CLI/);
    }
    const doc = run(["doctor", "--help"]);
    assert.equal(doc.status, 0, doc.stderr);
    assert.match(doc.stdout, /^usage: .*doctor \[--preflight\]/);
    assert.match(run(["results", "head", "--help"]).stdout, /head <id> \[N\]/);
    assert.match(run(["help", "audit"]).stdout, /audit tail \[--n N\]/);
    for (const [argv, want] of [
      [["bogus"], /unknown command 'bogus'/],
      [["result", "list"], /unknown command 'result'\. Did you mean 'results'\?/],
      [["field", "transaction"], /Did you mean 'fields'\?/],
      [["report", "search", "x"], /Did you mean 'reports'\?/],
    ] as [string[], RegExp][]) {
      const r = run(argv);
      assert.equal(r.status, 2, argv.join(" "));
      assert.equal(r.stdout, "");
      assert.match(r.stderr, want);
    }
    assert.throws(() => check("results", "bogus"), isUsage(/unknown results subcommand 'bogus'/));
    assert.throws(() => check("cache", "stats"), isUsage(/Did you mean 'status'\?/));
  });

  it("stray positionals are refused, -n works like --n, extra words on fields are search terms", async () => {
    const { id, env } = withResult();
    const head = run(["results", "head", id, "-n", "2"], env);
    assert.equal(head.status, 0, head.stderr);
    assert.equal(head.stdout.trim().split("\n").length, 3, "header + 2 rows");
    for (const [argv, want] of [
      [["periods", "2026"], /unexpected argument '2026' for periods\. Did you mean --grep 2026\?/],
      [["periods", "--open", "3"], /unexpected argument '3' for periods\. Did you mean --max 3\?/],
      [["audit", "tail", "2"], /Did you mean --n 2\?/],
      [["results", "list", "1"], /unexpected argument '1' for results list\. Did you mean --n 1\?/],
      [["cache", "status", "extra"], /unexpected argument 'extra' for cache status/],
      [["cache", "extra"], /unknown cache subcommand 'extra'/],
      [["results", "head", id, "abc"], /takes a row count after the id, got 'abc'/],
      [["results", "head", id, "-x"], /unknown option -x: flags take two dashes/],
      [["doctor", "now"], /unexpected argument 'now' for doctor/],
    ] as [string[], RegExp][]) {
      const r = run(argv, env);
      assert.equal(r.status, 2, `${argv.join(" ")}: ${r.stdout}`);
      assert.match(r.stderr, want);
    }
    // fields <table> <term> filters like --grep (not every field is printed).
    const ctx = tmpCtx({ account_id: "1" });
    handlePost({ tool_name: T("ns_getSuiteQLMetadata"), tool_input: { recordType: "transaction" }, tool_response: text(JSON.stringify({ properties: { id: { type: "integer", title: "Internal ID" }, foreignamount: { type: "number", title: "Amount (Foreign Currency)" }, memo: { type: "string", title: "Memo" } } })) }, ctx);
    const out = String(await main(["fields", "transaction", "amount"]));
    if (!/not cached/.test(out)) {
      assert.match(out, /matching "amount"/);
      assert.doesNotMatch(out, /\bmemo\b/i);
    }
  });

  it("value flags need a value, numeric flags need a positive number", () => {
    for (const [argv, want] of [
      [["results", "head", "r_1", "--where"], /--where needs a value/],
      [["results", "agg", "r_1", "--by"], /--by needs a value/],
      [["results", "head", "r_1", "--cols"], /--cols needs a value/],
      [["fields", "transaction", "--grep"], /--grep needs a value/],
      [["results", "head", "r_1", "--where="], /--where needs a value/],
      [["results", "head", "r_1", "--max", "abc"], /--max must be a positive whole number, got 'abc'/],
      [["results", "head", "r_1", "--max", "-1"], /--max must be a positive whole number/],
      [["results", "head", "r_1", "--max"], /--max needs a value/],
      [["results", "list", "--n", "0"], /--n must be a positive whole number, got '0'/],
      [["audit", "tail", "--n", "0"], /--n must be a positive whole number/],
      [["audit", "tail", "--days", "abc"], /--days must be a positive number/],
      [["results", "raw", "r_1", "--head", "abc"], /--head must be a positive whole number/],
      [["reports", "search", "x", "--max", "2.5"], /--max must be a positive whole number/],
    ] as [string[], RegExp][]) {
      assert.throws(() => check(...argv), isUsage(want), argv.join(" "));
    }
    // --max on agg/pivot is a metric column, not a row cap.
    check("results", "agg", "r_1", "--by", "type", "--max", "amount");
    check("results", "pivot", "r_1", "--rows", "a", "--cols", "b", "--max", "amount");
    check("audit", "tail", "--days", "0.5", "--n", "3");
  });

  it("the session id comes from CLAUDE_CODE_SESSION_ID; bare --session without one exits 2", () => {
    assert.equal(currentSession({ CLAUDE_CODE_SESSION_ID: "abc" }), "abc");
    assert.equal(currentSession({ CLAUDE_SESSION_ID: "old" }), "old");
    assert.equal(currentSession({}), undefined);
    const { env } = withResult();
    const bare = run(["audit", "tail", "--session"], env);
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /--session needs an id/);
    const mine = run(["audit", "tail", "--session"], { ...env, CLAUDE_CODE_SESSION_ID: "s1" });
    assert.equal(mine.status, 0, mine.stderr);
    assert.match(mine.stdout, /ns_runCustomSuiteQL/, "filtered to the session from CLAUDE_CODE_SESSION_ID");
    const other = run(["audit", "tail", "--session"], { ...env, CLAUDE_CODE_SESSION_ID: "nope" });
    assert.doesNotMatch(other.stdout, /ns_runCustomSuiteQL/, "the filter is applied, not dropped");
  });

  it("read_only=false is refused under Claude Code even with a (faked) TTY", () => {
    assert.equal(interactive({ CLAUDECODE: "1" }), false);
    assert.equal(interactive({ CLAUDE_CODE_SESSION_ID: "x" }), false);
    const ctx = tmpCtx();
    const saved = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "1";
    try {
      assert.throws(() => cmdConfig(ctx, ["config", "set", "read_only=false"]), /has to be done by the user, in their own terminal, outside Claude Code/);
    } finally {
      if (saved === undefined) delete process.env.CLAUDECODE;
      else process.env.CLAUDECODE = saved;
    }
    assert.equal(loadConfig(ctx.data).read_only, true);
    // The live bypass: `script` gives the CLI a TTY. The Claude Code environment still refuses it.
    if (process.platform === "darwin" && fs.existsSync("/usr/bin/script")) {
      const data = fs.mkdtempSync(path.join(os.tmpdir(), "nsx-tty-"));
      const r = spawnSync("/usr/bin/script", ["-q", "/dev/null", process.execPath, "--experimental-strip-types", "--no-warnings", CLI, "config", "set", "read_only=false"], {
        env: cleanEnv({ NSX_DATA_DIR: data, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "x" }),
        input: "",
        encoding: "utf8",
      });
      // Without a terminal of its own (CI, a socket stdin) script can't run; nothing to check then.
      if (!/tcgetattr|ioctl/.test(r.stderr)) assert.match(r.stdout + r.stderr, /has to be done by the user/);
      assert.equal(loadConfig(data).read_only, true, "not saved");
    }
  });

  it("profile set with a bad key/value exits 2; a good one prints the rebuilt card", () => {
    const { env } = withResult();
    const bad = run(["profile", "set", "bogus=1"], env);
    assert.equal(bad.status, 2, bad.stderr);
    assert.match(bad.stderr, /bogus/);
    const good = run(["profile", "set", "base_currency=EUR"], env);
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /Profile Card/);
  });

  it("a foreign CLAUDE_PLUGIN_ROOT is not used for the nsx command", () => {
    const saved = process.env.CLAUDE_PLUGIN_ROOT;
    try {
      process.env.CLAUDE_PLUGIN_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "other-plugin-"));
      assert.equal(cliCommand(), `node "${path.resolve(process.argv[1])}"`);
      assert.doesNotMatch(nsxCommand() ?? "", /other-plugin-/);
      process.env.CLAUDE_PLUGIN_ROOT = path.resolve(path.dirname(process.argv[1]), "..");
      assert.equal(cliCommand(), `node "${path.join(process.env.CLAUDE_PLUGIN_ROOT, "scripts", "nsx.mjs")}"`, "our own root is still used");
      assert.equal(nsxCommand(), cliCommand());
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = saved;
    }
  });

  it("sql lint / preview with no source print usage instead of waiting on an open stdin", async () => {
    for (const argv of [["sql", "lint"], ["preview", "ns_updateRecord"]]) {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, ...argv], { env: cleanEnv(dataEnv()), stdio: ["pipe", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      // stdin stays open (never ended), like `sleep 6 | nsx sql lint`.
      const code = await new Promise<number | null>((resolve) => {
        const t = setTimeout(() => {
          child.kill();
          resolve(null);
        }, 8000);
        child.on("exit", (c) => {
          clearTimeout(t);
          resolve(c);
        });
      });
      child.stdin.destroy();
      assert.equal(code, 2, `${argv.join(" ")} hung or failed: ${err}`);
      assert.match(err, /usage|no input given/);
    }
    // An explicit - still reads stdin.
    const r = run(["preview", "ns_updateRecord", "-"], dataEnv(), '{"recordType":"customer","id":1,"companyname":"X"}');
    assert.equal(r.status, 0, r.stderr);
  });

  it("nsx hints in CLI output are expanded to the runnable command", () => {
    const { env } = withResult();
    const r = run(["results", "schema", "r_000000"], env);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /node "[^"]*" results list/);
    assert.doesNotMatch(r.stderr, /(^|\s)nsx results list/);
    assert.match(r.stderr, /^nsx: /, "the error prefix stays");
    assert.match(run(["doctor", "--help"]).stdout, /^usage: node "[^"]*" doctor/);
  });

  it("bad JSON given to preview exits 2", () => {
    const bad = run(["preview", "ns_updateRecord", "-"], dataEnv(), "nope");
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /Could not read JSON from the tool input/);
    const arr = run(["preview", "ns_updateRecord", "-"], dataEnv(), "[1]");
    assert.equal(arr.status, 2);
    assert.match(arr.stderr, /must be a JSON object/);
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nsx-before-")), "before.json");
    fs.writeFileSync(f, "{broken");
    const before = run(["preview", "ns_updateRecord", "-", "--before", f], dataEnv(), "{}");
    assert.equal(before.status, 2);
    assert.match(before.stderr, /Could not read JSON from .*before\.json/);
  });

  it("read_only= (reset to the default, true) is not gated; read_only parsing fails closed", () => {
    const ctx = tmpCtx();
    cmdConfig(ctx, ["config", "set", "read_only="], false);
    assert.equal(loadConfig(ctx.data).read_only, true);
    for (const v of ["tru", "n", "disabled", "yes", "1"]) {
      fs.writeFileSync(path.join(ctx.data, "settings.json"), JSON.stringify({ read_only: v }));
      assert.equal(loadConfig(ctx.data).read_only, true, v);
    }
    for (const v of ["false", "no", "OFF", "0"]) {
      fs.writeFileSync(path.join(ctx.data, "settings.json"), JSON.stringify({ read_only: v }));
      assert.equal(loadConfig(ctx.data).read_only, false, v);
    }
  });

  it("numeric settings are whole numbers within bounds; unknown ttl sections are refused", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nsx-set-"));
    for (const [k, v, want] of [
      ["inline_max_chars", "0.5", /inline_max_chars must be a positive number: a whole number from 500 to 200000/],
      ["results_retention_days", "0.01", /from 1 to/],
      ["suiteql_default_page_size", "100000", /from 5 to 1000/],
      ["saved_search_default_rows", "abc", /saved_search_default_rows/],
      ["ttl_overrides", "searches=2, bogus=1", /can't use 'bogus=1'/],
      ["ttl_overrides", "searches=x", /can't use 'searches=x'/],
    ] as [string, string, RegExp][]) {
      assert.throws(() => saveSettings(dir, { [k]: v }), want, `${k}=${v}`);
    }
    saveSettings(dir, { suiteql_default_page_size: "1000", inline_max_chars: "9000", ttl_overrides: "searches=2, periods=0.5" });
    assert.equal(loadConfig(dir).suiteql_default_page_size, 1000);
    assert.equal(loadConfig(dir).ttl_days.periods, 0.5);
    // A value saved before the bounds existed is clamped, never sent to NetSuite as is.
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ suiteql_default_page_size: "100000" }));
    assert.equal(loadConfig(dir).suiteql_default_page_size, 1000);
  });

  it("preview refuses read tools and says when nothing changes", () => {
    for (const tool of ["ns_runCustomSuiteQL", "ns_getRecord"]) {
      const r = run(["preview", tool, "-"], dataEnv(), '{"sqlQuery":"SELECT 1"}');
      assert.equal(r.status, 2, tool);
      assert.match(r.stderr, /not a NetSuite write tool/);
    }
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nsx-noop-")), "rec.json");
    fs.writeFileSync(f, JSON.stringify({ recordType: "customer", id: 1, companyname: "X" }));
    const same = run(["preview", "ns_updateRecord", f, "--before", f], dataEnv());
    assert.equal(same.status, 0, same.stderr);
    assert.match(same.stdout, /\(no field changes detected/);
  });

  it("NSX_DATA_DIR is made absolute; a file or unwritable dir gets a clear message; the split note knows NSX_DATA_DIR is set", () => {
    const cwd = process.cwd();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "nsx-rel-"));
    const saved = process.env.NSX_DATA_DIR;
    try {
      process.chdir(base);
      process.env.NSX_DATA_DIR = "rel-data";
      const dir = dataDirChoice().dir;
      assert.ok(path.isAbsolute(dir));
      assert.equal(fs.realpathSync(dir), fs.realpathSync(path.join(base, "rel-data")));
      fs.writeFileSync(path.join(base, "afile"), "x");
      process.env.NSX_DATA_DIR = path.join(base, "afile");
      assert.throws(() => dataDirChoice(), (e: Error) => e instanceof DataDirError && /is a file, not a directory/.test(e.message));
    } finally {
      process.chdir(cwd);
      if (saved === undefined) delete process.env.NSX_DATA_DIR;
      else process.env.NSX_DATA_DIR = saved;
    }
    const doc = run(["doctor"], { NSX_DATA_DIR: path.join(base, "afile") });
    assert.equal(doc.status, 0, doc.stderr);
    assert.match(doc.stdout, /✗ data dir: NSX_DATA_DIR is .*afile, which is a file/);
    const other = run(["results", "list"], { NSX_DATA_DIR: path.join(base, "afile") });
    assert.equal(other.status, 1);
    assert.match(other.stderr, /which is a file, not a directory/);
    assert.doesNotMatch(other.stderr, /EEXIST/);
    if (process.getuid?.() !== 0) {
      const ro = path.join(base, "ro");
      fs.mkdirSync(ro);
      fs.chmodSync(ro, 0o555);
      try {
        const d = run(["doctor", "--preflight"], { NSX_DATA_DIR: ro, CLAUDE_PLUGIN_OPTION_ACCOUNT_ID: "1" });
        assert.match(d.stdout, /✗ data dir .*ro — not writable \(EACCES\)/);
        const p = run(["profile", "set", "base_currency=EUR"], { NSX_DATA_DIR: ro, CLAUDE_PLUGIN_OPTION_ACCOUNT_ID: "1" });
        assert.equal(p.status, 1);
        assert.match(p.stderr, /can't write .*permission denied/);
      } finally {
        fs.chmodSync(ro, 0o755);
      }
    }
    const note = splitDataDirNote("/a", ["/a", "/b"], undefined, "/a");
    assert.match(note!, /NSX_DATA_DIR is set here/);
    assert.doesNotMatch(note!, /set NSX_DATA_DIR to the same dir in every app/);
    assert.match(splitDataDirNote("/a", ["/a", "/b"], undefined, "")!, /set NSX_DATA_DIR to the same dir in every app/);
  });

  it("doctor starts with the nsx version and where it runs from", () => {
    const r = run(["doctor", "--preflight"]);
    assert.match(r.stdout.split("\n")[0], /^nsx \d+\.\d+\.\d+ at .*cli\.ts$/);
  });

  it("help lists results path, periods --grep/--max and audit flags; cache show <missing> lists what is cached; '1 period'", async () => {
    const help = run(["--help"]).stdout;
    assert.match(help, /raw\|path <id>/);
    assert.match(help, /periods \[--open\|--years\] \[--grep t\] \[--max N\]/);
    assert.match(help, /audit tail \[--n N\] \[--session \[id\]\] \[--days N\]/);
    const { ctx } = withResult();
    handlePost({ tool_name: T("ns_listAllReports"), tool_input: {}, tool_response: text(JSON.stringify([{ id: -200, title: "Income Statement" }])) }, ctx);
    const miss = String(await main(["cache", "show", "report"]));
    assert.match(miss, /Section 'report' not cached\. Cached: .*reports/);
  });

  it("underscore-named ns_ tools resolve to their connector (and so to the account dir)", () => {
    assert.equal(connectorServer("mcp__claude_ai_NetSuite__ns_prompt_library_app"), "claude_ai_NetSuite");
    assert.equal(connectorServer("mcp__ns__ns_create_record"), "ns");
    assert.equal(connectorServer("mcp__netsuite__ns_runCustomSuiteQL"), "netsuite");
    assert.equal(connectorServer("mcp__netsuite__other"), undefined);
  });

  it("every documented nsx example still parses under the stricter checks", () => {
    const files = [
      ...["skills", "agents"].flatMap((d) => fs.readdirSync(path.join(ROOT, d), { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".md")).map((f) => path.join(ROOT, d, f))),
      path.join(ROOT, "README.md"),
    ];
    // A `<result id>` placeholder is one argument.
    const split = (s: string) => [...s.matchAll(/"([^"]*)"|'([^']*)'|(<[^>]*>)|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
    let checked = 0;
    const failures: string[] = [];
    for (const f of files) {
      for (const m of fs.readFileSync(f, "utf8").matchAll(/(?:node "[^"]*nsx\.mjs"|(?<![\w./-])nsx) ([^`\n]*?)(?=`|\s+→|\s{3,}|$)/gm)) {
        const ex = m[1].trim();
        // Usage notation (`[--grep t]`, `a|b`, `…`) is not an invocation.
        if (!ex || /[\[\]…|]/.test(ex)) continue;
        const argv = split(ex);
        // Prose after "nsx" ("nsx can't find …") is not a command.
        if (!/^[a-z][a-z-]*$/.test(argv[0] ?? "")) continue;
        checked++;
        try {
          checkFlags(parseArgs(argv));
        } catch (e) {
          failures.push(`${path.relative(ROOT, f)}: nsx ${ex}\n    ${(e as Error).message.split("\n")[0]}`);
        }
      }
    }
    assert.ok(checked > 25, `found ${checked} examples`);
    assert.deepEqual(failures, []);
  });
});
