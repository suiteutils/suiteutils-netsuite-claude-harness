#!/usr/bin/env node
// Copies the version from package.json (the single source of truth) to every other place that
// carries it. Runs automatically from `npm version <x.y.z>`; test/version.test.ts checks the result.
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.join(import.meta.dirname, "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`package.json version is not semver: ${version}`);

function edit(file, pattern, replacement) {
  const p = path.join(root, file);
  const before = fs.readFileSync(p, "utf8");
  if (!pattern.test(before)) throw new Error(`${file}: version pattern not found`);
  fs.writeFileSync(p, before.replace(pattern, replacement));
}

edit(".claude-plugin/plugin.json", /("version":\s*")[^"]+(")/, `$1${version}$2`);
edit("src/config.ts", /(export const PLUGIN_VERSION = ")[^"]+(")/, `$1${version}$2`);
edit("skills/netsuite/SKILL.md", /^(\s+version: ")[^"]+(")/m, `$1${version}$2`);
console.log(`version ${version} synced`);
