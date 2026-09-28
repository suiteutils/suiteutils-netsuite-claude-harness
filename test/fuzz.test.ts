/** Hooks must pass through untouched (exit 0, no or valid output) on any malformed input. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { HOOKS } from "../src/cli.ts";
import { processHook } from "../src/hooks/io.ts";

const CLI = path.join(import.meta.dirname, "..", "src", "cli.ts");

function runHook(which: string, stdin: string, env: Record<string, string> = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "nsx-fuzz-"));
  return spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", CLI, "hook", which], {
    input: stdin,
    env: { ...process.env, NSX_DATA_DIR: data, CLAUDE_CONFIG_DIR: data, CLAUDE_PLUGIN_OPTION_ACCOUNT_ID: "1", ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
}

const tools = ["mcp__ns__ns_runCustomSuiteQL", "mcp__ns__ns_runSavedSearch", "mcp__ns__ns_listAllReports", "mcp__ns__ns_getRecord", "mcp__ns__ns_createRecord"];
const junk: unknown[] = [null, 0, "", "x", [], {}, [1, [2]], { content: 5 }, { content: [{ type: "text" }] }, "\u0000￿", { items: "no" }, { a: { b: { c: { d: { e: { f: { g: [] } } } } } } }];

function cases(): string[] {
  const out = ["", "not json", "[]", "null", "42", '{"tool_name":', "{}".repeat(3)];
  for (const t of tools) {
    for (const j of junk) {
      out.push(JSON.stringify({ tool_name: t, tool_input: j, tool_response: j, error: j, session_id: j, tool_use_id: j }));
    }
    out.push(JSON.stringify({ tool_name: t, tool_input: { sqlQuery: "SELECT ((( FROM '" }, tool_response: [{ type: "text", text: "{broken" }] }));
    out.push(JSON.stringify({ tool_name: t, tool_input: { sqlQuery: 42, pageSize: "x", range_end: {}, fields: [] } }));
    out.push(JSON.stringify({ tool_name: t, tool_input: { searchId: {}, fields: [null, 3, " ,"], pageSize: -1, sqlQuery: "SELECT a FROM t OFFSET 1 ROWS" }, tool_response: [{ type: "text", text: '"Error loading saved search with params {}. Error: Unable to determine record type for saved search id"' }] }));
    out.push(JSON.stringify({ tool_name: t, tool_input: { description: "[su-ns-harness:periods]", sqlQuery: "SELECT id FROM accountingperiod;;" }, tool_response: '"Error: Permission Violation"' }));
  }
  return out;
}

describe("fuzz: hooks never break a session", () => {
  const all = cases();
  for (const which of ["pre", "post", "failure", "session-start"]) {
    // Every case in-process (same code path as the CLI minus stdin/stdout), a sample as real processes.
    it(`${which} survives ${all.length} malformed inputs`, () => {
      const [handler, onError] = HOOKS[which];
      const saved = { ...process.env };
      try {
        for (const input of all) {
          process.env.NSX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nsx-fuzz-"));
          process.env.CLAUDE_CONFIG_DIR = process.env.NSX_DATA_DIR;
          process.env.CLAUDE_PLUGIN_OPTION_ACCOUNT_ID = "1";
          let out = "";
          assert.doesNotThrow(() => (out = processHook(which, input, handler, onError)), `threw for ${input.slice(0, 120)}`);
          if (out && which !== "session-start") assert.doesNotThrow(() => JSON.parse(out), `invalid JSON output for ${input.slice(0, 120)}`);
        }
      } finally {
        process.env = saved;
      }
    });

    it(`${which} exits 0 silently as a process`, () => {
      for (const input of all.filter((_, i) => i % 12 === 0)) {
        const r = runHook(which, input);
        assert.equal(r.status, 0, `exit ${r.status} for ${input.slice(0, 120)}\n${r.stderr}`);
        assert.equal(r.stderr, "", `stderr for ${input.slice(0, 120)}`);
        if (r.stdout && which !== "session-start") assert.doesNotThrow(() => JSON.parse(r.stdout), `invalid JSON output for ${input.slice(0, 120)}`);
      }
    });
  }

  it("denies writes when the data dir is unusable (fail closed)", () => {
    const r = runHook("pre", JSON.stringify({ tool_name: "mcp__ns__ns_createRecord", tool_input: { recordType: "customer", externalId: "x" } }), { NSX_DATA_DIR: "/dev/null/nope", CLAUDE_PLUGIN_OPTION_READ_ONLY: "false" });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny");
    const read = runHook("pre", JSON.stringify({ tool_name: "mcp__ns__ns_runCustomSuiteQL", tool_input: { sqlQuery: "SELECT id FROM t" } }), { NSX_DATA_DIR: "/dev/null/nope" });
    assert.equal(read.stdout, "", "reads still pass through");
  });

  it("truncated stdin for a write is denied as a process, with no data dir", () => {
    const r = runHook("pre", '{"tool_name":"mcp__ns__ns_voidTransaction","tool_input":{"id":', { NSX_DATA_DIR: "/dev/null/nope", CLAUDE_PLUGIN_OPTION_READ_ONLY: "false" });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny");
    assert.doesNotMatch(out.permissionDecisionReason, /hook\.log/);
  });

  it("broken stdin that names a write tool is denied as a process too", () => {
    for (const stdin of ['{"tool_name":"mcp__ns__ns_deleteRecord","tool_input":{"recordType":', '{"tool_name":"mcp__ns__ns_voidTransaction" x']) {
      const r = runHook("pre", stdin, { CLAUDE_PLUGIN_OPTION_READ_ONLY: "false" });
      assert.equal(r.status, 0);
      assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny", stdin);
    }
    assert.equal(runHook("pre", '{"tool_name":"mcp__ns__ns_runCustomSuiteQL",').stdout, "", "reads still pass through");
  });

  it("passes through when the data dir is unwritable", () => {
    const r = runHook("post", JSON.stringify({ tool_name: tools[0], tool_input: { sqlQuery: "SELECT a FROM t" }, tool_response: [{ type: "text", text: '{"items":[]}' }] }), { NSX_DATA_DIR: "/dev/null/nope" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  });
});
