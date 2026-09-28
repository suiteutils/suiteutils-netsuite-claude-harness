/** Every SQL example we ship must pass our own checker. */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { PROBES } from "../src/cache/probes.ts";
import { lintSuiteQL } from "../src/sql/lint.ts";

const ROOT = path.join(import.meta.dirname, "..");

function sqlBlocks(file: string): string[] {
  const md = fs.readFileSync(path.join(ROOT, file), "utf8");
  const blocks = [...md.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]);
  // init's probe table: | `description` | `sqlQuery` |
  for (const m of md.matchAll(/^\| `[^`]*\[su-ns-harness:[^`]*` \| `([^`]+)` \|$/gm)) blocks.push(m[1]);
  return blocks;
}

describe("shipped SQL lints clean", () => {
  for (const file of ["skills/netsuite/SKILL.md", "skills/netsuite/references/suiteql.md", "skills/netsuite/references/tools.md", "skills/init/SKILL.md", "skills/refresh/SKILL.md"]) {
    it(file, () => {
      const blocks = sqlBlocks(file);
      for (const sql of blocks) {
        const hasRight = sql.includes("-- RIGHT");
        if (/^-- WRONG/m.test(sql)) {
          // The anti-examples are the bugs we claim to catch: the checker must still flag them.
          const wrong = hasRight ? sql.slice(0, sql.indexOf("-- RIGHT")) : sql;
          assert.ok(lintSuiteQL(wrong).errors.length > 0, `${file}: WRONG example no longer caught:\n${wrong}`);
          if (!hasRight) continue;
        }
        const right = hasRight ? sql.slice(sql.indexOf("-- RIGHT")) : sql;
        const r = lintSuiteQL(right);
        assert.deepEqual(r.errors, [], `${file}:\n${right}`);
      }
    });
  }
  it("init has all five probes", () => assert.equal(sqlBlocks("skills/init/SKILL.md").length, 5));
  it("refresh has all five probes", () => assert.equal(sqlBlocks("skills/refresh/SKILL.md").length, 5));
});

describe("tagged probe SQL in skills matches the code", () => {
  // The hook caches a tagged result only when its SQL is exactly PROBES' (src/cache/probes.ts), so
  // every skill that tells Claude to run one must carry the same description and SQL.
  for (const file of ["skills/init/SKILL.md", "skills/refresh/SKILL.md"]) {
    it(file, () => {
      const md = fs.readFileSync(path.join(ROOT, file), "utf8");
      const table = [...md.matchAll(/^\| `([^`]*\[su-ns-harness:([^\]]+)\])` \| `([^`]+)` \|$/gm)].map((m) => ({ tag: m[2], description: m[1], sql: m[3] }));
      assert.deepEqual(table, PROBES.map((p) => ({ tag: p.tag, description: p.description, sql: p.sql })));
    });
  }
});

describe("skills Claude runs on its own", () => {
  // Session context and hook messages tell Claude to run refresh/doctor itself.
  for (const file of ["skills/init/SKILL.md", "skills/refresh/SKILL.md", "skills/doctor/SKILL.md"]) {
    it(`${file} is model-invocable`, () => {
      const front = fs.readFileSync(path.join(ROOT, file), "utf8").split(/^---$/m)[1] ?? "";
      assert.doesNotMatch(front, /disable-model-invocation:\s*true/);
    });
  }
});

describe("nsx invocation guidance", () => {
  // nsx isn't on PATH; every skill and the agent must point at the SessionStart path first.
  for (const file of ["skills/netsuite/SKILL.md", "skills/init/SKILL.md", "skills/refresh/SKILL.md", "skills/doctor/SKILL.md", "agents/ns-explorer.md"]) {
    it(file, () => {
      const md = fs.readFileSync(path.join(ROOT, file), "utf8");
      assert.match(md, /\*\*`nsx` is not on PATH\.\*\* Run every `nsx …`( below)? with the exact command on the `Cache CLI:` line of the session context/);
      assert.match(md, /use `node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/nsx\.mjs" …` \(Bash\)/);
    });
  }
});
