import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Ctx, context } from "../src/config.ts";

export const FIXTURES = path.join(import.meta.dirname, "fixtures");

export function fixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));
}

/** Fresh isolated data dir + configured account for each test. */
export function tmpCtx(opts: Record<string, string> = {}): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nsx-test-"));
  process.env.NSX_DATA_DIR = dir;
  // Keep the developer's own ~/.claude out of the tests.
  process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "nsx-home-"));
  for (const k of Object.keys(process.env)) if (k.startsWith("CLAUDE_PLUGIN_OPTION_")) delete process.env[k];
  process.env.CLAUDE_PLUGIN_OPTION_ACCOUNT_ID = opts.account_id ?? "1234567";
  for (const [k, v] of Object.entries(opts)) process.env[`CLAUDE_PLUGIN_OPTION_${k.toUpperCase()}`] = v;
  if (opts.account_id === "") delete process.env.CLAUDE_PLUGIN_OPTION_ACCOUNT_ID;
  return context();
}

export function hso(out: { json?: Record<string, unknown> } | undefined): Record<string, unknown> {
  return ((out?.json?.hookSpecificOutput as Record<string, unknown>) ?? {});
}

export const text = (s: string) => [{ type: "text", text: s }];

export function bigRows(n: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i++) {
    rows.push({
      tranid: `INV${10000 + i}`,
      trandate: `2026-0${1 + (i % 9)}-1${i % 9}`,
      entity: `Customer ${i % 412}`,
      amount: ((i * 37) % 9000) + 0.5,
      status: i % 3 ? "Open" : "Paid",
      subsidiary: `Sub ${i % 4}`,
      currency: "USD",
      memo: `memo ${i}`,
      id: i + 1,
    });
  }
  return rows;
}
