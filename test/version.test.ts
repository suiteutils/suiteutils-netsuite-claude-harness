/** Every copy of the version matches package.json (see scripts/sync-version.mjs). */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { PLUGIN_VERSION } from "../src/config.ts";

const ROOT = path.join(import.meta.dirname, "..");
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
const version = JSON.parse(read("package.json")).version as string;

describe("version", () => {
  it("is semver", () => assert.match(version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/));
  it("plugin.json matches", () => assert.equal(JSON.parse(read(".claude-plugin/plugin.json")).version, version));
  it("package-lock.json matches", () => assert.equal(JSON.parse(read("package-lock.json")).version, version));
  it("PLUGIN_VERSION matches", () => assert.equal(PLUGIN_VERSION, version));
  it("netsuite skill metadata matches", () => assert.match(read("skills/netsuite/SKILL.md"), new RegExp(`^\\s+version: "${version.replace(/\./g, "\\.")}"`, "m")));
  it("has a CHANGELOG entry", () => assert.match(read("CHANGELOG.md"), new RegExp(`^## ${version.replace(/\./g, "\\.")}\\b`, "m")));
});
