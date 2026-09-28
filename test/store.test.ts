import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { parseTtlOverrides } from "../src/config.ts";

const ROOT = path.join(import.meta.dirname, "..");

describe("cache store", () => {
  it("parallel hook processes don't drop each other's manifest entries", async () => {
    const acct = fs.mkdtempSync(path.join(os.tmpdir(), "race-"));
    const code = (i: number) =>
      `import {storeSection} from ${JSON.stringify(path.join(ROOT, "src/cache/store.ts"))}; import {DEFAULTS} from ${JSON.stringify(path.join(ROOT, "src/config.ts"))};` +
      ` storeSection(${JSON.stringify(acct)}, DEFAULTS, "fields/t${i}", "x", "{}", {header:["field"],rows:[["a"]]});`;
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        new Promise((r) => spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code(i)], { stdio: "ignore" }).on("exit", r)),
      ),
    );
    const m = JSON.parse(fs.readFileSync(path.join(acct, "manifest.json"), "utf8"));
    assert.equal(Object.keys(m.sections).length, 10);
    assert.equal(fs.existsSync(path.join(acct, "manifest.lock")), false);
  });
});

describe("cache store: section paths", () => {
  it("section names can't leave the account dir; invalid ones are reported", async () => {
    const { safeSectionName, sectionFile, sectionNameProblem } = await import("../src/cache/store.ts");
    const acct = fs.mkdtempSync(path.join(os.tmpdir(), "c2-"));
    for (const n of ["../x", "fields/../../x", "/etc/passwd", "fields/..", ".", "fields/.hidden"]) {
      assert.ok(sectionNameProblem(n), n);
      for (const kind of ["raw", "idx"] as const) assert.ok(sectionFile(acct, kind, n, ".json").startsWith(path.join(acct, kind) + path.sep), n);
      assert.doesNotMatch(safeSectionName(n), /(^|\/)\.\.?(\/|$)/, n);
    }
    for (const n of ["fields/transaction", "recordmeta/_all", "probe/base_currency", "fields/custrecord-x.y"]) assert.equal(sectionNameProblem(n), undefined, n);
  });
});

describe("cache paths stay inside the account dir", () => {
  it("section names can't climb out, whatever they contain", async () => {
    const { DEFAULTS } = await import("../src/config.ts");
    const { readIndex, readRaw, safeSectionName, sectionFile, sectionNameProblem, storeSection } = await import("../src/cache/store.ts");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2-"));
    const acct = path.join(root, "accounts", "a");
    for (const bad of ["fields/../../../x", "../x", "recordmeta/..", "fields/.hidden", "fields/a/b", "fields/a b"]) assert.ok(sectionNameProblem(bad), bad);
    for (const good of ["fields/transaction", "recordmeta/_all", "probe/base_currency", "periods", "fields/custrecord-x.y"]) assert.equal(sectionNameProblem(good), undefined, good);
    assert.equal(safeSectionName("fields/../../x"), "fields/_./_./x");
    // Even called directly with a hostile name, the store writes inside acct/raw and acct/idx.
    storeSection(acct, DEFAULTS, "recordmeta/../../../../victim", "x", "{}", { header: ["field"], rows: [["a"]] });
    const all = fs.readdirSync(root, { recursive: true, encoding: "utf8" }).map((f) => path.join(root, f));
    for (const f of all.filter((f) => fs.statSync(f).isFile())) assert.ok(f.startsWith(acct + path.sep), `wrote ${f}`);
    assert.equal(readRaw(acct, "../../../../etc/passwd"), undefined);
    assert.deepEqual(readIndex(acct, "../../x").rows, []);
    assert.equal(sectionFile(acct, "raw", "../..", ".json"), path.join(acct, "raw", "_.", "_..json"));
  });

  it("parallel hook processes don't drop each other's session-state updates", async () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "state-race-"));
    const code = (i: number) =>
      `import {loadState, saveState} from ${JSON.stringify(path.join(ROOT, "src/session.ts"))};` +
      ` const s = loadState(${JSON.stringify(data)}, "s"); (s.rateLimits ??= {})["k${i}"] = { n: 1, at: Date.now() }; (s.metadataAsked ??= []).push("t${i}"); saveState(${JSON.stringify(data)}, "s", s);`;
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        new Promise((r) => spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code(i)], { stdio: "ignore" }).on("exit", r)),
      ),
    );
    const st = JSON.parse(fs.readFileSync(path.join(data, "sessions", "s", "state.json"), "utf8"));
    assert.equal(Object.keys(st.rateLimits).length, 10);
    assert.equal(st.metadataAsked.length, 10);
    // A deletion made by one process survives another's unrelated save.
    const { loadState, saveState } = await import("../src/session.ts");
    const a = loadState(data, "s");
    const b = loadState(data, "s");
    delete a.rateLimits!.k0;
    saveState(data, "s", a);
    b.rateLimits!.k99 = { n: 2, at: 1 };
    saveState(data, "s", b);
    const end = loadState(data, "s");
    assert.equal("k0" in end.rateLimits!, false);
    assert.equal(end.rateLimits!.k99.n, 2);
  });
});

describe("config", () => {
  it("parses TTL overrides and ignores junk", () => {
    assert.deepEqual(parseTtlOverrides("searches=2, periods=0.5;bogus=3 reports=x fields=0"), { searches: 2, periods: 0.5 });
  });
});
