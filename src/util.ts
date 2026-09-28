import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Write via temp file + rename so a crashed hook never leaves half a manifest behind. */
export function writeFileAtomic(file: string, data: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

export function writeJson(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2));
}

export function sha256(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function shortId(prefix = "r_"): string {
  return prefix + randomBytes(3).toString("hex");
}

/** Stable JSON (sorted keys) so equal inputs hash equally regardless of key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const rounded = Math.round(n * 100) / 100 || 0; // no "-0"
  return rounded.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function ageLabel(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

export function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

// ---------- CSV / TSV ----------

/**
 * `spreadsheet`: the file is for Excel/Sheets, so a text cell starting with = + - @ (or a tab/CR)
 * gets a leading ' to stop it running as a formula (CWE-1236). Plain numbers are left alone.
 */
export function csvCell(v: unknown, spreadsheet = false): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (spreadsheet && /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: Record<string, unknown>[], spreadsheet = false): string {
  const lines = [columns.map((c) => csvCell(c, spreadsheet)).join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c], spreadsheet)).join(","));
  return lines.join("\n") + "\n";
}

export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

export function tsvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/[\t\r\n]+/g, " ");
}

export function readTsv(file: string): string[][] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.length)
      .map((l) => l.split("\t"));
  } catch {
    return [];
  }
}

/** Render rows as a fixed-width text table: header + up to maxRows rows (+ a "… more" line). */
/** `full`: columns (by header name) never cut at 40 chars, e.g. the report `params` list. */
export function textTable(header: string[], rows: string[][], maxRows = 60, opts: { full?: string[] } = {}): string {
  const n = maxRows === Infinity ? rows.length : Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : 60;
  const shown = rows.slice(0, n);
  const widths = header.map((h, i) =>
    Math.min(opts.full?.includes(h) ? Infinity : 40, Math.max(h.length, ...shown.map((r) => (r[i] ?? "").length))),
  );
  const fmt = (r: string[]) =>
    r
      .map((c, i) => {
        const s = (c ?? "").length > widths[i] ? `${c.slice(0, widths[i] - 1)}…` : (c ?? "");
        return s.padEnd(widths[i]);
      })
      .join("  ")
      .trimEnd();
  const lines = [fmt(header), ...shown.map(fmt)];
  if (rows.length > shown.length) lines.push(`… ${rows.length - shown.length} more rows`);
  return lines.join("\n");
}

/** `nsx … | head` closes the pipe early; that's not an error. */
export function ignoreEpipe(stream: NodeJS.WriteStream = process.stdout): void {
  stream.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw e;
  });
}
