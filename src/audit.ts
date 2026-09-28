import * as fs from "node:fs";
import * as path from "node:path";
import { isWriteTool, previewHash } from "./preview.ts";
import { csvCell, ensureDir, isoDate } from "./util.ts";

export interface AuditEntry {
  ts: string;
  session: string;
  tool: string;
  input: unknown;
  /** `unknown`: a write whose response gave no positive sign of success. */
  outcome: "ok" | "error" | "denied" | "pending" | "unknown";
  rows?: number;
  durationMs?: number;
  resultId?: string;
  errorClass?: string;
  note?: string;
  /** Writes only: the preview hash, which pairs a "pending" line with its later "ok"/"error". */
  preview?: string;
}

export function auditDir(acctDir: string): string {
  return path.join(acctDir, "audit");
}

export function appendAudit(acctDir: string, e: AuditEntry): void {
  const dir = ensureDir(auditDir(acctDir));
  if (isWriteTool(e.tool) && e.input && typeof e.input === "object" && !Array.isArray(e.input)) {
    e = { ...e, preview: previewHash(e.tool, e.input as Record<string, unknown>) };
  }
  fs.appendFileSync(path.join(dir, `${isoDate()}.jsonl`), JSON.stringify(e) + "\n");
}

export function readAudit(acctDir: string, opts: { session?: string; days?: number } = {}): AuditEntry[] {
  const dir = auditDir(acctDir);
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  // One file per UTC day (appendAudit), so the last N files are the last N days with activity.
  if (opts.days) files = files.slice(-opts.days);
  const out: AuditEntry[] = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as AuditEntry;
        if (!opts.session || e.session === opts.session) out.push(e);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

export function auditCsv(entries: AuditEntry[]): string {
  const cols = ["ts", "session", "tool", "outcome", "rows", "durationMs", "resultId", "errorClass", "preview", "input", "note"] as const;
  const lines = [cols.join(",")];
  for (const e of entries) {
    lines.push(cols.map((c) => csvCell(c === "input" ? JSON.stringify(e.input) : e[c], true)).join(","));
  }
  return lines.join("\n") + "\n";
}
