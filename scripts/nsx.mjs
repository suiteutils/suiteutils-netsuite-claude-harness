#!/usr/bin/env node

// src/cli.ts
import { spawnSync } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
import * as fs12 from "node:fs";
import * as os3 from "node:os";
import * as path13 from "node:path";

// src/audit.ts
import * as fs3 from "node:fs";
import * as path3 from "node:path";

// src/preview.ts
import * as fs2 from "node:fs";
import * as path2 from "node:path";

// src/util.ts
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeFileAtomic(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
function writeJson(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2));
}
function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}
function shortId(prefix = "r_") {
  return prefix + randomBytes(3).toString("hex");
}
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function truncate(s, max) {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}\u2026`;
}
function fmtNum(n) {
  if (!Number.isFinite(n)) return String(n);
  const rounded = Math.round(n * 100) / 100 || 0;
  return rounded.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
function ageLabel(ms) {
  const h = ms / 36e5;
  if (h < 1) return `${Math.max(1, Math.round(ms / 6e4))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}
function isoDate(d = /* @__PURE__ */ new Date()) {
  return d.toISOString().slice(0, 10);
}
function csvCell(v, spreadsheet = false) {
  if (v === null || v === void 0) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (spreadsheet && /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(columns, rows, spreadsheet = false) {
  const lines = [columns.map((c) => csvCell(c, spreadsheet)).join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c], spreadsheet)).join(","));
  return lines.join("\n") + "\n";
}
function parseCsv(text) {
  const out2 = [];
  let row = [];
  let cell2 = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell2 += '"';
          i++;
        } else inQuotes = false;
      } else cell2 += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      row.push(cell2);
      cell2 = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell2);
      out2.push(row);
      row = [];
      cell2 = "";
    } else cell2 += ch;
  }
  if (cell2 !== "" || row.length) {
    row.push(cell2);
    out2.push(row);
  }
  return out2;
}
function tsvCell(v) {
  if (v === null || v === void 0) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/[\t\r\n]+/g, " ");
}
function readTsv(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.length).map((l) => l.split("	"));
  } catch {
    return [];
  }
}
function textTable(header, rows, maxRows = 60, opts = {}) {
  const n = maxRows === Infinity ? rows.length : Number.isFinite(maxRows) ? Math.max(0, Math.floor(maxRows)) : 60;
  const shown = rows.slice(0, n);
  const widths = header.map(
    (h, i) => Math.min(opts.full?.includes(h) ? Infinity : 40, Math.max(h.length, ...shown.map((r) => (r[i] ?? "").length)))
  );
  const fmt = (r) => r.map((c, i) => {
    const s = (c ?? "").length > widths[i] ? `${c.slice(0, widths[i] - 1)}\u2026` : c ?? "";
    return s.padEnd(widths[i]);
  }).join("  ").trimEnd();
  const lines = [fmt(header), ...shown.map(fmt)];
  if (rows.length > shown.length) lines.push(`\u2026 ${rows.length - shown.length} more rows`);
  return lines.join("\n");
}
function ignoreEpipe(stream = process.stdout) {
  stream.on("error", (e) => {
    if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
    throw e;
  });
}

// src/preview.ts
var READ_TOOLS = /* @__PURE__ */ new Set([
  "ns_runCustomSuiteQL",
  "ns_runSavedSearch",
  "ns_runReport",
  "ns_getRecord",
  "ns_listAllReports",
  "ns_listSavedSearches",
  "ns_getSubsidiaries",
  "ns_getAccountingBooks",
  "ns_getAccountingContexts",
  "ns_getNexusIds",
  "ns_getSuiteQLMetadata",
  "ns_getRecordTypeMetadata",
  // The claude.ai NetSuite connector's UI apps (seen in the live tool list): pickers and a prompt library.
  "ns_prompt_library_app",
  "ns_report_filters_app",
  "ns_selector_app"
]);
var KNOWN_WRITE_TOOL = /^ns_(create|update|upsert|delete|transform|attach|detach)/i;
function isReadTool(tool) {
  return READ_TOOLS.has(tool) || /^ns_(get|list)(?=[A-Z_])/.test(tool);
}
function isWriteTool(tool) {
  return /^ns_/.test(tool) && !isReadTool(tool);
}
function previewHash(tool, input) {
  return sha256(`${tool}
${canonicalJson(input)}`).slice(0, 16);
}
function previewsDir(baseDir) {
  return path2.join(baseDir, "previews");
}
function flat(o, prefix = "", out2 = {}) {
  if (o && typeof o === "object" && !Array.isArray(o) && (Object.keys(o).length || !prefix)) {
    for (const [k, v] of Object.entries(o)) flat(v, prefix ? `${prefix}.${k}` : k, out2);
  } else out2[prefix] = o;
  return out2;
}
var show = (v) => v === void 0 ? "\u2205" : JSON.stringify(v);
var TARGET_KEYS = /^(recordType|recordId|id|type)$/i;
var WRAPPERS = ["values", "fields", "data", "record", "body"];
var ENVELOPE = /^(success|message|links)$/i;
var isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function fieldsOf(o, envelope, top = true) {
  const out2 = {};
  const wrapped = [];
  for (const [k, v] of Object.entries(o)) {
    if (WRAPPERS.includes(k) && isObj(v)) wrapped.push(v);
    else if (top && (TARGET_KEYS.test(k) || envelope && ENVELOPE.test(k))) continue;
    else out2[k] = v;
  }
  for (const w of wrapped) Object.assign(out2, fieldsOf(w, envelope, false));
  return out2;
}
function diffLines(tool, input, before) {
  const after = flat(fieldsOf(input, false));
  const create = /create/i.test(tool);
  const lines = [];
  if (create || !before) {
    for (const [k, v] of Object.entries(after)) lines.push(`+ ${k} = ${show(v)}`);
    if (!lines.length) lines.push("(the input sets no field values)");
    return lines;
  }
  const prev = flat(fieldsOf(before, true));
  const prevLc = new Map(Object.keys(prev).map((k) => [k.toLowerCase(), k]));
  for (const [k, v] of Object.entries(after)) {
    const bk = k in prev ? k : prevLc.get(k.toLowerCase());
    if (bk === void 0) lines.push(`~ ${k}: (not in the before-record) \u2192 ${show(v)}`);
    else if (canonicalJson(prev[bk]) !== canonicalJson(v)) lines.push(`~ ${k}: ${show(prev[bk])} \u2192 ${show(v)}`);
  }
  if (!lines.length) lines.push(Object.keys(after).length ? "(no field changes detected: every field in the input already has that value in the before-record)" : "(the input sets no field values)");
  return lines;
}
function writePreview(baseDir, tool, input, before) {
  const preview = { tool, input, before, createdAt: (/* @__PURE__ */ new Date()).toISOString(), diff: diffLines(tool, input, before) };
  const file = path2.join(previewsDir(baseDir), `${previewHash(tool, input)}.json`);
  writeJson(file, preview);
  return { file, preview };
}
function findPreview(baseDir, tool, input) {
  const file = path2.join(previewsDir(baseDir), `${previewHash(tool, input)}.json`);
  if (!fs2.existsSync(file)) return void 0;
  return readJson(file, void 0);
}
function cleanupPreviews(baseDir, retentionDays, now = Date.now()) {
  const dir = previewsDir(baseDir);
  let removed = 0;
  try {
    for (const f of fs2.readdirSync(dir)) {
      const p = path2.join(dir, f);
      if (now - fs2.statSync(p).mtimeMs > retentionDays * 864e5) {
        fs2.unlinkSync(p);
        removed++;
      }
    }
  } catch {
  }
  return removed;
}
function describeTarget(tool, input) {
  const t = input.recordType ?? input.type ?? "record";
  const id = input.recordId ?? input.id;
  return `${tool.replace(/^ns_/, "")} ${t}${id ? ` #${id}` : ""}`;
}

// src/audit.ts
function auditDir(acctDir) {
  return path3.join(acctDir, "audit");
}
function appendAudit(acctDir, e) {
  const dir = ensureDir(auditDir(acctDir));
  if (isWriteTool(e.tool) && e.input && typeof e.input === "object" && !Array.isArray(e.input)) {
    e = { ...e, preview: previewHash(e.tool, e.input) };
  }
  fs3.appendFileSync(path3.join(dir, `${isoDate()}.jsonl`), JSON.stringify(e) + "\n");
}
function readAudit(acctDir, opts = {}) {
  const dir = auditDir(acctDir);
  let files = [];
  try {
    files = fs3.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  if (opts.days) files = files.slice(-opts.days);
  const out2 = [];
  for (const f of files) {
    for (const line of fs3.readFileSync(path3.join(dir, f), "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (!opts.session || e.session === opts.session) out2.push(e);
      } catch {
      }
    }
  }
  return out2;
}
function auditCsv(entries) {
  const cols = ["ts", "session", "tool", "outcome", "rows", "durationMs", "resultId", "errorClass", "preview", "input", "note"];
  const lines = [cols.join(",")];
  for (const e of entries) {
    lines.push(cols.map((c) => csvCell(c === "input" ? JSON.stringify(e.input) : e[c], true)).join(","));
  }
  return lines.join("\n") + "\n";
}

// src/sql/tokenize.ts
function tokenize(sql) {
  const toks = [];
  let i = 0;
  let depth = 0;
  const push = (type, value, start, end, d = depth) => toks.push({ type, value, raw: sql.slice(start, end), start, end, depth: d });
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      i = e < 0 ? sql.length : e + 2;
      continue;
    }
    const start = i;
    if (c === "'") {
      let v = "";
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          v += "'";
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else v += sql[i++];
      }
      push("str", v, start, i);
      continue;
    }
    if (c === '"') {
      const e = sql.indexOf('"', i + 1);
      i = e < 0 ? sql.length : e + 1;
      push("qid", sql.slice(start + 1, i - 1).toLowerCase(), start, i);
      continue;
    }
    if (/[0-9]/.test(c) || c === "." && /[0-9]/.test(sql[i + 1] ?? "")) {
      while (i < sql.length && /[0-9.eE]/.test(sql[i])) i++;
      push("num", sql.slice(start, i), start, i);
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      while (i < sql.length && /[A-Za-z0-9_$#]/.test(sql[i])) i++;
      push("word", sql.slice(start, i).toLowerCase(), start, i);
      continue;
    }
    if (c === "(") {
      push("lp", c, i, ++i, depth);
      depth++;
      continue;
    }
    if (c === ")") {
      depth = Math.max(0, depth - 1);
      push("rp", c, i, ++i, depth);
      continue;
    }
    if (c === ",") {
      push("comma", c, i, ++i);
      continue;
    }
    if (c === ".") {
      push("dot", c, i, ++i);
      continue;
    }
    if (c === "*") {
      push("star", c, i, ++i);
      continue;
    }
    if (c === ";") {
      push("semi", c, i, ++i);
      continue;
    }
    if (c === "?" || c === ":") {
      i++;
      while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i++;
      push("param", sql.slice(start, i), start, i);
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (["<=", ">=", "<>", "!=", "||"].includes(two)) {
      i += 2;
      push("op", two, start, i);
      continue;
    }
    push("op", c, i, ++i);
  }
  return toks;
}
var SET_OPS = /* @__PURE__ */ new Set(["union", "minus", "intersect", "except"]);
function scopes(toks) {
  const out2 = [];
  const stack = [{ open: -1, close: toks.length, depth: 0, direct: [], isQuery: false }];
  toks.forEach((t, i) => {
    if (t.type === "lp") {
      stack[stack.length - 1].direct.push(i);
      stack.push({ open: i, close: -1, depth: t.depth + 1, direct: [], isQuery: false });
    } else if (t.type === "rp") {
      if (stack.length > 1) {
        const s = stack.pop();
        s.close = i;
        out2.push(s);
      }
      stack[stack.length - 1].direct.push(i);
    } else stack[stack.length - 1].direct.push(i);
  });
  while (stack.length > 1) {
    const s = stack.pop();
    s.close = toks.length;
    out2.push(s);
  }
  out2.push(stack[0]);
  const byOpen = new Map(out2.filter((s) => s.open >= 0).map((s) => [s.open, s]));
  for (const s of out2) {
    const first = toks[s.direct[0]];
    if (first?.type === "word") s.isQuery = first.value === "select" || first.value === "with";
    else if (first?.type === "lp" && byOpen.get(s.direct[0])?.isQuery) {
      s.isQuery = s.open < 0 || s.direct.some((i) => toks[i].type === "word" && SET_OPS.has(toks[i].value));
    }
  }
  return out2;
}

// src/errors.ts
var RULES = [
  // First: the message echoes the whole query, whose text could match any rule below (seen live).
  ["bad_syntax", /failed to parse sql/i],
  // Claude Code's own message when the connector's MCP session is gone (seen live).
  ["unreachable", /couldn'?t reach the MCP server|could not reach the MCP server|MCP server .{0,40}(not connected|disconnected|unavailable)|ECONNREFUSED|ENOTFOUND/i],
  // Governance (script usage units), not concurrency: narrow the query. Before rate_limit.
  ["timeout", /SSS_USAGE_LIMIT_EXCEEDED|usage limit exceeded/i],
  // A bare 429 also appears in echoed params (saved search id 429), so only HTTP/status 429 counts.
  ["rate_limit", /too many requests|\bHTTP\/?\S* 429\b|\bstatus(?:\s*code)?"?\s*[:=]?\s*429\b|\b429 too many\b|concurrent request limit|concurrency limit|rate.?limit|SSS_REQUEST_LIMIT_EXCEEDED/i],
  ["auth", /\b401\b|invalid_token|invalid_grant|unauthori[sz]ed|re-?authenticat|token (has )?expired|login required|INVALID_LOGIN|session (has )?(expired|timed out)/i],
  // Saved search of a standalone record type called without `type` (live: System Note searches).
  ["bad_record_type", /unable to determine record type/i],
  ["permission", /INSUFFICIENT_PERMISSION|do(es)? not have permission|permission (violation|denied)|\b403\b|not authori[sz]ed to|access denied/i],
  ["bad_record_type", /record type.*(not found|invalid|unknown|does not exist)|table .{0,80}(not found|does not exist)|invalid (search |record )?type|INVALID_RCRD_TYPE|unknown record type/i],
  ["bad_field", /unknown identifier|invalid (field|column|identifier)|(field|column) .{0,80}(not found|does not exist|is not valid|unknown)|unknown (field|column)|INVALID_FLD|not a valid field|ORA-00904/i],
  ["timeout", /time(d)? ?out|SSS_TIME_LIMIT_EXCEEDED|deadline exceeded|ETIMEDOUT|took too long/i],
  // Only when it's a report/search/record that's missing; a bare "does not exist" is too broad.
  ["not_found", /\b404\b|(report|saved search|search|record)\b.{0,80}\b(not found|does not exist|doesn't exist)|RCRD_DSNT_EXIST|INVALID_KEY_OR_REF|no (such )?(report|search|record)\b/i],
  ["bad_syntax", /syntax|parse error|invalid or unsupported search|unexpected token|ORA-009\d\d|missing (right|left) parenthesis|invalid (sql|query)/i]
];
var GENERIC_SUITESCRIPT = /unexpected SuiteScript error/i;
function classifyError(msg) {
  for (const [cls, re] of RULES) if (re.test(msg)) return cls;
  return "unknown";
}
var NOT_TABLE = /* @__PURE__ */ new Set(["select", "lateral", "dual"]);
var FROM_END = /* @__PURE__ */ new Set(["where", "group", "order", "having", "fetch", "union", "minus", "intersect", "connect", "start", "on", "join", "left", "right", "inner", "outer", "full", "cross", "offset"]);
function tablesInSql(sql) {
  const out2 = /* @__PURE__ */ new Set();
  let toks;
  try {
    toks = tokenize(sql);
  } catch {
    for (const m of sql.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)\b(?!\s*\.)/gi)) if (!NOT_TABLE.has(m[1].toLowerCase())) out2.add(m[1].toLowerCase());
    return [...out2];
  }
  for (const s of scopes(toks)) {
    if (!s.isQuery) continue;
    const d = s.direct;
    const take = (k) => {
      const t = toks[d[k]];
      const next = toks[d[k + 1]];
      if (t?.type === "word" && next?.type !== "dot" && !NOT_TABLE.has(t.value)) out2.add(t.value);
    };
    let inFrom = false;
    for (let k = 0; k < d.length; k++) {
      const t = toks[d[k]];
      if (t.type === "word" && (t.value === "from" || t.value === "join")) {
        take(k + 1);
        inFrom = t.value === "from";
      } else if (inFrom && t.type === "comma") take(k + 1);
      else if (t.type === "word" && FROM_END.has(t.value)) inFrom = false;
    }
  }
  return [...out2];
}
function fieldErrorTable(msg) {
  return /\b(?:field|column) '[^']*' (?:for|on|in) (?:record|table) '([a-z0-9_]+)'/i.exec(msg)?.[1]?.toLowerCase();
}
var MAX_RATE_LIMIT_TRIES = 3;
function rateLimitWait(attempt, rand = Math.random) {
  return 5 * 2 ** (attempt - 1) + Math.floor(rand() * 4);
}
function missingTable(msg) {
  return /record '([a-z0-9_]+)' was not found/i.exec(msg)?.[1];
}
var STANDALONE_SEARCH_TYPES = { "system note": "SystemNote", "saved search": "SavedSearch" };
function searchTypeErrorId(msg) {
  return /unable to determine record type for saved search id\s+([\w-]+)/i.exec(msg)?.[1];
}
function syntaxPosition(msg) {
  const m = [...msg.matchAll(/near:\s*(.*?)\((\d+),(\d+)\b/g)].pop();
  return m ? { near: m[1].trim(), line: Number(m[2]), column: Number(m[3]) } : void 0;
}
function syntaxHint(msg, sql) {
  const parts = [];
  const pos = syntaxPosition(msg);
  if (pos) {
    const line = sql?.split("\n")[pos.line - 1];
    const at = line !== void 0 && pos.column <= line.length + 1 ? line.slice(Math.max(0, pos.column - 25), pos.column + 15).trim() : "";
    parts.push(`NetSuite points near column ${pos.column}${pos.line > 1 ? ` of line ${pos.line}` : ""}${pos.near ? ` ("${pos.near}")` : ""}${at ? `: \u2026${at}\u2026` : ""}.`);
  }
  if (/invalid or unsupported search/i.test(msg)) {
    parts.push("This is often an ORDER BY on a column alias or a non-grouped expression with GROUP BY: order by the full expression (e.g. COUNT(*) DESC) or drop ORDER BY.");
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}
function advice(cls, opts = {}) {
  const attempt = opts.attempt ?? 1;
  switch (cls) {
    case "unreachable":
      return "Claude Code couldn't reach the NetSuite MCP server (connector disconnected or its login expired). Don't retry in a loop. Tell the user to re-authenticate: /mcp \u2192 NetSuite \u2192 Authenticate (a claude.ai connector: reconnect it under Settings \u2192 Connectors), then ask again.";
    case "rate_limit": {
      if (attempt > MAX_RATE_LIMIT_TRIES) {
        return `NetSuite rate limit (concurrency) hit ${attempt} times in a row on this call. Stop retrying; tell the user the account's integration concurrency limit is saturated (other integrations may be running) and try again later.`;
      }
      const wait = rateLimitWait(attempt, opts.rand);
      return `NetSuite rate limit: the account shares a small integration concurrency limit. Run \`sleep ${wait}\` then retry this exact call ONCE (attempt ${attempt} of ${MAX_RATE_LIMIT_TRIES}). Make NetSuite calls strictly one at a time \u2014 never in parallel.`;
    }
    case "auth":
      return "NetSuite authentication failed. Do not retry. Tell the user to reconnect the NetSuite connector (run /mcp, select the NetSuite server, re-authenticate), then ask again.";
    case "permission":
      return "The NetSuite role used by the connector lacks a permission for this. Do not retry. Tell the user which record/report was blocked and that the role needs the matching permission (e.g. Lists/Transactions view for that record type, or Reports > Financial Statements for reports).";
    case "bad_field": {
      const t = opts.tables?.length ? opts.tables : ["<table>"];
      if (opts.tool && opts.tool !== "ns_runCustomSuiteQL" && opts.tool !== "ns_getSuiteQLMetadata") {
        const rt = opts.tables?.[0] ?? "<type>";
        return `NetSuite rejected a field: an unknown field name or an invalid value. Check the names with \`nsx fields ${rt} --record --grep <term>\` (select/list fields take a reference such as {"id": "5"}), fix the input${isWriteTool(opts.tool) ? ", preview it again" : ""} and retry once.`;
      }
      return `Unknown field/column. The field cache for ${t.map((x) => `'${x}'`).join(", ")} is now marked stale. Check real names with \`nsx fields ${t[0]} --grep <term>\` (or call ns_getSuiteQLMetadata for the table to refresh it), fix the query, retry once.`;
    }
    case "bad_record_type": {
      if (opts.tool === "ns_runSavedSearch" && searchTypeErrorId(opts.message ?? "")) {
        const rt = opts.searchRecordType;
        const std = rt ? STANDALONE_SEARCH_TYPES[rt.toLowerCase()] : void 0;
        if (std) return `This saved search is a '${rt}' search (from the searches cache), a standalone type the connector can't infer. Call again with type: "${std}" (same searchId and range).`;
        if (rt) return `NetSuite can't infer this saved search's record type. The searches cache says it's a '${rt}' search: if ns_runSavedSearch's \`type\` parameter accepts it, call again with type: "${rt.replace(/\s+/g, "")}" (the record type without spaces); otherwise tell the user this search can't be run through the connector. Don't retry without \`type\`.`;
        return "NetSuite can't infer this saved search's record type. Look it up with `nsx searches search <id or title>` (recordtype column) and call again with `type` set to that record type without spaces (e.g. System Note \u2192 \"SystemNote\"). Don't retry without `type`.";
      }
      if (opts.tool === "ns_getRecord" || opts.tool === "ns_getRecordTypeMetadata") {
        return "Unknown record type. REST record types are lower-case (invoice, vendorbill, journalentry, customer); check the name with ns_getRecordTypeMetadata (no arguments), then call again with the exact name.";
      }
      return "Unknown record type. Check the cached list with `nsx recordtypes --grep <term>`; SuiteQL table names are lower-case record ids (e.g. transaction, customer, vendorbill is NOT a table \u2014 use transaction with type = 'VendBill').";
    }
    case "bad_syntax":
      return `SuiteQL syntax error.${syntaxHint(opts.message ?? "", opts.sql)} Run the query through \`nsx sql lint -\` first (ORDER BY \u2026 FETCH FIRST n ROWS ONLY instead of ROWNUM/LIMIT, no WITH, dates via TO_DATE('2026-01-31','YYYY-MM-DD'), || to concatenate, BUILTIN.DF(field) for display names). Retry once after fixing.`;
    case "timeout":
      if (/SSS_USAGE_LIMIT_EXCEEDED|usage limit exceeded/i.test(opts.message ?? "")) {
        return "NetSuite stopped the call at its governance (script usage) limit: the request did too much work, it's not a rate limit. Don't retry the same call. Narrow it: shorter date range, subsidiary filter, fewer rows (smaller pageSize or range), aggregate in SQL instead of pulling detail, or split by period or id range.";
      }
      return "The NetSuite call timed out. Don't retry the same call. Narrow it: shorter date range, subsidiary filter, aggregate in SQL instead of pulling detail, or split by period or id range. If it uses ANSI JOIN \u2026 ON, rewrite the joins in Oracle syntax (comma joins, (+) for outer joins; never both styles in one query).";
    case "not_found":
      if (opts.tool === "ns_runCustomSuiteQL") {
        const t = missingTable(opts.message ?? "") ?? opts.tables?.[0] ?? "this table";
        return `SuiteQL table '${t}' isn't exposed to the connector role (or doesn't exist). Don't retry and don't refresh reports or searches: skip what needs '${t}', find the data in another table (nsx recordtypes --grep <term>), or ask a NetSuite admin to grant the role access.`;
      }
      if (opts.tool === "ns_runReport") return "Report not found: the cached report list may be outdated (it's now marked stale). Call ns_listAllReports to refresh it, then find the report again with nsx reports search <term>.";
      if (opts.tool === "ns_runSavedSearch") return "Saved search not found: the cached list may be outdated (it's now marked stale). Call ns_listSavedSearches to refresh it, then find the search again with nsx searches search <term>.";
      if (opts.tool === "ns_getRecord") return "Record not found: no record of that type has this id (or the role can't see it). Don't retry the same id: confirm the internal id with a SuiteQL lookup (e.g. SELECT id, tranid FROM transaction WHERE tranid = '\u2026'), and check the record type matches.";
      if (opts.tool === "ns_getSuiteQLMetadata" || opts.tool === "ns_getRecordTypeMetadata") {
        return `Record type not found. Don't retry the same name: check it in the cached list (${opts.tool === "ns_getSuiteQLMetadata" ? "nsx recordtypes --grep <term>" : "ns_getRecordTypeMetadata with no arguments"}), then call again with the exact name.`;
      }
      return "Not found. Don't retry the same call: check the id or name it uses (a SuiteQL lookup confirms an internal id), then call again.";
    case "bad_field_likely": {
      const cols = opts.columns?.length ? opts.columns : ["<table.column>"];
      const [table, column] = cols[0].includes(".") ? cols[0].split(".", 2) : ["<table>", cols[0]];
      const prefix = column.slice(0, Math.max(3, Math.min(column.length - 1, 4)));
      return `The guard flagged ${cols.join(", ")} (not in the connector's metadata) before this call; that's the likely cause, since NetSuite's generic error doesn't name the field. Check: nsx fields ${table} --grep ${prefix}. Fix the column and retry once.`;
    }
    default:
      if (opts.tool === "ns_runCustomSuiteQL" && GENERIC_SUITESCRIPT.test(opts.message ?? "")) {
        return "NetSuite didn't say what's wrong. On this connector a misspelled column or an alias that isn't in FROM/JOIN gives exactly this error: check each column with nsx fields <table> --grep <term> and run the query through nsx sql lint before retrying once.";
      }
      return "Unrecognised NetSuite error. Don't retry blindly: show the user the error text, and only change and re-run the call if the message says what's wrong.";
  }
}

// src/cache/profile.ts
import * as path10 from "node:path";

// src/hooks/session-start.ts
import * as fs9 from "node:fs";
import * as path9 from "node:path";

// src/cache/store.ts
import * as fs5 from "node:fs";
import * as path5 from "node:path";

// src/config.ts
import * as fs4 from "node:fs";
import * as os from "node:os";
import * as path4 from "node:path";
var PLUGIN_VERSION = "0.5.1";
var MARKER = ".su-ns-harness";
var DEFAULT_TTL_DAYS = {
  recordtypes: 30,
  fields: 30,
  recordmeta: 30,
  reports: 7,
  searches: 1,
  subsidiaries: 7,
  books: 30,
  contexts: 30,
  nexus: 30,
  periods: 1,
  profile: 30
};
var DEFAULTS = {
  account_id: "",
  environment: "production",
  inline_max_chars: 6e3,
  saved_search_default_rows: 200,
  suiteql_default_page_size: 500,
  results_retention_days: 7,
  read_only: true,
  ttl_days: { ...DEFAULT_TTL_DAYS }
};
function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path4.join(os.homedir(), ".claude");
}
var NoDataDirError = class extends Error {
  constructor() {
    super(
      "No su-ns-harness data directory found. Start a Claude Code session with the su-ns-harness plugin enabled first (its hooks create it), or set NSX_DATA_DIR."
    );
  }
};
function ownRoot() {
  const script = process.argv[1];
  return script ? path4.resolve(path4.dirname(script), "..") : void 0;
}
function samePath(a, b) {
  try {
    return fs4.realpathSync(a) === fs4.realpathSync(b);
  } catch {
    return path4.resolve(a) === path4.resolve(b);
  }
}
function pluginDataIfOurs() {
  const data = process.env.CLAUDE_PLUGIN_DATA;
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const own = ownRoot();
  if (!data || !root || !own) return void 0;
  return samePath(root, own) ? data : void 0;
}
function pluginRootIfOurs() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  const own = ownRoot();
  return root && own && samePath(root, own) ? root : void 0;
}
var DataDirError = class extends Error {
};
function usableDir(dir, why) {
  const abs = path4.resolve(dir);
  let st;
  try {
    st = fs4.statSync(abs);
  } catch {
  }
  if (st && !st.isDirectory()) throw new DataDirError(`${why} is ${abs}, which is a file, not a directory. Point it at a directory.`);
  if (!st) {
    try {
      ensureDir(abs);
    } catch (e) {
      throw new DataDirError(`${why} is ${abs}, which can't be created (${e.code ?? e.message}).`);
    }
  }
  return abs;
}
function lastHookFired(dir) {
  const hb = readJson(path4.join(dir, "heartbeat.json"), {});
  let best;
  for (const e of Object.values(hb && typeof hb === "object" ? hb : {})) {
    const t = typeof e?.at === "string" ? Date.parse(e.at) : NaN;
    if (Number.isFinite(t) && (best === void 0 || t > best)) best = t;
  }
  return best;
}
function hasAccountCache(dir) {
  try {
    return fs4.readdirSync(path4.join(dir, "accounts")).some((n) => fs4.existsSync(path4.join(dir, "accounts", n, "manifest.json")));
  } catch {
    return false;
  }
}
function pickDataDir(dirs) {
  const scored = dirs.map((dir) => {
    let mtime = 0;
    try {
      mtime = fs4.statSync(path4.join(dir, MARKER)).mtimeMs;
    } catch {
    }
    return { dir, hasCache: hasAccountCache(dir), lastFired: lastHookFired(dir), mtime };
  });
  scored.sort(
    (a, b) => Number(b.hasCache) - Number(a.hasCache) || (b.lastFired ?? -Infinity) - (a.lastFired ?? -Infinity) || b.mtime - a.mtime || a.dir.localeCompare(b.dir)
  );
  const top = scored[0];
  if (!top) return void 0;
  return { dir: top.dir, auto: true, lastFired: top.lastFired, hasCache: top.hasCache, others: scored.slice(1).map((s) => s.dir) };
}
function cliRoot(argv1 = process.argv[1]) {
  if (!argv1 || !/(^|[/\\])(scripts[/\\]nsx\.mjs|src[/\\]cli\.ts)$/.test(argv1)) return void 0;
  return path4.resolve(path4.dirname(argv1), "..");
}
var realOr = (p) => {
  try {
    return fs4.realpathSync(p);
  } catch {
    return path4.resolve(p);
  }
};
function ownDataDirName(root = cliRoot()) {
  if (!root) return void 0;
  const abs = realOr(root);
  const plugin = readJson(path4.join(abs, ".claude-plugin", "plugin.json"), {})?.name;
  if (typeof plugin !== "string" || !plugin) return void 0;
  let market = /[/\\]plugins[/\\]cache[/\\]([^/\\]+)[/\\][^/\\]+[/\\][^/\\]+$/.exec(abs)?.[1];
  if (!market) {
    const m = readJson(path4.join(abs, ".claude-plugin", "marketplace.json"), {});
    const listed = Array.isArray(m?.plugins) && m.plugins.some((p) => p?.name === plugin);
    if (typeof m?.name === "string" && m.name && listed) market = m.name;
  }
  return market ? `${plugin}@${market}`.replace(/[^A-Za-z0-9_-]/g, "-") : void 0;
}
var INSTALL_FILE = "install.json";
function recordInstall(dir, root) {
  const file = path4.join(dir, INSTALL_FILE);
  const want = realOr(root);
  if (readJson(file, {})?.root === want) return;
  try {
    writeJson(file, { root: want, at: (/* @__PURE__ */ new Date()).toISOString() });
  } catch {
  }
}
function installRootOf(dir) {
  const r = readJson(path4.join(dir, INSTALL_FILE), {})?.root;
  return typeof r === "string" ? r : void 0;
}
function firedInSession(dir, session) {
  const hb = readJson(path4.join(dir, "heartbeat.json"), {});
  return Object.values(hb && typeof hb === "object" ? hb : {}).some((e) => !!e && (e.session === session || !!e.sessions && typeof e.sessions === "object" && session in e.sessions));
}
function pluginsDataBase() {
  return path4.join(claudeHome(), "plugins", "data");
}
function autoDataDirChoice(dirs = markedDataDirs(), opts = { session: process.env.CLAUDE_CODE_SESSION_ID, root: cliRoot() }) {
  const same = (a, b) => path4.resolve(a) === path4.resolve(b);
  const withOthers = (c, reason) => c && { ...c, reason, exists: true, others: dirs.filter((d) => !same(d, c.dir)) };
  if (opts.session) {
    const mine = dirs.filter((d) => firedInSession(d, opts.session));
    if (mine.length) return withOthers(pickDataDir(mine), "session");
  }
  const name = opts.name ?? ownDataDirName(opts.root);
  const ownDir = name ? path4.join(pluginsDataBase(), name) : void 0;
  let isDir = false;
  try {
    isDir = !!ownDir && fs4.statSync(ownDir).isDirectory();
  } catch {
  }
  if (ownDir && isDir) {
    return { dir: ownDir, auto: true, reason: "install", exists: true, hasCache: hasAccountCache(ownDir), lastFired: lastHookFired(ownDir), others: dirs.filter((d) => !same(d, ownDir)) };
  }
  if (opts.root) {
    const root = realOr(opts.root);
    const sameRoot = dirs.filter((d) => installRootOf(d) === root);
    if (sameRoot.length) return withOthers(pickDataDir(sameRoot), "same-install");
  }
  if (ownDir && dirs.length) return { dir: ownDir, auto: true, reason: "install", exists: false, hasCache: false, others: dirs };
  const ranked = pickDataDir(dirs);
  return ranked && { ...ranked, reason: "ranked", exists: true };
}
function dataDirChoice() {
  const env = process.env.NSX_DATA_DIR;
  const ours = env ? void 0 : pluginDataIfOurs();
  const named = env || ours;
  if (named) {
    const explicit = usableDir(named, env ? "NSX_DATA_DIR" : "CLAUDE_PLUGIN_DATA");
    const marker = path4.join(explicit, MARKER);
    if (!fs4.existsSync(marker)) {
      try {
        fs4.writeFileSync(marker, PLUGIN_VERSION);
      } catch {
      }
    }
    const root = ours && pluginRootIfOurs();
    if (root) recordInstall(explicit, root);
    return { dir: explicit, auto: false, hasCache: hasAccountCache(explicit), lastFired: lastHookFired(explicit), others: [] };
  }
  const choice = autoDataDirChoice();
  if (!choice) throw new NoDataDirError();
  return choice;
}
function dataDir() {
  return dataDirChoice().dir;
}
function describeChoice(c, now = Date.now()) {
  if (c.exists === false) return `${path4.basename(c.dir)} (this install's data dir; new, created on the first NetSuite call)`;
  const why = c.lastFired !== void 0 ? `hooks last fired ${ageLabel(Math.max(0, now - c.lastFired))} ago` : "hooks never fired";
  const reason = c.reason === "session" ? "this session's hooks write here, " : c.reason === "install" ? "this install's data dir, " : c.reason === "same-install" ? "written by this install's hooks, " : "";
  return `${path4.basename(c.dir)} (${reason}${why}${c.hasCache ? "" : ", no cache yet"})`;
}
function othersIgnored(c) {
  if (!c.others.length || !c.reason || c.reason === "ranked") return void 0;
  const names = c.others.map((d) => path4.basename(d)).join(", ");
  const one = c.others.length === 1;
  if (c.reason === "session") return `${names} ${one ? "is" : "are"} ignored (this session's hooks don't write there)`;
  return `${names} ${one ? "is another install's cache" : "are other installs' caches"} and ${one ? "is" : "are"} ignored`;
}
function dataDirNotice(now = Date.now()) {
  let c;
  try {
    c = dataDirChoice();
  } catch {
    return void 0;
  }
  if (!c.auto || !c.others.length) return void 0;
  const ignored = othersIgnored(c);
  if (ignored) return `nsx: using ${describeChoice(c, now)}; ${ignored}. Set NSX_DATA_DIR to pick another.`;
  const others = c.others.map((d) => path4.basename(d)).join(", ");
  return `nsx: using ${describeChoice(c, now)}; ${others} also exist${c.others.length === 1 ? "s" : ""}. Set NSX_DATA_DIR to pick one.`;
}
function markedDataDirs() {
  const base = path4.join(claudeHome(), "plugins", "data");
  try {
    return fs4.readdirSync(base).map((n) => path4.join(base, n)).filter((d) => fs4.existsSync(path4.join(d, MARKER))).sort();
  } catch {
    return [];
  }
}
function envOption(key) {
  const v = process.env[`CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`];
  return v === void 0 || v === "" ? void 0 : v;
}
var SETTINGS_FILE = "settings.json";
var SETTING_KEYS = [
  "read_only",
  "inline_max_chars",
  "saved_search_default_rows",
  "suiteql_default_page_size",
  "results_retention_days",
  "ttl_overrides",
  "account_id",
  "environment"
];
function savedSettings(dir) {
  return dir ? readJson(path4.join(dir, SETTINGS_FILE), {}) : {};
}
var NUMERIC_RANGES = {
  inline_max_chars: [500, 2e5],
  saved_search_default_rows: [1, 1e3],
  suiteql_default_page_size: [5, 1e3],
  results_retention_days: [1, 3650]
};
var TTL_HINT = `ttl_overrides looks like "searches=2, periods=0.5" (sections: ${Object.keys(DEFAULT_TTL_DAYS).join(", ")})`;
function ttlOverridesOrThrow(v) {
  const parts = v.split(/[,;\s]+/).filter(Boolean);
  const bad = parts.filter((p) => !Object.keys(parseTtlOverrides(p)).length);
  if (!parts.length || bad.length) throw new Error(`${bad.length ? `can't use ${bad.map((b) => `'${b}'`).join(", ")}: ` : ""}${TTL_HINT}`);
}
function saveSettings(dir, pairs) {
  const cur = savedSettings(dir);
  for (const [k, v] of Object.entries(pairs)) {
    if (!SETTING_KEYS.includes(k)) throw new Error(`Unknown setting '${k}'. Settings: ${SETTING_KEYS.join(", ")}`);
    const key = k;
    if (v === "") {
      delete cur[key];
      continue;
    }
    if (key === "read_only" && !/^(true|false|yes|no|on|off|1|0)$/i.test(v)) throw new Error("read_only must be true or false");
    if (key === "environment" && !/^(production|sandbox)$/i.test(v)) throw new Error("environment must be production or sandbox");
    const range = NUMERIC_RANGES[key];
    if (range) {
      const n = Number(v);
      if (!/^\d+$/.test(v) || n < range[0] || n > range[1]) throw new Error(`${key} must be a positive number: a whole number from ${range[0]} to ${range[1]}`);
    }
    if (key === "ttl_overrides") ttlOverridesOrThrow(v);
    if (key === "account_id" && !/^[A-Za-z0-9_-]+$/.test(v)) throw new Error("account_id looks like 1234567 or 1234567_SB1");
    cur[key] = v;
  }
  writeJson(path4.join(dir, SETTINGS_FILE), cur);
  return cur;
}
function configSource(key, dir) {
  if (envOption(key) !== void 0) return "env override";
  if (savedSettings(dir)[key] !== void 0) return "nsx config";
  return "default";
}
function readOnly(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && v.trim() !== "") return !/^(false|no|off|0)$/i.test(v.trim());
  return DEFAULTS.read_only;
}
function asNum(v, d, range) {
  const n = typeof v === "number" ? v : Number(v);
  if (!(Number.isFinite(n) && n > 0)) return d;
  return range ? Math.min(range[1], Math.max(range[0], n)) : n;
}
function loadConfig(dir = dataDir()) {
  const saved = savedSettings(dir);
  const pick2 = (k) => envOption(k) ?? saved[k];
  const ttl = { ...DEFAULT_TTL_DAYS };
  const overrides = pick2("ttl_overrides");
  if (overrides) Object.assign(ttl, parseTtlOverrides(overrides));
  const env = String(pick2("environment") ?? DEFAULTS.environment).toLowerCase();
  return {
    account_id: String(pick2("account_id") ?? "").trim(),
    environment: env === "sandbox" ? "sandbox" : "production",
    inline_max_chars: asNum(pick2("inline_max_chars"), DEFAULTS.inline_max_chars, NUMERIC_RANGES.inline_max_chars),
    saved_search_default_rows: asNum(pick2("saved_search_default_rows"), DEFAULTS.saved_search_default_rows, NUMERIC_RANGES.saved_search_default_rows),
    suiteql_default_page_size: asNum(pick2("suiteql_default_page_size"), DEFAULTS.suiteql_default_page_size, NUMERIC_RANGES.suiteql_default_page_size),
    results_retention_days: asNum(pick2("results_retention_days"), DEFAULTS.results_retention_days, NUMERIC_RANGES.results_retention_days),
    read_only: readOnly(pick2("read_only")),
    ttl_days: ttl
  };
}
function parseTtlOverrides(s) {
  const out2 = {};
  for (const part of s.split(/[,;\s]+/)) {
    const m = /^([a-z]+)=(\d+(?:\.\d+)?)$/i.exec(part.trim());
    if (m && m[1].toLowerCase() in DEFAULT_TTL_DAYS && Number(m[2]) > 0) out2[m[1].toLowerCase()] = Number(m[2]);
  }
  return out2;
}
function connectorServer(toolName) {
  return /^mcp__(.+?)__ns_[A-Za-z0-9_]+$/.exec(toolName ?? "")?.[1];
}
var CONNECTOR_FILE = "connector.json";
function lastConnector(dir) {
  if (!dir) return void 0;
  const c = readJson(path4.join(dir, CONNECTOR_FILE), {});
  return typeof c.server === "string" && c.server ? { server: c.server, lastSeen: String(c.lastSeen ?? "") } : void 0;
}
function recordConnector(dir, server, now = /* @__PURE__ */ new Date()) {
  const prev = lastConnector(dir);
  const day = now.toISOString().slice(0, 10);
  if (prev?.server === server && prev.lastSeen.slice(0, 10) === day) return;
  writeJson(path4.join(dir, CONNECTOR_FILE), { server, lastSeen: now.toISOString() });
}
function accountKey(cfg, server) {
  const id = cfg.account_id.replace(/[^A-Za-z0-9_-]/g, "");
  if (id) return `${id}-${cfg.environment}`;
  const conn = (server ?? "").replace(/[^A-Za-z0-9_-]/g, "");
  return conn ? `conn-${conn}` : void 0;
}
function accountLabel(ctx) {
  if (ctx.cfg.account_id) return `acct ${ctx.cfg.account_id}, ${ctx.cfg.environment}`;
  const s = ctx.server ?? "";
  return `connector ${s.length > 20 ? `${s.slice(0, 8)}\u2026` : s}`;
}
function statelessContext() {
  return { cfg: loadConfig(null), data: "" };
}
function context(toolName) {
  const data = dataDir();
  const cfg = loadConfig(data);
  const server = cfg.account_id ? void 0 : connectorServer(toolName) ?? lastConnector(data)?.server;
  const acct = accountKey(cfg, server);
  return { cfg, data, acct, acctDir: acct ? path4.join(data, "accounts", acct) : void 0, server };
}

// src/cache/store.ts
var INDEX_VERSION = 2;
function sectionKind(name) {
  return name.split("/")[0];
}
var SECTION_PART = /^[a-z0-9_-][a-z0-9_.-]*$/;
function sectionNameProblem(name) {
  const parts = name.split("/");
  if (parts.length > 2) return `'${name}' has more than one '/'`;
  for (const p of parts) {
    if (!SECTION_PART.test(p.toLowerCase())) return `'${p}' isn't a valid name (letters, digits, _ . - only, not starting with '.')`;
  }
  return void 0;
}
function safeSectionName(name) {
  return name.split("/").filter((p) => p !== "").map((p) => p.toLowerCase().replace(/[^a-z0-9_.-]/g, "_").replace(/^\./, "_")).join("/");
}
function sectionFile(acctDir, kind, name, ext) {
  const base = path5.resolve(acctDir, kind);
  const file = path5.resolve(base, `${safeSectionName(name)}${ext}`);
  if (!file.startsWith(base + path5.sep)) throw new Error(`su-ns-harness: cache section '${name}' resolves outside the cache directory; refused`);
  return file;
}
function manifestPath(acctDir) {
  return path5.join(acctDir, "manifest.json");
}
function loadManifest(acctDir, account = path5.basename(acctDir)) {
  return readJson(manifestPath(acctDir), { account, createdAt: (/* @__PURE__ */ new Date()).toISOString(), sections: {} });
}
function saveManifest(acctDir, m) {
  writeJson(manifestPath(acctDir), m);
}
var sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function withManifestLock(acctDir, fn) {
  return withFileLock(path5.join(acctDir, "manifest.lock"), fn);
}
function withFileLock(lock, fn) {
  ensureDir(path5.dirname(lock));
  let fd;
  for (let i = 0; i < 100 && fd === void 0; i++) {
    try {
      fd = fs5.openSync(lock, "wx");
    } catch {
      try {
        if (Date.now() - fs5.statSync(lock).mtimeMs > 5e3) fs5.unlinkSync(lock);
      } catch {
      }
      sleepMs(10);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== void 0) {
      fs5.closeSync(fd);
      try {
        fs5.unlinkSync(lock);
      } catch {
      }
    }
  }
}
function ttlDaysFor(cfg, name) {
  return cfg.ttl_days[sectionKind(name)] ?? 30;
}
function storeSection(acctDir, cfg, name, sourceTool, raw, index, status = index ? "ok" : "unparsed") {
  name = safeSectionName(name);
  writeFileAtomic(sectionFile(acctDir, "raw", name, ".json"), raw);
  if (index) writeIndex(acctDir, name, index);
  const entry = {
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
    ttlDays: ttlDaysFor(cfg, name),
    count: index?.rows.length ?? 0,
    sha256: sha256(raw),
    sourceTool,
    pluginVersion: PLUGIN_VERSION,
    indexVersion: INDEX_VERSION,
    status
  };
  withManifestLock(acctDir, () => {
    const m = loadManifest(acctDir);
    m.sections[name] = entry;
    saveManifest(acctDir, m);
  });
  return entry;
}
function writeIndex(acctDir, name, index) {
  const lines = [index.header.join("	"), ...index.rows.map((r) => r.map(tsvCell).join("	"))];
  writeFileAtomic(sectionFile(acctDir, "idx", name, ".tsv"), lines.join("\n") + "\n");
}
function rewriteIndex(acctDir, name, index) {
  name = safeSectionName(name);
  if (index) writeIndex(acctDir, name, index);
  else fs5.rmSync(sectionFile(acctDir, "idx", name, ".tsv"), { force: true });
  withManifestLock(acctDir, () => {
    const m = loadManifest(acctDir);
    const e = m.sections[name];
    if (!e) return;
    e.count = index?.rows.length ?? 0;
    if (e.status !== "stale") e.status = index ? "ok" : "unparsed";
    e.indexVersion = INDEX_VERSION;
    e.pluginVersion = PLUGIN_VERSION;
    saveManifest(acctDir, m);
  });
}
function markStale(acctDir, name, reason) {
  name = safeSectionName(name);
  return withManifestLock(acctDir, () => {
    const m = loadManifest(acctDir);
    const e = m.sections[name];
    if (!e) return false;
    e.status = "stale";
    e.staleReason = reason;
    saveManifest(acctDir, m);
    return true;
  });
}
function isFresh(e, cfg, name, now = Date.now()) {
  if (!e || e.status === "stale") return false;
  return now - Date.parse(e.fetchedAt) < ttlDaysFor(cfg, name) * 864e5;
}
function staleSections(m, cfg, now = Date.now()) {
  const out2 = [];
  for (const [name, e] of Object.entries(m.sections)) {
    if (!isFresh(e, cfg, name, now)) {
      out2.push({ name, ageMs: now - Date.parse(e.fetchedAt), ttlDays: ttlDaysFor(cfg, name), reason: e.staleReason });
    }
  }
  return out2.sort((a, b) => a.name.localeCompare(b.name));
}
function readIndex(acctDir, name) {
  const all = readTsv(sectionFile(acctDir, "idx", name, ".tsv"));
  return { header: all[0] ?? [], rows: all.slice(1) };
}
function readRaw(acctDir, name) {
  return readJson(sectionFile(acctDir, "raw", name, ".json"), void 0);
}
function acctDirs(dataDir2) {
  const base = path5.join(dataDir2, "accounts");
  try {
    return fs5.readdirSync(base).map((n) => path5.join(base, n));
  } catch {
    return [];
  }
}

// src/results/store.ts
import * as fs7 from "node:fs";
import * as path7 from "node:path";

// src/mcp.ts
import * as fs6 from "node:fs";
import * as os2 from "node:os";
import * as path6 from "node:path";
function tryJson(s) {
  const t = s.trim();
  if (!t || t[0] !== "{" && t[0] !== "[") return void 0;
  try {
    return JSON.parse(t);
  } catch {
    return void 0;
  }
}
function blocksText(blocks) {
  const texts = [];
  for (const b of blocks) {
    if (b && typeof b === "object" && b.type === "text") {
      texts.push(String(b.text ?? ""));
    }
  }
  return texts.length ? texts.join("\n") : void 0;
}
function decodeToolResponse(resp) {
  if (typeof resp === "string") {
    const json = tryJson(resp);
    if (Array.isArray(json)) {
      const inner = blocksText(json);
      if (inner !== void 0) return { text: inner, json: tryJson(inner) ?? void 0, isError: false };
    }
    return { text: resp, json, isError: false };
  }
  if (Array.isArray(resp)) {
    const inner = blocksText(resp);
    if (inner !== void 0) return { text: inner, json: tryJson(inner), isError: false };
    return { text: JSON.stringify(resp), json: resp, isError: false };
  }
  if (resp && typeof resp === "object") {
    const o = resp;
    const isError = o.isError === true;
    if (o.structuredContent !== void 0) {
      return { text: JSON.stringify(o.structuredContent), json: o.structuredContent, isError };
    }
    if (Array.isArray(o.content)) {
      const inner = blocksText(o.content) ?? "";
      return { text: inner, json: tryJson(inner), isError };
    }
    return { text: JSON.stringify(resp), json: resp, isError };
  }
  return { text: String(resp ?? ""), json: void 0, isError: false };
}
var SPILL = /exceeds maximum allowed tokens\. Output has been saved to (.+?)\.?\s*\n/;
var SPILL_HINT = /exceeds maximum allowed tokens|has been saved to \S*tool-results/i;
function resolveSpilled(d, opts = {}) {
  const m = SPILL.exec(d.text);
  if (!m || !opts.transcriptPath) return SPILL_HINT.test(d.text) && d.text.length < 5e3 ? { ...d, spillUnresolved: true } : d;
  try {
    const claudeHome2 = opts.claudeHome ?? (process.env.CLAUDE_CONFIG_DIR || path6.join(os2.homedir(), ".claude"));
    const transcript = path6.resolve(opts.transcriptPath);
    const expectedDir = fs6.realpathSync(path6.join(path6.dirname(transcript), path6.basename(transcript, ".jsonl"), "tool-results"));
    const home = fs6.realpathSync(claudeHome2) + path6.sep;
    const file = path6.resolve(m[1].trim());
    const st = fs6.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) return { ...d, spillUnresolved: true };
    const real = fs6.realpathSync(file);
    if (!real.startsWith(home) || path6.dirname(real) !== expectedDir) return { ...d, spillUnresolved: true };
    const inner = decodeToolResponse(fs6.readFileSync(real, "utf8"));
    return { text: inner.text, json: inner.json, isError: d.isError, spilledFrom: real };
  } catch {
    return { ...d, spillUnresolved: true };
  }
}
function stringPayload(d) {
  if (typeof d.json === "string") return d.json;
  const t = d.text.trim();
  if (t.startsWith('"')) {
    try {
      const v = JSON.parse(t);
      if (typeof v === "string") return v;
    } catch {
    }
  }
  return d.json === void 0 ? t : void 0;
}
var STRING_ERROR = /^(HTTP [45]\d\d\b|Error\b|Search error\b|Failed to parse\b|An unexpected SuiteScript error\b|The connector's server is rate-limiting)/i;
function isProblemObject(j) {
  const st = typeof j.status === "number" ? j.status : typeof j.status === "string" && /^\d{3}$/.test(j.status) ? Number(j.status) : NaN;
  if (Object.keys(j).length > 8 || "id" in j) return false;
  return st >= 400 && st < 600 && (typeof j.title === "string" || typeof j.detail === "string" || j["o:errorDetails"] !== void 0 || typeof j.message === "string");
}
function looksLikeError(d) {
  if (d.isError) return true;
  const j = d.json;
  if (j && typeof j === "object" && !Array.isArray(j)) {
    if (j.success === false) return true;
    if (j.error && !Array.isArray(j.error)) return true;
    if (typeof j["o:errorDetails"] === "object") return true;
    if (isProblemObject(j)) return true;
  }
  const s = stringPayload(d);
  return s !== void 0 && s.length < 5e3 && STRING_ERROR.test(s.trim());
}
function errorText(d) {
  const j = d.json;
  if (j && typeof j === "object") {
    if (!Array.isArray(j) && isProblemObject(j)) {
      const why = j.detail ?? j["o:errorDetails"] ?? j.message ?? j.title;
      return `HTTP ${String(j.status)}: ${typeof why === "string" ? why : JSON.stringify(why)}${typeof j.title === "string" && j.title !== why ? ` (${j.title})` : ""}`;
    }
    const e = j.error ?? j.message ?? j["o:errorDetails"] ?? j.detail;
    if (e) return typeof e === "string" ? e : JSON.stringify(e);
  }
  return stringPayload(d) ?? d.text;
}
function nsToolName(toolName) {
  if (typeof toolName !== "string") return void 0;
  const last = toolName.split("__").pop() ?? "";
  return /^ns_[A-Za-z0-9][A-Za-z0-9_]*$/.test(last) ? last : void 0;
}

// src/results/profile.ts
var NUM = /^-?((\d{1,3}(,\d{3})+|\d+)(\.\d+)?|\.\d+)([eE][-+]?\d+)?$/;
var ISO_DATE = /^\d{4}-\d{1,2}-\d{1,2}([T ]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*([ap]m|Z|[+-]\d{2}:?\d{2})?)?$/i;
var US_DATE = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
var BOOL = /^(t|f|true|false)$/i;
var usDateOk = (v) => {
  const [m, d] = v.split("/").map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
};
function isEmpty(v) {
  return v === null || v === void 0 || typeof v === "string" && v.trim() === "";
}
function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : void 0;
  if (typeof v !== "string") return void 0;
  const s = v.trim();
  if (NUM.test(s)) return Number(s.replace(/,/g, ""));
  return moneyNumber(s);
}
var SYMBOL = /^[$€£¥]$/;
var isTag = (t) => SYMBOL.test(t) || ISO_4217.has(t);
function moneyNumber(input) {
  let s = input;
  let neg = false;
  let marked = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) s = paren[1].trim(), neg = true, marked = true;
  const minus = () => {
    if (!s.startsWith("-")) return true;
    if (neg) return false;
    s = s.slice(1).trim();
    neg = true;
    return true;
  };
  if (!minus()) return void 0;
  const pre = /^([$€£¥]|[A-Z]{3}(?![A-Za-z]))\s*/.exec(s);
  if (pre && isTag(pre[1])) s = s.slice(pre[0].length), marked = true;
  const suf = /\s*((?<![A-Za-z])[A-Z]{3}|[$€£¥])$/.exec(s);
  if (suf && isTag(suf[1])) s = s.slice(0, suf.index), marked = true;
  if (!minus()) return void 0;
  if (!marked || s.startsWith("-") || !NUM.test(s)) return void 0;
  const n = Number(s.replace(/,/g, ""));
  return neg ? -n : n;
}
function dateKey(v) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const i = /^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/.exec(v);
  return i ? `${i[1]}-${i[2].padStart(2, "0")}-${i[3].padStart(2, "0")}${i[4].replace(/^T/, " ")}` : v.slice(0, 10);
}
var AMOUNT_LIKE = /amount|total|amt\b|balance|debit|credit|price|cost|revenue/i;
var HINT_METRIC = /amount|total/i;
var ID_NAME = /(^|[._\s-])(id|internalid|number|num|no|tranid|line|linesequencenumber)$|[a-z]id$/i;
var NOT_ID_NAME = /(paid|void|valid|fluid|rapid|avoid|liquid|humid)$/i;
var REF_NAME = /^(subsidiary|currency|period|postingperiod|accountingperiod|entity|account|customer|vendor|employee|department|class|location|item|name|parent|createdby)$/i;
var REF_LABEL = /(set|created|modified|last\s*run|owner|approved|entered|updated|submitted)\s*by$|(^|[\s._-])(bundle|role|owner)$/i;
var bare = (name) => name.slice(name.lastIndexOf(".") + 1).trim();
function isAmountLike(name) {
  return AMOUNT_LIKE.test(name);
}
function isHintMetric(name) {
  return HINT_METRIC.test(name);
}
function idLikeName(name) {
  const b = bare(name);
  if (isAmountLike(b)) return false;
  return REF_NAME.test(b) || REF_LABEL.test(b) || ID_NAME.test(b) && !NOT_ID_NAME.test(b);
}
function isCurrencyColumn(name) {
  const b = bare(name);
  if (!/currency|ccy|^curr|curr$/i.test(b)) return false;
  return !isAmountLike(name) && !/rate|current|recurr|precision/i.test(name);
}
function isCurrencyBearing(name) {
  if (isCurrencyColumn(name) || /rate/i.test(name)) return false;
  return isAmountLike(name) || /^foreign/i.test(bare(name)) || /foreign currency/i.test(name);
}
var ISO_4217 = new Set(
  "AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SLL SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWL".split(" ")
);
var present = (rows, c) => rows.map((r) => r[c]).filter((v) => !isEmpty(v));
var allInts = (vs) => vs.every((v) => typeof v === "number" && Number.isInteger(v) || typeof v === "string" && /^-?\d+$/.test(v.trim()));
function findCurrency(columns, rows) {
  let found = columns.filter(isCurrencyColumn);
  if (!found.length) {
    found = columns.filter((c) => {
      if (isCurrencyBearing(c) || idLikeName(c)) return false;
      const vs = present(rows, c);
      return vs.length > 0 && vs.every((v) => typeof v === "string" && ISO_4217.has(v.trim()));
    });
  }
  if (!found.length) return { columns: [], values: [] };
  const display = found.find((c) => {
    const vs = present(rows, c);
    return vs.length > 0 && !allInts(vs);
  });
  const column = display ?? found[0];
  const values = [...new Set(present(rows, column).map(String))].sort();
  return { column, columns: found, values };
}
function currencyCheck(columns, rows) {
  const cur = findCurrency(columns, rows);
  const amountColumns = columns.filter((c) => {
    if (!isCurrencyBearing(c)) return false;
    const vs = present(rows, c);
    return vs.length > 0 && vs.every((v) => toNumber(v) !== void 0) && !isIdColumn(c, vs);
  });
  let status = "none";
  let unknownColumns2 = [];
  const sub = columns.find((c) => /subsidiary/i.test(bare(c)) && !isCurrencyBearing(c) && !isCurrencyColumn(c));
  const subsidiaries = sub ? new Set(present(rows, sub).map((v) => String(v).trim())).size : 0;
  const baseAcrossSubs = subsidiaries > 1 ? amountColumns.filter((c) => !isForeignAmount(c) && present(rows, c).length > 1) : [];
  if (amountColumns.length) {
    if (cur.values.length > 1) status = "mixed", unknownColumns2 = baseAcrossSubs;
    else if (cur.column) {
      unknownColumns2 = baseAcrossSubs;
      status = unknownColumns2.length ? "unknown" : "single";
    } else {
      unknownColumns2 = amountColumns.filter((c) => (isForeignAmount(c) || baseAcrossSubs.includes(c)) && present(rows, c).length > 1);
      status = unknownColumns2.length ? "unknown" : "single";
    }
  }
  return { ...cur, amountColumns, status, unknownColumns: unknownColumns2, subsidiary: sub, subsidiaries, baseAcrossSubs };
}
function isForeignAmount(name) {
  return /^foreign/i.test(bare(name)) || /foreign currency/i.test(name);
}
function unknownLabel(check, col2) {
  return check.baseAcrossSubs.includes(col2) ? `${check.subsidiaries} subsidiaries` : "currency unknown";
}
var DOC_ID = /^(id|internalid|internal id|tranid|transaction|transactionid|transaction id|document number|document no\.?|docnumber|doc number|transactionnumber|transaction number)$/i;
function headerRepeats(columns, rows) {
  const out2 = /* @__PURE__ */ new Map();
  const ids = columns.filter((c) => DOC_ID.test(bare(c)));
  if (!ids.length || rows.length < 2) return out2;
  const amounts = columns.filter((c) => isCurrencyBearing(c) && present(rows, c).some((v) => toNumber(v) !== void 0));
  for (const id of ids) {
    const docs = /* @__PURE__ */ new Map();
    for (const r of rows) {
      if (isEmpty(r[id])) continue;
      const k = String(r[id]).trim();
      const g = docs.get(k);
      if (g) g.push(r);
      else docs.set(k, [r]);
    }
    const multi = [...docs.values()].filter((g) => g.length > 1);
    if (!multi.length) continue;
    for (const a of amounts) {
      if (out2.has(a)) continue;
      let constant = true;
      let valued = 0;
      let big = false;
      for (const g of multi) {
        const vs = g.map((r) => toNumber(r[a])).filter((v) => v !== void 0);
        if (vs.length < 2) continue;
        if (vs.some((v) => v !== vs[0])) {
          constant = false;
          break;
        }
        valued++;
        if (vs.length > 2) big = true;
      }
      if (constant && (valued >= 2 || big)) out2.set(a, id);
    }
  }
  return out2;
}
var headerRepeatNote = (col2, id) => `${col2} repeats per ${id} (a header amount on line rows): sums count it once per line. Take one row per ${id} (--by ${id} --max ${col2}) or query at header level.`;
var REPORT_COLS = ["line", "depth", "is_detail", "kind"];
var REPORT_NO_VALUE = /* @__PURE__ */ new Set(["structural", "spacer"]);
var isReportShape = (columns) => REPORT_COLS.every((c) => columns.includes(c));
var MEASURE_NAME = /qty|quantit|count|units?\b|hours?|days?|minutes?|age\b|percent|%|score|weight|size|months?|years?|weeks?|seconds?|duration|nights?|pax|guests?|seats?|people/i;
function isIdColumn(name, present2) {
  if (!present2.length || isAmountLike(name) || isCurrencyBearing(name)) return false;
  const ints = present2.every((v) => typeof v === "number" && Number.isInteger(v) || typeof v === "string" && /^-?\d+$/.test(v.trim()));
  if (!ints) return false;
  if (idLikeName(name)) return true;
  const strings = present2.every((v) => typeof v === "string");
  if (!strings || present2.length < 20) return false;
  const distinct = new Set(present2.map((v) => String(v).trim()));
  if (distinct.size >= present2.length * 0.9) return true;
  return !MEASURE_NAME.test(name) && distinct.size <= 12 && distinct.size <= present2.length / 5 && [...distinct].every((v) => /^\d{1,4}$/.test(v));
}
function inferType(values) {
  const present2 = values.filter((v) => !isEmpty(v));
  if (!present2.length) return "str";
  if (present2.every((v) => typeof v === "boolean" || typeof v === "string" && BOOL.test(v))) return "bool";
  if (present2.every((v) => toNumber(v) !== void 0 && !(typeof v === "string" && /^0\d/.test(v)))) return "num";
  if (present2.every((v) => typeof v === "string" && (ISO_DATE.test(v) || US_DATE.test(v.trim()) && usDateOk(v.trim())))) return "date";
  return "str";
}
var NOT_SUMMABLE = /exchange\s*_?rate|fx\s*_?rate|taxrate|(^|[\s._(-])(rate|ratio|pct|percent|percentage)s?([\s._)-]|$)|%/i;
function summable(name, present2) {
  if (NOT_SUMMABLE.test(name)) return false;
  if (isAmountLike(name) || isCurrencyBearing(name) || MEASURE_NAME.test(name)) return true;
  return !allInts(present2);
}
function profileColumns(columns, rows) {
  const report = isReportShape(columns);
  const cur = report ? void 0 : currencyCheck(columns, rows);
  const repeats = report ? /* @__PURE__ */ new Map() : headerRepeats(columns, rows);
  const list2 = (vs) => vs.length > 6 ? `${vs.slice(0, 6).join(", ")}\u2026` : vs.join(", ");
  const valueRows = report ? rows.filter((r) => !REPORT_NO_VALUE.has(String(r.kind))) : rows;
  return columns.map((name) => {
    const vals = rows.map((r) => r[name]);
    const present2 = vals.filter((v) => !isEmpty(v));
    let type = inferType(vals);
    if (type === "num" && isIdColumn(name, present2)) type = "id";
    const p = { name, type, nulls: vals.length - present2.length, distinct: new Set(present2.map(String)).size };
    if (type === "num") {
      const structuralCol = report && REPORT_COLS.includes(name);
      const measured = report && !structuralCol ? valueRows.map((r) => r[name]).filter((v) => !isEmpty(v)) : present2;
      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const v of measured) {
        const n = toNumber(v);
        sum += n;
        if (n < min) min = n;
        if (n > max) max = n;
      }
      p.sum = summable(name, present2) ? sum : void 0;
      if (measured.length) {
        p.min = min;
        p.max = max;
      }
      if (structuralCol) {
        p.sum = void 0;
      } else if (report) {
        p.sum = void 0;
        p.sumNa = "report rows nest";
        p.note = "report rows nest (sections > groups > accounts > detail lines): a column sum double-counts subtotals.";
      } else if (cur && cur.amountColumns.includes(name) && cur.status === "mixed") {
        p.sum = void 0;
        p.sumNa = "mixed currencies";
        p.note = `amounts are in ${cur.values.length} currencies (${cur.column}: ${list2(cur.values)}): no sum, and min/max compare different currencies. Group by ${cur.column}.`;
      } else if (cur && cur.baseAcrossSubs.includes(name)) {
        p.sum = void 0;
        p.sumNa = `${cur.subsidiaries} subsidiaries`;
        p.note = `base-currency amounts across ${cur.subsidiaries} subsidiaries (${cur.subsidiary}): each is in its subsidiary's currency, so they add up only per subsidiary. Group by ${cur.subsidiary}.`;
      } else if (cur && cur.unknownColumns.includes(name) && cur.status === "unknown") {
        p.sum = void 0;
        p.sumNa = "currency unknown";
        p.note = "currency unknown: no currency column, so this total may mix currencies. Add one (SuiteQL: BUILTIN.DF(t.currency) AS currency) and group by it.";
      } else if (repeats.has(name) && p.sum !== void 0) {
        const id = repeats.get(name);
        p.sum = void 0;
        p.sumNa = `repeats per ${id}`;
        p.note = headerRepeatNote(name, id);
      }
    } else if (type === "date") {
      const keys = present2.map((v) => dateKey(String(v))).sort();
      p.min = keys[0];
      p.max = keys[keys.length - 1];
    }
    return p;
  });
}

// src/results/store.ts
function savedReportInfo(raw) {
  let info;
  try {
    info = reportInfoOf(decodeToolResponse(raw).json);
  } catch {
    return void 0;
  }
  if (!info?.columns?.length) return void 0;
  return { ...info.title !== void 0 ? { title: info.title } : {}, columns: info.columns, ...info.notes?.length ? { notes: info.notes } : {} };
}
function reportCurrencyOf(meta, profile) {
  if (meta.tool !== "ns_runReport" || !profile) return void 0;
  let input = {};
  try {
    const q = JSON.parse(meta.query);
    if (q && typeof q === "object" && !Array.isArray(q)) input = q;
  } catch {
    return void 0;
  }
  const sub = input.subsidiaryId ?? input.subsidiary;
  const id = sub === void 0 || sub === null || String(sub).trim() === "" ? "-1" : String(sub).trim();
  if (id === "-1") return profile.baseCurrency;
  return profile.subsidiaryCurrencies?.[id] ?? (id === profile.parentSubsidiaryId ? profile.baseCurrency : void 0);
}
function reportCurrencyInfo(meta, profile, acctDir) {
  const code = reportCurrencyOf(meta, profile);
  if (!code) return void 0;
  let input = {};
  try {
    input = JSON.parse(meta.query);
  } catch {
  }
  const sub = input.subsidiaryId ?? input.subsidiary;
  const id = sub === void 0 || sub === null || String(sub).trim() === "" ? "-1" : String(sub).trim();
  if (id === "-1") return { code, label: "the base currency, consolidated" };
  let name;
  if (acctDir) {
    const ix = readIndex(acctDir, "subsidiaries");
    const ci = ix.header.findIndex((h) => h.toLowerCase() === "id");
    const ni = ix.header.findIndex((h) => h.toLowerCase() === "name");
    if (ci >= 0 && ni >= 0) name = ix.rows.find((r) => r[ci] === id)?.[ni]?.trim() || void 0;
  }
  return { code, label: `${name ?? `subsidiary ${id}`}'s base currency` };
}
function resultsRoot(acctDir) {
  return path7.join(acctDir, "results");
}
function acctDirOf(meta) {
  const root = path7.dirname(path7.dirname(meta.files.meta));
  if (path7.basename(root) !== path7.basename(resultsRoot(""))) return void 0;
  return path7.dirname(root);
}
function saveResult(opts) {
  const id = shortId("r_");
  const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
  const session = (opts.session || "nosession").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "nosession";
  const dir = ensureDir(path7.join(resultsRoot(opts.acctDir), session));
  const base = path7.join(dir, `${ts}_${opts.tool}_${id}`);
  const files = { raw: `${base}.raw.json`, csv: `${base}.csv`, meta: `${base}.meta.json` };
  writeFileAtomic(files.raw, opts.raw);
  writeFileAtomic(files.csv, toCsv(opts.columns, opts.rows));
  const profiles = profileColumns(opts.columns, opts.rows);
  const meta = {
    id,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    session,
    tool: opts.tool,
    query: opts.query,
    rowCount: opts.rows.length,
    columns: profiles.map((p) => ({ name: p.name, type: p.type })),
    truncated: opts.truncated,
    tookMs: opts.tookMs,
    files
  };
  const report = opts.report ?? (opts.tool === "ns_runReport" ? savedReportInfo(opts.raw) : void 0);
  if (report) meta.report = report;
  writeJson(files.meta, meta);
  fs7.appendFileSync(path7.join(resultsRoot(opts.acctDir), "index.jsonl"), JSON.stringify({ id, meta: files.meta }) + "\n");
  return meta;
}
function listResults(acctDir) {
  const idx = path7.join(resultsRoot(acctDir), "index.jsonl");
  let lines = [];
  try {
    lines = fs7.readFileSync(idx, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
  const out2 = [];
  for (const l of lines) {
    try {
      const { meta } = JSON.parse(l);
      const m = readJson(meta, void 0);
      if (m) out2.push(m);
    } catch {
    }
  }
  return out2;
}
function findResult(acctDirs2, id) {
  const want = id.startsWith("r_") ? id : `r_${id}`;
  for (const dir of acctDirs2) {
    const hit = listResults(dir).find((m) => m.id === want);
    if (hit) return hit;
  }
  return void 0;
}
function parseValue(v, type) {
  if (v.trim() === "") return null;
  if (type === "num") {
    const n = toNumber(v);
    return n === void 0 ? v : n;
  }
  return v;
}
function loadRows(meta) {
  const grid = parseCsv(fs7.readFileSync(meta.files.csv, "utf8"));
  const header = grid[0] ?? [];
  const types = new Map(meta.columns.map((c) => [c.name, c.type]));
  return grid.slice(1).map((cells) => {
    const r = {};
    header.forEach((h, i) => r[h] = parseValue(cells[i] ?? "", types.get(h) ?? "str"));
    return r;
  });
}
function cleanupResults(acctDir, retentionDays, now = Date.now()) {
  const root = resultsRoot(acctDir);
  let removed = 0;
  let sessions = [];
  try {
    sessions = fs7.readdirSync(root);
  } catch {
    return 0;
  }
  const cutoff = now - retentionDays * 864e5;
  for (const s of sessions) {
    const dir = path7.join(root, s);
    let st;
    try {
      st = fs7.statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const f of fs7.readdirSync(dir)) {
      const fp = path7.join(dir, f);
      try {
        if (fs7.statSync(fp).mtimeMs < cutoff) {
          fs7.unlinkSync(fp);
          removed++;
        }
      } catch {
      }
    }
    try {
      if (!fs7.readdirSync(dir).length) fs7.rmdirSync(dir);
    } catch {
    }
  }
  if (removed) {
    const idx = path7.join(root, "index.jsonl");
    try {
      const keep = fs7.readFileSync(idx, "utf8").split("\n").filter((l) => {
        try {
          return l && fs7.existsSync(JSON.parse(l).meta);
        } catch {
          return false;
        }
      });
      writeFileAtomic(idx, keep.length ? keep.join("\n") + "\n" : "");
    } catch {
    }
  }
  return removed;
}
function dirSize(dir) {
  let total = 0;
  try {
    for (const e of fs7.readdirSync(dir, { withFileTypes: true })) {
      const p = path7.join(dir, e.name);
      total += e.isDirectory() ? dirSize(p) : fs7.statSync(p).size;
    }
  } catch {
  }
  return total;
}
var PAGE_KEYS = ["pageIndex", "range_start", "range_end"];
var finite = (v) => v === null || v === void 0 || v === "" ? void 0 : Number.isFinite(Number(v)) ? Number(v) : void 0;
function queryIdentity(meta) {
  if (meta.tool === "ns_runCustomSuiteQL") return { same: meta.query.replace(/\s+/g, " ").trim(), input: {} };
  try {
    const q = JSON.parse(meta.query);
    if (q && typeof q === "object" && !Array.isArray(q)) {
      const input = q;
      const rest = Object.fromEntries(Object.entries(input).filter(([k]) => !PAGE_KEYS.includes(k)).sort(([x], [y]) => x.localeCompare(y)));
      return { same: JSON.stringify(rest), input };
    }
  } catch {
  }
  return { same: meta.query, input: {} };
}
function pagePos(meta, input) {
  const pos = { meta, rangeStart: finite(input.range_start), rangeEnd: finite(input.range_end) };
  if (meta.tool === "ns_runCustomSuiteQL") {
    try {
      const ex = extractRows(JSON.parse(fs7.readFileSync(meta.files.raw, "utf8")));
      if (ex) Object.assign(pos, { pageIndex: ex.pageIndex, pageSize: ex.pageSize, totalResults: ex.totalResults, numberOfPages: ex.numberOfPages });
    } catch {
    }
  }
  if (pos.pageIndex === void 0) pos.pageIndex = finite(input.pageIndex);
  return pos;
}
function concatResults(metas, opts = {}) {
  if (metas.length < 2) throw new Error("results concat needs at least two result ids");
  const ids = metas.map((m) => m.id);
  if (new Set(ids).size !== ids.length) throw new Error(`the same result is listed twice: ${ids.join(", ")}`);
  const first = metas[0];
  const acctOf = (m) => path7.dirname(path7.dirname(path7.dirname(m.files.meta)));
  const acctDir = acctOf(first);
  const cols = first.columns.map((c) => c.name);
  const idOf = queryIdentity(first);
  for (const m of metas.slice(1)) {
    if (acctOf(m) !== acctDir) throw new Error(`${m.id} belongs to another account than ${first.id}`);
    if (m.tool !== first.tool) throw new Error(`${m.id} comes from ${m.tool}, ${first.id} from ${first.tool}: only pages of one query can be combined`);
    const mc = m.columns.map((c) => c.name);
    if (mc.length !== cols.length || mc.some((c, i) => c !== cols[i])) throw new Error(`${m.id} has different columns (${mc.join(", ")}) from ${first.id} (${cols.join(", ")})`);
    if (queryIdentity(m).same !== idOf.same) throw new Error(`${m.id} ran a different query from ${first.id}; only pages of the same query (differing in pageIndex or range_start/range_end) can be combined`);
  }
  const notes = [];
  let pos = metas.map((m) => pagePos(m, queryIdentity(m).input));
  const byPage = pos.every((p) => p.pageIndex !== void 0);
  const byRange = !byPage && pos.every((p) => p.rangeStart !== void 0 || p.rangeEnd !== void 0);
  let complete;
  if (byPage) {
    pos = [...pos].sort((x, y) => x.pageIndex - y.pageIndex);
    for (let i = 1; i < pos.length; i++) {
      const [p, q] = [pos[i - 1], pos[i]];
      if (q.pageIndex === p.pageIndex) throw new Error(`${p.meta.id} and ${q.meta.id} are both page ${p.pageIndex + 1}`);
      if (q.pageIndex !== p.pageIndex + 1) {
        const [from, to] = [p.pageIndex + 2, q.pageIndex];
        notes.push(`${from === to ? `page ${from} is` : `pages ${from}\u2013${to} are`} missing (between ${p.meta.id} and ${q.meta.id})`);
      }
      if (p.pageSize !== void 0 && q.pageSize !== void 0 && p.pageSize !== q.pageSize) throw new Error(`${p.meta.id} and ${q.meta.id} use different page sizes (${p.pageSize}, ${q.pageSize}): the pages don't line up`);
    }
    const total = pos.find((p) => p.totalResults !== void 0)?.totalResults;
    const n = pos.find((p) => p.numberOfPages !== void 0)?.numberOfPages;
    const pages = `pages ${pos.map((p) => p.pageIndex + 1).join(", ")}${n !== void 0 ? ` of ${n}` : ""}`;
    const rows2 = pos.reduce((s, p) => s + p.meta.rowCount, 0);
    notes.unshift(`in page order: ${pages}`);
    if (total !== void 0 && rows2 < total) complete = `combined ${pages} (${rows2} of ${total} rows): still not the full result`;
  } else if (byRange) {
    pos = [...pos].sort((x, y) => (x.rangeStart ?? 0) - (y.rangeStart ?? 0));
    for (let i = 1; i < pos.length; i++) {
      const [p, q] = [pos[i - 1], pos[i]];
      const pEnd = (p.rangeStart ?? 0) + p.meta.rowCount;
      const qStart = q.rangeStart ?? 0;
      if (qStart < pEnd) throw new Error(`${p.meta.id} (rows ${p.rangeStart ?? 0}\u2013${pEnd}) and ${q.meta.id} (from ${qStart}) overlap`);
      if (qStart > pEnd) notes.push(`rows ${pEnd}\u2013${qStart} are missing (between ${p.meta.id} and ${q.meta.id})`);
    }
    notes.unshift(`in slice order: ${pos.map((p) => `${p.rangeStart ?? 0}\u2013${(p.rangeStart ?? 0) + p.meta.rowCount}`).join(", ")}`);
  } else {
    notes.push("no page or slice position recorded: combined in the order given, and contiguity wasn't checked");
  }
  const last = pos[pos.length - 1].meta;
  if (!complete && last.truncated && !(byPage && pos.some((p) => p.totalResults !== void 0))) complete = `the last part (${last.id}) was itself incomplete: ${last.truncated}`;
  if (notes.some((n) => n.includes("missing"))) complete = [complete, "some pages/slices in between are missing"].filter(Boolean).join("; ");
  const rows = pos.flatMap((p) => loadRows(p.meta));
  const query = first.tool === "ns_runCustomSuiteQL" ? first.query : idOf.same;
  const meta = saveResult({
    acctDir,
    session: opts.session ?? first.session,
    tool: first.tool,
    query,
    columns: cols,
    rows,
    raw: JSON.stringify({ concatOf: pos.map((p) => p.meta.id), notes }),
    truncated: complete,
    report: first.report
  });
  return { meta, notes };
}

// src/session.ts
import * as fs8 from "node:fs";
import * as path8 from "node:path";
var UNKNOWN_COLS_MAX = 20;
var RATE_LIMIT_RESET_MS = 5 * 6e4;
var UNKNOWN_COLS_MS = 30 * 6e4;
function rememberUnknownCols(s, toolUseId, cols, now = Date.now()) {
  const all = { ...s.unknownCols ?? {}, [toolUseId]: { cols, at: now } };
  const kept = Object.entries(all).filter(([, e]) => e && Array.isArray(e.cols) && now - e.at <= UNKNOWN_COLS_MS).sort((a, b) => b[1].at - a[1].at).slice(0, UNKNOWN_COLS_MAX);
  s.unknownCols = Object.fromEntries(kept);
}
function takeUnknownCols(s, toolUseId, now = Date.now()) {
  const e = s.unknownCols?.[toolUseId];
  if (!e) return void 0;
  delete s.unknownCols[toolUseId];
  return now - e.at <= UNKNOWN_COLS_MS && Array.isArray(e.cols) ? e.cols : void 0;
}
var INFLIGHT_STALE_MS = 12e4;
var safe = (s) => (s || "nosession").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 60) || "nosession";
function sessionDir(data, session) {
  return path8.join(data, "sessions", safe(session));
}
function beginCall(data, session, toolUseId, info) {
  const dir = ensureDir(path8.join(sessionDir(data, session), "inflight"));
  const others = [];
  const now = Date.now();
  for (const f of fs8.readdirSync(dir)) {
    const p = path8.join(dir, f);
    const e = readJson(p, void 0);
    if (!e || now - e.startedAt > INFLIGHT_STALE_MS) {
      try {
        fs8.unlinkSync(p);
      } catch {
      }
      continue;
    }
    if (f !== `${safe(toolUseId)}.json`) others.push(e.tool);
  }
  writeJson(path8.join(dir, `${safe(toolUseId)}.json`), info);
  return others;
}
function endCall(data, session, toolUseId) {
  const p = path8.join(sessionDir(data, session), "inflight", `${safe(toolUseId)}.json`);
  const e = readJson(p, void 0);
  try {
    fs8.unlinkSync(p);
  } catch {
  }
  return e;
}
var loaded = /* @__PURE__ */ new WeakMap();
var statePath = (data, session) => path8.join(sessionDir(data, session), "state.json");
function readState(file) {
  const s = readJson(file, { retries: {} });
  if (!s || typeof s !== "object" || Array.isArray(s)) return { retries: {} };
  if (!s.retries || typeof s.retries !== "object") s.retries = {};
  return s;
}
function loadState(data, session) {
  const s = readState(statePath(data, session));
  loaded.set(s, JSON.stringify(s));
  return s;
}
var recOf = (v) => v && typeof v === "object" && !Array.isArray(v) ? v : {};
function mergeRecord(base, mine, disk) {
  const [b, m, out2] = [recOf(base), recOf(mine), { ...recOf(disk) }];
  for (const k of /* @__PURE__ */ new Set([...Object.keys(b), ...Object.keys(m)])) {
    if (!(k in m)) delete out2[k];
    else if (JSON.stringify(b[k]) !== JSON.stringify(m[k])) out2[k] = m[k];
  }
  return out2;
}
function saveState(data, session, s) {
  const file = statePath(data, session);
  const base = JSON.parse(loaded.get(s) ?? '{"retries":{}}');
  withFileLock(`${file}.lock`, () => {
    const disk = readState(file);
    const [b, m] = [base, s];
    const next = { ...disk };
    for (const k of /* @__PURE__ */ new Set([...Object.keys(b), ...Object.keys(m)])) {
      if (Array.isArray(m[k]) || Array.isArray(disk[k])) {
        const added = (Array.isArray(m[k]) ? m[k] : []).filter((x) => !(Array.isArray(b[k]) && b[k].includes(x)));
        next[k] = [.../* @__PURE__ */ new Set([...Array.isArray(disk[k]) ? disk[k] : [], ...added])];
      } else if (recOf(m[k]) === m[k] || recOf(disk[k]) === disk[k] || recOf(b[k]) === b[k]) {
        next[k] = mergeRecord(b[k], m[k], disk[k]);
      } else if (!(k in m)) delete next[k];
      else if (JSON.stringify(b[k]) !== JSON.stringify(m[k])) next[k] = m[k];
    }
    writeJson(file, next);
    loaded.set(s, JSON.stringify(next));
  });
}
var HEARTBEAT_SESSIONS = 5;
function heartbeat(data, session, event, now = /* @__PURE__ */ new Date()) {
  const p = path8.join(data, "heartbeat.json");
  const hb = readJson(p, {});
  const at = now.toISOString();
  const sid = typeof session === "string" ? session : String(session ?? "");
  const prev = hb[event];
  const sessions = { ...prev && typeof prev.sessions === "object" ? prev.sessions : {}, [sid]: at };
  const recent = Object.entries(sessions).sort((a, b) => b[1].localeCompare(a[1])).slice(0, HEARTBEAT_SESSIONS);
  hb[event] = { at, session: sid, sessions: Object.fromEntries(recent) };
  writeJson(p, hb);
}
function cleanupSessions(data, maxAgeDays = 2) {
  const root = path8.join(data, "sessions");
  const cutoff = Date.now() - maxAgeDays * 864e5;
  try {
    for (const s of fs8.readdirSync(root)) {
      const p = path8.join(root, s);
      if (fs8.statSync(p).mtimeMs < cutoff) fs8.rmSync(p, { recursive: true, force: true });
    }
  } catch {
  }
}

// src/hooks/session-start.ts
function cliCommand() {
  const root = pluginRootIfOurs();
  const script = root ? path9.join(root, "scripts", "nsx.mjs") : path9.resolve(process.argv[1] ?? "scripts/nsx.mjs");
  return `node "${script}"`;
}
var CLI_HINT = "<reports search|searches search|fields|periods|results|sql lint|profile> \u2026";
function connectorLine(ctx) {
  const seen = lastConnector(ctx.data || null);
  const last = seen ? `last used ${isoDate(new Date(seen.lastSeen))} (server ${seen.server})` : "not used yet";
  return `Connector: ${last}. Whether it's enabled in THIS session only shows in your tool list: NetSuite tools end in ns_runCustomSuiteQL, ns_listAllReports, \u2026 under any server name. If there are none, it isn't connected or enabled; /su-ns-harness:init step 1 has the fix.`;
}
function sessionContext(ctx, now = Date.now()) {
  const cli = cliCommand();
  if (!ctx.acct || !ctx.acctDir) {
    return [
      `su-ns-harness (NetSuite): no NetSuite call seen yet, so there's no local cache. When the user first asks about NetSuite, run the su-ns-harness:init skill yourself before answering (it needs nothing from the user; tell them it takes a few minutes).`,
      `Cache CLI (not on PATH \u2014 always run it exactly like this): ${cli} ${CLI_HINT}`,
      connectorLine(ctx)
    ].join("\n");
  }
  const label = accountLabel(ctx);
  if (!fs9.existsSync(manifestPath(ctx.acctDir))) {
    return [
      `NetSuite (${label}) \u2014 local cache is empty.`,
      `\u2192 Before the first NetSuite answer, run the su-ns-harness:init skill yourself (it needs nothing from the user; tell them it takes a few minutes), or at least call the catalog tools you need (results are cached automatically).`,
      `Cache CLI (not on PATH \u2014 always run it exactly like this): ${cli} ${CLI_HINT}`,
      connectorLine(ctx)
    ].join("\n");
  }
  const m = loadManifest(ctx.acctDir);
  const times = Object.values(m.sections).map((e) => Date.parse(e.fetchedAt)).filter(Number.isFinite);
  const oldest = times.length ? Math.min(...times) : now;
  const lines = [];
  lines.push(`NetSuite (${label}) \u2014 cache built ${isoDate(new Date(oldest))} (${ageLabel(now - oldest)} ago), ${Object.keys(m.sections).length} sections`);
  lines.push(...profileLines(loadProfile(ctx.acctDir)));
  const stale = staleSections(m, ctx.cfg, now);
  if (stale.length) {
    const shown = stale.slice(0, 8).map((s) => `${s.name} (${s.reason ? s.reason : `${ageLabel(s.ageMs)} > ${s.ttlDays}d TTL`})`);
    lines.push(`Stale: ${shown.join(", ")}${stale.length > 8 ? `, +${stale.length - 8} more` : ""}`);
    lines.push(`\u2192 Before the first NetSuite answer this session, refresh only the stale sections you need: run the su-ns-harness:refresh skill (sections: stale, or just the ones you need), one call at a time.`);
  } else {
    lines.push(`Cache fresh \u2014 answer catalog questions from nsx, not from ns_* catalog tools.`);
  }
  const unparsed = Object.entries(m.sections).filter(([, e]) => e.status === "unparsed").map(([n]) => n);
  if (unparsed.length) lines.push(`Unparsed sections (raw only): ${unparsed.slice(0, 5).join(", ")}`);
  lines.push(`Cache CLI (not on PATH \u2014 always run it exactly like this): ${cli} ${CLI_HINT}`);
  lines.push(connectorLine(ctx));
  lines.push(`Mode: ${ctx.cfg.read_only ? "read-only (writes blocked)" : "writes allowed with preview + approval"}`);
  return lines.join("\n");
}
function handleSessionStart(input, ctx = context()) {
  heartbeat(ctx.data, input.session_id ?? "", "session-start");
  if (ctx.acctDir) {
    if (fs9.existsSync(manifestPath(ctx.acctDir)) && reindexOutdated(ctx.acctDir).length && loadProfile(ctx.acctDir)) buildProfile(ctx.acctDir);
    cleanupResults(ctx.acctDir, ctx.cfg.results_retention_days);
    cleanupPreviews(ctx.acctDir, ctx.cfg.results_retention_days);
  }
  cleanupSessions(ctx.data);
  return { text: sessionContext(ctx) };
}

// src/cache/profile.ts
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function materialityFor(ttm) {
  const amount = ttm < 1e6 ? 5e3 : ttm < 1e7 ? 25e3 : ttm < 1e8 ? 5e4 : ttm < 1e9 ? 25e4 : 1e6;
  return { amount, pct: 5 };
}
function col(ix, name) {
  return ix.header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
}
function isEliminationName(name) {
  return /elimination/i.test(name ?? "");
}
var truthy = (v) => /^(t|true|y|yes|1)$/i.test((v ?? "").trim());
function parseDate(s) {
  const t = s.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(t);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(t);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
  return void 0;
}
function profilePath(acctDir) {
  return path10.join(acctDir, "profile.json");
}
function loadProfile(acctDir) {
  return readJson(profilePath(acctDir), void 0);
}
function buildProfile(acctDir, now = Date.now()) {
  const prev = loadProfile(acctDir);
  const p = { builtAt: (/* @__PURE__ */ new Date()).toISOString(), overrides: prev?.overrides ?? {} };
  const subs = readIndex(acctDir, "subsidiaries");
  const elimIds = /* @__PURE__ */ new Set();
  if (subs.rows.length) {
    const elim = col(subs, "iselimination");
    const id = col(subs, "id");
    const nm = col(subs, "name");
    const isElim = (r) => elim >= 0 && r[elim] ? truthy(r[elim]) : isEliminationName(r[nm]);
    for (const r of subs.rows) if (isElim(r) && r[id]) elimIds.add(r[id]);
    const real = subs.rows.filter((r) => !isElim(r) && r[id] !== "-1" && !/\(consolidated\)\s*$/i.test(r[nm] ?? ""));
    p.subsidiaryCount = real.length;
    const hasConsolidated = subs.rows.some((r) => r[id] === "-1" || /\(consolidated\)\s*$/i.test(r[nm] ?? ""));
    p.oneWorld = real.length > 1 || hasConsolidated || elimIds.size > 0;
    const parent = col(subs, "parent");
    const cur2 = col(subs, "currency");
    const root = parent >= 0 ? real.find((r) => !r[parent]) : void 0;
    if (root?.[id]) p.parentSubsidiaryId = root[id];
    const consolidated = subs.rows.map((r) => /^(.*?)\s*\(consolidated\)\s*$/i.exec(r[nm] ?? "")?.[1]).find(Boolean);
    const named = consolidated ? real.find((r) => (r[nm] ?? "").trim().toLowerCase() === consolidated.trim().toLowerCase()) : void 0;
    if (!p.parentSubsidiaryId && named?.[id]) p.parentSubsidiaryId = named[id];
    if (real.length === 1 && real[0][id]) p.parentSubsidiaryId ??= real[0][id];
    const withCur = root ?? real[0];
    if (withCur && cur2 >= 0 && withCur[cur2]) p.baseCurrency = withCur[cur2];
  }
  const books = readIndex(acctDir, "books");
  if (books.rows.length) p.multiBook = books.rows.length > 1;
  const cur = readIndex(acctDir, "probe/base_currency");
  if (cur.rows[0]) {
    const [cc, cid] = [col(cur, "currency"), col(cur, "id")];
    const code = cc >= 0 ? (cur.rows[0][cc] ?? "").trim() : "";
    if (code) p.baseCurrency = code;
    if (cid >= 0 && cur.rows[0][cid]) p.parentSubsidiaryId = cur.rows[0][cid];
  }
  const fx = readIndex(acctDir, "probe/base_currency_fx");
  const [fs_, fc, fn] = [col(fx, "sub"), col(fx, "currency"), col(fx, "n")];
  if (fx.rows.length && fs_ >= 0 && fc >= 0) {
    const best = {};
    for (const r of fx.rows) {
      const sub = r[fs_];
      const n = fn >= 0 ? Number(r[fn]) || 0 : 1;
      if (sub && r[fc] && (!best[sub] || n > best[sub].n)) best[sub] = { c: r[fc], n };
    }
    p.subsidiaryCurrencies = Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.c]));
    const pc = p.parentSubsidiaryId ? p.subsidiaryCurrencies[p.parentSubsidiaryId] : void 0;
    if (!p.baseCurrency && pc) {
      p.baseCurrency = pc;
      p.baseCurrencySource = "fx";
    }
  }
  if (p.baseCurrency && p.parentSubsidiaryId && !p.subsidiaryCurrencies?.[p.parentSubsidiaryId]) (p.subsidiaryCurrencies ??= {})[p.parentSubsidiaryId] = p.baseCurrency;
  if (!p.baseCurrency) {
    const types = readIndex(acctDir, "recordtypes").rows;
    if (types.length && !types.some((r) => (r[0] ?? "").toLowerCase() === "subsidiary")) p.baseCurrencyWhy = "the connector role can't query the subsidiary table";
    else if (cur.header.length && !cur.rows.length) p.baseCurrencyWhy = "the base-currency probe returned no parent subsidiary";
    else if (cur.rows.length) p.baseCurrencyWhy = "the base-currency probe returned the parent subsidiary without a currency";
    if (p.baseCurrencyWhy && fx.rows.length) p.baseCurrencyWhy += p.parentSubsidiaryId ? `, and the parent subsidiary (${p.parentSubsidiaryId}) has no rate-1 transactions in the last month` : ", and the parent subsidiary isn't known";
  }
  const periods = readIndex(acctDir, "periods");
  if (periods.rows.length) {
    const [name, start, end, closed, isyear, isq, adj] = ["periodname", "startdate", "enddate", "closed", "isyear", "isquarter", "isadjust"].map((c) => col(periods, c));
    const years = periods.rows.filter((r) => isyear >= 0 && truthy(r[isyear]));
    const lastYear = years.map((r) => parseDate(r[start] ?? "")).filter((d) => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
    if (lastYear) p.fiscalYearStartMonth = MONTHS[lastYear.getUTCMonth()];
    const open = periods.rows.filter((r) => !truthy(r[closed]) && !truthy(r[isyear]) && !truthy(r[isq]) && !(adj >= 0 && truthy(r[adj]))).map((r) => ({ r, s: parseDate(r[start] ?? "")?.getTime(), e: parseDate(r[end] ?? "")?.getTime() })).filter((x) => x.s !== void 0).sort((a, b) => a.s - b.s);
    const current = open.filter((x) => (x.e ?? x.s) >= now - 365 * 864e5);
    p.openPeriods = (current.length ? current : open).map((x) => x.r[name]).filter(Boolean).slice(0, 6);
  }
  const fy = readIndex(acctDir, "probe/fiscal_calendar");
  if (!p.fiscalYearStartMonth && fy.rows[0]) {
    const d = fy.rows[0].map((c) => parseDate(c)).find(Boolean);
    if (d) p.fiscalYearStartMonth = MONTHS[d.getUTCMonth()];
  }
  const appr = readIndex(acctDir, "probe/approval_workflows");
  if (appr.rows.length) {
    const t = Math.max(0, col(appr, "type"));
    const n = col(appr, "with_status") >= 0 ? col(appr, "with_status") : 1;
    p.approvalWorkflows = Object.fromEntries(appr.rows.map((r) => [r[t], Number(r[n]) > 0]));
  }
  const ttm = readIndex(acctDir, "probe/ttm_revenue");
  const rev = col(ttm, "revenue") >= 0 ? col(ttm, "revenue") : ttm.header.length - 1;
  const [sid, sname] = [col(ttm, "subsidiary_id"), col(ttm, "subsidiary")];
  if (sid >= 0 || sname >= 0) {
    const bySub = ttm.rows.map((r) => {
      const id = sid >= 0 ? r[sid] || void 0 : void 0;
      const currency = id ? p.subsidiaryCurrencies?.[id] : void 0;
      return { id, name: (sname >= 0 ? r[sname] : "") || (sid >= 0 ? `subsidiary ${r[sid]}` : "?"), amount: Number(r[rev]), ...currency ? { currency } : {} };
    }).filter((x) => Number.isFinite(x.amount) && !(x.id && elimIds.has(x.id)) && !isEliminationName(x.name)).sort((a, b) => b.amount - a.amount);
    if (bySub.length) {
      if (!p.oneWorld && bySub.length === 1) p.ttmRevenue = Math.abs(bySub[0].amount);
      else p.ttmRevenueBySubsidiary = bySub;
    }
  } else {
    const ttmVal = Number(ttm.rows[0]?.[rev] ?? NaN);
    if (Number.isFinite(ttmVal)) {
      p.ttmRevenue = Math.abs(ttmVal);
      if (p.oneWorld) p.ttmRevenueMixed = true;
    }
  }
  if (prev?.ttmRevenueConsolidated) p.ttmRevenueConsolidated = prev.ttmRevenueConsolidated;
  applyOverrides(p);
  writeJson(profilePath(acctDir), p);
  writeFileAtomic(path10.join(acctDir, "profile.md"), profileCard(p));
  return p;
}
function deriveMateriality(p) {
  delete p.materiality;
  const c = p.ttmRevenueConsolidated;
  if (c && c.amount > 0) {
    p.materiality = { ...materialityFor(c.amount), basis: "consolidated" };
    return;
  }
  const by = p.ttmRevenueBySubsidiary;
  if (by?.length) {
    const parent = p.parentSubsidiaryId ? by.find((x) => x.id === p.parentSubsidiaryId) : void 0;
    const pick2 = parent && parent.amount > 0 ? parent : by[0];
    if (pick2.amount > 0) p.materiality = { ...materialityFor(pick2.amount), from: pick2.name, ...pick2.id ? { fromId: pick2.id } : {}, basis: pick2 === parent ? "parent" : "largest" };
    return;
  }
  if (p.ttmRevenue !== void 0 && p.ttmRevenue > 0 && !p.ttmRevenueMixed && !p.oneWorld) p.materiality = materialityFor(p.ttmRevenue);
}
function applyOverrides(p) {
  const o = p.overrides ?? {};
  if (o.base_currency) {
    p.baseCurrency = o.base_currency;
    delete p.baseCurrencySource;
    delete p.baseCurrencyWhy;
    if (p.parentSubsidiaryId) {
      (p.subsidiaryCurrencies ??= {})[p.parentSubsidiaryId] = o.base_currency;
      for (const x of p.ttmRevenueBySubsidiary ?? []) if (x.id === p.parentSubsidiaryId) x.currency = o.base_currency;
    }
  }
  if (o.fiscal_year_start) p.fiscalYearStartMonth = o.fiscal_year_start;
  if (o.oneworld) p.oneWorld = truthy(o.oneworld);
  if (o.multibook) p.multiBook = truthy(o.multibook);
  const ttmc = o.ttm_revenue_consolidated ? parseAmount(o.ttm_revenue_consolidated) : void 0;
  if (ttmc !== void 0 && ttmc > 0) p.ttmRevenueConsolidated = { amount: ttmc, source: "set by the user" };
  deriveMateriality(p);
  const amt = o.materiality_amount ? parseAmount(o.materiality_amount) : void 0;
  const pctN = o.materiality_pct ? Number(o.materiality_pct.replace(/%$/, "")) : void 0;
  const userAmount = amt !== void 0 && amt > 0 ? amt : void 0;
  const userPct = pctN !== void 0 && Number.isFinite(pctN) && pctN > 0 && pctN <= 100 ? pctN : void 0;
  if (userAmount !== void 0 || userPct !== void 0 && p.materiality) {
    const derived = userAmount !== void 0 ? {} : { from: p.materiality?.from, fromId: p.materiality?.fromId, basis: p.materiality?.basis };
    p.materiality = {
      amount: userAmount ?? p.materiality?.amount ?? 0,
      pct: userPct ?? p.materiality?.pct ?? 5,
      ...Object.fromEntries(Object.entries(derived).filter(([, v]) => v !== void 0))
    };
  }
  for (const [k, v] of Object.entries(o)) {
    const m = /^approval\.(.+)$/.exec(k);
    if (m) (p.approvalWorkflows ??= {})[m[1]] = truthy(v);
  }
}
function setConsolidatedRevenue(acctDir, v) {
  const p = loadProfile(acctDir) ?? buildProfile(acctDir);
  if (p.overrides?.ttm_revenue_consolidated) delete p.overrides.ttm_revenue_consolidated;
  p.ttmRevenueConsolidated = v;
  applyOverrides(p);
  writeJson(profilePath(acctDir), p);
  writeFileAtomic(path10.join(acctDir, "profile.md"), profileCard(p));
  return p;
}
var OVERRIDE_KEYS = ["base_currency", "fiscal_year_start", "oneworld", "multibook", "ttm_revenue_consolidated", "materiality_amount", "materiality_pct"];
var BOOL2 = /^(t|true|y|yes|1|f|false|n|no|0)$/i;
var MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function parseAmount(v) {
  const m = /^(\d{1,3}(?:[, _]\d{3})+|\d+)(\.\d+)?\s*([kmb])?$/i.exec(v.trim());
  if (!m) return void 0;
  const n = Number(m[1].replace(/[, _]/g, "") + (m[2] ?? "")) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[3] ?? "").toLowerCase()] ?? 1);
  return Number.isFinite(n) ? n : void 0;
}
function normaliseOverride(key, value) {
  const v = value.trim();
  if (/^approval\./.test(key)) {
    if (!/^approval\.[A-Za-z][A-Za-z0-9_]*$/.test(key)) return { error: "the type code after 'approval.' must be a NetSuite transaction type code, e.g. approval.VendBill" };
    return BOOL2.test(v) ? { value: /^(t|true|y|yes|1)$/i.test(v) ? "true" : "false" } : { error: "expected yes or no" };
  }
  switch (key) {
    case "base_currency":
      return /^[A-Za-z]{3}$/.test(v) ? { value: v.toUpperCase() } : { error: "expected a 3-letter currency code, e.g. EUR" };
    case "fiscal_year_start": {
      const i = /^\d{1,2}$/.test(v) ? Number(v) - 1 : MONTH_NAMES.findIndex((m) => v.length >= 3 && m.startsWith(v.toLowerCase()));
      return i >= 0 && i < 12 ? { value: MONTHS[i] } : { error: "expected a month, e.g. Jan, January or 1" };
    }
    case "oneworld":
    case "multibook":
      return BOOL2.test(v) ? { value: /^(t|true|y|yes|1)$/i.test(v) ? "true" : "false" } : { error: "expected yes or no" };
    case "ttm_revenue_consolidated":
    case "materiality_amount": {
      const n = parseAmount(v);
      return n !== void 0 && n > 0 ? { value: String(n) } : { error: "expected a positive amount, e.g. 50000, 50,000 or 50k" };
    }
    case "materiality_pct": {
      const n = Number(v.replace(/%$/, "").trim());
      return v && Number.isFinite(n) && n > 0 && n <= 100 ? { value: String(n) } : { error: "expected a percentage above 0 and at most 100, e.g. 5" };
    }
    default:
      return { error: `unknown key (known: ${OVERRIDE_KEYS.join(", ")}, approval.<TypeCode>)` };
  }
}
function setOverrides(acctDir, pairs) {
  const problems = [];
  const set = {};
  const unset = [];
  for (const [rawKey, value] of Object.entries(pairs)) {
    const key = rawKey.trim();
    const known = OVERRIDE_KEYS.includes(key) || /^approval\./.test(key);
    if (known && value.trim() === "") {
      unset.push(key);
      continue;
    }
    const r = normaliseOverride(key, value);
    if ("error" in r) problems.push(`- ${key}=${value}: ${r.error}`);
    else set[key] = r.value;
  }
  if (problems.length) throw new Error(`Invalid profile setting${problems.length > 1 ? "s" : ""} (nothing was changed):
${problems.join("\n")}`);
  const prev = loadProfile(acctDir) ?? { builtAt: (/* @__PURE__ */ new Date()).toISOString() };
  const overrides = { ...prev.overrides ?? {}, ...set };
  for (const k of unset) delete overrides[k];
  for (const [k, v] of Object.entries(overrides)) if (v === "") delete overrides[k];
  prev.overrides = overrides;
  if (unset.includes("ttm_revenue_consolidated")) delete prev.ttmRevenueConsolidated;
  writeJson(profilePath(acctDir), prev);
  return buildProfile(acctDir);
}
var yn = (b) => b === void 0 ? "?" : b ? "yes" : "no";
function money(n, currency) {
  const v = n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : `${n}`;
  if (!currency) return v;
  const c = currency.trim();
  if (/^(usd\b|u\.?s\.? dollar)/i.test(c)) return `$${v}`;
  const iso = /^([A-Z]{3})\s*-\s/.exec(c);
  return `${iso ? iso[1] : c} ${v}`;
}
function compact(n) {
  const a = Math.abs(n);
  const v = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}K` : `${Math.round(a)}`;
  return n < 0 ? `-${v}` : v;
}
function ccyCode(c) {
  const t = c.trim();
  return /^([A-Z]{3})\s*-\s/.exec(t)?.[1] ?? t;
}
function amountIn(n, currency) {
  return currency ? `${ccyCode(currency)} ${compact(n)}` : compact(n);
}
function materialityText(p, short = false) {
  const m = p.materiality;
  if (!m) return void 0;
  const pct = short ? ` / ${m.pct}%` : ` or ${m.pct}%`;
  const confirm = short ? "unconfirmed" : "confirm";
  if (m.basis === "consolidated") return `${money(m.amount, p.baseCurrency)}${pct} (from consolidated TTM revenue)`;
  if (m.basis === "parent") return `${money(m.amount, p.baseCurrency)}${pct} (from the parent subsidiary, ${m.from}; ${confirm})`;
  if (!m.from) {
    if (p.oneWorld && !p.overrides?.materiality_amount) {
      return `${money(m.amount)}${pct} (derived from a mixed-currency total; refresh the ttm_revenue probe or set materiality_amount)`;
    }
    return `${money(m.amount, p.baseCurrency)}${pct}`;
  }
  const inBase = !!m.fromId && m.fromId === p.parentSubsidiaryId;
  const amount = money(m.amount, inBase ? p.baseCurrency : void 0);
  const curs = new Set((p.ttmRevenueBySubsidiary ?? []).map((x) => x.currency ?? "?"));
  const differ = inBase ? "" : curs.has("?") ? "; currencies may differ" : curs.size > 1 ? "; currencies differ" : "";
  return `${amount}${pct} (from the largest subsidiary, ${m.from}, in its currency${differ}; ${confirm})`;
}
function ttmRows(p) {
  const out2 = [];
  const c = p.ttmRevenueConsolidated;
  if (c) out2.push(["TTM revenue (consolidated)", amountIn(c.amount, p.baseCurrency)]);
  const by = p.ttmRevenueBySubsidiary;
  if (by?.length) {
    const shown = by.slice(0, 8).map((x) => `${x.name} ${amountIn(x.amount, x.currency)}`);
    out2.push(["TTM revenue by subsidiary (each in its own base currency, not converted)", `${shown.join(" \xB7 ")}${by.length > 8 ? ` \xB7 +${by.length - 8} more` : ""}`]);
    return out2;
  }
  if (c) return out2;
  if (p.ttmRevenue === void 0) return [["TTM revenue", "unknown"]];
  if (p.ttmRevenueMixed || p.oneWorld) {
    return [["TTM revenue", `${compact(p.ttmRevenue)}, a sum of several subsidiaries' base currencies (not a real total); for per-subsidiary figures, run the su-ns-harness:refresh skill (sections: profile)`]];
  }
  return [["TTM revenue", money(p.ttmRevenue, p.baseCurrency)]];
}
function baseCurrencyText(p) {
  if (p.baseCurrency) return p.baseCurrencySource === "fx" ? `${p.baseCurrency} (from transactions at rate 1; confirm)` : p.baseCurrency;
  return p.baseCurrencyWhy ? `unknown (${p.baseCurrencyWhy}; set it with ${cliCommand()} profile set base_currency=<code>)` : "unknown";
}
function profileLines(p) {
  if (!p) return [];
  const subs = p.oneWorld ? `yes (${p.subsidiaryCount} subs)` : yn(p.oneWorld);
  const l1 = `Base currency ${p.baseCurrency ?? "?"}${p.baseCurrency && p.baseCurrencySource === "fx" ? " (inferred, unconfirmed)" : ""} \xB7 FY starts ${p.fiscalYearStartMonth ?? "?"} \xB7 OneWorld: ${subs} \xB7 Multi-book: ${yn(p.multiBook)}`;
  const parts = [];
  if (p.openPeriods?.length) parts.push(`Open periods: ${p.openPeriods.join(", ")}`);
  if (p.materiality) parts.push(`Materiality tier: ${materialityText(p, true)}`);
  if (p.approvalWorkflows) {
    const on = Object.entries(p.approvalWorkflows).filter(([, v]) => v).map(([k]) => k);
    parts.push(`Approval workflows: ${on.length ? on.join(", ") : "none"}`);
  }
  return parts.length ? [l1, parts.join(" \xB7 ")] : [l1];
}
function profileCard(p) {
  const rows = [
    ["Base currency", baseCurrencyText(p)],
    ["Fiscal year starts", p.fiscalYearStartMonth ?? "unknown"],
    ["OneWorld", p.oneWorld === void 0 ? "unknown" : p.oneWorld ? `yes, ${p.subsidiaryCount} subsidiaries` : "no"],
    ["Multi-book", yn(p.multiBook)],
    ["Open periods", p.openPeriods?.join(", ") || "unknown"],
    ...ttmRows(p),
    ["Materiality", materialityText(p) ?? "unknown"],
    [
      "Approval workflows",
      p.approvalWorkflows ? Object.entries(p.approvalWorkflows).map(([k, v]) => `${k}: ${v ? "yes" : "no"}`).join(", ") || "none found" : "unknown"
    ]
  ];
  const overrides = Object.entries(p.overrides ?? {});
  return [
    "# NetSuite Profile Card",
    "",
    "| | |",
    "|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    "",
    overrides.length ? `User overrides: ${overrides.map(([k, v]) => `${k}=${v}`).join(", ")}` : "No user overrides.",
    `Correct anything with: ${cliCommand()} profile set key=value (base_currency, fiscal_year_start, oneworld, multibook, ttm_revenue_consolidated, materiality_amount, materiality_pct, approval.<TypeCode>)`,
    ""
  ].join("\n");
}

// src/rows.ts
var CONTAINER_KEYS = ["items", "rows", "data", "results", "records", "searchResults", "lines", "value", "result"];
var CHILD_KEYS = ["children", "rows", "lines", "sections", "subRows", "items"];
var LABEL_KEYS = ["label", "name", "title", "account", "description", "text"];
var isObj2 = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function flattenRow(obj, prefix = "", out2 = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (k === "links") continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObj2(v) && prefix.split(".").length < 3) flattenRow(v, key, out2);
    else if (Array.isArray(v)) out2[key] = v.length ? JSON.stringify(v) : "";
    else out2[key] = v;
  }
  return out2;
}
function columnsOf(rows) {
  const seen = /* @__PURE__ */ new Set();
  for (const r of rows) for (const k of Object.keys(r)) seen.add(k);
  return [...seen];
}
function childArray(o) {
  for (const k of CHILD_KEYS) if (Array.isArray(o[k]) && o[k].some(isObj2)) return o[k];
  return void 0;
}
function labelOf(o) {
  for (const k of LABEL_KEYS) if (typeof o[k] === "string" && o[k]) return o[k];
  return void 0;
}
function flattenTree(nodes, trail, out2) {
  for (const n of nodes) {
    if (!isObj2(n)) continue;
    const kids = childArray(n);
    const scalars = {};
    for (const [k, v] of Object.entries(n)) if (!CHILD_KEYS.includes(k) || !Array.isArray(v)) scalars[k] = v;
    const row = flattenRow(scalars);
    if (Object.keys(row).length) out2.push({ section: trail.join(" > "), ...row });
    if (kids) {
      const label = labelOf(n);
      flattenTree(kids, label ? [...trail, label] : trail, out2);
    }
  }
}
function fromMatrix(columns, data) {
  const names = columns.map(
    (c, i) => isObj2(c) ? String(c.name ?? c.label ?? c.id ?? `c${i}`) : String(c ?? `c${i}`)
  );
  return data.map((r) => {
    const row = {};
    r.forEach((v, i) => row[names[i] ?? `c${i}`] = v);
    return row;
  });
}
function fromArray(arr, path14) {
  if (!arr.length) return { rows: [], columns: [], path: path14 };
  if (arr.every(Array.isArray)) {
    const rows2 = fromMatrix(arr[0].map((_, i) => `c${i}`), arr);
    return { rows: rows2, columns: columnsOf(rows2), path: path14 };
  }
  if (!arr.some(isObj2)) {
    const rows2 = arr.map((v) => ({ value: v }));
    return { rows: rows2, columns: ["value"], path: path14 };
  }
  const objs = arr.filter(isObj2);
  const rows = [];
  if (objs.some((o) => childArray(o))) flattenTree(objs, [], rows);
  else for (const o of objs) rows.push(flattenRow(o));
  return { rows, columns: columnsOf(rows), path: path14 };
}
function largestObjectArray(v, path14, depth) {
  if (depth > 6) return void 0;
  let best;
  if (Array.isArray(v)) {
    if (v.some(isObj2)) best = { arr: v, path: path14 };
    if (v.length <= 3) {
      v.forEach((el, i) => {
        const c = largestObjectArray(el, `${path14}[${i}]`, depth + 1);
        if (c && (!best || c.arr.length > best.arr.length)) best = c;
      });
    }
  } else if (isObj2(v)) {
    for (const [k, val] of Object.entries(v)) {
      const c = largestObjectArray(val, `${path14}.${k}`, depth + 1);
      if (c && (!best || c.arr.length > best.arr.length)) best = c;
    }
  }
  return best;
}
function num(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : void 0;
}
function pagingMeta(o) {
  const bool = (...ks) => ks.map((k) => o[k]).find((v) => typeof v === "boolean");
  return pickDefined({
    hasMore: bool("hasNextPage", "hasMore", "hasMoreResults"),
    totalResults: num(o.totalResults) ?? num(o.totalRecords) ?? num(o.totalCount),
    pageIndex: num(o.pageIndex),
    pageSize: num(o.pageSize),
    numberOfPages: num(o.numberOfPages) ?? num(o.totalPages)
  });
}
var STRUCTURAL = ["line", "depth", "is_detail", "kind"];
var AGING_BUCKETS = ["Current", "1-30", "31-60", "61-90", "Over 90"];
var str = (v) => typeof v === "string" && v ? v : void 0;
function periodName(id, label) {
  const m = id ? /^(.+?) > (.+)$/.exec(id) : null;
  if (!m) return void 0;
  const prefix = m[1].trim();
  if (/^\d{4}-\d{2}$/.test(prefix)) return prefix;
  const q = /^(\d{4})-([1-4])$/.exec(prefix);
  if (q) return `${q[1]}-Q${q[2]}`;
  if (prefix === "empty") return "Total";
  return `${prefix} ${label ?? m[2]}`;
}
function reportColumnNames(cols, title) {
  const objs = cols.filter(isObj2);
  const raw = objs.map((c) => ({ id: str(c.id), path: str(c.path), label: str(c.label) }));
  const count = (vals) => {
    const m = /* @__PURE__ */ new Map();
    for (const v of vals) if (v !== void 0) m.set(v, (m.get(v) ?? 0) + 1);
    return m;
  };
  const labels = count(raw.map((c) => c.label));
  const paths = count(raw.map((c) => c.path));
  const multiLabel = labels.size > 1;
  const notes = [];
  const aging = /aging/i.test(title ?? "");
  const names = raw.map((c, i) => {
    const label = c.label ?? c.id ?? c.path ?? `c${i}`;
    if (!c.label || (labels.get(c.label) ?? 0) < 2) return label;
    const shared = c.path !== void 0 && (paths.get(c.path) ?? 0) > 1;
    if (shared) {
      const group = raw.map((x, j) => x.path === c.path ? j : -1).filter((j) => j >= 0);
      const k = group.indexOf(i);
      if (aging && group.length === AGING_BUCKETS.length) return multiLabel ? `${AGING_BUCKETS[k]} ${c.label}` : AGING_BUCKETS[k];
      return `${c.label} ${k + 1}`;
    }
    const p = periodName(c.id, c.label);
    if (!p) return `${label} ${i + 1}`;
    return multiLabel && (p === "Total" || /^\d{4}-(\d{2}|Q\d)$/.test(p)) ? `${p} ${c.label}` : p;
  });
  if (aging && raw.some((c) => c.path !== void 0 && (paths.get(c.path) ?? 0) === AGING_BUCKETS.length && (labels.get(c.label ?? "") ?? 0) > 1)) {
    notes.push(`Bucket names (${AGING_BUCKETS.join(", ")}) are NetSuite's defaults, inferred from column order (not sent); raw column ids are in the result's meta.json.`);
  }
  const used = new Set(STRUCTURAL);
  const out2 = raw.map((c, i) => {
    let name = names[i];
    if (used.has(name)) name = `${name} (${c.id ?? i})`;
    for (let n = 2; used.has(name); n++) name = `${names[i]} (${n})`;
    used.add(name);
    return { name, ...pickDefined(c) };
  });
  return { cols: out2, notes };
}
function columnValue(c, i, vals, list2, shared, n) {
  if (c.id !== void 0 && c.id in vals) return vals[c.id];
  for (const k of [c.path, c.label]) if (k !== void 0 && !shared.has(k) && k in vals) return vals[k];
  if (list2 && list2.length === n) {
    const cell2 = list2[i];
    const ks = Object.keys(cell2);
    if (ks.length === 1) return cell2[ks[0]];
  }
  return null;
}
function fromReport(json) {
  const data = json.reportData;
  const entries = Array.isArray(data) ? data : Object.entries(data).sort(([a], [b]) => Number(a) - Number(b) || a.localeCompare(b)).map(([, v]) => v);
  const title = typeof json.title === "string" ? json.title : void 0;
  const { cols, notes } = reportColumnNames(Array.isArray(json.reportColumns) ? json.reportColumns : [], title);
  const seen = /* @__PURE__ */ new Map();
  for (const c of cols) for (const k of /* @__PURE__ */ new Set([c.path, c.label])) if (k !== void 0) seen.set(k, (seen.get(k) ?? 0) + 1);
  const shared = new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
  const rows = [];
  const stack = [];
  for (const r of entries) {
    if (!isObj2(r)) continue;
    const alias = typeof r.alias === "string" && r.alias ? r.alias : void 0;
    const parent = typeof r.parent === "string" && r.parent ? r.parent : void 0;
    const detail = r.isDetailLine === true;
    let depth = 0;
    let owner;
    if (!parent) stack.length = 0;
    else {
      while (stack.length && stack[stack.length - 1].alias !== parent) stack.pop();
      owner = stack[stack.length - 1];
      depth = owner ? owner.depth + 1 : 1;
    }
    const value = r.value ?? r.label ?? null;
    const kind = detail ? "detail" : parent ? "line" : alias || r.value != null ? "section" : "structural";
    if (kind === "structural") depth = -1;
    const line = kind === "detail" ? r.value ?? r.label ?? owner?.line ?? null : value;
    const raw = r.summaryLineValues ?? r.detailLineValues;
    const list2 = Array.isArray(raw) && raw.every(isObj2) ? raw : void 0;
    const vals = Object.assign({}, ...Array.isArray(raw) ? raw.filter(isObj2) : isObj2(raw) ? [raw] : []);
    const row = { line, depth, is_detail: detail, kind };
    cols.forEach((c, i) => row[c.name] = columnValue(c, i, vals, list2, shared, cols.length));
    if (!cols.length) {
      for (const [k, v] of Object.entries(vals)) if (!(k in row)) row[k] = v;
    }
    const blank2 = row.line === null || row.line === void 0 || String(row.line).trim() === "";
    if (kind !== "structural" && blank2 && Object.keys(row).slice(4).every((k) => row[k] === null || row[k] === void 0 || row[k] === "" || row[k] === 0)) row.kind = "spacer";
    rows.push(row);
    if (detail && owner) stack.pop();
    else if (!detail && alias) stack.push({ alias, depth, line });
  }
  const columns = columnsOf(rows);
  const valueColumns = columns.filter((c) => !STRUCTURAL.includes(c));
  const report = { title, valueColumns };
  if (cols.length) report.columns = cols;
  if (notes.length) report.notes = notes;
  return { rows, columns, path: "$.reportData", report };
}
function reportInfoOf(json) {
  if (!isObj2(json) || !(isObj2(json.reportData) || Array.isArray(json.reportData)) || !Array.isArray(json.reportColumns)) return void 0;
  const title = typeof json.title === "string" ? json.title : void 0;
  const { cols, notes } = reportColumnNames(json.reportColumns, title);
  const info = { title, valueColumns: cols.map((c) => c.name), columns: cols };
  if (notes.length) info.notes = notes;
  return info;
}
function identicalReportColumns(rows, cols) {
  const out2 = [];
  const empty = (v) => v === null || v === void 0 || v === "";
  for (let a = 0; a < cols.length; a++) {
    for (let b = a + 1; b < cols.length; b++) {
      const [x, y] = [cols[a], cols[b]];
      if ((x.id ?? x.name) === (y.id ?? y.name)) continue;
      let filled = false;
      const same = rows.every((r) => {
        const [u, v] = [r[x.name], r[y.name]];
        if (!empty(u) || !empty(v)) filled = true;
        return empty(u) && empty(v) || u === v;
      });
      if (same && filled) out2.push([x.name, y.name]);
    }
  }
  return out2;
}
var LOOSE_ISO = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
var LOOSE_DATETIME = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([ap])\.?m\.?)?$/i;
var realDate = (y, m, d) => {
  const dt = parseDate(`${y}-${m}-${d}`);
  return dt && dt.getUTCMonth() + 1 === Number(m) && dt.getUTCDate() === Number(d) ? dt.toISOString().slice(0, 10) : void 0;
};
function normaliseDateValue(v) {
  const m = v.length < 10 ? LOOSE_ISO.exec(v) : null;
  if (m) return realDate(m[1], m[2], m[3]);
  const t = v.length <= 24 ? LOOSE_DATETIME.exec(v.trim()) : null;
  if (!t) return void 0;
  const day = realDate(t[1], t[2], t[3]);
  if (!day) return void 0;
  let h = Number(t[4]);
  const min = Number(t[5]);
  const sec = t[6] === void 0 ? void 0 : Number(t[6]);
  if (t[7]) {
    if (h < 1 || h > 12) return void 0;
    h = h % 12 + (t[7].toLowerCase() === "p" ? 12 : 0);
  } else if (h > 23) return void 0;
  if (min > 59 || sec !== void 0 && sec > 59) return void 0;
  const pad = (n) => String(n).padStart(2, "0");
  return `${day} ${pad(h)}:${pad(min)}${sec === void 0 ? "" : `:${pad(sec)}`}`;
}
function normaliseDates(ex) {
  normaliseSlashDates(ex);
  for (const r of ex.rows) {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v !== "string" || v.length < 8 || !/^\d{4}-/.test(v)) continue;
      const n = normaliseDateValue(v);
      if (n !== void 0 && n !== v) r[k] = n;
    }
  }
  return ex;
}
var SLASH_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?))?$/i;
function normaliseSlashDates(ex) {
  for (const c of ex.columns) {
    const hits = [];
    let ok = true;
    for (const r of ex.rows) {
      const v = r[c];
      if (v === null || v === void 0 || typeof v === "string" && v.trim() === "") continue;
      const m = typeof v === "string" ? SLASH_DATE.exec(v.trim()) : null;
      if (!m) {
        ok = false;
        break;
      }
      hits.push({ r, m });
    }
    if (!ok || !hits.length) continue;
    const first = Math.max(...hits.map((h) => Number(h.m[1])));
    const second = Math.max(...hits.map((h) => Number(h.m[2])));
    const order = first <= 12 && second > 12 ? "md" : first > 12 && second <= 12 ? "dm" : void 0;
    if (!order) continue;
    const out2 = [];
    for (const { m } of hits) {
      const [mo, d] = order === "md" ? [m[1], m[2]] : [m[2], m[1]];
      const day = realDate(m[3], mo, d);
      const n = day && (m[4] ? normaliseDateValue(`${day} ${m[4]}`) : day);
      if (!n) {
        ok = false;
        break;
      }
      out2.push(n);
    }
    if (ok) hits.forEach((h, i) => h.r[c] = out2[i]);
  }
}
function extractRows(json) {
  const ex = extractInner(json);
  return ex && normaliseDates(ex);
}
function extractInner(json) {
  if (json === void 0 || json === null) return void 0;
  if (Array.isArray(json)) return fromArray(json, "$");
  if (!isObj2(json)) return void 0;
  if (isObj2(json.reportData) || Array.isArray(json.reportData) && json.reportData.some(isObj2)) return fromReport(json);
  const meta = pagingMeta(json);
  const cols = json.columns ?? json.headers;
  if (Array.isArray(cols)) {
    for (const k of ["rows", "data", "values"]) {
      const d = json[k];
      if (Array.isArray(d) && d.every(Array.isArray)) {
        const rows = fromMatrix(cols, d);
        return { rows, columns: columnsOf(rows), path: `$.${k}`, ...meta };
      }
    }
  }
  for (const k of CONTAINER_KEYS) {
    const v = json[k];
    if (Array.isArray(v)) {
      const r = fromArray(v, `$.${k}`);
      if (r) return { ...r, ...meta };
    }
    if (isObj2(v)) {
      const inner = extractInner(v);
      if (inner) return { ...meta, ...inner, path: `$.${k}${inner.path.slice(1)}` };
    }
  }
  const found = largestObjectArray(json, "$", 0);
  if (found) {
    const r = fromArray(found.arr, found.path);
    if (r) return { ...r, ...meta };
  }
  const row = flattenRow(json);
  return { rows: [row], columns: Object.keys(row), path: "$" };
}
function pickDefined(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== void 0));
}

// src/cache/probes.ts
var PROBES = [
  {
    tag: "periods",
    description: "Accounting periods [su-ns-harness:periods]",
    sql: "SELECT id, periodname, TO_CHAR(startdate,'YYYY-MM-DD') AS startdate, TO_CHAR(enddate,'YYYY-MM-DD') AS enddate, closed, isyear, isquarter, isadjust FROM accountingperiod ORDER BY startdate",
    table: "accountingperiod",
    required: ["id", "periodname", "startdate", "enddate", "closed", "isyear", "isquarter", "isadjust"]
  },
  {
    tag: "profile:base_currency",
    description: "Base currency [su-ns-harness:profile:base_currency]",
    sql: "SELECT s.id, BUILTIN.DF(s.currency) AS currency FROM subsidiary s WHERE s.parent IS NULL",
    table: "subsidiary",
    required: ["id", "currency"]
  },
  {
    // Fallback when the role can't see `subsidiary` (live-verified): each subsidiary's own currency
    // is the one its transactions carry at exchange rate 1 (≥ 99.8% of rows on the live account).
    tag: "profile:base_currency_fx",
    description: "Subsidiary currencies [su-ns-harness:profile:base_currency_fx]",
    sql: "SELECT tl.subsidiary AS sub, BUILTIN.DF(t.currency) AS currency, COUNT(*) AS n FROM transaction t JOIN transactionline tl ON tl.transaction = t.id WHERE tl.mainline = 'T' AND t.exchangerate = 1 AND t.trandate >= ADD_MONTHS(SYSDATE, -1) GROUP BY tl.subsidiary, BUILTIN.DF(t.currency)",
    table: "transaction",
    required: ["sub", "currency", "n"]
  },
  {
    tag: "profile:approval_workflows",
    description: "Approval status usage [su-ns-harness:profile:approval_workflows]",
    sql: "SELECT t.type, COUNT(t.approvalstatus) AS with_status, COUNT(*) AS total FROM transaction t WHERE t.trandate >= ADD_MONTHS(SYSDATE, -12) AND t.type IN ('VendBill','PurchOrd','Journal','ExpRept','SalesOrd','CustInvc','VendPymt','CustCred') GROUP BY t.type",
    table: "transaction",
    required: ["type", "with_status"],
    optional: ["total"]
  },
  {
    tag: "profile:ttm_revenue",
    description: "TTM revenue [su-ns-harness:profile:ttm_revenue]",
    sql: "SELECT tl.subsidiary AS subsidiary_id, BUILTIN.DF(tl.subsidiary) AS subsidiary, SUM(tal.amount) * -1 AS revenue FROM transactionaccountingline tal JOIN transaction t ON t.id = tal.transaction JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline JOIN account a ON a.id = tal.account WHERE UPPER(a.accttype) = 'INCOME' AND tal.posting = 'T' AND t.trandate >= ADD_MONTHS(SYSDATE, -12) GROUP BY tl.subsidiary, BUILTIN.DF(tl.subsidiary)",
    table: "transactionaccountingline",
    // One row per subsidiary; an older cached copy may hold one `revenue` row (a cross-subsidiary sum).
    required: ["revenue"],
    optional: ["subsidiary_id", "subsidiary"]
  }
];
function probeKey(tag) {
  return tag.startsWith("profile:") ? `profile:${tag.slice("profile:".length).replace(/[^a-z0-9_]/gi, "_")}` : tag;
}
function probeFor(tag) {
  const key = probeKey(tag.toLowerCase());
  return PROBES.find((p) => p.tag === key);
}
function normaliseSql(sql) {
  let toks;
  try {
    toks = tokenize(sql);
  } catch {
    return sql.trim().replace(/;\s*$/, "").replace(/\s+/g, " ").toLowerCase();
  }
  while (toks.length && toks[toks.length - 1].type === "semi") toks.pop();
  return toks.map((t) => t.type === "str" ? JSON.stringify(t.value) : t.type === "word" ? t.value : t.raw).join(" ");
}
function isCanonicalProbe(tag, sql) {
  const p = tag ? probeFor(tag) : void 0;
  return !!p && normaliseSql(sql) === normaliseSql(p.sql);
}

// src/cache/catalog.ts
var lc = (s) => s.toLowerCase();
function pick(row, candidates) {
  const keys = Object.keys(row);
  for (const c of candidates) {
    const k = keys.find((key) => lc(key) === lc(c));
    if (k !== void 0 && row[k] !== void 0 && row[k] !== null && row[k] !== "") return row[k];
  }
  return void 0;
}
var str2 = (v) => v === void 0 || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
function catalogTarget(tool, input, tag) {
  const cli = "nsx";
  switch (tool) {
    case "ns_listAllReports":
      return { section: "reports", label: "reports", hint: `${cli} reports search "<term>"` };
    case "ns_listSavedSearches":
      return { section: "searches", label: "saved searches", hint: `${cli} searches search "<term>"` };
    case "ns_getSubsidiaries":
      return { section: "subsidiaries", label: "subsidiaries", hint: `${cli} cache show subsidiaries` };
    case "ns_getAccountingBooks":
      return { section: "books", label: "accounting books", hint: `${cli} cache show books` };
    case "ns_getAccountingContexts":
      return { section: "contexts", label: "accounting contexts", hint: `${cli} cache show contexts` };
    case "ns_getNexusIds":
      return { section: "nexus", label: "nexus ids", hint: `${cli} cache show nexus` };
    case "ns_getSuiteQLMetadata": {
      const t = str2(input.recordType).trim();
      return t ? { section: `fields/${lc(t)}`, label: `fields for ${lc(t)}`, hint: `${cli} fields ${lc(t)} [--grep <term>]` } : { section: "recordtypes", label: "record types", hint: `${cli} recordtypes [--grep <term>]` };
    }
    case "ns_getRecordTypeMetadata": {
      const t = str2(input.recordType ?? input.type ?? input.recordTypeName).trim();
      return t ? { section: `recordmeta/${lc(t)}`, label: `fields (record metadata) for ${lc(t)}`, hint: `${cli} fields ${lc(t)} --record` } : { section: "recordmeta/_all", label: "record types (record API)", hint: `${cli} cache show recordmeta/_all` };
    }
    case "ns_runCustomSuiteQL":
      if (tag === "periods") return { section: "periods", label: "accounting periods", hint: `${cli} periods [--open]` };
      if (tag?.startsWith("profile:")) {
        const key = probeKey(tag).slice("profile:".length);
        return { section: `probe/${key}`, label: `profile probe '${key}'`, hint: `${cli} cache build` };
      }
      return void 0;
    default:
      return void 0;
  }
}
function descriptionTag(input) {
  const m = /\[su-ns-harness:([a-z0-9_:.-]+)\]/i.exec(str2(input.description));
  return m?.[1].toLowerCase();
}
var TAG_SPECS = Object.fromEntries(PROBES.map((p) => [p.tag, { table: p.table, required: p.required, ...p.optional ? { optional: p.optional } : {} }]));
function tagMismatch(tag, sql, json) {
  const key = probeKey(tag);
  const spec = TAG_SPECS[key];
  if (!spec) return `not a query su-ns-harness runs (known tags: ${Object.keys(TAG_SPECS).map((k) => `[su-ns-harness:${k}]`).join(", ")})`;
  const expected = `expected ${spec.required.join(", ")}${spec.optional?.length ? ` (optional: ${spec.optional.join(", ")})` : ""} from ${spec.table}`;
  if (!tablesInSql(sql).includes(spec.table)) return `the query doesn't read ${spec.table} (${expected})`;
  if (!isCanonicalProbe(key, sql)) return "not the init query (a tagged query must use the SQL from the su-ns-harness:init skill, step 3, or the su-ns-harness:refresh skill's table, exactly, with no extra filters or paging)";
  const ex = extractRows(json);
  if (!ex) return `the result isn't a table (${expected})`;
  if (ex.hasMore || ex.totalResults !== void 0 && ex.totalResults > ex.rows.length) {
    return `the result is one page (${ex.rows.length} of ${ex.totalResults ?? "more"} rows); a tagged query must return every row, so call it without pageSize/pageIndex`;
  }
  if (!ex.rows.length) return key === "periods" ? "the result is empty (an account always has accounting periods)" : void 0;
  const cols = ex.columns.map(lc);
  const allowed = /* @__PURE__ */ new Set([...spec.required, ...spec.optional ?? []]);
  const missing = spec.required.filter((c) => !cols.includes(c));
  const extra = cols.filter((c) => !allowed.has(c));
  if (missing.length || extra.length) return `columns don't match (${expected}; got ${ex.columns.join(", ")})`;
  return void 0;
}
function shrinkRefusal(acctDir, section, newCount) {
  if (section.startsWith("probe/")) return void 0;
  const e = loadManifest(acctDir).sections[section];
  if (!e || e.status === "stale" || e.count <= 0) return void 0;
  if (newCount > 0 && (e.count < 4 || newCount * 2 >= e.count)) return void 0;
  return `${section} ${e.count} \u2192 ${newCount}: not replaced, the cached copy was kept. If that's intended, run \`nsx cache invalidate ${section}\` and the call again (or run the su-ns-harness:refresh skill (sections: ${section}), which does this).`;
}
function simpleIndex(json, header, cols) {
  const ex = extractRows(json);
  if (!ex || !ex.rows.length) return ex ? { header, rows: [] } : void 0;
  const rows = ex.rows.map((r) => cols.map((c) => str2(pick(r, c))));
  if (rows.every((r) => r.every((c) => c === ""))) return void 0;
  return { header, rows };
}
function dropEmptyColumns(ix, keep) {
  const cols = ix.header.map((_, i) => i).filter((i) => i < keep || ix.rows.some((r) => r[i]));
  return { header: cols.map((i) => ix.header[i]), rows: ix.rows.map((r) => cols.map((i) => r[i] ?? "")) };
}
function reportTitle(t) {
  return t.replace(/\{#([^#}]*)#\}/g, "$1");
}
var flagOn = (r, k) => r[k] === true || /^(t|true|y|yes|1)$/i.test(str2(r[k]));
function reportParams(r) {
  const p = [flagOn(r, "as_of_format") ? "as-of" : "from+to"];
  const sub = flagOn(r, "has_subsidiary_filter");
  const consol = flagOn(r, "supports_consolidation");
  if (sub) p.push(consol ? "sub(consol)" : "sub");
  else if (consol) p.push("consol");
  for (const [k, label] of [["supports_book", "book"], ["supports_book2", "book2"], ["supports_range", "range"], ["supports_accounting_context", "acct-ctx"], ["supports_nexus", "nexus"], ["supports_cash_basis_mode", "cash-basis"], ["supports_period_end_mode", "period-end"]]) {
    if (flagOn(r, k)) p.push(label);
  }
  return p.join(" \xB7 ");
}
function reportSupportsRange(acctDir, reportId) {
  const want = str2(reportId).trim();
  if (!want) return void 0;
  const ex = extractRows(readRaw(acctDir, "reports"));
  const r = ex?.rows.find((row) => str2(row.id).trim() === want);
  if (!r || !("supports_range" in r)) return void 0;
  return flagOn(r, "supports_range");
}
function parseReports(json) {
  const header = ["id", "title", "params"];
  const ex = extractRows(json);
  if (!ex) return void 0;
  if (!ex.rows.length) return { header, rows: [] };
  if (ex.rows.some((r) => "as_of_format" in r || "has_subsidiary_filter" in r || Object.keys(r).some((k) => k.startsWith("supports_")))) {
    return { header, rows: ex.rows.map((r) => [str2(r.id), reportTitle(str2(pick(r, ["title", "name"]))), reportParams(r)]) };
  }
  const ix = simpleIndex(json, header, [
    ["id", "reportId", "internalId", "reportid"],
    ["title", "name", "reportName", "label"],
    ["params", "parameters", "filters", "supportedParameters"]
  ]);
  return ix && { header, rows: ix.rows.map((r) => [r[0], reportTitle(str2(r[1])), r[2]]) };
}
function joinTarget(p) {
  if (p?.["x-n:joinable"] && p["x-n:recordType"]) return str2(p["x-n:recordType"]);
  return str2(p?.["x-ns-join"] ?? p?.["x-ns-referenceType"] ?? p?.$ref ?? "");
}
function fromSchema(json) {
  const props = json?.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return void 0;
  const rows = Object.entries(props).map(([field, p]) => [
    field,
    str2(p?.format ?? p?.type),
    str2(p?.title),
    str2(p?.nullable),
    joinTarget(p)
  ]);
  return { header: FIELD_HEADER, rows };
}
var FIELD_HEADER = ["field", "type", "label", "nullable", "joinTarget"];
function schemaCandidates(json) {
  const o = json;
  return [json, o?.schema, o?.metadata];
}
function isEmptySchema(json) {
  return schemaCandidates(json).some((c) => {
    const s = c;
    return !!s && typeof s === "object" && s.type === "object" && s.properties === void 0;
  });
}
function emptyFieldsNote(acctDir, table, kind = "fields") {
  const t = lc(table);
  if (kind === "recordmeta") {
    return `The connector returned no record metadata for '${t}' (REST record API); nsx fields ${t} --record has nothing to show. Check the record type name with ns_getRecordTypeMetadata (no arguments; REST names are lower-case, e.g. vendorbill). Don't retry the same call.`;
  }
  const types = readIndex(acctDir, "recordtypes").rows;
  if (types.length && !types.some((r) => lc(r[0] ?? "") === t)) {
    return `No fields for '${t}', and it isn't in this account's SuiteQL record-type list: the connector role probably can't see this table. Don't retry; queries on it will likely fail with "Record '${t}' was not found".`;
  }
  return `The connector exposes no field metadata for '${t}'; queries still work, column checks are skipped. Don't retry.`;
}
function parseFields(json) {
  for (const c of schemaCandidates(json)) {
    const schema = fromSchema(c);
    if (schema) return schema;
  }
  return simpleIndex(json, FIELD_HEADER, [
    ["id", "name", "fieldId", "field", "columnName", "column"],
    ["type", "dataType", "fieldType", "datatype"],
    ["label", "title", "displayName", "description"],
    ["nullable", "isNullable", "mandatory"],
    ["joinTarget", "join", "references", "recordType", "target", "joinRecordType"]
  ]);
}
function parseSection(section, json) {
  const kind = section.split("/")[0];
  switch (kind) {
    case "reports":
      return parseReports(json);
    case "searches":
      return simpleIndex(json, ["id", "title", "recordtype", "public"], [
        ["id", "searchId", "scriptId", "internalId"],
        ["title", "name", "label"],
        ["recordType", "recordtype", "searchType", "type"],
        ["public", "isPublic"]
      ]);
    case "subsidiaries": {
      const ix = simpleIndex(json, ["id", "name", "currency", "parent", "country", "iselimination"], [
        ["id", "internalId", "subsidiaryId"],
        ["name", "fullName", "fullname", "legalName"],
        ["currency", "currencyName", "baseCurrency", "currency.refName"],
        ["parent", "parentId", "parent.id"],
        ["country", "country.refName"],
        ["isElimination", "iselimination"]
      ]);
      return ix && dropEmptyColumns(ix, 2);
    }
    case "books":
    case "contexts":
    case "nexus":
      return simpleIndex(json, ["id", "name", "extra"], [
        ["id", "internalId", "nexusId", "bookId"],
        ["name", "label", "description", "country"],
        ["isPrimary", "isprimary", "state", "status", "type"]
      ]);
    case "recordtypes": {
      const ex = extractRows(json);
      if (!ex) return void 0;
      const rows = ex.rows.map((r) => [str2(pick(r, ["id", "name", "recordType", "value", "tableName", "table"])), str2(pick(r, ["label", "title", "displayName"]))]).filter((r) => r[0]);
      return rows.length || !ex.rows.length ? { header: ["recordtype", "label"], rows } : void 0;
    }
    case "fields":
    case "recordmeta":
      return parseFields(json);
    case "periods":
      return simpleIndex(json, ["id", "periodname", "startdate", "enddate", "closed", "isyear", "isquarter", "isadjust"], [
        ["id"],
        ["periodname", "periodName", "name"],
        ["startdate", "startDate"],
        ["enddate", "endDate"],
        ["closed", "isclosed", "isClosed"],
        ["isyear", "isYear"],
        ["isquarter", "isQuarter"],
        ["isadjust", "isAdjust"]
      ]);
    case "probe": {
      const ex = extractRows(json);
      if (!ex) return void 0;
      return { header: ex.columns, rows: ex.rows.map((r) => ex.columns.map((c) => str2(r[c]))) };
    }
    default:
      return void 0;
  }
}
function reindexOutdated(acctDir) {
  const done = [];
  for (const [name, e] of Object.entries(loadManifest(acctDir).sections)) {
    if ((e.indexVersion ?? 1) >= INDEX_VERSION || e.status === "empty") continue;
    const raw = readRaw(acctDir, name);
    if (raw === void 0) continue;
    rewriteIndex(acctDir, name, parseSection(name, raw));
    done.push(name);
  }
  return done;
}

// src/hooks/io.ts
import * as fs10 from "node:fs";
import * as path11 from "node:path";
function logHookError(where, err) {
  try {
    const dir = path11.join(dataDir(), "logs");
    fs10.mkdirSync(dir, { recursive: true });
    const file = path11.join(dir, "hook.log");
    try {
      if (fs10.statSync(file).size > 1e6) fs10.renameSync(file, `${file}.1`);
    } catch {
    }
    const msg = err instanceof Error ? `${err.message}
${err.stack ?? ""}` : String(err);
    fs10.appendFileSync(file, `${(/* @__PURE__ */ new Date()).toISOString()} [${where}] ${msg}
`);
  } catch {
  }
}
function captureInput(name, raw) {
  const dir = process.env.NSX_CAPTURE_DIR;
  if (!dir) return;
  try {
    fs10.mkdirSync(dir, { recursive: true });
    let tool = "";
    try {
      tool = String(JSON.parse(raw).tool_name ?? "").replace(/^.*__/, "");
    } catch {
    }
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:.]/g, "");
    fs10.writeFileSync(path11.join(dir, `${stamp}_${name}${tool ? `_${tool}` : ""}.json`), raw);
    const env = { argv1: process.argv[1], CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA };
    fs10.writeFileSync(path11.join(dir, `${stamp}_${name}.env.json`), JSON.stringify(env, null, 2));
  } catch (err) {
    logHookError(`${name}:capture`, err);
  }
}
function expandNsx(v, cmd = nsxCommand()) {
  if (!cmd) return v;
  if (typeof v === "string") return v.replace(/(^|[\s`(:'"])nsx (?=[a-z-])/g, `$1${cmd} `);
  if (Array.isArray(v)) return v.map((x) => expandNsx(x, cmd));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === "updatedInput" ? x : expandNsx(x, cmd)]));
  }
  return v;
}
function nsxCommand() {
  const root = process.env.CLAUDE_PLUGIN_ROOT;
  if (!root) return void 0;
  const ours = pluginRootIfOurs();
  return `node "${ours ? path11.join(ours, "scripts", "nsx.mjs") : path11.resolve(process.argv[1] ?? "scripts/nsx.mjs")}"`;
}
async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}
async function runHook(name, handler, onError) {
  let raw = "";
  try {
    raw = await readStdin();
  } catch (err) {
    logHookError(name, err);
    return;
  }
  const text = processHook(name, raw, handler, onError);
  process.stdout.on("error", (err) => logHookError(`${name}:stdout`, err));
  try {
    if (text) process.stdout.write(text);
  } catch (err) {
    logHookError(`${name}:write`, err);
  }
}
function toolFromRaw(raw) {
  const named = /"tool_name"\s*:\s*"([^"\\]{1,200})"/.exec(raw)?.[1];
  const tool = named ?? /\bmcp__[A-Za-z0-9_-]{1,100}?__ns_[A-Za-z0-9_]{1,100}/.exec(raw)?.[0];
  return tool ? { tool_name: tool } : void 0;
}
function processHook(name, raw, handler, onError) {
  let out2;
  let input;
  try {
    captureInput(name, raw);
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    input = parsed;
    out2 = handler(input);
  } catch (err) {
    logHookError(name, err);
    out2 = void 0;
    input ??= toolFromRaw(raw);
    if (input && onError) {
      try {
        out2 = onError(input);
      } catch (err2) {
        logHookError(`${name}:onError`, err2);
      }
    }
  }
  try {
    if (out2?.json) return JSON.stringify(expandNsx(out2.json));
    if (out2?.text) return expandNsx(out2.text);
  } catch (err) {
    logHookError(`${name}:write`, err);
  }
  return "";
}

// src/results/engine.ts
function unquote(s) {
  const t = s.trim();
  return /^'.*'$|^".*"$/.test(t) ? t.slice(1, -1) : t;
}
function fmtValue(n, column) {
  if (!Number.isFinite(n)) return String(n);
  const digits = column !== void 0 && NOT_SUMMABLE.test(column) ? 6 : 2;
  const f = 10 ** digits;
  const rounded = Math.round(n * f) / f || 0;
  return rounded.toLocaleString("en-US", { maximumFractionDigits: digits });
}
var DATE_LIT = /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4})([T ]\d{1,2}:\d{2}(:\d{2})?(\s*[ap]\.?m\.?)?)?$/i;
var DATE_CELL = /^(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}\/\d{4})([T ]|$)/;
function dateLiteralKey(v) {
  const t = v.trim();
  if (!DATE_LIT.test(t)) return void 0;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(.*)$/.exec(t);
  const iso = us ? `${us[3]}-${us[1]}-${us[2]}${us[4]}` : t;
  const d = /^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/.exec(iso);
  const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const dt = new Date(Date.UTC(y, m - 1, day));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day) return void 0;
  const date = `${d[1]}-${d[2].padStart(2, "0")}-${d[3].padStart(2, "0")}`;
  if (!d[4]) return date;
  return normaliseDateValue(`${date}${d[4].replace(/^T/, " ")}`);
}
function cellDateKey(v) {
  if (typeof v !== "string") return void 0;
  const t = v.trim();
  if (!DATE_CELL.test(t)) return void 0;
  return dateLiteralKey(t) ?? dateKey(t);
}
function cmp(a, b) {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== void 0 && nb !== void 0) return na - nb;
  return String(a ?? "").localeCompare(b, void 0, { sensitivity: "base" });
}
function dateCmp(a, lit) {
  const cell2 = cellDateKey(a);
  if (cell2 === void 0) return void 0;
  const c = lit.length === 10 ? cell2.slice(0, 10) : cell2;
  return c < lit ? -1 : c > lit ? 1 : 0;
}
function splitOutsideQuotes(s, word) {
  const parts = [];
  let cur = "";
  let quote;
  const re = new RegExp(`^\\s+${word}\\s+`, "i");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = void 0;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    const m = re.exec(s.slice(i));
    if (m && /\s/.test(ch)) {
      parts.push(cur);
      cur = "";
      i += m[0].length - 1;
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}
var COL = String.raw`"([^"]+)"|\x60([^\x60]+)\x60|([^\s"'\x60<>=!~][^"'\x60<>=!~]*?)`;
var NULL_COND = new RegExp(String.raw`^\s*(?:${COL})\s+is\s+(not\s+)?null\s*$`, "i");
var OP_COND = new RegExp(String.raw`^\s*(?:${COL})\s*(>=|<=|!=|<>|=|>|<|!~|~)\s*(.*?)\s*$`);
function conditions(expr) {
  return splitOutsideQuotes(expr, "or").map(
    (g) => splitOutsideQuotes(g, "and").map((c) => {
      const n = NULL_COND.exec(c);
      if (n) return { col: (n[1] ?? n[2] ?? n[3]).trim(), quoted: n[3] === void 0, nul: true, not: !!n[4] };
      const m = OP_COND.exec(c);
      if (!m) {
        throw new Error(
          `Cannot parse condition: ${c.trim()} (use col op value; ops = != > >= < <= ~ !~, or 'col is null'; quote a column name with spaces or parentheses: "Last Run On" >= '2026-09-01' or \`Last Run On\` >= '2026-09-01')`
        );
      }
      const raw = m[5];
      if (!/^['"]/.test(raw) && (raw === "" || /^[<>=!~]/.test(raw))) {
        throw new Error(`Cannot parse condition: ${c.trim()} (${raw === "" ? "no value after the operator; for blanks use 'col is null'" : `unexpected "${raw[0]}" after ${m[4]}; ops = != > >= < <= ~ !~`}; quote a value that starts with one: amount = '>1')`);
      }
      return { col: (m[1] ?? m[2] ?? m[3]).trim(), quoted: m[3] === void 0, op: m[4], raw };
    })
  );
}
var loose = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
function resolveColumn(columns, name) {
  if (columns.includes(name)) return name;
  for (const f of [(s) => s.toLowerCase(), loose]) {
    const hits = columns.filter((c) => f(c) === f(name));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return void 0;
  }
  return void 0;
}
var blank = (v) => v === null || v === void 0 || typeof v === "string" && v.trim() === "";
function parseWhere(expr, columns) {
  const groups = conditions(expr);
  if (columns) {
    const missing = groups.flat().filter((c) => resolveColumn(columns, c.col) === void 0).map((c) => c.col);
    if (missing.length) throw new Error(`Unknown column(s): ${[...new Set(missing)].join(", ")}. Available: ${columns.join(", ")}${columns.some((c) => /\s/.test(c)) ? ' (names are matched case-insensitively; quote one with spaces or parentheses: "Last Run On")' : ""}`);
  } else {
    const bad = groups.flat().find((c) => !c.quoted && /\s/.test(c.col));
    if (bad) throw new Error(`Cannot parse condition: ${bad.col} \u2026 (quote a column name with spaces: "${bad.col}")`);
  }
  const conds = groups.map(
    (group) => group.map((c) => {
      const col2 = columns ? resolveColumn(columns, c.col) : c.col;
      if ("nul" in c) return (r) => blank(r[col2]) !== c.not;
      const v = unquote(c.raw);
      const lit = c.op === "~" || c.op === "!~" ? void 0 : dateLiteralKey(v);
      const order = (x) => lit === void 0 ? cmp(x, v) : dateCmp(x, lit);
      const is = (x, ok) => {
        const o = order(x);
        return o !== void 0 && ok(o);
      };
      switch (c.op) {
        case "=":
          return (r) => !blank(r[col2]) && is(r[col2], (o) => o === 0);
        // Blank cells never match a comparison, `!=` included (use `is null`).
        case "!=":
        case "<>":
          return (r) => !blank(r[col2]) && !is(r[col2], (o) => o === 0);
        case ">":
          return (r) => !blank(r[col2]) && is(r[col2], (o) => o > 0);
        case ">=":
          return (r) => !blank(r[col2]) && is(r[col2], (o) => o >= 0);
        case "<":
          return (r) => !blank(r[col2]) && is(r[col2], (o) => o < 0);
        case "<=":
          return (r) => !blank(r[col2]) && is(r[col2], (o) => o <= 0);
        case "~":
          return (r) => String(r[col2] ?? "").toLowerCase().includes(v.toLowerCase());
        default:
          return (r) => !String(r[col2] ?? "").toLowerCase().includes(v.toLowerCase());
      }
    })
  );
  return (r) => conds.some((g) => g.every((p) => p(r)));
}
function resolveColumns(columns, wanted, side) {
  const out2 = [];
  const missing = [];
  for (const w of wanted) {
    if (!w) continue;
    const name = w.trim().replace(/^(["`])(.*)\1$/, "$2");
    const hit = resolveColumn(columns, name);
    if (hit === void 0) missing.push(name);
    else out2.push(hit);
  }
  if (missing.length) throw new Error(`Unknown column(s)${side ? ` in ${side}` : ""}: ${missing.join(", ")}. Available${side ? ` in ${side}` : ""}: ${columns.join(", ")}`);
  return out2;
}
var cell = (v, id, col2) => v === null || v === void 0 ? "" : typeof v === "number" && !id ? fmtValue(v, col2) : String(v);
function renderRows(columns, rows, maxLines = 60) {
  const ids = columns.map(idLikeName);
  return textTable(columns, rows.map((r) => columns.map((c, i) => cell(r[c], ids[i], c))), maxLines);
}
function sortRows(rows, col2, type, asc = false) {
  const t = type ?? inferType(rows.map((r) => r[col2]));
  const kind = t === "num" || t === "id" ? "num" : t === "date" ? "date" : "text";
  const keyOf = (v) => {
    if (isEmpty(v)) return void 0;
    if (kind === "num") return toNumber(v);
    return kind === "date" ? dateKey(String(v).trim()) : String(v);
  };
  const dir = (kind === "text" ? 1 : -1) * (asc ? -1 : 1);
  const keyed = rows.map((r, i) => ({ r, i, k: keyOf(r[col2]) }));
  keyed.sort((x, y) => {
    if (x.k === void 0 || y.k === void 0) return x.k === y.k ? x.i - y.i : x.k === void 0 ? 1 : -1;
    const c = typeof x.k === "number" && typeof y.k === "number" ? x.k - y.k : kind === "date" ? x.k < y.k ? -1 : x.k > y.k ? 1 : 0 : String(x.k).localeCompare(String(y.k), void 0, { numeric: true, sensitivity: "base" });
    return c ? c * dir : x.i - y.i;
  });
  return keyed.map((e) => e.r);
}
function metricKind(rows, col2, types) {
  const vals = rows.map((r) => r[col2]);
  const present2 = vals.filter((v) => !isEmpty(v));
  if (!present2.length) return "num";
  const t = types?.[col2];
  if (t === "date") return "date";
  if (t === "id") return "id";
  if (t === "num") return "num";
  if (t === "str" || t === "bool") return present2.every((v) => toNumber(v) !== void 0) ? "num" : "text";
  const it = inferType(vals);
  if (it === "date") return "date";
  if (it === "num") return isIdColumn(col2, present2) ? "id" : "num";
  if (it === "bool") return "text";
  return present2.some((v) => toNumber(v) !== void 0) ? "num" : "text";
}
function checkMetric(fn, col2, kind, rows) {
  if (fn !== "sum" && fn !== "avg") return;
  if (kind === "date") throw new Error(`--${fn} needs a number column; "${col2}" is a date (use --min/--max)`);
  if (kind === "text") {
    const present2 = rows.map((r) => r[col2]).filter((v) => !isEmpty(v));
    const bad = present2.filter((v) => toNumber(v) === void 0);
    const why = bad.length < present2.length ? ` (${bad.length} of ${present2.length} values aren't numbers, e.g. "${String(bad[0]).trim().slice(0, 30)}")` : "";
    throw new Error(`--${fn} needs a number column; "${col2}" is text${why} (use --count, --min/--max, or --by)`);
  }
  if (kind === "id") throw new Error(`--${fn} needs an amount or a count; "${col2}" holds ids (internal ids or list values), which don't add up (use --count, --by, or --min/--max)`);
  if (fn === "sum" && NOT_SUMMABLE.test(col2)) throw new Error(`--sum of "${col2}" means nothing: rates, ratios and percentages don't add up (use --avg or --min/--max)`);
}
var truthy2 = (v) => v === true || String(v).trim().toLowerCase() === "true" || String(v).trim().toLowerCase() === "t";
function checkReportLevels(rows, cols, what) {
  if (!rows.length || !isReportShape(Object.keys(rows[0]))) return;
  const valued = rows.filter((r) => cols.some((c) => !REPORT_COLS.includes(c) && !isEmpty(r[c])));
  const depths2 = [...new Set(valued.map((r) => String(r.depth)))].sort((x, y) => Number(x) - Number(y));
  const bad = valued.filter((r) => r.kind === "detail" || r.kind === "structural" || truthy2(r.is_detail)).length;
  if (depths2.length <= 1 && !bad) return;
  const across = [depths2.length > 1 ? `depths ${depths2.join(", ")}` : "", bad ? `${bad} detail/structural row(s), which repeat their lines` : ""].filter(Boolean).join(" and ");
  throw new Error(`report rows nest; filter to one level: --where "depth=1 and is_detail=false" (${what} across ${across} double-counts subtotals)`);
}
function repeatsIn(rows, id) {
  const seen = /* @__PURE__ */ new Set();
  for (const r of rows) {
    if (isEmpty(r[id])) continue;
    const k = String(r[id]).trim();
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}
var loose2 = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
function resolveSort(sort, by, metrics, names) {
  if (sort === void 0) return names[0];
  const s = sort.trim().replace(/^(["`])(.*)\1$/, "$2");
  const out2 = [...by, ...names];
  const hit = resolveColumn(out2, s);
  if (hit) return hit;
  const on = names.filter((_, i) => metrics[i].col !== void 0 && loose2(metrics[i].col) === loose2(s));
  if (on.length === 1) return on[0];
  throw new Error(`--sort ${s} isn't an output column${on.length > 1 ? ` (${s} has ${on.length} metrics: ${on.join(", ")})` : ""}. Sort by one of: ${out2.join(", ")}`);
}
var list8 = (vs) => vs.slice(0, 8).join(", ") + (vs.length > 8 ? ", \u2026" : "");
var argOf = (s) => /^[\w.$#,-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
function baseSubsNote(cols, cur, tail) {
  const u = [...new Set(cols)];
  return `${u.join(", ")} ${u.length > 1 ? "are" : "is"} in each subsidiary's base currency and the rows span ${cur.subsidiaries} subsidiaries (${cur.subsidiary}): ${tail}`;
}
function aggregate(rows, spec) {
  const metrics = spec.metrics.length ? spec.metrics : [{ fn: "count" }];
  const names = metrics.map((m) => m.col ? `${m.fn}_${m.col}` : m.fn);
  const kinds = metrics.map((m) => m.col && m.fn !== "count" ? metricKind(rows, m.col, spec.types) : "num");
  metrics.forEach((m, i) => m.col && checkMetric(m.fn, m.col, kinds[i], rows));
  const addCols = metrics.filter((m) => (m.fn === "sum" || m.fn === "avg") && m.col).map((m) => m.col);
  if (addCols.length) checkReportLevels(rows, addCols, "a sum");
  const sortCol = resolveSort(spec.sort, spec.by, metrics, names);
  const allCols = Object.keys(rows[0] ?? {});
  const cur = currencyCheck(allCols, rows);
  const unknownCols = cur.unknownColumns;
  const curOf = currencyOf(cur.column);
  const repeats = headerRepeats(allCols, rows);
  const numeric = (k) => k === "num" || k === "id";
  const groups = /* @__PURE__ */ new Map();
  const newAcc = () => metrics.map(() => ({ sum: 0, n: 0, min: void 0, max: void 0, currencies: /* @__PURE__ */ new Set(), rows: [], skipped: 0 }));
  const totalAcc = newAcc();
  for (const r of rows) {
    const keyVals = spec.by.map((b) => r[b]);
    const k = JSON.stringify(keyVals);
    let g = groups.get(k);
    if (!g) {
      g = { key: Object.fromEntries(spec.by.map((b, i) => [b, keyVals[i]])), acc: newAcc() };
      groups.set(k, g);
    }
    const c = curOf(r);
    metrics.forEach((m, i) => {
      for (const a of [g.acc[i], totalAcc[i]]) {
        if (m.fn === "count" && !m.col) {
          a.n++;
          continue;
        }
        const raw = r[m.col];
        if (m.fn === "count") {
          if (!isEmpty(raw)) a.n++;
          continue;
        }
        const v = isEmpty(raw) ? void 0 : numeric(kinds[i]) ? toNumber(raw) : kinds[i] === "date" ? dateKey(String(raw).trim()) : String(raw);
        if (v === void 0) {
          if (!isEmpty(raw)) a.skipped++, a.bad ??= String(raw).trim().slice(0, 30);
          continue;
        }
        if (c !== void 0) a.currencies.add(c);
        a.rows.push(r);
        a.n++;
        if (typeof v === "number") a.sum += v;
        if (a.min === void 0 || v < a.min) a.min = v;
        if (a.max === void 0 || v > a.max) a.max = v;
      }
    });
  }
  const finish = (acc) => Object.fromEntries(
    metrics.map((m, i) => {
      const a = acc[i];
      const v = m.fn === "count" ? a.n : !a.n ? null : m.fn === "sum" ? a.sum : m.fn === "avg" ? a.sum / a.n : m.fn === "min" ? a.min : a.max;
      return [names[i], v];
    })
  );
  const money2 = metrics.filter((m, i) => m.col && m.fn !== "count" && kinds[i] === "num" && isCurrencyBearing(m.col));
  const adds = money2.filter((m) => m.fn === "sum" || m.fn === "avg");
  const mixed = cur.values.length > 1;
  const na = (n) => `n/a (${n} currencies)`;
  let out2 = [...groups.values()].map((g) => {
    const row = { ...g.key, ...finish(g.acc) };
    metrics.forEach((m, i) => {
      if (m.fn !== "sum" && m.fn !== "avg" || !m.col) return;
      const a = g.acc[i];
      if (!a.n) return;
      const rid = repeats.get(m.col);
      if (adds.includes(m) && a.currencies.size > 1) row[names[i]] = na(a.currencies.size);
      else if (adds.includes(m) && unknownCols.includes(m.col)) {
        const chk = currencyCheck(allCols, a.rows);
        if (chk.unknownColumns.includes(m.col)) row[names[i]] = `n/a (${unknownLabel(chk, m.col)})`;
      }
      if (typeof row[names[i]] === "number" && rid && repeatsIn(a.rows, rid)) row[names[i]] = `n/a (repeats per ${rid})`;
    });
    return row;
  });
  const mi = names.indexOf(sortCol);
  const isNa = (v) => typeof v === "string" && v.startsWith("n/a");
  const sortType = mi >= 0 && kinds[mi] === "date" ? "date" : mi >= 0 && kinds[mi] === "text" ? "str" : out2.every((r) => isEmpty(r[sortCol]) || isNa(r[sortCol]) || toNumber(r[sortCol]) !== void 0) ? "num" : spec.types?.[sortCol] ?? inferType(out2.map((r) => r[sortCol]));
  out2 = sortRows(out2, sortCol, sortType, !!spec.asc);
  if (spec.top) out2 = out2.slice(0, spec.top);
  const totals = finish(totalAcc);
  const warnings = [];
  const hasMinMax = money2.some((m) => m.fn === "min" || m.fn === "max");
  const minmax = hasMinMax ? " min/max compare amounts in different currencies." : "";
  if (money2.length && mixed && cur.column) {
    const grouped = spec.by.some((b) => cur.columns.includes(b));
    const n = cur.values.length;
    const list2 = list8(cur.values);
    for (const m of adds) totals[`${m.fn}_${m.col}`] = grouped ? na(n) : `n/a (${n} currencies mixed in groups; add --by ${cur.column})`;
    if (grouped) {
      if (adds.length) warnings.push(`${cur.column} has ${n} values (${list2}): per-group amounts are fine, the TOTAL isn't.`);
    } else if (!spec.by.length) warnings.push(`the rows are in ${n} currencies (${cur.column}: ${list2}):${adds.length ? " amounts don't add up." : ""}${minmax} Add --by ${cur.column}.`);
    else warnings.push(`${cur.column} has ${n} values (${list2}):${adds.length ? " groups spanning several currencies show n/a." : ""}${minmax} Add ${cur.column} to --by.`);
  }
  const unknownMoney = money2.filter((m) => unknownCols.includes(m.col));
  const baseMoney = unknownMoney.filter((m) => cur.baseAcrossSubs.includes(m.col));
  const foreignUnknown = unknownMoney.filter((m) => !cur.baseAcrossSubs.includes(m.col));
  if (baseMoney.length) {
    const label = `n/a (${cur.subsidiaries} subsidiaries)`;
    for (const m of adds) if (baseMoney.includes(m) && !isNa(totals[`${m.fn}_${m.col}`])) totals[`${m.fn}_${m.col}`] = label;
    const grouped = spec.by.includes(cur.subsidiary);
    const add = baseMoney.some((m) => adds.includes(m));
    const mm = baseMoney.some((m) => m.fn === "min" || m.fn === "max");
    const tail = grouped ? `per-subsidiary amounts are fine, the TOTAL isn't.` : `${add ? spec.by.length ? "groups spanning several subsidiaries show n/a" : "they don't add up" : ""}${add && mm ? "; " : ""}${mm ? "min/max compare amounts in different currencies" : ""}. Group by subsidiary: --by ${argOf([...spec.by, cur.subsidiary].join(","))}.`;
    warnings.push(baseSubsNote(baseMoney.map((m) => m.col), cur, tail));
  }
  if (foreignUnknown.length) {
    for (const m of adds) if (foreignUnknown.includes(m)) totals[`${m.fn}_${m.col}`] = "n/a (currency unknown)";
    const cols = foreignUnknown.map((m) => m.col).filter((c, i, a) => a.indexOf(c) === i).join(", ");
    const unknownMinMax = foreignUnknown.some((m) => m.fn === "min" || m.fn === "max");
    warnings.push(`currency unknown: no currency column, so ${cols} may mix currencies${spec.by.length && adds.length ? "; groups that may span currencies show n/a" : ""}${unknownMinMax ? "; min/max may compare amounts in different currencies" : ""}. Re-run with a currency column (BUILTIN.DF(t.currency) AS currency) and group by it.`);
  }
  const warnedRepeat = /* @__PURE__ */ new Set();
  metrics.forEach((m, i) => {
    if (m.fn !== "sum" && m.fn !== "avg" || !m.col || !repeats.has(m.col)) return;
    const rid = repeats.get(m.col);
    if (!repeatsIn(totalAcc[i].rows, rid)) return;
    if (typeof totals[names[i]] === "number") totals[names[i]] = `n/a (repeats per ${rid})`;
    if (!warnedRepeat.has(m.col)) warnings.push(headerRepeatNote(m.col, rid)), warnedRepeat.add(m.col);
  });
  metrics.forEach((m, i) => {
    const a = totalAcc[i];
    if (a.skipped) warnings.push(`${names[i]}: skipped ${a.skipped} non-numeric value(s) of ${m.col} (e.g. "${a.bad}"); they aren't in the ${m.fn}.`);
  });
  return { columns: [...spec.by, ...names], rows: out2, totals, warnings, warning: warnings.length ? warnings.join("\n\u26A0 ") : void 0 };
}
var currencyOf = (column) => (r) => column === void 0 || isEmpty(r[column]) ? void 0 : String(r[column]).trim();
function pivot(rows, rowCol, colCol, fn, valCol, maxCols = 12, types) {
  const kind = valCol && fn !== "count" ? metricKind(rows, valCol, types) : "num";
  if (valCol) checkMetric(fn, valCol, kind, rows);
  if (valCol && (fn === "sum" || fn === "avg")) checkReportLevels(rows, [valCol], `a ${fn}`);
  const colVals = [...new Set(rows.map((r) => String(r[colCol] ?? "")))].sort();
  const shown = colVals.slice(0, maxCols);
  const overflow = colVals.length > maxCols;
  const res = /* @__PURE__ */ new Map();
  const cells = /* @__PURE__ */ new Map();
  let skipped = 0;
  let bad;
  for (const r of rows) {
    const rk = String(r[rowCol] ?? "");
    let ck = String(r[colCol] ?? "");
    if (!shown.includes(ck)) ck = "(other)";
    if (!res.has(rk)) res.set(rk, { [rowCol]: rk });
    let v = 1;
    if (valCol) {
      const raw = r[valCol];
      if (isEmpty(raw)) continue;
      if (fn !== "count") {
        v = kind === "num" || kind === "id" ? toNumber(raw) : kind === "date" ? dateKey(String(raw).trim()) : String(raw);
        if (v === void 0) {
          skipped++;
          bad ??= String(raw).trim().slice(0, 30);
          continue;
        }
      }
    }
    const key = `${rk}\0${ck}`;
    const cell2 = cells.get(key) ?? { rk, ck, rows: [], n: 0, sum: 0 };
    cells.set(key, cell2);
    cell2.rows.push(r);
    cell2.n++;
    if (typeof v === "number") cell2.sum += v;
    if (cell2.min === void 0 || v < cell2.min) cell2.min = v;
    if (cell2.max === void 0 || v > cell2.max) cell2.max = v;
  }
  for (const c of cells.values()) {
    res.get(c.rk)[c.ck] = fn === "count" ? c.n : fn === "sum" ? c.sum : fn === "avg" ? c.sum / c.n : fn === "min" ? c.min : c.max;
  }
  const warnings = [];
  const adds = fn === "sum" || fn === "avg";
  if (valCol && fn !== "count" && kind === "num" && isCurrencyBearing(valCol) && rows.length) {
    const allCols = Object.keys(rows[0]);
    const cur = currencyCheck(allCols, rows);
    const onAxis = cur.columns.includes(rowCol) || cur.columns.includes(colCol);
    const done = /* @__PURE__ */ new Set();
    if (cur.status === "mixed" && cur.column && !onAxis) {
      const curOf = currencyOf(cur.column);
      let blanked = 0;
      if (adds) {
        for (const c of cells.values()) {
          const k = new Set(c.rows.map(curOf).filter((v) => v !== void 0)).size;
          if (k > 1) {
            res.get(c.rk)[c.ck] = `n/a (${k} currencies)`;
            done.add(c);
            blanked++;
          }
        }
      }
      const n = cur.values.length;
      warnings.push(`${cur.column} has ${n} values (${list8(cur.values)}) and neither --rows nor --cols is ${cur.column}: ${adds ? `${blanked} cell(s) spanning several currencies show n/a` : "min/max compare amounts in different currencies"}. Put ${cur.column} on --rows or --cols, or filter to one currency.`);
    }
    if (cur.unknownColumns.includes(valCol)) {
      let blanked = 0;
      if (adds) {
        for (const c of cells.values()) {
          if (done.has(c)) continue;
          const chk = currencyCheck(allCols, c.rows);
          if (chk.unknownColumns.includes(valCol)) {
            res.get(c.rk)[c.ck] = `n/a (${unknownLabel(chk, valCol)})`;
            done.add(c);
            blanked++;
          }
        }
      }
      if (cur.baseAcrossSubs.includes(valCol)) {
        const subAxis = rowCol === cur.subsidiary || colCol === cur.subsidiary;
        if (!subAxis) warnings.push(baseSubsNote([valCol], cur, `${adds ? `${blanked} cell(s) spanning several subsidiaries show n/a` : "min/max compare amounts in different currencies"}. Put ${cur.subsidiary} on --rows or --cols, or filter to one subsidiary.`));
      } else {
        warnings.push(`currency unknown: no currency column, so ${valCol} may mix currencies${adds ? "; cells that may span currencies show n/a" : " (min/max may compare different currencies)"}. Re-run with a currency column (BUILTIN.DF(t.currency) AS currency) and pivot on it.`);
      }
    }
  }
  if (valCol && adds) {
    const rid = headerRepeats(Object.keys(rows[0] ?? {}), rows).get(valCol);
    if (rid) {
      let hit = 0;
      for (const c of cells.values()) {
        if (typeof res.get(c.rk)[c.ck] === "number" && repeatsIn(c.rows, rid)) res.get(c.rk)[c.ck] = `n/a (repeats per ${rid})`, hit++;
      }
      if (hit) warnings.push(headerRepeatNote(valCol, rid));
    }
  }
  if (skipped) warnings.push(`skipped ${skipped} non-numeric value(s) of ${valCol} (e.g. "${bad}"); they aren't in the ${fn}.`);
  return { columns: [rowCol, ...shown, ...overflow ? ["(other)"] : []], rows: [...res.values()], warnings, warning: warnings.length ? warnings.join("\n\u26A0 ") : void 0 };
}
var REPORT_SKIP = /* @__PURE__ */ new Set(["detail", "structural", "spacer"]);
function outcome(r, c, tol) {
  if (r._presence !== "both") return "changed";
  const d = r[`${c}_delta`];
  const va = r[`${c}_a`];
  const vb = r[`${c}_b`];
  if (typeof d === "number") return Math.abs(d) > tol ? "changed" : "same";
  if (typeof d === "string" || typeof va === "string" || typeof vb === "string") return "incomparable";
  if ((va === null || va === void 0) !== (vb === null || vb === void 0)) return "changed";
  return "same";
}
function diffChanged(r, cols, tol = 0) {
  return (Array.isArray(cols) ? cols : [cols]).some((c) => outcome(r, c, tol) !== "same");
}
function canonKey(v) {
  if (isEmpty(v)) return "";
  if (typeof v === "number") return String(v);
  const t = String(v).trim();
  return /^-?\d+(\.\d+)?$/.test(t) && !/^-?0\d/.test(t) ? String(Number(t)) : t;
}
function diff(a, b, on, cols, opts = {}) {
  const tol = opts.tolerance ?? 0;
  if (!Number.isFinite(tol) || tol < 0) throw new Error(`--tolerance must be a number \u2265 0 (an absolute amount, e.g. 0.01), not ${opts.tolerance}`);
  let key = [...on];
  const notes = [];
  const warnings = [];
  const keyOf = (r) => JSON.stringify(key.map((k) => canonKey(r[k])));
  const repeats = (rows) => {
    const n = /* @__PURE__ */ new Map();
    for (const r of rows) n.set(keyOf(r), (n.get(keyOf(r)) ?? 0) + 1);
    return new Map([...n].filter(([, c]) => c > 1));
  };
  const allRepeats = () => {
    const m = repeats(a);
    for (const [k, c] of repeats(b)) m.set(k, Math.max(c, m.get(k) ?? 0));
    return m;
  };
  const show2 = (k) => JSON.parse(k).map((v) => String(v ?? "")).join(", ");
  const example = (m) => {
    const [k, c] = [...m].sort((x, y) => y[1] - x[1])[0];
    return `"${show2(k)}" \xD7${c}`;
  };
  let rep = allRepeats();
  const report = isReportShape(Object.keys(a[0] ?? b[0] ?? {})) && isReportShape(Object.keys(b[0] ?? a[0] ?? {}));
  if (report && rep.size) {
    const skip = (r) => REPORT_SKIP.has(String(r.kind)) || isEmpty(r.line) && cols.every((c) => isEmpty(r[c]) || r[c] === 0);
    const na = a.filter(skip).length;
    const nb = b.filter(skip).length;
    a = a.filter((r) => !skip(r));
    b = b.filter((r) => !skip(r));
    notes.push(`report rows: left out ${na} (a) and ${nb} (b) detail/structural/spacer rows, which repeat a line's name; the section and account lines carry the values.`);
    rep = allRepeats();
    if (rep.size && !key.includes("depth")) {
      key = [...key, "depth"];
      notes.push(`'${on.join(",")}' still repeats among report lines, so rows are keyed on ${key.join(",")}.`);
      rep = allRepeats();
    }
    if (rep.size) {
      throw new Error(`key '${key.join(",")}' isn't unique among the report lines: ${rep.size} keys repeat (e.g. ${example(rep)}). Diffing would add nested rows together; narrow both sides with --where or add a key column.`);
    }
  }
  if (rep.size) warnings.push(`key '${key.join(",")}' isn't unique: ${rep.size} keys repeat (e.g. ${example(rep)}); values were summed \u2014 use a unique key or --on a,b`);
  for (const c of cols) {
    const present2 = [...a, ...b].map((r) => r[c]).filter((v) => !isEmpty(v));
    const bad = present2.filter((v) => toNumber(v) === void 0);
    if (present2.length && bad.length === present2.length) throw new Error(`diff --cols compares numbers; "${c}" is text (e.g. "${String(bad[0]).trim().slice(0, 30)}"): put it in --on to match on it, or compare with results filter`);
    if (bad.length) warnings.push(`${c}: skipped ${bad.length} non-numeric value(s) (e.g. "${String(bad[0]).trim().slice(0, 30)}"); they aren't compared.`);
  }
  const money2 = report ? [] : cols.filter(isCurrencyBearing);
  const checkOf = (rows) => currencyCheck(Object.keys(rows[0] ?? {}), rows);
  const curA = checkOf(a);
  const curB = checkOf(b);
  const curCol = curA.column ?? curB.column;
  const keyed = [...curA.columns, ...curB.columns].some((c) => key.includes(c));
  const sums = (rows, cur) => {
    const curOf = currencyOf(cur.column);
    const keepRows = money2.length > 0 && cur.unknownColumns.length > 0;
    const m = /* @__PURE__ */ new Map();
    for (const r of rows) {
      const k = keyOf(r);
      const e = m.get(k) ?? { key: Object.fromEntries(key.map((o) => [o, r[o]])), v: cols.map(() => null), currencies: /* @__PURE__ */ new Set(), rows: [] };
      let valued = false;
      cols.forEach((c, i) => {
        const n = toNumber(r[c]);
        if (n === void 0) return;
        e.v[i] = (e.v[i] ?? 0) + n;
        if (money2.includes(c)) valued = true;
      });
      if (valued) {
        const c = curOf(r);
        if (c !== void 0) e.currencies.add(c);
        if (keepRows) e.rows.push(r);
      }
      m.set(k, e);
    }
    return m;
  };
  const A = sums(a, curA);
  const B = sums(b, curB);
  const allColsA = Object.keys(a[0] ?? {});
  const allColsB = Object.keys(b[0] ?? {});
  let spanning = 0;
  let crossed = 0;
  let unknownKeys = 0;
  const out2 = [];
  for (const k of /* @__PURE__ */ new Set([...A.keys(), ...B.keys()])) {
    const ea = A.get(k);
    const eb = B.get(k);
    const row = { ...ea?.key ?? eb.key };
    const checkEntry = (e, allCols) => e && e.rows.length > 1 ? currencyCheck(allCols, e.rows) : void 0;
    const chkA = checkEntry(ea, allColsA);
    const chkB = checkEntry(eb, allColsB);
    const one = (e) => e && e.currencies.size === 1 ? [...e.currencies][0] : void 0;
    let rowSpans = false;
    let rowCrossed = false;
    let rowUnknown = false;
    cols.forEach((c, i) => {
      let va = ea ? ea.v[i] : null;
      let vb = eb ? eb.v[i] : null;
      let blankDelta = false;
      if (money2.includes(c)) {
        if (va === null) {
        } else if (ea && ea.currencies.size > 1) va = `n/a (${ea.currencies.size} currencies)`, rowSpans = true;
        else if (chkA?.unknownColumns.includes(c)) va = `n/a (${unknownLabel(chkA, c)})`, rowUnknown = true;
        if (vb === null) {
        } else if (eb && eb.currencies.size > 1) vb = `n/a (${eb.currencies.size} currencies)`, rowSpans = true;
        else if (chkB?.unknownColumns.includes(c)) vb = `n/a (${unknownLabel(chkB, c)})`, rowUnknown = true;
        const ca = one(ea);
        const cb = one(eb);
        if (typeof va === "number" && typeof vb === "number" && ca !== void 0 && cb !== void 0 && ca !== cb) blankDelta = true, rowCrossed = true;
      }
      row[`${c}_a`] = va;
      row[`${c}_b`] = vb;
      if (typeof va === "string" || typeof vb === "string") {
        row[`${c}_delta`] = null;
        row[`${c}_pct`] = null;
      } else if (blankDelta) {
        row[`${c}_delta`] = `n/a (${one(ea)} vs ${one(eb)})`;
        row[`${c}_pct`] = null;
      } else {
        row[`${c}_delta`] = va !== null && vb !== null ? vb - va : null;
        row[`${c}_pct`] = va === null || vb === null ? null : Math.abs(va) < 1 ? "n/a" : Math.round((vb - va) / Math.abs(va) * 1e3) / 10;
      }
    });
    if (rowSpans) spanning++;
    if (rowCrossed) crossed++;
    if (rowUnknown) unknownKeys++;
    row._presence = ea && eb ? "both" : ea ? "only_a" : "only_b";
    out2.push(row);
  }
  if (money2.length && !keyed && (spanning || crossed)) {
    const values = [.../* @__PURE__ */ new Set([...curA.values, ...curB.values])].sort();
    const what = [spanning ? `${spanning} key(s) spanning several currencies show n/a` : "", crossed ? `${crossed} key(s) in a different currency on each side show an n/a delta` : ""].filter(Boolean).join("; ");
    warnings.push(`${curCol} has ${values.length} values (${list8(values)}): ${what}. Add ${curCol} to --on.`);
  }
  if (money2.length && unknownKeys) {
    const base = money2.filter((c) => curA.baseAcrossSubs.includes(c) || curB.baseAcrossSubs.includes(c));
    const foreign = money2.filter((c) => !base.includes(c) && (curA.unknownColumns.includes(c) || curB.unknownColumns.includes(c)));
    const sub = curA.subsidiary ?? curB.subsidiary;
    if (base.length) warnings.push(`${base.join(", ")} ${base.length > 1 ? "are" : "is"} in each subsidiary's base currency and keys span several subsidiaries (${sub}): those keys show n/a. Add ${sub} to --on.`);
    if (foreign.length) warnings.push(`currency unknown: no currency column, so ${foreign.join(", ")} may mix currencies; ${unknownKeys} key(s) that may span currencies show n/a. Re-run with a currency column (BUILTIN.DF(t.currency) AS currency) and add it to --on.`);
  }
  const rc = opts.reportCurrency;
  if (report && rc?.a && rc.b && rc.a.toUpperCase() !== rc.b.toUpperCase()) {
    const vs = `n/a (${rc.a} vs ${rc.b})`;
    for (const r of out2) {
      if (r._presence !== "both") continue;
      for (const c of cols) r[`${c}_delta`] = vs, r[`${c}_pct`] = vs;
    }
    warnings.push(`a is in ${rc.a}, b is in ${rc.b}: the figures are shown side by side, with no delta. Diff reports run in the same currency (subsidiaries that share one, or both consolidated).`);
  }
  const counts = { changed: 0, incomparable: 0, same: 0 };
  for (const r of out2) {
    const o = cols.map((c) => outcome(r, c, tol));
    counts[o.includes("changed") ? "changed" : o.includes("incomparable") ? "incomparable" : "same"]++;
  }
  const mag = (r) => Math.max(
    -1,
    ...cols.map((c) => {
      const v = [r[`${c}_delta`], r[`${c}_a`], r[`${c}_b`]].find((x) => typeof x === "number");
      return typeof v === "number" ? Math.abs(v) : -1;
    })
  );
  out2.sort((x, y) => mag(y) - mag(x));
  return {
    columns: [...key, ...cols.flatMap((c) => [`${c}_a`, `${c}_b`, `${c}_delta`, `${c}_pct`]), "_presence"],
    rows: out2,
    on: key,
    notes,
    warnings,
    warning: warnings.length ? warnings.join("\n\u26A0 ") : void 0,
    counts
  };
}

// src/results/summary.ts
var LIST_TOOLS = /* @__PURE__ */ new Set(["ns_runCustomSuiteQL", "ns_runSavedSearch"]);
function sqlRowCap(sql) {
  let cap;
  for (const m of sql.matchAll(/rownum\s*(<=|<|=)\s*(\d+)/gi)) {
    const n = m[1] === "<" ? Number(m[2]) - 1 : Number(m[2]);
    cap = cap === void 0 ? n : Math.min(cap, n);
  }
  const f = /fetch\s+(?:first|next)\s+(\d+)\s+rows?/i.exec(sql);
  if (f) cap = cap === void 0 ? Number(f[1]) : Math.min(cap, Number(f[1]));
  return cap;
}
function maskSql(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, (m) => "'" + " ".repeat(Math.max(0, m.length - 2)) + "'").replace(/--[^\n]*/g, (m) => " ".repeat(m.length)).replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
}
function depths(s) {
  const out2 = [];
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === ")") d--;
    out2.push(d);
    if (s[i] === "(") d++;
  }
  return out2;
}
var NOT_ALIAS = /^(where|join|left|right|inner|outer|full|cross|order|group|having|on|fetch|offset|union|minus|intersect|start|connect)$/i;
function pagingKeyHint(sql) {
  const m = maskSql(sql);
  const d = depths(m);
  let order;
  for (const hit of m.matchAll(/\border\s+by\s+/gi)) {
    if (d[hit.index] !== 0) continue;
    const start = hit.index + hit[0].length;
    let end = start;
    while (end < m.length && d[end] >= 0 && !(d[end] === 0 && /^(fetch|offset)\b|^;/i.test(m.slice(end)))) end++;
    order = sql.slice(start, end).replace(/\s+/g, " ").trim();
  }
  let alias;
  for (const hit of m.matchAll(/\bfrom\s+/gi)) {
    if (d[hit.index] !== 0) continue;
    let rest = hit.index + hit[0].length;
    if (m[rest] === "(") {
      while (rest < m.length && !(m[rest] === ")" && d[rest] === 0)) rest++;
      rest++;
    } else rest += /^[a-z_][\w.]*/i.exec(m.slice(rest))?.[0].length ?? 0;
    const a = /^\s+(?:as\s+)?([a-z_]\w*)/i.exec(m.slice(rest));
    if (a && !NOT_ALIAS.test(a[1])) alias = a[1];
    break;
  }
  const key = alias ? `${alias}.id` : "id";
  if (order) {
    const shown = order.length > 60 ? `${order.slice(0, 57)}\u2026` : order;
    return /\bid\b/i.test(order) ? `keep the same unique ORDER BY (${shown})` : `keep a unique ORDER BY, e.g. ${shown}, ${key}`;
  }
  return `add a unique ORDER BY, e.g. ${key}`;
}
function detectTruncation(tool, input, rowCount, ex) {
  if (LIST_TOOLS.has(tool) && ex) {
    const total = ex.totalResults;
    if (ex.hasMore || total !== void 0 && total > rowCount) {
      const of = total !== void 0 ? ` (${fmtNum(rowCount)} of ${fmtNum(total)} rows)` : "";
      if (tool === "ns_runSavedSearch") {
        const end = Number(input.range_end);
        return `the connector reports more rows${of}: this is one slice, not the full result. Next slice: same call with range_start: ${Number.isFinite(end) ? end : rowCount}`;
      }
      const idx = ex.pageIndex ?? (Number.isFinite(Number(input.pageIndex)) ? Number(input.pageIndex) : 0);
      const pages = ex.numberOfPages !== void 0 ? ` of ${fmtNum(ex.numberOfPages)}` : "";
      return `this is page ${idx + 1}${pages}${of}, not the full result. More pages: re-run with pageIndex: ${idx + 1} (same sqlQuery and pageSize; ${pagingKeyHint(String(input.sqlQuery ?? ""))}), or aggregate in SuiteQL instead; to combine pages you've fetched, run nsx results concat <id> <id> \u2026 (it checks for missing pages) before agg`;
    }
  }
  if (!rowCount) return void 0;
  if (tool === "ns_runCustomSuiteQL") {
    const cap = sqlRowCap(String(input.sqlQuery ?? ""));
    if (cap !== void 0 && rowCount === cap) return `result hit the ROWNUM/FETCH cap (${cap})`;
  }
  if (tool === "ns_runSavedSearch") {
    const start = Number(input.range_start ?? 0);
    const end = Number(input.range_end);
    if (Number.isFinite(end) && rowCount >= end - start) return `result hit range_end (${end}) \u2014 likely more rows`;
  }
  return void 0;
}
function describeCol(p) {
  if (p.type === "num") {
    const parts = p.sumNa ? [`sum n/a: ${p.sumNa}`] : p.sum !== void 0 ? [`sum ${fmtValue(p.sum, p.name)}`] : [];
    if (p.min !== void 0) parts.push(`min ${fmtValue(p.min, p.name)}`, `max ${fmtValue(p.max, p.name)}`);
    if (p.nulls) parts.push(`nulls ${p.nulls}`);
    return `${p.name}(num, ${parts.join(", ")})`;
  }
  if (p.type === "date") return `${p.name}(date ${p.min}..${p.max}${p.nulls ? `, nulls ${p.nulls}` : ""})`;
  return `${p.name}(${p.type}, ${fmtNum(p.distinct)} distinct${p.nulls ? `, nulls ${p.nulls}` : ""})`;
}
function wrap(items, width, indent) {
  const lines = [];
  let cur = "";
  for (const it of items) {
    if (cur && cur.length + 1 + it.length > width) {
      lines.push(cur);
      cur = indent + it;
    } else cur = cur ? `${cur} ${it}` : it;
  }
  if (cur) lines.push(cur);
  return lines;
}
var arg = (s) => /^[\w.$#,-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
function nextHint(meta, profiles, h) {
  const measure = profiles.find((p) => p.type === "num" && isHintMetric(p.name) && !idLikeName(p.name) && !p.sumNa?.startsWith("repeats per"));
  const dim = profiles.find((p) => p.type === "str" && p.name !== h.currency && p.distinct > 1 && p.distinct <= meta.rowCount / 2);
  if (measure && h.unknownAmounts.includes(measure.name)) {
    const redo = `to sum ${arg(measure.name)}, re-run with BUILTIN.DF(t.currency) AS currency`;
    return dim ? `nsx results agg ${meta.id} --by ${arg(dim.name)} --count --top 20   (${redo})` : `nsx results schema ${meta.id}   (${redo})`;
  }
  if (measure && h.subsidiary && h.baseAmounts.includes(measure.name)) {
    const by = [h.subsidiary, h.currency].filter((c, i, a) => c && a.indexOf(c) === i).join(",");
    return `nsx results agg ${meta.id} --by ${arg(by)} --sum ${arg(measure.name)} --top 20`;
  }
  if (measure && (dim || h.currency)) {
    const by = [dim?.name, h.currency].filter(Boolean).join(",");
    return `nsx results agg ${meta.id} --by ${arg(by)} --sum ${arg(measure.name)} --top 20`;
  }
  return `nsx results head ${meta.id} 20   \xB7   nsx results schema ${meta.id}`;
}
function buildSummary({ meta, rows, columns, budget = 1400, reportCurrency }) {
  if (meta.tool === "ns_runReport" && columns.includes("depth") && columns.includes("line")) return reportSummary({ meta, rows, columns, budget, reportCurrency });
  const profiles = profileColumns(columns, rows);
  const cur = currencyCheck(columns, rows);
  const repeats = headerRepeats(columns, rows);
  const rel = `results/${meta.session}/${meta.files.csv.split("/").pop()}`;
  const took = meta.tookMs !== void 0 ? `   Took: ${(meta.tookMs / 1e3).toFixed(1)}s` : "";
  const foreignUnknown = cur.unknownColumns.filter((c) => !cur.baseAcrossSubs.includes(c));
  const warnLines = [];
  if (cur.status === "mixed" && cur.column) {
    warnLines.push(`Mixed currencies in ${cur.column} (${truncate(cur.values.join(", "), 60)}): amounts don't add across rows and min/max compare different currencies; group by ${cur.column}.`);
  }
  if (cur.baseAcrossSubs.length) {
    const cols = truncate(cur.baseAcrossSubs.join(", "), 60);
    warnLines.push(`Several subsidiaries: ${cols} ${cur.baseAcrossSubs.length > 1 ? "are" : "is"} in each subsidiary's base currency across ${cur.subsidiaries} subsidiaries (${cur.subsidiary}), so a total mixes currencies; group by ${cur.subsidiary}.`);
  }
  if (foreignUnknown.length) {
    warnLines.push(`Currency unknown: no currency column beside ${truncate(foreignUnknown.join(", "), 60)}, so a total may mix currencies. Add one (BUILTIN.DF(t.currency) AS currency) and group by it.`);
  }
  for (const p of profiles) if (p.sumNa?.startsWith("repeats per") && repeats.has(p.name)) warnLines.push(`Double count: ${headerRepeatNote(p.name, repeats.get(p.name))}`);
  const tailLines = [];
  if (meta.truncated) tailLines.push(`Truncation warning: ${meta.truncated} \u2014 totals may be incomplete.`);
  tailLines.push(
    `Next: ${nextHint(meta, profiles, {
      currency: cur.status === "mixed" ? cur.column : void 0,
      unknownAmounts: foreignUnknown,
      baseAmounts: cur.baseAcrossSubs,
      subsidiary: cur.subsidiary
    })}`
  );
  const attempt = (sampleRows, cell2, detailed, queryMax, maxCols = columns.length) => {
    const lines = [];
    lines.push(`[su-ns-harness] ${fmtNum(meta.rowCount)} rows \xD7 ${columns.length} cols saved \u2192 ${rel} (id ${meta.id})`);
    lines.push(`Query: ${truncate(meta.query, queryMax)}   Source: ${meta.tool}${took}`);
    const cols = (detailed ? profiles.map(describeCol) : profiles.map((p) => `${p.name}(${p.type})`)).slice(0, maxCols);
    if (maxCols < columns.length) cols.push(`\u2026 ${columns.length - maxCols} more cols (nsx results schema ${meta.id})`);
    lines.push(...wrap(cols, 110, "         ").map((l, i) => i === 0 ? `Columns: ${l}` : l));
    lines.push(...warnLines);
    if (sampleRows > 0 && rows.length) {
      lines.push(`First ${Math.min(sampleRows, rows.length)} rows:`);
      lines.push(columns.map((c) => csvCell(truncate(c, cell2))).join(","));
      for (const r of rows.slice(0, sampleRows)) {
        lines.push(columns.map((c) => csvCell(r[c] === null || r[c] === void 0 ? "" : truncate(String(r[c]), cell2))).join(","));
      }
    }
    lines.push(...tailLines);
    return lines.join("\n");
  };
  const plans = [
    [5, 24, true, 240],
    [3, 18, true, 160],
    [2, 14, true, 120],
    [2, 12, false, 100],
    [0, 12, false, 80]
  ];
  let text = "";
  for (const p of plans) {
    text = attempt(...p);
    if (text.length <= budget) return text;
  }
  for (let n = columns.length - 1; n >= 0; n--) {
    text = attempt(0, 12, false, n ? 80 : 60, n);
    if (text.length <= budget) return text;
  }
  return text;
}
function reportSummary({ meta, rows, columns, budget = 1400, reportCurrency }) {
  const rel = `results/${meta.session}/${meta.files.csv.split("/").pop()}`;
  const took = meta.tookMs !== void 0 ? `   Took: ${(meta.tookMs / 1e3).toFixed(1)}s` : "";
  const valueCols = columns.filter((c) => !["line", "depth", "is_detail", "kind"].includes(c));
  const hasKind = columns.includes("kind");
  const sections = rows.filter((r) => hasKind ? r.kind === "section" : r.depth === 0 && r.is_detail !== true && r.line !== null);
  const val = (v) => typeof v === "number" ? fmtValue(v) : v === null || v === void 0 || v === "" ? "\u2013" : String(v);
  const levels = rows.map((r) => Number(r.depth)).filter((n) => Number.isFinite(n) && n >= 0);
  const maxDepth = levels.length ? Math.max(...levels) : 0;
  const structural = rows.some((r) => r.kind === "structural");
  const spacer = rows.some((r) => r.kind === "spacer");
  const v0 = valueCols[0];
  const hint = `nsx results filter ${meta.id} --where "depth>=0 and depth<=1 and is_detail=false${spacer ? " and kind!=spacer" : ""}"${v0 ? ` --cols ${arg(["line", "depth", ...valueCols.length <= 8 ? valueCols : [...valueCols.slice(0, 3), valueCols[valueCols.length - 1]]].join(","))}` : ""}`;
  const pnl = sections.some((r) => /profit|loss|income|expense|sales|revenue|purchases|overheads/i.test(String(r.line)));
  const signNote = pnl ? sectionSignNote(rows, v0) : "";
  let input = {};
  try {
    const q = JSON.parse(meta.query);
    if (q && typeof q === "object" && !Array.isArray(q)) input = q;
  } catch {
  }
  const range = input.range !== void 0 && input.range !== null && input.range !== "" && valueCols.length <= 1 ? String(input.range) : void 0;
  const query = reportQuery(meta.query, input);
  const aging = /aging/i.test(meta.report?.title ?? "");
  const notes = [];
  const same = meta.report?.columns ? identicalReportColumns(rows, meta.report.columns.filter((c) => valueCols.includes(c.name))) : [];
  if (same.length) {
    const pairs = same.slice(0, 3).map(([a, b]) => `${a} = ${b}`).join(", ");
    notes.push(`Warning: columns ${pairs}${same.length > 3 ? ", \u2026" : ""} hold the same value on every row though NetSuite sent them as different columns; check the raw response (nsx results raw ${meta.id} --head 40) before using them.`);
  }
  for (const n of meta.report?.notes ?? []) notes.push(n);
  for (const r of sections) {
    const m = /^-\s*No\s+(.+?)\s*-$/i.exec(String(r.line ?? "").trim());
    if (m) notes.push(`"${String(r.line).trim()}" holds ${aging ? "open items" : "lines"} with no ${m[1].toLowerCase()}; it is not a ${m[1].toLowerCase()}.`);
  }
  const attempt = (maxSections, queryMax, inline) => {
    const lines = [];
    lines.push(`[su-ns-harness] Report: ${fmtNum(meta.rowCount)} lines (depth 0-${maxDepth}) \xD7 ${valueCols.length} value cols saved \u2192 ${rel} (id ${meta.id})`);
    lines.push(`Query: ${truncate(query, queryMax)}   Source: ${meta.tool}${took}`);
    const shown = maxSections >= sections.length ? sections : maxSections > 1 ? [...sections.slice(0, maxSections - 1), sections[sections.length - 1]] : sections.slice(0, maxSections);
    const cut = sections.length - shown.length;
    const more = `  \u2026 ${cut} more section${cut === 1 ? "" : "s"}`;
    if (valueCols.length <= 1) {
      const items = shown.map((r, i) => `${String(r.line)} ${val(v0 ? r[v0] : void 0)}${i < shown.length - 1 ? " \xB7" : ""}`);
      lines.push(...wrap(items, 110, "  ").map((l, i) => i === 0 ? `Sections${v0 ? ` (${v0})` : ""}: ${l}` : l));
    } else if (inline) {
      lines.push("Sections:");
      shown.forEach((r, i) => {
        if (cut && maxSections > 1 && i === shown.length - 1) lines.push(more);
        lines.push(`  ${truncate(String(r.line), 40)}: ${valueCols.map((c) => `${c} ${val(r[c])}`).join(" | ")}`);
      });
    } else {
      lines.push(`Sections (${truncate(valueCols.join(" | "), 120)}):`);
      shown.forEach((r, i) => {
        if (cut && maxSections > 1 && i === shown.length - 1) lines.push(more);
        lines.push(`  ${truncate(String(r.line), 40)}: ${valueCols.map((c) => val(r[c])).join(" | ")}`);
      });
    }
    if (cut && (valueCols.length <= 1 || maxSections <= 1)) lines.push(more);
    if (!sections.length) lines.push("No section lines found.");
    lines.push(`Rows nest by depth (sections > groups > accounts > detail lines); don't sum a value column across rows, it double-counts subtotals.${structural ? " The kind=structural row (depth -1) is NetSuite's container row, not a grand total." : ""}`);
    lines.push(reportCurrency ? `Amounts are in ${reportCurrency.code} (${reportCurrency.label}).` : "Amounts are in the report currency (the parent subsidiary's for consolidated reports).");
    if (signNote) lines.push(signNote);
    lines.push(...notes);
    if (range) lines.push(`range "${truncate(range, 30)}" had no effect. Accepted values (lowercase): month, quarter.`);
    if (meta.truncated) lines.push(`Truncation warning: ${meta.truncated} \u2014 totals may be incomplete.`);
    lines.push(`Next: ${hint}`);
    return lines.join("\n");
  };
  let text = "";
  for (const q of [300, 160, 100, 60]) {
    for (let n = Math.min(sections.length, 40); n >= 0; n--) {
      for (const inline of valueCols.length > 1 ? [true, false] : [false]) {
        text = attempt(n, q, inline);
        if (text.length <= budget) return text;
      }
    }
  }
  return text;
}
var REPORT_KEYS = ["reportId", "range", "subsidiaryId", "book", "book2", "accountingContext", "nexusId", "taxCashBasisMode", "periodEndTransactionReportMode", "dateFrom", "dateTo"];
function reportQuery(query, input) {
  const keys = Object.keys(input);
  if (!keys.length) return query;
  const ordered = [...REPORT_KEYS.filter((k) => k in input), ...keys.filter((k) => !REPORT_KEYS.includes(k))];
  return JSON.stringify(Object.fromEntries(ordered.map((k) => [k, input[k]])));
}
function sectionSignNote(rows, col2) {
  const base = "Account lines carry their P&L sign (income +, expense \u2212)";
  if (!col2) return `${base}.`;
  const flipped = [];
  let matched = 0;
  let neither = 0;
  const skip = (r) => r.kind === "spacer" || r.kind === "detail" || r.is_detail === true;
  const depthOf = (r) => Number(r.depth);
  const lineSign = /* @__PURE__ */ new Map();
  const found = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (skip(r) || r.kind === "structural") continue;
    const d = depthOf(r);
    const value = toNumber(r[col2]);
    if (!Number.isFinite(d) || d < 0 || value === void 0) continue;
    lineSign.set(i, value);
    let sum = 0;
    let signed = 0;
    let n = 0;
    for (let j = i + 1; j < rows.length && !(depthOf(rows[j]) <= d); j++) {
      const c = rows[j];
      if (depthOf(c) !== d + 1 || skip(c)) continue;
      const v = toNumber(c[col2]);
      if (v === void 0) continue;
      sum += v;
      signed += lineSign.get(j) ?? v;
      n++;
    }
    if (!n || Math.abs(sum) < 5e-3) continue;
    const tol = Math.max(0.01, Math.abs(sum) * 1e-6);
    if (Math.abs(value + sum) <= tol && Math.abs(value - signed) > tol) {
      found.push(String(r.line));
      lineSign.set(i, -value);
    } else if (Math.abs(value - sum) <= tol || Math.abs(value - signed) <= tol) matched++;
    else neither++;
  }
  flipped.push(...found.reverse());
  const names = [...new Set(flipped)];
  if (names.length) {
    const shown = names.length > 5 ? `${names.slice(0, 5).join(", ")}, \u2026` : names.join(", ");
    return `${base}; these sections show the opposite sign of their account lines (positive = net expense, negative = net credit): ${shown}.`;
  }
  if (matched && !neither) return `${base}; section totals match the sign of their lines.`;
  return `${base}; expense sections are shown with the opposite sign of their account lines (positive = net expense, negative = net credit).`;
}
function sourceFooter(tool, input, rowCount, truncated) {
  const what = tool === "ns_runCustomSuiteQL" ? `SuiteQL "${truncate(String(input.sqlQuery ?? ""), 80)}"` : tool === "ns_runReport" ? `report ${input.reportId ?? "?"}${input.dateFrom ? ` ${input.dateFrom}..${input.dateTo ?? ""}` : ""}${input.subsidiaryId ? ` sub ${input.subsidiaryId}` : ""}` : tool === "ns_runSavedSearch" ? `saved search ${input.searchId ?? "?"}` : tool === "ns_getRecord" ? `${input.recordType ?? "record"} ${input.recordId ?? ""}` : tool;
  const time = (/* @__PURE__ */ new Date()).toTimeString().slice(0, 5);
  const parts = [`[su-ns-harness] Source: ${what} \xB7 pulled ${time}`];
  if (rowCount !== void 0) parts.push(`${rowCount} rows`);
  if (truncated) parts.push(`\u26A0 ${truncated}`);
  return parts.join(" \xB7 ");
}

// src/hooks/post.ts
var SHAPED = /* @__PURE__ */ new Set(["ns_runCustomSuiteQL", "ns_runSavedSearch", "ns_runReport", "ns_getRecord"]);
var PROFILE_SECTIONS = /^(subsidiaries|books|periods|probe\/)/;
function queryLabel(tool, input) {
  if (tool === "ns_runCustomSuiteQL") return String(input.sqlQuery ?? "");
  return canonicalJson(input);
}
function postOut(ctxLines, replacement) {
  if (!ctxLines.length && replacement === void 0) return void 0;
  const hso = { hookEventName: "PostToolUse" };
  if (replacement !== void 0) hso.updatedMCPToolOutput = replacement;
  if (ctxLines.length) hso.additionalContext = ctxLines.join("\n");
  return { json: { hookSpecificOutput: hso } };
}
function unparsedNote(section, label, text, json) {
  const keys = json && typeof json === "object" && !Array.isArray(json) ? Object.keys(json).slice(0, 5).join(", ") : Array.isArray(json) ? "(array)" : "(not JSON)";
  return truncate(`[su-ns-harness] Stored ${label} (${fmtNum(text.length)} chars, keys: ${keys}) raw, but couldn't parse it; kept out of context. Inspect: nsx cache show ${section}. Please report the format.`, 300);
}
function looseDateNote(text) {
  let example;
  let twelve = false;
  for (const m of text.matchAll(/"(\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?)?)\\?"/gi)) {
    const n = normaliseDateValue(m[1]);
    if (n === void 0 || n === m[1]) continue;
    const ampm = /[ap]\.?m\.?$/i.test(m[1]);
    if (!example || ampm && !twelve) example = [m[1], n];
    twelve ||= ampm;
    if (twelve) break;
  }
  if (!example) return void 0;
  return `[su-ns-harness] Dates are ${twelve ? "12-hour, " : ""}unpadded (${example[0]} = ${example[1]}).`;
}
function flaggedColumns(ctx, session, toolUseId) {
  if (!toolUseId) return void 0;
  const state = loadState(ctx.data, session);
  if (!state.unknownCols?.[toolUseId]) return void 0;
  const cols = takeUnknownCols(state, toolUseId);
  saveState(ctx.data, session, state);
  return cols;
}
function cachedSearchRecordType(acctDir, searchId, errorId) {
  const ix = readIndex(acctDir, "searches");
  const [id, rt] = [ix.header.indexOf("id"), ix.header.indexOf("recordtype")];
  if (id < 0 || rt < 0) return void 0;
  const want = [String(searchId ?? ""), errorId ?? "", errorId ? `customsearch${errorId}` : ""].map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const w of want) {
    const r = ix.rows.find((row) => (row[id] ?? "").toLowerCase() === w);
    if (r?.[rt]) return r[rt];
  }
  return void 0;
}
function normaliseFields(f) {
  const parts = Array.isArray(f) ? f.map((x) => String(x ?? "")) : typeof f === "string" ? f.split(",") : void 0;
  if (!parts) return void 0;
  return parts.map((x) => x.trim()).filter(Boolean).join(",");
}
function missingRecordFields(fields, json) {
  const want = normaliseFields(fields);
  if (!want || want === "*" || want === "[full]") return [];
  const o = json;
  const rec = o && typeof o === "object" && !Array.isArray(o) ? o.data && typeof o.data === "object" && !Array.isArray(o.data) ? o.data : o : void 0;
  if (!rec) return [];
  const have = new Set(Object.keys(rec).map((k) => k.toLowerCase()));
  return want.split(",").filter((f) => !f.includes(".") && !have.has(f.toLowerCase()));
}
function missingFieldsNote(ctx, type, missing) {
  const ix = ctx.acctDir && type !== "<type>" ? readIndex(ctx.acctDir, `recordmeta/${type}`) : void 0;
  const col2 = ix ? ix.header.indexOf("field") : -1;
  if (!ix || col2 < 0 || !ix.rows.length) {
    return `[su-ns-harness] Requested but not in the record: ${missing.join(", ")}. NetSuite leaves out empty fields, and a misspelled name gives no error: check names with nsx fields ${type} --record before saying the record has no value.`;
  }
  const known = new Set(ix.rows.map((r) => (r[col2] ?? "").toLowerCase()));
  const bad = missing.filter((f) => !known.has(f.toLowerCase()));
  const empty = missing.filter((f) => known.has(f.toLowerCase()));
  const parts = [];
  if (bad.length) parts.push(`${bad.join(", ")}: not ${bad.length > 1 ? "fields" : "a field"} of ${type} (check the name: nsx fields ${type} --record --grep <term>)`);
  if (empty.length) parts.push(`${empty.join(", ")}: ${empty.length > 1 ? "fields" : "a field"} of ${type}, empty on this record (NetSuite leaves out empty fields)`);
  return `[su-ns-harness] Requested but not in the record: ${parts.join("; ")}.`;
}
var rlKey = (tool, ti) => `rl:${sha256(`${tool}
${canonicalJson(ti)}`).slice(0, 16)}`;
function noteConnector(ctx, toolName) {
  try {
    const server = connectorServer(toolName);
    if (server) recordConnector(ctx.data, server);
  } catch (err) {
    logHookError("post:connector", err);
  }
}
function writeSuccess(json) {
  const o = json && typeof json === "object" && !Array.isArray(json) ? json : void 0;
  if (!o || o.success === false) return void 0;
  const idOf = (r) => {
    const x = r && typeof r === "object" && !Array.isArray(r) ? r : void 0;
    const v = x?.id ?? x?.recordId ?? x?.internalId;
    return typeof v === "string" || typeof v === "number" ? String(v) : void 0;
  };
  return idOf(o) ?? idOf(o.data) ?? idOf(o.record) ?? idOf(o.result) ?? (o.success === true ? true : void 0);
}
function failureContext(ctx, session, tool, ti, message, toolUseId) {
  let cls = classifyError(message);
  const flagged = flaggedColumns(ctx, session, toolUseId);
  if (flagged?.length && (cls === "unknown" || GENERIC_SUITESCRIPT.test(message))) cls = "bad_field_likely";
  let tables = [];
  if (cls === "bad_field" && ctx.acctDir) {
    const named = fieldErrorTable(message);
    tables = named ? [named] : tool === "ns_runCustomSuiteQL" ? tablesInSql(String(ti.sqlQuery ?? "")) : [String(ti.recordType ?? "").toLowerCase()].filter(Boolean);
    const kind = tool === "ns_runCustomSuiteQL" || named ? "fields" : "recordmeta";
    for (const t of tables) markStale(ctx.acctDir, `${kind}/${t}`, "error: unknown field");
  }
  if (cls === "not_found" && ctx.acctDir) {
    if (tool === "ns_runReport") markStale(ctx.acctDir, "reports", "error: report not found");
    if (tool === "ns_runSavedSearch") markStale(ctx.acctDir, "searches", "error: search not found");
  }
  let attempt = 1;
  if (cls === "rate_limit") {
    const state = loadState(ctx.data, session);
    const key = rlKey(tool, ti);
    const prev = state.rateLimits?.[key];
    const now = Date.now();
    attempt = prev && Number.isFinite(prev.n) && now - prev.at <= RATE_LIMIT_RESET_MS ? prev.n + 1 : 1;
    (state.rateLimits ??= {})[key] = { n: attempt, at: now };
    delete state.retries[key];
    saveState(ctx.data, session, state);
  }
  const searchRecordType = tool === "ns_runSavedSearch" && ctx.acctDir ? cachedSearchRecordType(ctx.acctDir, ti.searchId, searchTypeErrorId(message)) : void 0;
  const a = advice(cls, { attempt, tables, tool, message, columns: flagged, sql: tool === "ns_runCustomSuiteQL" ? String(ti.sqlQuery ?? "") : void 0, searchRecordType });
  const text = a ? `[su-ns-harness] Error class: ${cls}${cls === "rate_limit" ? ` (hit ${attempt} time${attempt === 1 ? "" : "s"} in a row)` : ""}. ${a}` : "";
  return { text, cls };
}
function handlePost(input, ctx = context(input.tool_name)) {
  const tool = nsToolName(input.tool_name ?? "");
  if (!tool) return void 0;
  const session = input.session_id ?? "";
  heartbeat(ctx.data, session, "post");
  noteConnector(ctx, input.tool_name);
  const ti = input.tool_input ?? {};
  const inflight = input.tool_use_id ? endCall(ctx.data, session, input.tool_use_id) : void 0;
  const tookMs = input.duration_ms ?? (inflight ? Date.now() - inflight.startedAt : void 0);
  const decoded = resolveSpilled(decodeToolResponse(input.tool_response), { transcriptPath: input.transcript_path });
  const audit = (e) => {
    if (ctx.acctDir) appendAudit(ctx.acctDir, { ts: (/* @__PURE__ */ new Date()).toISOString(), session, tool, input: ti, outcome: "ok", durationMs: tookMs, ...e });
  };
  if (decoded.spillUnresolved) {
    audit({ note: "spilled result not resolvable" });
    const catalog = !!catalogTarget(tool, ti, descriptionTag(ti));
    const how = catalog ? "It was not cached either. Don't read the whole file into context: grep it for the entry you need, or read it in small slices." : "Don't read the whole file into context: re-run the query as an aggregate or with a tighter filter, or read it in small slices.";
    return postOut([
      `[su-ns-harness] Claude Code saved this large result to a file that su-ns-harness could not read (unexpected message format or location), so it was not summarised. ${how} (Please report this: the Claude Code spill format may have changed.)`
    ]);
  }
  if (looksLikeError(decoded)) {
    const f = failureContext(ctx, session, tool, ti, errorText(decoded), input.tool_use_id);
    audit({ outcome: "error", errorClass: f.cls, note: truncate(errorText(decoded), 300) });
    if (f.cls === "rate_limit" && f.text) return postOut([], f.text);
    return postOut(f.text ? [f.text] : []);
  }
  const state = loadState(ctx.data, session);
  const key = rlKey(tool, ti);
  const flagged = input.tool_use_id ? state.unknownCols?.[input.tool_use_id] : void 0;
  if (state.retries[key] || state.rateLimits?.[key] || flagged) {
    delete state.retries[key];
    if (state.rateLimits) delete state.rateLimits[key];
    if (flagged) delete state.unknownCols[input.tool_use_id];
    saveState(ctx.data, session, state);
  }
  if (isWriteTool(tool)) {
    const ok = writeSuccess(decoded.json);
    if (ok === void 0) {
      audit({ outcome: "unknown", note: truncate(decoded.text, 300) });
      return postOut([
        `[su-ns-harness] Write outcome unknown: NetSuite's response has no record id and no success flag, so it may have failed. Read the record back with ns_getRecord (fields=<the fields you changed>) before telling the user it worked, and show them the response if it reads like an error.`
      ]);
    }
    audit({ note: truncate(decoded.text, 300) });
    return postOut([`[su-ns-harness] Write succeeded${ok === true ? "" : ` (record id ${ok})`}. Verify it by reading the record back with ns_getRecord (fields=<the fields you changed>) and show the user the result.`]);
  }
  const tag = descriptionTag(ti);
  let target = catalogTarget(tool, ti, tag);
  const notes = [];
  const mismatch = target && tag && tool === "ns_runCustomSuiteQL" ? tagMismatch(tag, String(ti.sqlQuery ?? ""), decoded.json ?? decoded.text) : void 0;
  if (mismatch) {
    target = void 0;
    notes.push(`[su-ns-harness] Tag [su-ns-harness:${tag}] ignored: ${mismatch}. Nothing was cached; the result is shown as an ordinary query.`);
  }
  const badName = target ? sectionNameProblem(target.section) : void 0;
  if (target && badName) {
    notes.push(`[su-ns-harness] Not cached: ${badName}. Record type and table names are plain lower-case ids (e.g. transaction, vendorbill).`);
    target = void 0;
  }
  if (target && !ctx.acctDir) {
    audit({});
    return postOut(["[su-ns-harness] Caching is off: this call's connector couldn't be identified from the tool name."]);
  }
  if (target && ctx.acctDir) {
    const acctDir = ctx.acctDir;
    const json = decoded.json ?? decoded.text;
    const isSchema = /^(fields|recordmeta)\//.test(target.section);
    const parsed = parseSection(target.section, json);
    const empty = isSchema && isEmptySchema(json) && !parsed?.rows.length;
    const index = empty ? { header: [], rows: [] } : parsed;
    const prev = loadManifest(acctDir).sections[safeSectionName(target.section)];
    if (!index && prev && prev.status !== "unparsed") {
      audit({ outcome: "error", note: truncate(`unparsed ${target.section} response, cache kept: ${decoded.text}`, 300) });
      return postOut([], truncate(`[su-ns-harness] The ${target.label} response couldn't be parsed, so the cached copy (${fmtNum(prev.count)} rows, fetched ${prev.fetchedAt.slice(0, 10)}) was kept. Response: ${decoded.text.trim()}`, 600));
    }
    const shrink = index ? shrinkRefusal(acctDir, safeSectionName(target.section), index.rows.length) : void 0;
    if (shrink) {
      audit({ rows: index?.rows.length, note: truncate(`not cached: ${shrink}`, 300) });
      if (target.section === "periods") {
        notes.push(`[su-ns-harness] ${shrink}`);
        target = void 0;
      } else return postOut([], `[su-ns-harness] ${shrink}`);
    }
  }
  if (target && ctx.acctDir) {
    const json = decoded.json ?? decoded.text;
    const isSchema = /^(fields|recordmeta)\//.test(target.section);
    const empty = isSchema && isEmptySchema(json) && !parseSection(target.section, json)?.rows.length;
    const index = empty ? { header: [], rows: [] } : parseSection(target.section, json);
    const entry = storeSection(ctx.acctDir, ctx.cfg, target.section, tool, decoded.text, index, empty ? "empty" : void 0);
    if (PROFILE_SECTIONS.test(target.section)) buildProfile(ctx.acctDir);
    audit({ rows: entry.count, outcome: "ok", note: `cached ${target.section}${empty ? " (empty)" : ""}` });
    if (empty) {
      const [kind, table] = target.section.split("/");
      return postOut([], `[su-ns-harness] ${emptyFieldsNote(ctx.acctDir, table, kind === "recordmeta" ? "recordmeta" : "fields")}`);
    }
    if (!index) {
      const shown = decoded.json === void 0 && decoded.text.trim().length <= 300 ? ` Response: ${decoded.text.trim()}` : "";
      return postOut([], `${unparsedNote(target.section, target.label, decoded.text, decoded.json)}${shown}`);
    }
    const what = target.section.startsWith("probe/") ? `${target.label} (${fmtNum(entry.count)} row${entry.count === 1 ? "" : "s"})` : `${fmtNum(entry.count)} ${target.label}`;
    return postOut([], `[su-ns-harness] Cached ${what} \u2192 use: ${target.hint}`);
  }
  if (!SHAPED.has(tool)) {
    audit({});
    return postOut(notes);
  }
  if (tool === "ns_getRecord") {
    const missing = missingRecordFields(ti.fields, decoded.json);
    if (missing.length) notes.push(missingFieldsNote(ctx, String(ti.recordType ?? "<type>").toLowerCase(), missing));
  }
  const ex = extractRows(decoded.json);
  const rowCount = ex?.rows.length;
  const truncated = ex ? detectTruncation(tool, ti, ex.rows.length, ex) : void 0;
  const size = decoded.text.length;
  if (size <= ctx.cfg.inline_max_chars || !ctx.acctDir) {
    audit({ rows: rowCount });
    const lines = [...notes, sourceFooter(tool, ti, rowCount, truncated)];
    const dates = tool === "ns_runSavedSearch" ? looseDateNote(decoded.text) : void 0;
    if (dates) lines.push(dates);
    if (!ctx.acctDir && size > ctx.cfg.inline_max_chars) lines.push("[su-ns-harness] Large result not offloaded: this call's connector couldn't be identified from the tool name.");
    return postOut(lines);
  }
  if (!ex || !ex.rows.length) {
    const meta2 = saveResult({ acctDir: ctx.acctDir, session, tool, query: queryLabel(tool, ti), columns: [], rows: [], raw: decoded.text, tookMs });
    audit({ resultId: meta2.id, note: "unparsed large result" });
    return postOut(notes, `[su-ns-harness] Large response (${fmtNum(size)} chars) was not tabular; saved raw \u2192 ${meta2.files.raw} (id ${meta2.id}).
Peek: ${cliCommand()} results raw ${meta2.id} --grep <term>   or   ${cliCommand()} results raw ${meta2.id} --head 40`);
  }
  const meta = saveResult({ acctDir: ctx.acctDir, session, tool, query: queryLabel(tool, ti), columns: ex.columns, rows: ex.rows, raw: decoded.text, truncated, tookMs });
  audit({ rows: meta.rowCount, resultId: meta.id });
  return postOut(notes, buildSummary({ meta, rows: ex.rows, columns: ex.columns, reportCurrency: reportCurrencyInfo(meta, loadProfile(ctx.acctDir), ctx.acctDir) }));
}
function handleFailure(input, ctx = context(input.tool_name)) {
  const tool = nsToolName(input.tool_name ?? "");
  if (!tool) return void 0;
  const session = input.session_id ?? "";
  heartbeat(ctx.data, session, "failure");
  noteConnector(ctx, input.tool_name);
  const ti = input.tool_input ?? {};
  const inflight = input.tool_use_id ? endCall(ctx.data, session, input.tool_use_id) : void 0;
  if (input.is_interrupt) return void 0;
  const msg = String(input.error ?? "");
  const f = failureContext(ctx, session, tool, ti, msg, input.tool_use_id);
  if (ctx.acctDir) {
    appendAudit(ctx.acctDir, {
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      session,
      tool,
      input: ti,
      outcome: "error",
      errorClass: f.cls,
      durationMs: input.duration_ms ?? (inflight ? Date.now() - inflight.startedAt : void 0),
      note: truncate(msg, 300)
    });
  }
  if (!f.text) return void 0;
  return { json: { hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: f.text } } };
}

// src/hooks/pre.ts
import * as fs11 from "node:fs";
import * as path12 from "node:path";

// src/sql/lint.ts
var HARD_RULES = /* @__PURE__ */ new Set([
  "not-select",
  "offset-ignored",
  "html-entity",
  "multi-statement",
  "rownum-over-subquery",
  "rownum-with-aggregate",
  "rownum-greater-than"
]);
var AGGREGATES = /* @__PURE__ */ new Set(["sum", "count", "avg", "min", "max", "listagg", "median", "stddev", "variance"]);
var CLAUSES = /* @__PURE__ */ new Set(["select", "from", "where", "group", "having", "order", "fetch", "offset", "union", "minus", "intersect", "connect", "start"]);
var NOT_ALIAS2 = /* @__PURE__ */ new Set([
  "on",
  "where",
  "left",
  "right",
  "inner",
  "outer",
  "full",
  "cross",
  "join",
  "group",
  "order",
  "having",
  "union",
  "minus",
  "fetch",
  "offset",
  "as",
  "and",
  "or",
  "connect",
  "start"
]);
var CUSTOM_PREFIX = /^(custbody|custcol|custentity|custitem|custrecord|custevent|custpage)/;
var TYPE_CODES = {
  custinvc: "invoice",
  salesord: "salesorder",
  vendbill: "vendorbill",
  purchord: "purchaseorder",
  journal: "journalentry",
  custpymt: "customerpayment",
  vendpymt: "vendorpayment",
  custcred: "creditmemo",
  vendcred: "vendorcredit",
  cashsale: "cashsale",
  estimate: "estimate",
  itemrcpt: "itemreceipt",
  itemship: "itemfulfillment",
  deposit: "deposit",
  check: "check",
  invadjst: "inventoryadjustment",
  trnfrord: "transferorder",
  exprept: "expensereport",
  rtnauth: "returnauthorization",
  custrfnd: "customerrefund",
  opprtnty: "opportunity",
  cardchrg: "creditcardcharge",
  cardrfnd: "creditcardrefund",
  workord: "workorder",
  vendauth: "vendorreturnauthorization",
  transfer: "transfer",
  fxreval: "fxreval",
  custdep: "customerdeposit",
  depappl: "depositapplication",
  cashrfnd: "cashrefund",
  statchng: "statisticaljournalentry"
};
var CODE_DISPLAY = Object.fromEntries(
  [
    "CustInvc",
    "SalesOrd",
    "VendBill",
    "PurchOrd",
    "Journal",
    "CustPymt",
    "VendPymt",
    "CustCred",
    "VendCred",
    "CashSale",
    "Estimate",
    "ItemRcpt",
    "ItemShip",
    "Deposit",
    "Check",
    "InvAdjst",
    "TrnfrOrd",
    "ExpRept",
    "RtnAuth",
    "CustRfnd",
    "Opprtnty",
    "CardChrg",
    "CardRfnd",
    "WorkOrd",
    "VendAuth",
    "Transfer",
    "FxReval",
    "CustDep",
    "DepAppl",
    "CashRfnd",
    "StatChng"
  ].map((c) => [c.toLowerCase(), c])
);
var RECORD_TO_CODE = Object.fromEntries(Object.entries(TYPE_CODES).map(([c, r]) => [r, c]));
var SET_OPS2 = /* @__PURE__ */ new Set(["union", "minus", "intersect", "except"]);
var SUBQUERY = "(subquery)";
function analyzeScope(toks, s, byOpen) {
  const info = {
    scope: s,
    rownum: [],
    rownumNested: 0,
    rownumInOn: 0,
    aggregate: false,
    groupBy: false,
    orderBy: false,
    compound: false,
    rownumWithAggregate: false,
    rownumWithOrderBy: false,
    aliases: /* @__PURE__ */ new Map(),
    fromSubquery: false,
    selectStar: false,
    leftJoinOnDates: false,
    leftSide: /* @__PURE__ */ new Set(),
    leftOnLeftFilters: [],
    probeLimit: false,
    fetch: false,
    limit: [],
    offset: false,
    offsetSkip: [],
    declared: [],
    singleCurrency: false,
    singleSubsidiary: false,
    groupWords: /* @__PURE__ */ new Set()
  };
  let clause = "";
  let inLeftJoinOn = false;
  let inOn = false;
  let bRownum = false;
  let bAgg = false;
  const closeBranch = () => {
    if (bRownum && bAgg) info.rownumWithAggregate = true;
    bRownum = false;
    bAgg = false;
  };
  const d = s.direct;
  let leftNow = /* @__PURE__ */ new Set();
  const addSource = (j, isFrom) => {
    const first = toks[d[j]];
    if (first?.type === "lp") {
      if (isFrom) {
        info.fromSubquery = true;
        info.fromSource = d[j];
      }
      const close = byOpen.get(d[j])?.close;
      const ci = d.indexOf(close ?? -1);
      if (ci >= 0) {
        let a = toks[d[ci + 1]];
        if (a?.type === "word" && a.value === "as") a = toks[d[ci + 2]];
        if (a && (a.type === "word" || a.type === "qid") && !NOT_ALIAS2.has(a.value)) {
          info.aliases.set(a.value, SUBQUERY);
          info.declared.push(a.value);
        }
      }
    } else if (first?.type === "word" || first?.type === "qid") {
      const table = first.value;
      let a = toks[d[j + 1]];
      if (a?.type === "word" && a.value === "as") a = toks[d[j + 2]];
      const alias = a && (a.type === "word" || a.type === "qid") && !NOT_ALIAS2.has(a.value) ? a.value : void 0;
      info.aliases.set(table, table);
      if (alias) info.aliases.set(alias, table);
      info.declared.push(alias ?? table);
      if (isFrom) {
        info.fromTable = table;
        info.fromAlias = alias ?? table;
      }
    }
  };
  for (let k = 0; k < d.length; k++) {
    const t = toks[d[k]];
    const next = toks[d[k + 1]];
    if (t.type === "lp") {
      const child = byOpen.get(d[k]);
      const prev = toks[d[k - 1]];
      if (child && !child.isQuery && !(prev?.type === "word" && prev.value === "over")) {
        if (findInParens(toks, child, byOpen, (x, nx) => x.type === "word" && AGGREGATES.has(x.value) && nx?.type === "lp")) bAgg = info.aggregate = true;
        if ((clause === "where" || clause === "having") && findInParens(toks, child, byOpen, (x) => x.type === "word" && x.value === "rownum")) {
          info.rownumNested++;
          bRownum = true;
        } else if (inOn && findInParens(toks, child, byOpen, (x) => x.type === "word" && x.value === "rownum")) {
          info.rownumInOn++;
          bRownum = true;
        }
        if (clause === "group") findInParens(toks, child, byOpen, (x) => (x.type === "word" && info.groupWords.add(x.value), false));
      }
    }
    if (t.type === "word") {
      const prevW = toks[d[k - 1]];
      const keyword = t.value === "offset" ? offsetKeyword(prevW, next) : t.value === "fetch" ? prevW?.type !== "dot" && (isWord(next, "first") || isWord(next, "next")) : true;
      if (CLAUSES.has(t.value) && keyword || SET_OPS2.has(t.value)) {
        clause = t.value;
        inLeftJoinOn = false;
        inOn = false;
      }
      if (SET_OPS2.has(t.value)) {
        info.compound = true;
        closeBranch();
      }
      if (t.value === "group" && next?.value === "by") bAgg = info.groupBy = true;
      if (t.value === "order" && next?.value === "by") info.orderBy = true;
      if ((t.value === "fetch" || t.value === "offset") && keyword) info.fetch = true;
      if (t.value === "offset" && keyword) info.offset = true;
      if (t.value === "limit" && next?.type === "num" && toks[d[k - 1]]?.type !== "dot") info.limit.push(k);
      if (clause === "group") info.groupWords.add(t.value);
      if (AGGREGATES.has(t.value) && next?.type === "lp") bAgg = info.aggregate = true;
      if (t.value === "rownum" && (clause === "where" || clause === "having")) {
        info.rownum.push(k);
        bRownum = true;
      } else if (t.value === "rownum" && inOn) {
        info.rownumInOn++;
        bRownum = true;
      }
      if (t.value === "join") inLeftJoinOn = inOn = false;
      if (t.value === "on") {
        inOn = true;
        inLeftJoinOn = lastJoinKind(toks, d, k) === "left";
        if (inLeftJoinOn) leftNow = new Set(info.declared.slice(0, -1));
      }
      if (inLeftJoinOn && /^(trandate|postingperiod|posting|startdate|enddate|periodname)$/.test(t.value)) {
        info.leftJoinOnDates = true;
        for (const a of leftNow) info.leftSide.add(a);
        const alias = prevW?.type === "dot" ? toks[d[k - 2]]?.value : void 0;
        if (alias && leftNow.has(alias)) info.leftOnLeftFilters.push(`${toks[d[k - 2]].raw}.${t.raw}`);
      }
      if ((t.value === "from" || t.value === "join") && next) addSource(k + 1, t.value === "from");
      if (t.value === "offset" && keyword && intOf(next) !== 0) info.offsetSkip.push(k);
      if (clause === "fetch" && (t.value === "first" || t.value === "next") && next?.type === "num" && Number(next.value) <= 1) info.probeLimit = true;
      if (t.value === "rownum" && next?.type === "op" && toks[d[k + 2]]?.type === "num") {
        const n = Number(toks[d[k + 2]].value);
        if (next.value === "<=" && n <= 1 || next.value === "=" && n === 1 || next.value === "<" && n <= 2) info.probeLimit = true;
      }
    }
    if (t.type === "comma" && clause === "from" && next) addSource(k + 1, false);
    if (t.type === "star" && clause === "select") {
      const prev = toks[d[k - 1]];
      const isSelectStar = prev && (prev.type === "comma" || prev.type === "dot" || prev.type === "word" && (prev.value === "select" || prev.value === "distinct" || prev.value === "all" || prev.value === "unique"));
      if (isSelectStar) info.selectStar = true;
    }
  }
  closeBranch();
  info.singleCurrency = info.groupWords.has("currency") || whereSingle(toks, s, byOpen, "currency");
  info.singleSubsidiary = info.groupWords.has("subsidiary") || whereSingle(toks, s, byOpen, "subsidiary");
  const anyRownum = rownumCount(info) > 0;
  if (!info.compound && anyRownum && (info.groupBy || info.aggregate)) info.rownumWithAggregate = true;
  if (!info.compound && anyRownum && info.orderBy && !info.rownumWithAggregate) info.rownumWithOrderBy = true;
  return info;
}
function findInParens(toks, s, byOpen, pred) {
  for (let j = 0; j < s.direct.length; j++) {
    const t = toks[s.direct[j]];
    if (pred(t, toks[s.direct[j + 1]])) return true;
    if (t.type === "lp") {
      const c = byOpen.get(s.direct[j]);
      if (c && !c.isQuery && findInParens(toks, c, byOpen, pred)) return true;
    }
  }
  return false;
}
var rownumCount = (q) => q.rownum.length + q.rownumNested + q.rownumInOn;
function offsetKeyword(prev, next) {
  if (prev?.type === "dot" || isWord(prev, "as")) return false;
  return next?.type === "num" || next?.type === "param" || next?.type === "lp";
}
function whereSingle(toks, s, byOpen, column) {
  const d = s.direct;
  const lit = (x) => x?.type === "num" || x?.type === "str" || x?.type === "param";
  let found = false;
  for (let w = 0; w < d.length; w++) {
    if (!isWord(toks[d[w]], "where")) continue;
    let e = w + 1;
    while (e < d.length && !(toks[d[e]].type === "word" && (CLAUSES.has(toks[d[e]].value) || SET_OPS2.has(toks[d[e]].value)))) e++;
    const end = e < d.length ? d[e] : s.close;
    let single = false;
    for (let i = d[w] + 1; i < end; i++) {
      const t = toks[i];
      if (t.type === "lp" && byOpen.get(i)?.isQuery) {
        i = byOpen.get(i).close;
        continue;
      }
      if (isWord(t, "or")) return false;
      if (!isWord(t, column)) continue;
      const start = toks[i - 1]?.type === "dot" ? i - 2 : i;
      if (isOp(toks[i + 1], "=") && lit(toks[i + 2])) single = true;
      else if (isWord(toks[i + 1], "in") && toks[i + 2]?.type === "lp" && lit(toks[i + 3]) && toks[i + 4]?.type === "rp") single = true;
      else if (toks[i + 1]?.type === "rp" && toks[start - 1]?.type === "lp" && isWord(toks[start - 2], "df") && isOp(toks[i + 2], "=") && lit(toks[i + 3])) single = true;
    }
    if (single) found = true;
  }
  return found;
}
function clauseAt(toks, q, i) {
  let clause = "";
  for (const j of q.scope.direct) {
    if (j >= i) break;
    const t = toks[j];
    if (t.type !== "word") continue;
    if (CLAUSES.has(t.value) || SET_OPS2.has(t.value) || t.value === "on" || t.value === "join") clause = t.value;
  }
  return clause;
}
function approvalCompared(toks, i) {
  const next = toks[i + 1];
  if (next?.type === "op" && COMPARE.has(next.value)) return true;
  if (isWord(next, "in") || isWord(next, "between") || isWord(next, "like")) return true;
  if (isWord(next, "not") && (isWord(toks[i + 2], "in") || isWord(toks[i + 2], "between") || isWord(toks[i + 2], "like"))) return true;
  const start = toks[i - 1]?.type === "dot" ? i - 2 : i;
  const before = toks[start - 1];
  return before?.type === "op" && COMPARE.has(before.value);
}
function aggregatesOver(toks, infos, q) {
  const out2 = [];
  const end = Math.min(q.scope.close, toks.length);
  for (let i = q.scope.open + 1; i + 1 < end; i++) {
    if (!(toks[i].type === "word" && AGGREGATES.has(toks[i].value) && toks[i + 1].type === "lp") || enclosing(infos, i)[0] !== q) continue;
    const close = toks.findIndex((x, j) => j > i + 1 && x.type === "rp" && x.depth === toks[i + 1].depth);
    for (const r of columnRefs(toks.slice(i + 2, close < 0 ? end : close))) out2.push(r.alias);
  }
  return out2;
}
function analyze(toks) {
  const all = scopes(toks);
  const byOpen = new Map(all.filter((x) => x.open >= 0).map((x) => [x.open, x]));
  return all.map((x) => analyzeScope(toks, x, byOpen));
}
function lastJoinKind(toks, d, k) {
  for (let j = k - 1; j >= 0; j--) {
    const t = toks[d[j]];
    if (t.type !== "word") continue;
    if (t.value === "join") {
      const p = toks[d[j - 1]];
      const pp = toks[d[j - 2]];
      if (p?.value === "outer") return pp?.value;
      return p?.type === "word" ? p.value : "inner";
    }
    if (CLAUSES.has(t.value)) return void 0;
  }
  return void 0;
}
function columnRefs(toks, star = false) {
  const out2 = [];
  for (let i = 0; i + 2 < toks.length; i++) {
    const a = toks[i], dot = toks[i + 1], c = toks[i + 2];
    if ((a.type === "word" || a.type === "qid") && dot.type === "dot" && (c.type === "word" || c.type === "qid" || star && c.type === "star")) {
      if (toks[i - 1]?.type === "dot" || toks[i + 3]?.type === "dot") continue;
      if (toks[i + 3]?.type === "lp") continue;
      out2.push({ alias: a.value, col: c.value, idx: i });
    }
  }
  return out2;
}
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
function closest(col2, pool) {
  const scored = pool.map((c) => ({ c, n: editDistance(col2, c) })).filter((x) => x.n > 0 && x.n <= 2 && 2 * x.n <= col2.length);
  const best = Math.min(...scored.map((x) => x.n));
  return scored.filter((x) => x.n === best).map((x) => x.c).sort().slice(0, 3);
}
function unknownColumns(r) {
  return [...new Set(r.warnings.flatMap((w) => w.columns ?? []))];
}
function enclosing(infos, idx) {
  return infos.filter((s) => s.scope.isQuery && s.scope.open < idx && idx < s.scope.close).sort((a, b) => b.scope.depth - a.scope.depth);
}
function resolveAlias(infos, idx, alias) {
  for (const s of enclosing(infos, idx)) {
    const t = s.aliases.get(alias);
    if (t) return t;
  }
  return void 0;
}
function typeLiterals(toks) {
  const out2 = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== "word" || t.value !== "type" && t.value !== "recordtype") continue;
    if (toks[i + 1]?.type === "lp") continue;
    const op = toks[i + 1];
    if (op?.type === "op" && (op.value === "=" || op.value === "<>" || op.value === "!=") && toks[i + 2]?.type === "str") {
      out2.push({ column: t.value, value: toks[i + 2].value, idx: i, negated: op.value !== "=" });
    } else if (op?.type === "word" && (op.value === "in" || op.value === "not" && toks[i + 2]?.value === "in")) {
      let j = i + (op.value === "not" ? 3 : 2);
      if (toks[j]?.type !== "lp") continue;
      for (j++; j < toks.length && toks[j].type !== "rp"; j++) {
        if (toks[j].type === "str") out2.push({ column: t.value, value: toks[j].value, idx: i, negated: op.value === "not" });
      }
    }
  }
  return out2;
}
function constantBranch(toks, from, to) {
  const b = toks.slice(from, to);
  if (b.length === 2 && b[0].type === "op" && (b[0].value === "-" || b[0].value === "+")) b.shift();
  return b.length === 1 && (b[0].type === "num" || isWord(b[0], "null"));
}
function indicatorSum(toks, lp, close) {
  if (close < 0) return false;
  const d = toks[lp].depth + 1;
  const first = toks[lp + 1];
  if (isWord(first, "case") && isWord(toks[close - 1], "end") && toks[close - 1].depth === d) {
    let nest = 0;
    let start = -1;
    let branches = 0;
    for (let j = lp + 2; j < close; j++) {
      const t = toks[j];
      if (t.depth !== d || t.type !== "word") continue;
      if (t.value === "case") nest++;
      if (nest > 0) {
        if (t.value === "end") nest--;
        continue;
      }
      if (t.value === "when" || t.value === "else" || t.value === "end") {
        if (start >= 0) {
          if (!constantBranch(toks, start, j)) return false;
          branches++;
          start = -1;
        }
        if (t.value === "else") start = j + 1;
      } else if (t.value === "then") start = j + 1;
    }
    return branches > 0;
  }
  if (isWord(first, "decode") && toks[lp + 2]?.type === "lp") {
    const dlp = lp + 2;
    const dclose = toks.findIndex((x, j) => j > dlp && x.type === "rp" && x.depth === toks[dlp].depth);
    if (dclose !== close - 1) return false;
    const args = [];
    let s0 = dlp + 1;
    for (let j = dlp + 1; j <= dclose; j++) {
      if (j === dclose || toks[j].type === "comma" && toks[j].depth === d + 1) {
        args.push([s0, j]);
        s0 = j + 1;
      }
    }
    if (args.length < 3) return false;
    const results = [];
    for (let k = 2; k < args.length; k += 2) results.push(k);
    if (args.length % 2 === 0) results.push(args.length - 1);
    return results.every((k) => constantBranch(toks, args[k][0], args[k][1]));
  }
  return false;
}
var FIXABLE = /* @__PURE__ */ new Set(["rownum-with-aggregate", "rownum-with-order-by", "rownum-over-subquery", "limit-clause", "offset-ignored"]);
var READ_START = /* @__PURE__ */ new Set(["select", "with"]);
var BUDGET_TABLES = /* @__PURE__ */ new Set(["budgets", "budgetsmachine"]);
var FACT_TABLES = /* @__PURE__ */ new Set(["transaction", "transactionline", "transactionaccountingline"]);
var TAL_AMOUNTS = /* @__PURE__ */ new Set(["amount", "debit", "credit", "netamount"]);
var HIDDEN_COLUMNS = {
  // live-verified query 2026-09-27; undocumented (transaction currency per Oracle, not base currency)
  transactionline: /* @__PURE__ */ new Set(["amount"]),
  // live-verified query 2026-09-27; undocumented (documented: fullname, accountsearchdisplayname)
  account: /* @__PURE__ */ new Set(["acctname"]),
  // "Sub-period of": https://www.netsuite.com.au/help/helpcenter/en_US/srbrowser/Browser2021_1/analytics/record/accountingPeriod.html
  accountingperiod: /* @__PURE__ */ new Set(["parent"])
};
var FETCH_FIRST = "Put ORDER BY \u2026 FETCH FIRST N ROWS ONLY at the end of the query instead (or use the connector's pageSize + pageIndex: 0). Don't wrap it as SELECT * FROM (\u2026) WHERE ROWNUM <= N: NetSuite applies that outer ROWNUM before the inner GROUP BY/ORDER BY too.";
function lintSuiteQL(sql, ctx = {}) {
  const result = lintOnly(sql, ctx);
  if (result.errors.length && result.errors.every((e) => FIXABLE.has(e.rule))) {
    const paging = result.errors.some((e) => e.rule === "offset-ignored") ? offsetPaging(sql) : void 0;
    const base = paging ? paging.sql : sql;
    const fixed = fixQuery(base);
    if ((paging || fixed !== sql) && !lintOnly(fixed, ctx).errors.length) {
      result.fixed = fixed;
      if (paging) result.paging = { pageSize: paging.pageSize, pageIndex: paging.pageIndex };
    }
  }
  return result;
}
function statementHeads(toks) {
  const heads = [];
  let first = true;
  for (const t of toks) {
    if (t.type === "semi") {
      first = true;
      continue;
    }
    if (!first) continue;
    if (t.type === "lp") continue;
    heads.push(t);
    first = false;
  }
  return heads;
}
var HTML_ENTITY = /&(?:(lt|gt|le|ge|amp|quot|apos|nbsp)|#(\d{1,7})|#x([0-9a-f]{1,6}));/gi;
var NAMED_ENTITY = { lt: "<", gt: ">", le: "<=", ge: ">=", amp: "&", quot: '"', apos: "'", nbsp: " " };
function quotedEnd(sql, i, q) {
  for (let j = i + 1; j < sql.length; j++) {
    if (sql[j] !== q) continue;
    if (sql[j + 1] === q) j++;
    else return j + 1;
  }
  return sql.length;
}
function htmlEntities(sql) {
  const out2 = /* @__PURE__ */ new Map();
  let code = "";
  for (let i = 0; i < sql.length; ) {
    const c = sql[i];
    if (c === "'") {
      const j = quotedEnd(sql, i, "'");
      code += " ".repeat(j - i);
      i = j;
    } else if (c === '"') {
      const j = quotedEnd(sql, i, '"');
      code += " ".repeat(j - i);
      i = j;
    } else if (c === "-" && sql[i + 1] === "-") {
      const e = sql.indexOf("\n", i);
      const j = e < 0 ? sql.length : e;
      code += " ".repeat(j - i);
      i = j;
    } else if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      const j = e < 0 ? sql.length : e + 2;
      code += " ".repeat(j - i);
      i = j;
    } else {
      code += c;
      i++;
    }
  }
  for (const m of code.matchAll(HTML_ENTITY)) {
    const [raw, name, dec, hex] = m;
    const n = dec ? Number(dec) : hex ? parseInt(hex, 16) : void 0;
    const char = name ? NAMED_ENTITY[name.toLowerCase()] : n !== void 0 && n <= 1114111 ? String.fromCodePoint(n) : "?";
    if (!out2.has(raw.toLowerCase())) out2.set(raw.toLowerCase(), char);
  }
  return [...out2].map(([entity, char]) => ({ entity, char }));
}
function lintOnly(sql, ctx) {
  const errors = [];
  const warnings = [];
  const entities = htmlEntities(sql);
  if (entities.length) {
    const ops = entities.every((e) => /^[<>]=?$/.test(e.char));
    const list2 = entities.map((e) => `${e.entity} (HTML-escaped '${e.char}')`).join(", ");
    return {
      errors: [{ rule: "html-entity", message: `The query contains ${list2}: write the ${ops ? "operator" : "character"} itself. sqlQuery is plain SQL, never HTML-escaped.` }],
      warnings
    };
  }
  const toks = tokenize(sql);
  if (!toks.length) return { errors: [{ rule: "empty", message: "Empty query." }], warnings };
  const heads = statementHeads(toks);
  const bad = heads.find((t) => !(t.type === "word" && READ_START.has(t.value)));
  if (bad) {
    const verb = bad.type === "word" ? bad.raw.toUpperCase() : void 0;
    return {
      errors: [{ rule: "not-select", message: `Only SELECT queries may go through ns_runCustomSuiteQL${verb ? `; this one runs ${verb}` : ""}. Send a single read-only query.` }],
      warnings
    };
  }
  if (heads.length > 1) {
    return {
      errors: [{ rule: "multi-statement", message: `Send one query; the connector runs a single statement, and this has ${heads.length} (separated by ;). Make one call per query, or combine them with UNION ALL or subqueries.` }],
      warnings
    };
  }
  const body = toks.filter((t) => t.type !== "semi" && t.type !== "lp" && t.type !== "rp");
  if (body.length < 2 || isWord(body[1], "from")) {
    return { errors: [{ rule: "incomplete-query", message: "The query is incomplete: SELECT needs a column list and FROM <table>. Send the whole query (quote it on the command line)." }], warnings };
  }
  const infos = analyze(toks);
  const queries = infos.filter((i) => i.scope.isQuery);
  const byOpen = new Map(queries.map((q) => [q.scope.open, q]));
  for (const q of queries) {
    if (q.rownumWithAggregate) {
      errors.push({
        rule: "rownum-with-aggregate",
        message: `ROWNUM is filtered at the same level as GROUP BY/aggregates, so rows are capped BEFORE aggregation and totals are silently wrong. Drop the ROWNUM filter. ${FETCH_FIRST}`
      });
    } else if (q.rownumWithOrderBy) {
      errors.push({
        rule: "rownum-with-order-by",
        message: `ROWNUM is filtered at the same level as ORDER BY, so an arbitrary N rows are taken BEFORE sorting and the 'top N' is wrong. Drop the ROWNUM filter. ${FETCH_FIRST}`
      });
    } else if (rownumOverSorted(q, byOpen)) {
      errors.push({
        rule: "rownum-over-subquery",
        message: "ROWNUM over an aggregated or sorted subquery: NetSuite applies the outer ROWNUM before the inner GROUP BY/ORDER BY, so you get partial sums in arbitrary order. Drop the outer ROWNUM and end the inner query with ORDER BY \u2026 FETCH FIRST N ROWS ONLY (or use pageSize + pageIndex: 0)."
      });
    }
    if (q.limit.length) {
      errors.push({
        rule: "limit-clause",
        message: q.offset ? "SuiteQL has no LIMIT. To page, drop LIMIT/OFFSET and use the connector's pageSize + pageIndex with a unique ORDER BY (e.g. ORDER BY t.id)." : "SuiteQL has no LIMIT. Use FETCH FIRST n ROWS ONLY (after ORDER BY for a top n)."
      });
    }
    if (q.offsetSkip.length) {
      errors.push({
        rule: "offset-ignored",
        message: "NetSuite ignores OFFSET (live-verified 2026-09-27) and returns the first rows again. Page with pageSize + pageIndex and a unique ORDER BY, or filter on the sort key (WHERE t.id > <last id> \u2026 ORDER BY t.id FETCH FIRST n ROWS ONLY)."
      });
    }
  }
  const undef = /* @__PURE__ */ new Set();
  for (const ref of columnRefs(toks, true)) {
    const scopesUp = enclosing(infos, ref.idx);
    if (!scopesUp.length || scopesUp.some((q) => q.aliases.has(ref.alias))) continue;
    if (undef.has(ref.alias)) continue;
    undef.add(ref.alias);
    const known = [...new Set(scopesUp.flatMap((q) => q.declared))];
    errors.push({
      rule: "undefined-alias",
      message: `${toks[ref.idx].raw}.${toks[ref.idx + 2].raw}: '${toks[ref.idx].raw}' isn't a table or alias in this query's FROM/JOIN (or an enclosing query's)${known.length ? `; in scope: ${known.join(", ")}` : ""}. Use one of those, or join the table it belongs to. NetSuite would fail with a generic error that doesn't name it.`
    });
  }
  for (const q of queries) {
    if (!(q.groupBy || q.aggregate)) continue;
    for (const c of queries) {
      const before = toks[c.scope.open - 1];
      const isSource = c.scope.depth === q.scope.depth + 1 && c.scope.open > q.scope.open && c.scope.close < q.scope.close && before?.type === "word" && (before.value === "from" || before.value === "join");
      if (isSource && rownumCount(c) > 0 && !c.orderBy && !rownumOverSorted(c, byOpen)) {
        errors.push({
          rule: "rownum-before-aggregate",
          message: "A ROWNUM-limited subquery feeds GROUP BY/aggregates, so an arbitrary N rows are aggregated and totals are wrong. Aggregate the full data, then cap the aggregated result with ORDER BY \u2026 FETCH FIRST N ROWS ONLY."
        });
      }
    }
  }
  for (const q of queries) {
    if (q.selectStar && !q.fromSubquery && !q.probeLimit) {
      errors.push({
        rule: "select-star",
        message: `SELECT * returns every column${q.fromTable ? ` of ${q.fromTable}` : ""} and wastes tokens. Name the columns you need (see: nsx fields ${q.fromTable ?? "<table>"}), or probe with FETCH FIRST 1 ROWS ONLY.`
      });
    }
  }
  const lits = typeLiterals(toks).filter((l) => resolvesToTransaction(toks, infos, l.idx));
  for (const l of lits) {
    const v = l.value.toLowerCase();
    if (l.column === "type" && !TYPE_CODES[v] && RECORD_TO_CODE[v]) {
      errors.push({
        rule: "type-literal",
        message: `transaction.type uses internal codes, not record ids: use type = '${CODE_DISPLAY[RECORD_TO_CODE[v]]}' (or recordtype = '${v}') instead of type = '${l.value}'.`
      });
    } else if (l.column === "recordtype" && TYPE_CODES[v] && !RECORD_TO_CODE[v]) {
      errors.push({
        rule: "recordtype-literal",
        message: `transaction.recordtype uses record ids, not type codes: use recordtype = '${TYPE_CODES[v]}' (or type = '${CODE_DISPLAY[v]}') instead of recordtype = '${l.value}'.`
      });
    } else if (l.column === "type" && !TYPE_CODES[v]) {
      warnings.push({
        rule: "type-literal-unknown",
        message: `transaction.type '${l.value}' isn't in the harness's list of type codes (a short list; the code may still be right). If the query returns nothing, check the code: it's an internal code like CustInvc, VendBill or Journal, not a record id.`
      });
    } else if (l.column === "recordtype" && ctx.recordTypes?.size && !ctx.recordTypes.has(v) && !RECORD_TO_CODE[v]) {
      warnings.push({
        rule: "recordtype-unknown",
        message: `recordtype '${l.value}' isn't in the harness's type list or the cached SuiteQL record-type list (neither is complete; the value may still be right). If the query returns nothing, check it (nsx recordtypes --grep ${v}).`
      });
    }
  }
  if (ctx.approvalWorkflows) {
    const wf = Object.fromEntries(Object.entries(ctx.approvalWorkflows).map(([k, v]) => [k.toLowerCase(), v]));
    const hit = /* @__PURE__ */ new Set();
    for (let i = 0; i < toks.length; i++) {
      if (!isWord(toks[i], "approvalstatus") || !approvalCompared(toks, i)) continue;
      const q = enclosing(infos, i)[0];
      if (!q || !["where", "having"].includes(clauseAt(toks, q, i))) continue;
      const codes = lits.filter((l) => !l.negated && enclosing(infos, l.idx)[0] === q).map((l) => {
        const v = l.value.toLowerCase();
        return l.column === "type" ? v : RECORD_TO_CODE[v] ?? (TYPE_CODES[v] ? v : void 0);
      }).filter((c) => !!c && c in wf);
      if (codes.length && codes.every((c) => wf[c] === false)) for (const c of codes) hit.add(c);
    }
    if (hit.size) {
      const known = [...hit];
      errors.push({
        rule: "approvalstatus-no-workflow",
        message: `Filtering on approvalstatus for ${known.map((c) => CODE_DISPLAY[c] ?? c).join(", ")}, which has no approval workflow in this account (profile), so the filter returns zero rows. Drop the approvalstatus condition; filter on status with BUILTIN.CF(t.status) = '${CODE_DISPLAY[known[0]] ?? known[0]}:<letter>' instead.`
      });
    }
  }
  if (ctx.fields) {
    const reported = /* @__PURE__ */ new Set();
    for (const ref of columnRefs(toks)) {
      const table = resolveAlias(infos, ref.idx, ref.alias);
      if (!table) continue;
      const cols = ctx.fields(table);
      if (!cols || !cols.size || cols.has(ref.col)) continue;
      const key = `${table}.${ref.col}`;
      if (reported.has(key)) continue;
      reported.add(key);
      const generic = `if the query then fails with a generic error ("An unexpected SuiteScript error has occurred"), this column is the likely cause: NetSuite doesn't name the bad field`;
      if (CUSTOM_PREFIX.test(ref.col)) {
        warnings.push({ rule: "unknown-custom-field", columns: [key], message: `Custom field ${key} is not in the cached field list; it may be new, but ${generic} (nsx fields ${table} --grep ${ref.col.slice(0, 10)}).` });
      } else if (!HIDDEN_COLUMNS[table]?.has(ref.col)) {
        const pool = [.../* @__PURE__ */ new Set([...cols, ...HIDDEN_COLUMNS[table] ?? []])];
        const close = closest(ref.col, pool);
        const near2 = pool.filter((c) => !close.includes(c) && (c.includes(ref.col) || ref.col.includes(c))).slice(0, 5);
        const hint = close.length ? ` Did you mean ${close.join(" or ")}?` : near2.length ? ` Similar: ${near2.join(", ")}.` : "";
        warnings.push({
          rule: "unknown-column",
          columns: [key],
          message: `${key} is not in the connector's metadata for ${table}. It may still exist, but ${generic}.${hint} (nsx fields ${table} --grep ${ref.col.slice(0, 4)})`
        });
      }
    }
  }
  const hasLineFilter = toks.some((t) => t.type === "word" && /^(mainline|accountinglinetype|taxline|iscogs|transactionlinetype)$/.test(t.value));
  if (!hasLineFilter) {
    for (let i = 0; i + 1 < toks.length; i++) {
      const t = toks[i];
      if (t.type !== "word" || t.value !== "sum" || toks[i + 1].type !== "lp") continue;
      const close = toks.findIndex((x, j) => j > i + 1 && x.type === "rp" && x.depth === toks[i + 1].depth);
      if (indicatorSum(toks, i + 1, close)) continue;
      const inner = columnRefs(toks.slice(i + 2, close < 0 ? toks.length : close));
      if (inner.some((r) => /amount$/.test(r.col) && resolveAlias(infos, i, r.alias) === "transactionline")) {
        warnings.push({
          rule: "transactionline-sum-unfiltered",
          message: "Summing transactionline amounts without a mainline/line-type filter can double count (header + lines, tax lines). Add mainline = 'F' (and taxline = 'F'), or use transactionaccountingline for GL amounts."
        });
        break;
      }
    }
  }
  const mixed = /* @__PURE__ */ new Set();
  for (let i = 0; i + 1 < toks.length; i++) {
    if (toks[i].type !== "word" || toks[i].value !== "sum" || toks[i + 1].type !== "lp") continue;
    const close = toks.findIndex((x, j) => j > i + 1 && x.type === "rp" && x.depth === toks[i + 1].depth);
    if (indicatorSum(toks, i + 1, close)) continue;
    const inner = toks.slice(i + 2, close < 0 ? toks.length : close);
    const q = enclosing(infos, i)[0];
    if (q && !q.singleCurrency && inner.some((x) => x.type === "word" && (x.value === "foreigntotal" || x.value === "foreignamount"))) mixed.add(q);
  }
  if (mixed.size) {
    warnings.push({
      rule: "sum-mixed-currency",
      // article_1029114601: BUILTIN.CURRENCY_CONVERT(amount, target currency, rate date); rate date defaults to today
      message: "SUM(foreigntotal/foreignamount) adds amounts in each transaction's own currency, so different currencies get added together. Group by currency (and show it), filter to one currency, sum a base amount (transactionaccountingline.amount) per subsidiary (group or filter by tl.subsidiary: each subsidiary has its own base currency), use the consolidated report / BUILTIN.CONSOLIDATE, or convert with BUILTIN.CURRENCY_CONVERT(amount, <target currency id>, <rate date>) (the rate date defaults to today, not the transaction date)."
    });
  }
  if (ctx.multiCurrencySubsidiaries) {
    for (let i = 0; i + 1 < toks.length; i++) {
      if (!isWord(toks[i], "sum") || toks[i + 1].type !== "lp") continue;
      const close = toks.findIndex((x, j) => j > i + 1 && x.type === "rp" && x.depth === toks[i + 1].depth);
      if (indicatorSum(toks, i + 1, close)) continue;
      const inner = toks.slice(i + 2, close < 0 ? toks.length : close);
      if (inner.some((x) => isWord(x, "consolidate"))) continue;
      const q = enclosing(infos, i)[0];
      if (!q || q.singleSubsidiary) continue;
      const base = columnRefs(inner).find((r) => TAL_AMOUNTS.has(r.col) && resolveAlias(infos, i, r.alias) === "transactionaccountingline");
      if (!base) continue;
      warnings.push({
        rule: "sum-across-subsidiaries",
        message: `SUM(${base.alias}.${base.col}) adds each subsidiary's base-currency amounts together, and this account's subsidiaries use different currencies (profile), so the total mixes currencies. Group or filter by subsidiary (tl.subsidiary, joining transactionline tl ON tl.transaction = ${base.alias}.transaction AND tl.id = ${base.alias}.transactionline), or use the consolidated report / BUILTIN.CONSOLIDATE for a group total.`
      });
      break;
    }
  }
  const fanout = /* @__PURE__ */ new Set();
  for (const q of queries) {
    if (!(q.aggregate || q.groupBy)) continue;
    const tables = new Set(q.aliases.values());
    if ([...tables].some((t) => BUDGET_TABLES.has(t)) && [...tables].some((t) => FACT_TABLES.has(t))) fanout.add(q);
  }
  if (fanout.size) {
    warnings.push({
      rule: "budget-fanout",
      message: "Budget rows joined to transaction rows and aggregated in one query: each budget row repeats for every matching transaction line (and vice versa), so both sums inflate. Aggregate budgets and actuals in separate subqueries, then join the totals: FROM (SELECT \u2026 GROUP BY \u2026) b LEFT JOIN (SELECT \u2026 GROUP BY \u2026) a ON \u2026."
    });
  }
  for (const q of queries) {
    if (!q.leftJoinOnDates || !(q.aggregate || q.groupBy) || fanout.has(q)) continue;
    if (!aggregatesOver(toks, infos, q).some((a) => q.leftSide.has(a))) continue;
    warnings.push({
      rule: "left-join-aggregate",
      message: `Date/posting filter inside LEFT JOIN \u2026 ON while aggregating a left-table column: every left-table row (${q.fromTable ?? "left"}) is kept and multiplied by matching right rows, so left-side sums inflate. Aggregate each side in its own subquery, then join the totals.`
    });
  }
  const leftFilters = [...new Set(queries.flatMap((q) => q.leftOnLeftFilters))];
  if (leftFilters.length) {
    warnings.push({
      rule: "left-join-on-filter",
      message: `${leftFilters.join(", ")} is filtered inside LEFT JOIN \u2026 ON, but it belongs to the left side of that join, so it doesn't remove any rows (a LEFT JOIN keeps every left row). Move the condition to WHERE.`
    });
  }
  syntaxRules(toks, infos, errors, warnings, ctx);
  orderByAlias(sql, toks, queries, warnings);
  return { errors, warnings };
}
var UNSUPPORTED_FUNCTIONS = {
  listagg: "no SuiteQL equivalent; return the rows and combine them outside SQL",
  datediff: "subtract dates instead (d1 - d2 is days) or use MONTHS_BETWEEN(d1, d2)",
  left: "use SUBSTR(s, 1, n)",
  right: "use SUBSTR(s, -n)",
  substring: "use SUBSTR(s, start, length)",
  charindex: "use INSTR(s, sub)",
  locate: "use INSTR(s, sub)",
  position: "use INSTR(s, sub)",
  ceiling: "use CEIL",
  lcase: "use LOWER",
  ucase: "use UPPER",
  convert: "no SuiteQL equivalent; use TO_CHAR / TO_NUMBER / TO_DATE",
  char_length: "use LENGTH",
  character_length: "use LENGTH",
  repeat: "no SuiteQL equivalent",
  bit_length: "no SuiteQL equivalent",
  bit_xor_agg: "no SuiteQL equivalent",
  cot: "use 1 / TAN(x)"
};
var COMPARE = /* @__PURE__ */ new Set(["=", "<", ">", "<=", ">=", "<>", "!="]);
var DATE_LIKE = /^\s*(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})\b/;
var isWord = (t, v) => t?.type === "word" && (v === void 0 || t.value === v);
var isOp = (t, v) => t?.type === "op" && t.value === v;
var intOf = (t) => t?.type === "num" && /^\d+$/.test(t.value) ? Number(t.value) : void 0;
var isPlusMarker = (toks, i) => toks[i]?.type === "lp" && isOp(toks[i + 1], "+") && toks[i + 2]?.type === "rp";
function syntaxRules(toks, infos, errors, warnings, ctx = {}) {
  const once = /* @__PURE__ */ new Set();
  const err = (rule, message, key = rule) => {
    if (once.has(key)) return;
    once.add(key);
    errors.push({ rule, message });
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], prev = toks[i - 1], next = toks[i + 1];
    if (isWord(t, "with") && (!prev || prev.type === "lp" || prev.type === "semi")) {
      err("cte-unsupported", "SuiteQL doesn't support WITH clauses; rewrite each CTE as a FROM subquery: FROM (SELECT \u2026) x.");
    }
    if (t.type === "word" && next?.type === "lp" && prev?.type !== "dot" && UNSUPPORTED_FUNCTIONS[t.value]) {
      err("unsupported-function", `${t.value.toUpperCase()}() isn't supported in SuiteQL: ${UNSUPPORTED_FUNCTIONS[t.value]}.`, `fn:${t.value}`);
    }
    if ((isWord(t, "date") || isWord(t, "timestamp")) && next?.type === "str" && prev?.type !== "dot") {
      err("date-literal", `SuiteQL has no ${t.value.toUpperCase()} '\u2026' literals; use TO_DATE('2026-01-01','YYYY-MM-DD').`);
    }
    const textLit = (x) => x?.type === "str" && !/^\s*-?\d+(\.\d+)?\s*$/.test(x.value);
    if (isOp(t, "+") && (textLit(prev) || textLit(next))) {
      err("string-plus-concat", "SuiteQL can't concatenate with +; use || to concatenate.");
    } else if (isOp(t, "+") && ctx.fieldType) {
      const numeric = (x) => x?.type === "num" || x?.type === "str" && !textLit(x);
      const left = operandColumn(toks, infos, i, -1);
      const right = operandColumn(toks, infos, i, 1);
      const str3 = [left, right].find((c) => c && ctx.fieldType(c.table, c.col) === "string");
      const other = str3 === left ? next : prev;
      if (str3 && !numeric(other)) {
        err("string-plus-concat", `SuiteQL can't concatenate with +; use || to concatenate (${str3.table}.${str3.col} is a string column).`);
      }
    }
    if (isOp(t, "[") && isWord(next, "nolint")) {
      err("bracket-identifier", "[nolint] goes in the tool call's description, not in sqlQuery: remove it from the SQL (in the SQL it's a square bracket, which SuiteQL doesn't support).");
    } else if (isOp(t, "[")) {
      err("bracket-identifier", "Square brackets aren't supported in SuiteQL; drop them and use the plain name (or an AS alias).");
    }
    if (isPlusMarker(toks, i) && isOp(toks[i + 3], "=")) {
      err("right-outer-plus", "(+) on the left of = is an Oracle-syntax right outer join, which SuiteQL doesn't support; move (+) to the other side (swap the operands): b.id = a.id (+).");
    }
    if (isWord(t, "rownum") && rownumNeverTrue(toks, i)) {
      err("rownum-greater-than", "A ROWNUM condition that skips the first row (ROWNUM > n, = n, <> 1, BETWEEN n AND \u2026) always returns no rows; page with pageSize + pageIndex (and a unique ORDER BY) instead.");
    }
    if (isWord(t, "in") && next?.type === "lp") {
      let n = 0;
      for (let j = i + 2; j < toks.length && !(toks[j].type === "rp" && toks[j].depth === next.depth); j++) {
        if (toks[j].depth === next.depth + 1 && (toks[j].type === "str" || toks[j].type === "num")) n++;
      }
      if (n > 1e3) err("in-list-too-long", `IN (\u2026) has ${n} items; SuiteQL allows at most 1000. Split it into IN lists of up to 1000 joined with OR, or filter by a subquery or id range.`);
    }
  }
  for (const q of infos) {
    if (!q.scope.isQuery) continue;
    const d = q.scope.direct;
    if (d.some((i) => isPlusMarker(toks, i)) && d.some((i) => isWord(toks[i], "join"))) {
      err("mixed-join-syntax", "This query mixes Oracle (+) outer joins with ANSI JOIN \u2026 ON, and SuiteQL can't use both syntaxes in the same query. Use one style: comma joins with (+), or LEFT JOIN \u2026 ON.");
    }
  }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== "word" || !/date$/.test(t.value) || t.value === "date" && toks[i - 1]?.type !== "dot" || toks[i + 1]?.type === "lp") continue;
    const lit = (x) => x?.type === "str" && DATE_LIKE.test(x.value);
    let o = i + 1;
    while (toks[o]?.type === "rp" && o - i <= 2) o++;
    const op = toks[o];
    const pre = toks[i - 1]?.type === "dot" ? i - 2 : i;
    const inAt = isWord(op, "in") ? o + 1 : isWord(op, "not") && isWord(toks[o + 1], "in") ? o + 2 : -1;
    const hit = op?.type === "op" && COMPARE.has(op.value) && lit(toks[o + 1]) || isWord(op, "between") && (lit(toks[o + 1]) || lit(toks[betweenAnd(toks, o) + 1])) || inAt > 0 && toks[inAt]?.type === "lp" && lit(toks[inAt + 1]) || toks[pre - 1]?.type === "op" && COMPARE.has(toks[pre - 1].value) && lit(toks[pre - 2]);
    if (hit) {
      warnings.push({ rule: "string-date-compare", message: "Compare dates with TO_DATE('2026-01-01','YYYY-MM-DD'), not a plain string: string comparisons depend on the account's date format." });
      break;
    }
  }
  for (let i = 0; i < toks.length; i++) {
    if (!isWord(toks[i], "status")) continue;
    const qualified = toks[i - 1]?.type === "dot";
    const start = qualified ? i - 2 : i;
    const b = start - 1;
    if (toks[b]?.type === "lp" && isWord(toks[b - 1], "cf")) continue;
    const op = toks[i + 1];
    let strs = false;
    if (op?.type === "op" && (op.value === "=" || op.value === "<>" || op.value === "!=")) strs = toks[i + 2]?.type === "str";
    else if (isWord(op, "in") || isWord(op, "not") && isWord(toks[i + 2], "in")) {
      const lp = op.value === "not" ? i + 3 : i + 2;
      strs = toks[lp]?.type === "lp" && toks[lp + 1]?.type === "str";
    }
    if (!strs || !resolvesToTransaction(toks, infos, i)) continue;
    const col2 = qualified ? `${toks[i - 2].raw}.status` : "status";
    warnings.push({
      rule: "status-without-cf",
      message: `Raw ${col2} holds only the status letter; filter with BUILTIN.CF(${col2}) = 'CustInvc:A' (type:letter).`
    });
    break;
  }
  for (let i = 0; i < toks.length; i++) {
    const q = toks[i];
    if (q.type !== "qid" || toks[i + 1]?.type === "dot") continue;
    const op = toks[i - 1];
    if (!(isOp(op, "=") || isOp(op, "<>") || isOp(op, "!="))) continue;
    if (!(toks[i - 3]?.type === "dot" && (toks[i - 2]?.type === "word" || toks[i - 2]?.type === "qid"))) continue;
    if (enclosing(infos, i).some((x) => x.aliases.has(q.value))) continue;
    warnings.push({
      rule: "double-quoted-string",
      message: `${q.raw} is in double quotes, which SuiteQL reads as a column/identifier name, not a string. For a string value use single quotes: '${q.raw.slice(1, -1).replace(/'/g, "''")}'.`
    });
    break;
  }
}
function betweenAnd(toks, b) {
  for (let j = b + 1; j < toks.length; j++) {
    const t = toks[j];
    if (t.depth < toks[b].depth || t.type === "semi") break;
    if (t.depth === toks[b].depth && t.type !== "rp" && isWord(t, "and")) return j;
  }
  return -2;
}
function operandColumn(toks, infos, i, dir) {
  const isName = (x) => x?.type === "word" || x?.type === "qid";
  let alias;
  let col2;
  if (dir === -1) {
    col2 = toks[i - 1];
    if (!isName(col2)) return void 0;
    if (toks[i - 2]?.type === "dot") {
      if (!isName(toks[i - 3]) || toks[i - 4]?.type === "dot") return void 0;
      alias = toks[i - 3].value;
    }
  } else {
    const a = toks[i + 1];
    if (!isName(a)) return void 0;
    if (toks[i + 2]?.type === "dot") {
      col2 = toks[i + 3];
      if (!isName(col2) || toks[i + 4]?.type === "dot" || toks[i + 4]?.type === "lp") return void 0;
      alias = a.value;
    } else {
      if (toks[i + 2]?.type === "lp") return void 0;
      col2 = a;
    }
  }
  if (alias) {
    const table = resolveAlias(infos, i, alias);
    return table && table !== SUBQUERY ? { table, col: col2.value } : void 0;
  }
  const q = enclosing(infos, i)[0];
  if (!q || q.declared.length !== 1 || !q.fromTable) return void 0;
  return { table: q.fromTable, col: col2.value };
}
var ORDER_MODIFIERS = /* @__PURE__ */ new Set(["asc", "desc", "nulls", "first", "last"]);
var SELECT_MODIFIERS = /* @__PURE__ */ new Set(["distinct", "all", "unique"]);
function orderByAlias(sql, toks, queries, warnings) {
  const flat2 = (a, b) => sql.slice(toks[a].start, toks[b].end).replace(/\s+/g, " ");
  const split = (idx) => {
    const items = [[]];
    for (const j of idx) {
      if (toks[j].type === "comma") items.push([]);
      else items[items.length - 1].push(j);
    }
    return items.filter((x) => x.length);
  };
  const hits = [];
  for (const q of queries) {
    if (!q.groupBy || !q.orderBy || q.compound) continue;
    const d = q.scope.direct;
    if (!isWord(toks[d[0]], "select")) continue;
    let k = 1;
    while (SELECT_MODIFIERS.has(toks[d[k]]?.value) && toks[d[k]]?.type === "word") k++;
    if (isWord(toks[d[k]], "top") && toks[d[k + 1]]?.type === "num") k += 2;
    const fromAt = d.findIndex((j, n) => n >= k && isWord(toks[j], "from"));
    if (fromAt < 0) continue;
    const exprs = /* @__PURE__ */ new Map();
    for (const item of split(d.slice(k, fromAt))) {
      const n = item.length;
      const last = toks[item[n - 1]];
      if (n < 2 || !(last.type === "word" || last.type === "qid") || last.value === "end") continue;
      const hasAs = isWord(toks[item[n - 2]], "as");
      const before = toks[item[n - 2]];
      if (!hasAs && !(before.type === "rp" || before.type === "word" || before.type === "qid" || before.type === "num" || before.type === "str")) continue;
      const body = item.slice(0, hasAs ? n - 2 : n - 1);
      if (!body.length) continue;
      const complex = body.some((j) => toks[j].type === "lp" || toks[j].type === "op" || toks[j].type === "star" || isWord(toks[j], "case"));
      if (complex) exprs.set(last.value, flat2(body[0], body[body.length - 1]));
    }
    if (!exprs.size) continue;
    const orderAt = d.findIndex((j, n) => isWord(toks[j], "order") && isWord(toks[d[n + 1]], "by"));
    let end = d.length;
    for (let n = orderAt + 2; n < d.length; n++) {
      if (toks[d[n]].type === "word" && ["fetch", "offset", "limit"].includes(toks[d[n]].value)) {
        end = n;
        break;
      }
    }
    for (const item of split(d.slice(orderAt + 2, end))) {
      const first = toks[item[0]];
      const expr = exprs.get(first.value);
      if (!expr || !(first.type === "word" || first.type === "qid") || !item.slice(1).every((j) => toks[j].type === "word" && ORDER_MODIFIERS.has(toks[j].value))) continue;
      const mods = item.length > 1 ? ` ${flat2(item[1], item[item.length - 1])}` : "";
      hits.push(`${expr}${mods} instead of ${first.raw}${mods}`);
    }
  }
  if (hits.length) {
    warnings.push({
      rule: "order-by-alias-group-by",
      message: `NetSuite may reject ORDER BY on an alias with GROUP BY ("Invalid or unsupported search"): order by the full expression (${hits.join("; ")}).`
    });
  }
}
function rownumNeverTrue(toks, i) {
  const op = toks[i + 1];
  if (op?.type === "op") {
    const n = intOf(toks[i + 2]);
    if (n !== void 0 && (op.value === ">" && n >= 1 || (op.value === ">=" || op.value === "=") && n > 1)) return true;
    if (n === 1 && (op.value === "<>" || op.value === "!=")) return true;
  }
  if (isWord(op, "between")) {
    const a = intOf(toks[i + 2]);
    if (a !== void 0 && a > 1 && isWord(toks[i + 3], "and")) return true;
  }
  const pop = toks[i - 1];
  if (pop?.type === "op" && toks[i - 3]?.type !== "op") {
    const n = intOf(toks[i - 2]);
    if (n !== void 0 && (pop.value === "<" && n >= 1 || (pop.value === "<=" || pop.value === "=") && n > 1)) return true;
    if (n === 1 && (pop.value === "<>" || pop.value === "!=")) return true;
  }
  return false;
}
function pagingOrderMissing(sql) {
  const toks = tokenize(sql);
  const top = analyze(toks).find((x) => x.scope.open < 0);
  if (!top || !top.scope.isQuery) return false;
  return !top.orderBy && (!!top.groupBy || !top.aggregate);
}
function rownumOverSorted(q, byOpen) {
  if (rownumCount(q) === 0) return false;
  for (let src = q.fromSource === void 0 ? void 0 : byOpen.get(q.fromSource); src; src = src.fromSource === void 0 ? void 0 : byOpen.get(src.fromSource)) {
    if (src.groupBy || src.aggregate || src.orderBy) return true;
  }
  return false;
}
function resolvesToTransaction(toks, infos, idx) {
  const alias = toks[idx - 1]?.type === "dot" ? toks[idx - 2]?.value : void 0;
  if (alias) return resolveAlias(infos, idx, alias) === "transaction";
  return enclosing(infos, idx)[0]?.fromTable === "transaction";
}
function rownumBound(toks, d, k) {
  const op = toks[d[k + 1]];
  const n = toks[d[k + 2]];
  const pop = toks[d[k - 1]];
  const pn = toks[d[k - 2]];
  let limit;
  let first = k;
  let last = k;
  if (op?.type === "op" && n?.type === "num" && Number.isInteger(Number(n.value))) {
    const v = Number(n.value);
    if (op.value === "<=") limit = v;
    else if (op.value === "<") limit = v - 1;
    else if (op.value === "=" && v === 1) limit = 1;
    else return void 0;
    last = k + 2;
  } else if (pop?.type === "op" && pn?.type === "num" && Number.isInteger(Number(pn.value))) {
    const v = Number(pn.value);
    if (pop.value === ">=") limit = v;
    else if (pop.value === ">") limit = v - 1;
    else return void 0;
    first = k - 2;
  } else return void 0;
  return limit < 1 ? void 0 : { limit, first, last };
}
function fixRownum(sql) {
  const original = sql;
  let out2 = sql.trim().replace(/;\s*$/, "");
  let changed = false;
  for (let pass = 0; pass < 5; pass++) {
    const toks = tokenize(out2);
    const infos = analyze(toks);
    const byOpen = new Map(infos.filter((q) => q.scope.isQuery).map((q) => [q.scope.open, q]));
    const target = infos.filter((q) => q.scope.isQuery && (q.rownumWithAggregate || q.rownumWithOrderBy || rownumOverSorted(q, byOpen))).sort((a, b) => b.scope.depth - a.scope.depth)[0];
    if (!target) break;
    if (target.compound || target.rownumNested || target.rownumInOn || target.rownum.length !== 1) return original;
    const d = target.scope.direct;
    const k = target.rownum[0];
    const bound = rownumBound(toks, d, k);
    if (!bound) return original;
    const top = target.scope.open < 0;
    const sStart = top ? 0 : toks[target.scope.open].end;
    const sEnd = target.scope.close >= toks.length ? out2.length : toks[target.scope.close].start;
    const fetch = `FETCH FIRST ${bound.limit} ROWS ONLY`;
    let next;
    if (!target.rownumWithAggregate && !target.rownumWithOrderBy) {
      let src = target.fromSource === void 0 ? void 0 : byOpen.get(target.fromSource);
      if (!src || d[3] !== target.fromSource) return original;
      const w = (i) => toks[d[i]];
      if (w(0)?.value !== "select" || w(1)?.type !== "star" || w(2)?.value !== "from" || w(4)?.type !== "rp") return original;
      let j = 5;
      if (w(j)?.value === "as") j++;
      if (w(j) && w(j).value !== "where") j++;
      if (w(j)?.value !== "where" || bound.first !== j + 1 || bound.last !== d.length - 1) return original;
      while (src && !(src.groupBy || src.aggregate || src.orderBy)) {
        if (!passThrough(toks, src)) return original;
        src = src.fromSource === void 0 ? void 0 : byOpen.get(src.fromSource);
      }
      if (!src || src.fetch || src.scope.close >= toks.length) return original;
      const body = dedent(out2.slice(toks[src.scope.open].end, toks[src.scope.close].start));
      const block = top ? `${body}
${fetch}` : `${body}${fetchSep(body)}${fetch}`;
      next = out2.slice(0, sStart) + block + out2.slice(sEnd);
    } else {
      if (target.fetch) return original;
      const before = toks[d[bound.first - 1]];
      const after = toks[d[bound.last + 1]];
      const joinsLeft = before?.type === "word" && (before.value === "where" || before.value === "having" || before.value === "and");
      const joinsRight = !after || after.type === "rp" || after.type === "word" && (after.value === "and" || CLAUSES.has(after.value));
      if (!joinsLeft || !joinsRight) return original;
      let clauseAt2 = -1;
      for (let j = bound.first - 1; j >= 0; j--) {
        const t2 = toks[d[j]];
        if (t2.type === "word" && (CLAUSES.has(t2.value) || t2.value === "on" || t2.value === "join")) {
          clauseAt2 = j;
          break;
        }
      }
      if (clauseAt2 < 0 || !["where", "having"].includes(toks[d[clauseAt2]].value)) return original;
      let clauseEnd = d.length;
      for (let j = clauseAt2 + 1; j < d.length; j++) {
        const t2 = toks[d[j]];
        if (t2.type === "word" && CLAUSES.has(t2.value)) {
          clauseEnd = j;
          break;
        }
      }
      if (d.slice(clauseAt2 + 1, clauseEnd).some((i) => isWord(toks[i], "or"))) return original;
      let cutStart = toks[d[bound.first]].start;
      let cutEnd = toks[d[bound.last]].end;
      if (before.value === "and") cutStart = before.start;
      else if (after?.type === "word" && after.value === "and") cutEnd = after.end;
      else cutStart = before.start;
      const left = out2.slice(0, cutStart).replace(/[ \t]+$/, "");
      const mid = out2.slice(cutEnd, sEnd).replace(/^[ \t]+/, "");
      const block = (left + (mid && !/^[\s)]/.test(mid) ? " " : "") + mid).trimEnd();
      next = `${block}${fetchSep(block)}${fetch}${out2.slice(sEnd)}`;
    }
    const nt = tokenize(next);
    const count = (ts, v) => ts.filter((t) => isWord(t, v)).length;
    if (count(nt, "fetch") !== count(toks, "fetch") + 1 || count(nt, "rownum") !== count(toks, "rownum") - 1) return original;
    out2 = next;
    changed = true;
  }
  return changed ? out2 : original;
}
function passThrough(toks, q) {
  const d = q.scope.direct;
  const w = (i) => toks[d[i]];
  if (!isWord(w(0), "select") || w(1)?.type !== "star" || !isWord(w(2), "from") || d[3] !== q.fromSource || w(4)?.type !== "rp") return false;
  if (d.length === 5) return true;
  if (d.length === 6) return w(5).type === "word" || w(5).type === "qid";
  return d.length === 7 && isWord(w(5), "as") && (w(6).type === "word" || w(6).type === "qid");
}
function fetchSep(text) {
  const ts = tokenize(text);
  const lastEnd = ts.length ? ts[ts.length - 1].end : 0;
  return text.slice(lastEnd).includes("--") ? "\n" : " ";
}
function dedent(s) {
  const lines = s.trim().split("\n");
  const ind = Math.min(...lines.slice(1).filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)[0].length));
  return Number.isFinite(ind) && ind > 0 ? [lines[0], ...lines.slice(1).map((l) => l.slice(ind))].join("\n") : lines.join("\n");
}
function fixLimit(sql) {
  const toks = tokenize(sql);
  if (toks.some((t, i) => isWord(t, "fetch") && (isWord(toks[i + 1], "first") || isWord(toks[i + 1], "next")))) return sql;
  let out2 = sql;
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i];
    const n = toks[i + 1];
    if (t.type !== "word" || t.value !== "limit" || n?.type !== "num" || toks[i - 1]?.type === "dot") continue;
    if (toks[i + 2]?.type === "comma") return sql;
    if (isWord(toks[i + 2], "offset") || isWord(toks[i - 2], "offset")) return sql;
    out2 = out2.slice(0, t.start) + `FETCH FIRST ${n.raw} ROWS ONLY` + out2.slice(n.end);
  }
  return out2;
}
function offsetPaging(sql) {
  const toks = tokenize(sql);
  if (toks.some((t, i2) => isWord(t, "limit") && toks[i2 + 1]?.type === "num" && toks[i2 - 1]?.type !== "dot")) return void 0;
  const offs = toks.map((t, i2) => isWord(t, "offset") && offsetKeyword(toks[i2 - 1], toks[i2 + 1]) ? i2 : -1).filter((i2) => i2 >= 0);
  if (offs.length !== 1) return void 0;
  const i = offs[0];
  if (toks[i].depth !== 0) return void 0;
  const n = intOf(toks[i + 1]);
  const m = intOf(toks[i + 5]);
  const rowsWord = (t) => isWord(t, "rows") || isWord(t, "row");
  if (n === void 0 || m === void 0 || !rowsWord(toks[i + 2]) || !isWord(toks[i + 3], "fetch")) return void 0;
  if (!(isWord(toks[i + 4], "next") || isWord(toks[i + 4], "first")) || !rowsWord(toks[i + 6]) || !isWord(toks[i + 7], "only")) return void 0;
  const rest = toks.slice(i + 8);
  if (rest.some((t) => t.type !== "semi")) return void 0;
  if (n <= 0 || m < 5 || n % m !== 0) return void 0;
  return { sql: sql.slice(0, toks[i].start).trimEnd(), pageSize: m, pageIndex: n / m };
}
function topFetchRows(sql) {
  const toks = tokenize(sql);
  let n;
  toks.forEach((t, i) => {
    if (t.depth === 0 && isWord(t, "fetch") && (isWord(toks[i + 1], "first") || isWord(toks[i + 1], "next"))) {
      const v = intOf(toks[i + 2]);
      if (v !== void 0 && (isWord(toks[i + 3], "rows") || isWord(toks[i + 3], "row")) && isWord(toks[i + 4], "only")) n = v;
    }
  });
  return n;
}
function nolintOf(description) {
  const out2 = { all: false, rules: /* @__PURE__ */ new Set() };
  for (const m of String(description ?? "").matchAll(/\[nolint(?::([^\]]*))?\]/gi)) {
    const names = (m[1] ?? "").split(/[\s,]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!names.length) out2.all = true;
    for (const n of names) out2.rules.add(n);
  }
  return out2;
}
function fixQuery(sql) {
  return fixRownum(fixLimit(sql));
}
function formatLint(r) {
  const lines = [];
  for (const e of r.errors) lines.push(`ERROR [${e.rule}] ${e.message}`);
  for (const w of r.warnings) lines.push(`WARN  [${w.rule}] ${w.message}`);
  if (r.fixed && r.paging) lines.push("", `Suggested fix: call with pageSize: ${r.paging.pageSize}, pageIndex: ${r.paging.pageIndex} and this query (the same rows the OFFSET asked for):`, r.fixed);
  else if (r.fixed) lines.push("", "Suggested fix:", r.fixed);
  return lines.join("\n") || "OK: no issues found.";
}

// src/hooks/pre.ts
var LARGE_RECORD = /* @__PURE__ */ new Set([...Object.values(TYPE_CODES), "transaction", "customer", "vendor", "employee", "item", "inventoryitem", "assemblyitem", "kititem", "project", "job"]);
function lintContextFor(ctx) {
  if (!ctx.acctDir) return {};
  const acctDir = ctx.acctDir;
  const m = loadManifest(acctDir);
  const fresh = (name) => {
    const e = m.sections[safeSectionName(name)];
    return isFresh(e, ctx.cfg, name) && e.status === "ok";
  };
  const rows = /* @__PURE__ */ new Map();
  const tableRows = (table) => {
    if (!rows.has(table)) {
      const name = `fields/${table}`;
      rows.set(table, fresh(name) ? readIndex(acctDir, name).rows : void 0);
    }
    return rows.get(table);
  };
  const lc2 = {
    fields: (table) => {
      const r = tableRows(table);
      return r && new Set(r.map((x) => (x[0] ?? "").toLowerCase()).filter(Boolean));
    },
    fieldType: (table, column) => tableRows(table)?.find((r) => (r[0] ?? "").toLowerCase() === column)?.[1]?.toLowerCase() || void 0
  };
  if (fresh("recordtypes")) lc2.recordTypes = new Set(readIndex(acctDir, "recordtypes").rows.map((r) => (r[0] ?? "").toLowerCase()));
  const p = loadProfile(acctDir);
  if (p?.approvalWorkflows && Object.keys(p.approvalWorkflows).length) lc2.approvalWorkflows = p.approvalWorkflows;
  const curs = new Set(
    [...Object.values(p?.subsidiaryCurrencies ?? {}), ...(p?.ttmRevenueBySubsidiary ?? []).map((x) => x.currency ?? "")].map((c) => c.trim().toUpperCase()).filter(Boolean)
  );
  if (curs.size > 1) lc2.multiCurrencySubsidiaries = true;
  return lc2;
}
function out(d) {
  if (!d.decision && !d.updatedInput && !d.context.length) return void 0;
  const hso = { hookEventName: "PreToolUse" };
  if (d.decision) {
    hso.permissionDecision = d.decision;
    hso.permissionDecisionReason = d.reason;
  }
  if (d.updatedInput && d.decision !== "deny") hso.updatedInput = d.updatedInput;
  if (d.context.length) hso.additionalContext = d.context.join("\n");
  return { json: { hookSpecificOutput: hso } };
}
function bestEffort(fn) {
  try {
    return fn();
  } catch (err) {
    logHookError("pre:bookkeeping", err);
    return void 0;
  }
}
function failClosedForWrites(input) {
  const tool = nsToolName(input.tool_name ?? "");
  if (!tool || !isWriteTool(tool)) return void 0;
  return out({
    decision: "deny",
    reason: "[su-ns-harness] This NetSuite write was blocked because su-ns-harness could not check it (internal error). Don't retry it as is: run the su-ns-harness:doctor skill (it shows the logged error, when one could be written), fix the problem, then try again.",
    context: []
  });
}
var RANGE_VALUES = /^(month|quarter|year|week|day)$/i;
function sessionStartFired(data, session) {
  const hb = readJson(path12.join(data, "heartbeat.json"), {});
  const e = hb?.["session-start"];
  return !!e && (e.session === session || !!(e.sessions && typeof e.sessions === "object" && session in e.sessions));
}
function missedSessionContext(input, ctx) {
  const session = input.session_id ?? "";
  if (!session || !ctx.data || sessionStartFired(ctx.data, session)) return void 0;
  const dir = ensureDir(sessionDir(ctx.data, session));
  try {
    fs11.closeSync(fs11.openSync(path12.join(dir, "session-context-sent"), "wx"));
  } catch {
    return void 0;
  }
  return `[su-ns-harness] SessionStart didn't run in this session (the plugin was loaded mid-session, e.g. with /reload-plugins), so here is its context:
${sessionContext(ctx)}`;
}
function handlePre(input, ctx = context(input.tool_name)) {
  const res = guard(input, ctx);
  if (!nsToolName(input.tool_name ?? "") || res?.json?.hookSpecificOutput?.permissionDecision === "deny") return res;
  const intro = bestEffort(() => missedSessionContext(input, ctx));
  if (!intro) return res;
  const hso = { hookEventName: "PreToolUse", ...res?.json?.hookSpecificOutput ?? {} };
  hso.additionalContext = [intro, hso.additionalContext].filter((x) => typeof x === "string" && x).join("\n");
  return { ...res, json: { ...res?.json ?? {}, hookSpecificOutput: hso } };
}
function guard(input, ctx) {
  const tool = nsToolName(input.tool_name ?? "");
  if (!tool) return void 0;
  const server = connectorServer(input.tool_name);
  if (server) bestEffort(() => recordConnector(ctx.data, server));
  bestEffort(() => heartbeat(ctx.data, input.session_id ?? "", "pre"));
  const session = input.session_id ?? "";
  const ti = { ...input.tool_input ?? {} };
  const d = { context: [] };
  const auditBase = ctx.acctDir ? ctx.acctDir : path12.join(ctx.data, "accounts", "_unconfigured");
  const deny = (reason, note) => {
    if (input.tool_use_id) bestEffort(() => endCall(ctx.data, session, input.tool_use_id));
    bestEffort(() => appendAudit(auditBase, { ts: (/* @__PURE__ */ new Date()).toISOString(), session, tool, input: ti, outcome: "denied", note }));
    return out({ decision: "deny", reason: `[su-ns-harness] ${reason}`, context: [] });
  };
  if (isWriteTool(tool)) {
    const unknownTool = !KNOWN_WRITE_TOOL.test(tool) ? `${tool} is an unknown NetSuite tool: treated as a write. ` : "";
    if (ctx.cfg.read_only) {
      return deny(
        `${unknownTool}Writes are disabled (read_only = true). Do not retry, and don't change the setting yourself. If the user wants NetSuite writes, they turn them on in their own terminal: ${cliCommand()} config set read_only=false (applies to the next call, no restart).`,
        "read_only"
      );
    }
    const ext = (v) => typeof v === "string" ? v.trim() !== "" : typeof v === "number";
    const sub = (k) => ti[k] && typeof ti[k] === "object" ? ti[k].externalId : void 0;
    if (/create/i.test(tool) && !ext(ti.externalId) && !ext(sub("values")) && !ext(sub("fields")) && !ext(sub("data"))) {
      return deny("Set externalId on every create so a retried call cannot create a duplicate record. Add a stable externalId (e.g. 'claude-<purpose>-<date>-<n>') and call again.", "missing_externalId");
    }
    const base = ctx.acctDir ?? ctx.data;
    const pv = findPreview(base, tool, ti);
    if (!pv) {
      return deny(
        `Writes need a preview first. Pipe the exact tool input to: nsx preview ${tool} -   (add --before <file.json> with the current record from ns_getRecord for updates). Show the user the diff it prints, then make this same call again with identical input (hash ${previewHash(tool, ti)}).`,
        "missing_preview"
      );
    }
    bestEffort(() => appendAudit(auditBase, { ts: (/* @__PURE__ */ new Date()).toISOString(), session, tool, input: ti, outcome: "pending", note: "awaiting user approval" }));
    const file = path12.join(previewsDir(base), `${previewHash(tool, ti)}.json`);
    const notes = [];
    const before = pv.before && typeof pv.before === "object" && !Array.isArray(pv.before) ? pv.before : void 0;
    const diff2 = diffLines(tool, ti, before);
    if (!/create/i.test(tool) && !before) notes.push("No before-state supplied: values shown are what will be written; old values unknown.");
    if (unknownTool) notes.push(`${tool} isn't a tool su-ns-harness knows: check what it does before approving.`);
    if (diff2.length > 15) notes.push(`\u2026 ${diff2.length - 15} more changes. Full input: ${file}`);
    return out({
      decision: "ask",
      reason: `[su-ns-harness] NetSuite WRITE: ${describeTarget(tool, ti)}
${[...diff2.slice(0, 15), ...notes].join("\n")}`,
      context: ["After this write succeeds, verify it by reading the record back with ns_getRecord (fields=\u2026)."]
    });
  }
  const inputHash = sha256(`${tool}
${canonicalJson(ti)}`).slice(0, 16);
  if (input.tool_use_id) {
    const others = bestEffort(() => beginCall(ctx.data, session, input.tool_use_id, { tool, startedAt: Date.now(), inputHash })) ?? [];
    if (others.length) {
      d.context.push(`[su-ns-harness] ${others.length} other NetSuite call(s) in flight (${others.join(", ")}). The account's concurrency limit is small: run NetSuite calls one at a time, not in parallel.`);
    }
  }
  if (tool === "ns_runCustomSuiteQL") {
    if (typeof ti.sqlQuery !== "string" || !ti.sqlQuery.trim()) {
      const keys = Object.keys(ti).filter((k) => k !== "sqlQuery");
      const what = ti.sqlQuery === void 0 || ti.sqlQuery === null ? "No `sqlQuery` in the input" : typeof ti.sqlQuery !== "string" ? `\`sqlQuery\` must be a string (got ${Array.isArray(ti.sqlQuery) ? "an array" : `a ${typeof ti.sqlQuery}`})` : "`sqlQuery` is empty";
      return deny(
        `${what}${keys.length ? ` (got: ${keys.join(", ")})` : ""}. ns_runCustomSuiteQL takes the SQL text in \`sqlQuery\`; call again with it.`,
        "missing_sqlQuery"
      );
    }
    const blank2 = (v) => v === void 0 || v === null || v === "";
    for (const key of ["pageSize", "pageIndex"]) {
      const v = ti[key];
      const ok = blank2(v) || (typeof v === "number" || typeof v === "string") && Number.isInteger(Number(v)) && Number(v) >= 0;
      if (!ok) {
        return deny(`${key} must be a whole number \u2265 0 (got ${JSON.stringify(v)}). Omit it to get the default, or pass a number.`, `bad_${key}`);
      }
    }
    const sql = ti.sqlQuery;
    const tag = descriptionTag(ti);
    const probe = !!tag && isCanonicalProbe(tag, sql);
    const nl = nolintOf(ti.description);
    const nolint = nl.all;
    const lc2 = lintContextFor(ctx);
    const res = probe ? { errors: [], warnings: [] } : lintSuiteQL(sql, lc2);
    const hard = res.errors.filter((e) => HARD_RULES.has(e.rule));
    if (hard.length) {
      const msg = hard.some((e) => e.rule === "not-select") ? `${formatLint(res)}
Don't retry.` : `${formatLint(res)}
[nolint] doesn't apply to this rule: the result would always be wrong. Fix the query and call again.`;
      return deny(msg, hard.map((e) => e.rule).join(","));
    }
    const overridden = res.errors.filter((e) => nl.all || nl.rules.has(e.rule));
    const blocking = res.errors.filter((e) => !overridden.includes(e));
    if (blocking.length) {
      return deny(
        `SuiteQL check failed \u2014 fix and call again (only if you are sure an error is a false positive, add [nolint:<rule>] (or [nolint] for all) to the description, not to sqlQuery):
${formatLint(res)}`,
        blocking.map((e) => e.rule).join(",")
      );
    }
    if (overridden.length) {
      d.context.push(`[su-ns-harness] [nolint] overrode these SuiteQL errors; the query runs as written, so check the result against them:
${overridden.map((e) => `- [${e.rule}] ${e.message}`).join("\n")}`);
    }
    const warns = res.warnings.map((w) => w.message);
    if (Number(ti.pageIndex) > 0 && pagingOrderMissing(sql)) warns.push("Paging needs a unique ORDER BY (e.g. ORDER BY t.id) or pages can overlap or skip rows.");
    if (warns.length) d.context.push(`[su-ns-harness] SuiteQL warnings:
${warns.map((w) => `- ${w}`).join("\n")}`);
    const unknown = unknownColumns(res);
    if (unknown.length && input.tool_use_id) {
      bestEffort(() => {
        const st = loadState(ctx.data, session);
        rememberUnknownCols(st, input.tool_use_id, unknown);
        saveState(ctx.data, session, st);
      });
    }
    if (ctx.acctDir && lc2.recordTypes?.size) {
      const known = lc2.recordTypes;
      const tables = tablesInSql(sql);
      const hidden = nolint ? [] : tables.filter((t) => !known.has(t));
      if (hidden.length && probe && tag?.startsWith("profile:")) {
        return deny(
          `Skip this profile probe: ${hidden.map((t) => `'${t}'`).join(", ")} is not in this account's SuiteQL record-type list, so the connector role can't query it. Don't retry; note it as unknown for the Profile Card and go on to the next probe.`,
          "probe_table_hidden"
        );
      }
      if (hidden.length) {
        return deny(
          `${hidden.map((t) => `'${t}'`).join(", ")} ${hidden.length > 1 ? "aren't" : "isn't"} in this account's SuiteQL record-type list, so ${hidden.length > 1 ? "they aren't" : "it isn't"} exposed to the connector role (the call would fail with "Record '${hidden[0]}' was not found"). Don't retry and don't refresh reports or searches: find the data in another table (nsx recordtypes --grep <term>), or ask a NetSuite admin to grant the role access. Only if you know the cached list is outdated, add [nolint] to the description.`,
          "table_not_exposed"
        );
      }
      const m = loadManifest(ctx.acctDir);
      const uncached = tables.filter((t) => known.has(t) && !m.sections[safeSectionName(`fields/${t}`)]);
      const state = probe ? void 0 : bestEffort(() => loadState(ctx.data, session));
      if (state && uncached.length) {
        const asked = state.metadataAsked ??= [];
        const ask = uncached.filter((t) => !asked.includes(t));
        if (ask.length) {
          asked.push(...ask);
          bestEffort(() => saveState(ctx.data, session, state));
          return deny(
            `Field metadata for ${ask.map((t) => `'${t}'`).join(", ")} isn't cached yet. First call ns_getSuiteQLMetadata with recordType ${ask.map((t) => `"${t}"`).join(", then ")} (one call at a time; each result is cached automatically), check column names with nsx fields <table> --grep <term>, then run this query again.`,
            "fields_not_cached"
          );
        }
      }
    }
    if (!probe) {
      const fetchN = topFetchRows(sql);
      const dflt = fetchN !== void 0 && fetchN <= 1e3 ? Math.max(fetchN, 5) : ctx.cfg.suiteql_default_page_size;
      const size = blank2(ti.pageSize) ? dflt : ti.pageSize;
      const clamped = Number.isFinite(Number(size)) && Number(size) < 5 ? 5 : size;
      if (clamped !== size) d.context.push(`[su-ns-harness] pageSize raised to 5: the connector's minimum page size is 5 (smaller values return 5 rows anyway).`);
      if (clamped !== ti.pageSize || blank2(ti.pageIndex)) d.updatedInput = { ...ti, pageSize: clamped, pageIndex: blank2(ti.pageIndex) ? 0 : ti.pageIndex };
    }
  }
  if (tool === "ns_runSavedSearch") {
    const upd = { ...ti };
    let changed = false;
    if (ti.range_end === void 0 || ti.range_end === null || ti.range_end === "") {
      const n = ctx.cfg.saved_search_default_rows;
      const start = Number(ti.range_start ?? 0);
      const from = Number.isFinite(start) && start >= 0 ? start : 0;
      Object.assign(upd, { range_start: from, range_end: from + n });
      changed = true;
      d.context.push(`[su-ns-harness] Saved search limited to ${n} rows (range_end added). If the user needs more, pass range_start/range_end explicitly.`);
    }
    if ((ti.type === void 0 || ti.type === null || ti.type === "") && ctx.acctDir) {
      const rt = bestEffort(() => cachedSearchRecordType(ctx.acctDir, ti.searchId));
      const std = rt ? STANDALONE_SEARCH_TYPES[rt.toLowerCase()] : void 0;
      if (std) {
        upd.type = std;
        changed = true;
        d.context.push(`[su-ns-harness] type: "${std}" added: the searches cache says this is a '${rt}' search, which the connector can't run without it.`);
      }
    }
    if (changed) d.updatedInput = upd;
  }
  if (tool === "ns_runReport" && ti.range !== void 0 && ti.range !== null && ti.range !== "") {
    const upd = { ...d.updatedInput ?? ti };
    const supported = ctx.acctDir ? bestEffort(() => reportSupportsRange(ctx.acctDir, ti.reportId)) : void 0;
    if (supported === false) {
      delete upd.range;
      d.updatedInput = upd;
      d.context.push(`[su-ns-harness] report ${String(ti.reportId)} doesn't support range (column grouping); removed.`);
    } else if (typeof ti.range === "string") {
      const v = ti.range.trim();
      if (RANGE_VALUES.test(v) && v.toLowerCase() !== ti.range) {
        upd.range = v.toLowerCase();
        d.updatedInput = upd;
        d.context.push(`[su-ns-harness] range ${JSON.stringify(ti.range)} \u2192 ${JSON.stringify(upd.range)} (the connector only accepts lowercase).`);
      }
    }
  }
  if (tool === "ns_getRecord") {
    const f = ti.fields;
    const type = String(ti.recordType ?? "").toLowerCase();
    const norm = normaliseFields(f);
    if (f === "*" || f === "[full]") {
      const { fields: _drop, ...rest } = ti;
      d.updatedInput = rest;
    } else if (norm !== void 0 && norm !== "" && norm !== f) {
      d.updatedInput = { ...ti, fields: norm };
    } else if ((f === void 0 || f === null || f === "") && LARGE_RECORD.has(type)) {
      return deny(
        `A full ${type} record (all fields + sublists) is very large. Pass fields as a comma-separated list (see: nsx fields ${type} --record), or set fields to "[full]" if you really need everything.`,
        "getRecord_no_fields"
      );
    }
  }
  return out(d);
}

// src/results/xlsx.ts
import { deflateRawSync } from "node:zlib";
var CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 4294967295;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const body = deflateRawSync(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(67324752, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(2048, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(33639248, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(2048, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt32LE(0, 12);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + body.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(101010256, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}
var esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
function colRef(i) {
  let s = "";
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s;
  return s;
}
function toXlsx(columns, rows, numericCols) {
  const rowXml = (vals, r, header) => `<row r="${r}">${vals.map((v, i) => {
    const ref = `${colRef(i)}${r}`;
    if (v === null || v === void 0 || v === "") return "";
    const n = !header && numericCols.has(columns[i]) ? toNumber(v) : void 0;
    return n !== void 0 ? `<c r="${ref}"><v>${n}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(String(v))}</t></is></c>`;
  }).join("")}</row>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${colRef(Math.max(0, columns.length - 1))}${rows.length + 1}"/><sheetData>` + rowXml(columns, 1, true) + rows.map((r, i) => rowXml(columns.map((c) => r[c]), i + 2, false)).join("") + `</sheetData></worksheet>`;
  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
    },
    { name: "xl/worksheets/sheet1.xml", data: sheet }
  ];
  return zip(files.map((f) => ({ name: f.name, data: Buffer.from(f.data, "utf8") })));
}

// src/cli.ts
var UsageError = class extends Error {
  name = "UsageError";
};
var BOOLEAN_FLAGS = /* @__PURE__ */ new Set(["asc", "any-account", "open", "years", "record", "preflight", "help", "version"]);
function parseArgs(argv) {
  const pos = [];
  const flags = {};
  const multi = {};
  const set = (k, v) => {
    flags[k] = v;
    (multi[k] ??= []).push(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) set(a.slice(2, eq), a.slice(eq + 1));
      else if (!BOOLEAN_FLAGS.has(a.slice(2)) && argv[i + 1] !== void 0 && !argv[i + 1].startsWith("--")) set(a.slice(2), argv[++i]);
      else set(a.slice(2), true);
    } else pos.push(a);
  }
  return { pos, flags, multi };
}
var WHERE = ["where", "any-account"];
var COMMAND_FLAGS = {
  reports: ["max"],
  searches: ["max"],
  recordtypes: ["grep", "max"],
  fields: ["grep", "record", "max"],
  periods: ["open", "years", "grep", "max"],
  "cache status": [],
  "cache show": ["grep", "max"],
  "cache build": [],
  "cache invalidate": [],
  "profile show": [],
  "profile set": [],
  "profile ttm-report": [],
  "profile from-report": [],
  "results list": ["n", "any-account"],
  "results schema": ["any-account"],
  "results head": ["cols", "n", "sort", "asc", "max", ...WHERE],
  "results filter": ["cols", "sort", "asc", "max", ...WHERE],
  "results agg": ["by", "sum", "avg", "min", "max", "count", "top", "sort", "asc", ...WHERE],
  "results pivot": ["rows", "cols", "sum", "avg", "min", "max", "count", ...WHERE],
  "results diff": ["on", "cols", "tolerance", "top", "max", ...WHERE],
  "results concat": ["any-account"],
  "results export": ["csv", "xlsx", "out", "sort", "asc", ...WHERE],
  "results raw": ["grep", "head", "any-account"],
  "results path": ["any-account"],
  sql: [],
  preview: ["before"],
  "audit export": ["session", "days", "out"],
  "audit tail": ["n", "session", "days"],
  "config show": [],
  "config set": [],
  doctor: ["preflight"],
  version: []
};
var DEFAULT_SUB = { cache: "status", profile: "show", results: "list", audit: "export", config: "show" };
var COMMANDS = ["reports", "searches", "recordtypes", "fields", "periods", "cache", "profile", "results", "sql", "preview", "audit", "config", "doctor", "version", "help"];
var SUBCOMMANDS = {
  cache: ["status", "show", "build", "invalidate"],
  profile: ["show", "set", "ttm-report", "from-report"],
  results: ["list", "schema", "head", "filter", "agg", "pivot", "diff", "concat", "export", "raw", "path"],
  audit: ["export", "tail"],
  config: ["show", "set"]
};
var MAX_POS = {
  periods: 0,
  "cache status": 0,
  "cache show": 1,
  "cache build": 0,
  "cache invalidate": 1,
  "profile show": 0,
  "profile ttm-report": 0,
  "profile from-report": 1,
  "results list": 0,
  "results schema": 1,
  "results head": 2,
  "results filter": 1,
  "results agg": 1,
  "results pivot": 1,
  "results diff": 2,
  "results export": 1,
  "results raw": 1,
  "results path": 1,
  preview: 2,
  "audit export": 0,
  "audit tail": 0,
  "config show": 0,
  doctor: 0,
  version: 0,
  help: 1
};
var NUMBER_FLAG = { periods: "--max", "results list": "--n", "audit tail": "--n", "cache show": "--max" };
var VALUE_HINT = {
  where: '--where "amount>10000"',
  cols: "--cols a,b",
  grep: "--grep term",
  by: "--by col",
  rows: "--rows col",
  on: "--on key",
  out: "--out file",
  before: "--before current.json",
  days: "--days 7",
  n: "--n 10",
  head: "--head 40",
  max: "--max 100"
};
var NUMERIC = { n: "int", max: "int", head: "int", days: "num" };
var MAX_IS_METRIC = /* @__PURE__ */ new Set(["results agg", "results pivot"]);
var USAGE = {
  reports: "nsx reports search <terms\u2026> [--max N]",
  searches: "nsx searches search <terms\u2026> [--max N]",
  recordtypes: "nsx recordtypes [term\u2026] [--grep t|t2] [--max N]",
  fields: "nsx fields <table> [term\u2026] [--grep t] [--record] [--max N]",
  periods: "nsx periods [--open|--years] [--grep t] [--max N]",
  cache: "nsx cache status | cache show <section> [--grep t] [--max N] | cache build | cache invalidate <section|kind|all>",
  profile: "nsx profile show | profile set key=value\u2026 | profile ttm-report | profile from-report <result id>",
  results: 'nsx results list [--n N] | results schema|head|filter|agg|pivot|export|raw|path <id> \u2026 | results diff <idA> <idB> --on k --cols c | results concat <id> <id>\u2026\n  head <id> [N] [--n N] [--cols a,b] [--where "\u2026"] [--sort col [--asc]]   filter <id> --where "\u2026"\n  agg <id> --by col --sum|--avg|--min|--max col [--count] [--top N]   pivot <id> --rows col --cols col (--sum col|--count)\n  export <id> --csv [path] | --xlsx [path]   raw <id> [--grep t] [--head N]   path <id>   (--any-account: look in other accounts too)',
  sql: 'nsx sql lint <file|-|"sql"> | sql fix-rownum <file|-|"sql">   (- reads stdin)',
  preview: "echo '<tool input json>' | nsx preview <ns_write_tool> - [--before current.json]   (or a JSON file instead of -)",
  audit: "nsx audit export [--session [id]] [--days N] [--out file] | audit tail [--n N] [--session [id]] [--days N]",
  config: "nsx config show | config set key=value\u2026   (empty value = default; read_only=false only from your own terminal)",
  doctor: "nsx doctor [--preflight]",
  version: "nsx version   (or --version, -v)",
  help: "nsx help [command]   (or <command> --help)"
};
function guess(w, known) {
  return known.find((k) => k.startsWith(w) || w.startsWith(k)) ?? known.find((k) => near(w, k));
}
function normalizeArgv(argv) {
  const short = { "-n": "--n", "-h": "--help", "-v": "--version", "-V": "--version" };
  return argv[0] === "hook" ? argv : argv.map((t) => short[t] ?? t);
}
function near(a, b) {
  if (Math.abs(a.length - b.length) > 2) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] <= 2;
}
function checkFlags(a) {
  const cmd = a.pos[0];
  if (!cmd || cmd === "hook") return;
  if (!COMMANDS.includes(cmd)) {
    const g = guess(cmd, COMMANDS);
    throw new UsageError(`unknown command '${cmd}'.${g ? ` Did you mean '${g}'?` : ""} Commands: ${COMMANDS.join(", ")} (nsx --help)`);
  }
  const subs = SUBCOMMANDS[cmd];
  if (subs && a.pos[1] !== void 0 && !subs.includes(a.pos[1])) {
    const g = guess(a.pos[1], subs);
    throw new UsageError(`unknown ${cmd} subcommand '${a.pos[1]}'.${g ? ` Did you mean '${g}'?` : ""} usage: ${USAGE[cmd]}`);
  }
  const sub = a.pos[1] ?? DEFAULT_SUB[cmd];
  const scope = Object.hasOwn(COMMAND_FLAGS, `${cmd} ${sub}`) ? `${cmd} ${sub}` : Object.hasOwn(COMMAND_FLAGS, cmd) ? cmd : void 0;
  if (!scope) return;
  const dash = a.pos.find((t) => /^-[A-Za-z]/.test(t));
  if (dash) throw new UsageError(`unknown option ${dash}: flags take two dashes (--${dash.replace(/^-+/, "")}). usage: ${USAGE[cmd]}`);
  const allowed = COMMAND_FLAGS[scope];
  const bad = Object.keys(a.flags).filter((f) => !allowed.includes(f));
  if (bad.length) {
    const g = bad.length === 1 ? allowed.find((f) => f.startsWith(bad[0]) || bad[0].startsWith(f) || near(bad[0], f)) : void 0;
    throw new UsageError(
      `unknown flag${bad.length > 1 ? "s" : ""} ${bad.map((f) => `--${f}`).join(", ")} for ${scope} (${allowed.length ? `flags: ${allowed.map((f) => `--${f}`).join(", ")}` : "it takes no flags"})${g ? `. Did you mean --${g}?` : ""}`
    );
  }
  for (const [f, v] of Object.entries(a.flags)) {
    const metric = f === "max" && MAX_IS_METRIC.has(scope);
    if (Object.hasOwn(VALUE_HINT, f) && !metric && (v === true || v.trim() === "")) throw new UsageError(`--${f} needs a value: ${VALUE_HINT[f]}`);
    const kind = metric ? void 0 : NUMERIC[f];
    if (kind && typeof v === "string") {
      const n = Number(v);
      const ok = kind === "int" ? /^\d+$/.test(v.trim()) && n >= 1 : Number.isFinite(n) && n > 0;
      if (!ok) throw new UsageError(`--${f} must be a positive ${kind === "int" ? "whole number" : "number"}, got '${v}'`);
    }
  }
  if (Object.hasOwn(MAX_POS, scope)) {
    const own = scope.includes(" ") && a.pos[1] !== void 0 ? 2 : 1;
    const extra = a.pos.slice(own + MAX_POS[scope]);
    if (extra.length) {
      const year = scope === "periods" && /^(19|20)\d\d$/.test(extra[0] ?? "");
      const hint = NUMBER_FLAG[scope] && extra.length === 1 && /^\d+$/.test(extra[0]) ? ` Did you mean ${year ? "--grep" : NUMBER_FLAG[scope]} ${extra[0]}?` : "";
      throw new UsageError(`unexpected argument${extra.length > 1 ? "s" : ""} ${extra.map((x) => `'${x}'`).join(" ")} for ${scope}.${hint} usage: ${USAGE[cmd]}`);
    }
  }
  if (scope === "results head" && a.pos[3] !== void 0 && !/^\d+$/.test(a.pos[3])) {
    throw new UsageError(`results head takes a row count after the id, got '${a.pos[3]}'. usage: nsx results head <id> [N] [--where "\u2026"]`);
  }
}
var flag = (a, k) => typeof a.flags[k] === "string" ? a.flags[k] : void 0;
var num2 = (a, k, dflt) => {
  const v = Number(flag(a, k));
  return flag(a, k) !== void 0 && Number.isFinite(v) && v >= 0 ? v : dflt;
};
var list = (s) => s ? s.split(",").map((x) => x.trim()).filter(Boolean) : [];
function readInput(src) {
  if (!src) throw new UsageError(`no input given: pass a file, - to read stdin, or the text itself ("SELECT \u2026" / '{"\u2026": \u2026}')`);
  if (src === "-") return fs12.readFileSync(0, "utf8");
  if (fs12.existsSync(src) && fs12.statSync(src).isFile()) return fs12.readFileSync(src, "utf8");
  if (/^\s*[\[{(]|^\s*(select|with)\b/i.test(src) || /\s/.test(src.trim())) return src;
  throw new UsageError(`No such file: ${src}`);
}
function needAcct(ctx) {
  if (!ctx.acctDir) throw new UsageError("No NetSuite connector call seen yet, so there is no cache to read. Run the su-ns-harness:init skill yourself (it needs nothing from the user), or make any ns_* call, first.");
  return ctx.acctDir;
}
function freshness(ctx, acctDir, section) {
  const e = loadManifest(acctDir).sections[safeSectionName(section)];
  if (!e) return "";
  const age = ageLabel(Date.now() - Date.parse(e.fetchedAt));
  return isFresh(e, ctx.cfg, section) ? `(cached ${age} ago)` : `(STALE: cached ${age} ago${e.staleReason ? `, ${e.staleReason}` : ""} \u2014 refresh before relying on it)`;
}
function searchRows(header, rows, terms) {
  const want = terms.map((t) => t.toLowerCase().split("|").map((x) => x.trim()).filter(Boolean)).filter((alts) => alts.length);
  const hits = rows.filter((r) => {
    const line = r.join(" ").toLowerCase();
    return want.every((alts) => alts.some((w) => line.includes(w)));
  });
  const phrase = want.length === 1 ? want[0] : want.length ? [terms.join(" ").toLowerCase()] : [];
  const rank = (r) => {
    let best = 3;
    for (const cell2 of r) {
      const c = cell2.toLowerCase();
      for (const w of phrase) best = Math.min(best, c === w ? 0 : c.startsWith(w) ? 1 : c.includes(w) ? 2 : 3);
    }
    return best;
  };
  const nameCol = ["title", "name", "recordtype", "field"].map((n) => header.indexOf(n)).find((i) => i >= 0) ?? 0;
  const ranked = hits.map((r) => ({ r, k: rank(r) }));
  ranked.sort((a, b) => a.k - b.k || (a.r[nameCol] ?? "").length - (b.r[nameCol] ?? "").length || (a.r[nameCol] ?? "").localeCompare(b.r[nameCol] ?? ""));
  return ranked.map((x) => x.r);
}
function search(ctx, acctDir, section, terms, max, missHint) {
  const ix = readIndex(acctDir, section);
  if (!ix.header.length) return `No ${section} cached. ${missHint}`;
  const hits = searchRows(ix.header, ix.rows, terms);
  const shown = hits.slice(0, max);
  const note = shown.length < hits.length ? ` (showing ${shown.length}; --max N for more)` : "";
  const head = `${hits.length} of ${ix.rows.length} ${section} match ${terms.length ? `"${terms.join(" ")}" (substring; a|b = either)` : "(all)"}${note} ${freshness(ctx, acctDir, section)}`;
  if (!hits.length) return `${head}
No match. Try fewer/other terms; if it should exist, the cache may be outdated: ${missHint}`;
  return `${head}
${textTable(ix.header, shown, shown.length, { full: ["params"] })}`;
}
function cmdFields(ctx, a) {
  const acctDir = needAcct(ctx);
  const table = (a.pos[1] ?? "").toLowerCase();
  if (!table) throw new UsageError(`usage: ${USAGE.fields}`);
  const section = a.flags.record ? `recordmeta/${table}` : `fields/${table}`;
  if (loadManifest(acctDir).sections[safeSectionName(section)]?.status === "empty") return `${emptyFieldsNote(acctDir, table)} ${freshness(ctx, acctDir, section)}`;
  const ix = readIndex(acctDir, section);
  if (!ix.header.length) {
    return `Fields for '${table}' not cached. Call ${a.flags.record ? `ns_getRecordTypeMetadata with recordType "${table}"` : `ns_getSuiteQLMetadata with recordType "${table}"`} once \u2014 the result is cached automatically \u2014 then re-run this.`;
  }
  const terms = [flag(a, "grep"), ...a.pos.slice(2)].filter((t) => !!t);
  const rows = terms.length ? searchRows(ix.header, ix.rows, terms) : ix.rows;
  return `${rows.length} of ${ix.rows.length} fields in ${table}${terms.length ? ` matching "${terms.join(" ")}"` : ""} ${freshness(ctx, acctDir, section)}
${textTable(ix.header, rows, num2(a, "max", 60))}`;
}
function cmdPeriods(ctx, a) {
  const acctDir = needAcct(ctx);
  const ix = readIndex(acctDir, "periods");
  if (!ix.header.length) return "Periods not cached. Run the su-ns-harness:refresh skill yourself (sections: periods); it has the exact tagged query.";
  const c = (n) => ix.header.indexOf(n);
  const yes = (r, n) => /^(t|true|y|1)$/i.test(r[c(n)] ?? "");
  let rows = ix.rows;
  if (a.flags.open) {
    const open = rows.filter((r) => !yes(r, "closed") && !yes(r, "isyear") && !yes(r, "isquarter") && !yes(r, "isadjust")).map((r) => ({ r, s: parseDate(r[c("startdate")] ?? "")?.getTime() ?? Infinity, e: parseDate(r[c("enddate")] ?? "")?.getTime() })).sort((x, y) => x.s - y.s);
    const current = open.filter((x) => (x.e ?? x.s) >= Date.now() - 365 * 864e5);
    rows = (current.length ? current : open).map((x) => x.r);
  }
  if (a.flags.years) rows = rows.filter((r) => yes(r, "isyear"));
  const g = flag(a, "grep")?.toLowerCase();
  if (g) rows = rows.filter((r) => r.join(" ").toLowerCase().includes(g));
  const max = num2(a, "max", a.flags.open ? 6 : 40);
  const shown = a.flags.open ? rows.slice(0, max) : rows.slice(-max);
  const note = shown.length < rows.length ? ` (showing the ${a.flags.open ? "earliest" : "latest"} ${shown.length}; --max N for more)` : "";
  return `${rows.length} period${rows.length === 1 ? "" : "s"}${note} ${freshness(ctx, acctDir, "periods")}
${textTable(ix.header, shown, shown.length)}`;
}
function cmdCache(ctx, a) {
  const sub = a.pos[1] ?? "status";
  const acctDir = needAcct(ctx);
  if (sub === "status") {
    const m = loadManifest(acctDir);
    const rows = Object.entries(m.sections).sort(([x], [y]) => x.localeCompare(y)).map(([n, e]) => [n, String(e.count), e.status === "ok" && !isFresh(e, ctx.cfg, n) ? "stale" : e.status, ageLabel(Date.now() - Date.parse(e.fetchedAt)), `${ttlDaysFor(ctx.cfg, n)}d`, e.sourceTool]);
    if (!rows.length) return `Cache for ${accountLabel(ctx)} is empty. Run the su-ns-harness:init skill yourself (it needs nothing from the user).`;
    const stale = staleSections(m, ctx.cfg).length;
    return `Cache ${accountLabel(ctx)}: ${rows.length} sections, ${stale} stale
${textTable(["section", "count", "status", "age", "ttl", "source"], rows, 500)}`;
  }
  if (sub === "show") {
    const name = a.pos[2];
    if (!name) throw new UsageError("usage: nsx cache show <section> [--grep term]");
    if (loadManifest(acctDir).sections[safeSectionName(name)]?.status === "empty") {
      const [kind, table] = name.split("/");
      return (kind === "fields" || kind === "recordmeta") && table ? emptyFieldsNote(acctDir, table) : `Section '${name}' is empty: the call worked but returned nothing.`;
    }
    const ix = readIndex(acctDir, name);
    if (!ix.header.length) {
      const raw = readRaw(acctDir, name);
      if (raw === void 0) {
        const have = Object.keys(loadManifest(acctDir).sections).sort();
        const kind = name.split("/")[0];
        const alike = have.filter((n) => n.split("/")[0] === kind);
        const listed = (alike.length ? alike : have).slice(0, 30);
        return `Section '${name}' not cached.${have.length ? ` Cached${alike.length ? ` ${kind} sections` : ""}: ${listed.join(", ")}${(alike.length || have.length) > listed.length ? ", \u2026" : ""} (nsx cache status lists all)` : " Nothing is cached yet."}`;
      }
      const s = typeof raw === "string" ? raw : JSON.stringify(raw);
      return `Section '${name}' is unparsed; raw (first 3000 chars):
${s.slice(0, 3e3)}`;
    }
    const g = flag(a, "grep");
    const rows = g ? searchRows(ix.header, ix.rows, [g]) : ix.rows;
    return `${rows.length} rows in ${name} ${freshness(ctx, acctDir, name)}
${textTable(ix.header, rows, num2(a, "max", 60))}`;
  }
  if (sub === "build") {
    const p = buildProfile(acctDir);
    const m = loadManifest(acctDir);
    return `Rebuilt profile from ${Object.keys(m.sections).length} cached sections.

${profileCard(p)}`;
  }
  if (sub === "invalidate") {
    const target = a.pos[2];
    if (!target) throw new UsageError("usage: nsx cache invalidate <section|kind|all>");
    const m = loadManifest(acctDir);
    const names = Object.keys(m.sections).filter((n) => target === "all" || n === safeSectionName(target) || n.split("/")[0] === target);
    for (const n of names) markStale(acctDir, n, "invalidated by user");
    return names.length ? `Marked stale: ${names.join(", ")}` : `No cached section matches '${target}'.`;
  }
  throw new UsageError("usage: nsx cache status|show <section>|build|invalidate <section>");
}
function cmdProfile(ctx, a) {
  const acctDir = needAcct(ctx);
  const sub = a.pos[1] ?? "show";
  if (sub === "show") {
    const p = loadProfile(acctDir);
    return p ? profileCard(p) : "No profile yet. Run the su-ns-harness:init skill yourself (it needs nothing from the user).";
  }
  if (sub === "set") {
    const pairs = {};
    for (const kv of a.pos.slice(2)) {
      const i = kv.indexOf("=");
      if (i <= 0) throw new UsageError(`Expected key=value, got '${kv}'`);
      pairs[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    }
    if (!Object.keys(pairs).length) throw new UsageError("usage: nsx profile set key=value [key=value\u2026]");
    try {
      return profileCard(setOverrides(acctDir, pairs));
    } catch (e) {
      if (e.code) throw e;
      throw new UsageError(e.message);
    }
  }
  if (sub === "ttm-report") return ttmReportInput(acctDir);
  if (sub === "from-report") {
    const meta = findResult([acctDir], a.pos[2] ?? "");
    if (!meta) throw new UsageError(`usage: nsx profile from-report <result id>   (${a.pos[2] ? `result ${a.pos[2]} not found; see nsx results list` : "missing result id"}). If the report came back inline, read its Sales line and run: nsx profile set ttm_revenue_consolidated=<amount>`);
    const r = consolidatedRevenue(meta, loadRows(meta));
    return `Stored consolidated TTM revenue ${fmtNum(r.amount)} (${r.source}).

${profileCard(setConsolidatedRevenue(acctDir, r))}`;
  }
  throw new UsageError("usage: nsx profile show|set key=value|ttm-report|from-report <result id>");
}
var isoDay = (d) => d.toISOString().slice(0, 10);
var truthyCell = (v) => /^(t|true|y|yes|1)$/i.test((v ?? "").trim());
var monthLabel = (d) => d.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
function ttmWindow(acctDir, now = /* @__PURE__ */ new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ix = readIndex(acctDir, "periods");
  const c = (n) => ix.header.indexOf(n);
  if (c("startdate") >= 0 && c("enddate") >= 0) {
    const seen = /* @__PURE__ */ new Set();
    const done = ix.rows.filter((r) => !truthyCell(r[c("isyear")]) && !truthyCell(r[c("isquarter")]) && !truthyCell(r[c("isadjust")])).map((r) => ({ s: parseDate(r[c("startdate")] ?? "")?.getTime(), e: parseDate(r[c("enddate")] ?? "")?.getTime(), closed: truthyCell(r[c("closed")]) })).filter((p) => p.s !== void 0 && p.e !== void 0 && p.s <= p.e).filter((p) => p.e < today || p.closed && p.s <= today).sort((x, y) => x.s - y.s).filter((p) => seen.has(p.s) ? false : (seen.add(p.s), true));
    const last = done.slice(-12);
    const span = last.length === 12 ? (last[11].e - last[0].s) / 864e5 : 0;
    if (span >= 330 && span <= 380) {
      const [a, b] = [new Date(last[0].s), new Date(last[11].e)];
      return { from: isoDay(a), to: isoDay(b), label: `last 12 complete periods, ${monthLabel(a)} \u2013 ${monthLabel(b)}` };
    }
  }
  const from = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate() + 1));
  return { from: isoDay(from), to: isoDay(now), label: "the 12 months to today (no 12 complete periods in the periods cache)" };
}
function ttmReportInput(acctDir, now = /* @__PURE__ */ new Date()) {
  const reports = readIndex(acctDir, "reports");
  const [id, title, params] = ["id", "title", "params"].map((c) => reports.header.indexOf(c));
  if (id < 0 || title < 0) throw new UsageError("No reports cached. Call ns_listAllReports once (it's cached automatically), then run this again.");
  const is = reports.rows.filter((r) => (r[title] ?? "").trim().toLowerCase() === "income statement");
  const consol = is.find((r) => /\bconsol\b|sub\(consol\)/.test(r[params] ?? ""));
  const pick2 = consol ?? is[0];
  if (!pick2) throw new UsageError('No report titled "Income Statement" in the cache. Find one with nsx reports search "income statement", run it for the last 12 months, then nsx profile from-report <result id>.');
  const subs = readIndex(acctDir, "subsidiaries");
  const [sid, sname] = [subs.header.indexOf("id"), subs.header.indexOf("name")];
  const consolSub = consol && sid >= 0 && sname >= 0 ? subs.rows.find((r) => /\(consolidated\)\s*$/i.test(r[sname] ?? "")) : void 0;
  const w = ttmWindow(acctDir, now);
  const input = { reportId: Number(pick2[id]), ...consolSub ? { subsidiaryId: Number(consolSub[sid]) } : {}, dateFrom: w.from, dateTo: w.to };
  return [
    `Call ns_runReport with exactly this input (${pick2[title]}${consolSub ? `, ${consolSub[sname]}` : ""}, ${w.label}):`,
    JSON.stringify(input),
    `Then run: ${cliCommand()} profile from-report <the result id from its summary>   (inline result, no id: ${cliCommand()} profile set ttm_revenue_consolidated=<its Sales amount>)`
  ].join("\n");
}
var REVENUE_LINES = ["sales", "total income", "income", "revenue", "total revenue"];
function consolidatedRevenue(meta, rows) {
  if (meta.tool !== "ns_runReport") throw new UsageError(`${meta.id} is a ${meta.tool} result, not a report. Run the report from nsx profile ttm-report first.`);
  let q = {};
  try {
    q = JSON.parse(meta.query);
  } catch {
  }
  const sub = Number(q.subsidiaryId);
  if (q.subsidiaryId !== void 0 && Number.isFinite(sub) && sub >= 0) {
    throw new UsageError(`${meta.id} is for subsidiary ${sub}, not consolidated. Run the report with the consolidated subsidiary (nsx profile ttm-report prints the input).`);
  }
  const values = meta.columns.filter((c) => c.type === "num" && !["depth", "is_detail"].includes(c.name)).map((c) => c.name);
  if (values.length !== 1) throw new UsageError(`${meta.id} has ${values.length} amount columns (${values.join(", ") || "none"}); expected one. Run the report without column grouping.`);
  const isSection = (r) => r.kind === void 0 ? r.is_detail !== true : r.kind === "section";
  for (const name of REVENUE_LINES) {
    const r = rows.find((x) => isSection(x) && String(x.line ?? "").trim().toLowerCase() === name);
    const n = Number(r?.[values[0]]);
    if (r && Number.isFinite(n)) {
      const period = q.dateFrom && q.dateTo ? ` ${q.dateFrom} to ${q.dateTo}` : "";
      return { amount: Math.abs(n), source: `${meta.id}: ${String(r.line)}${period}` };
    }
  }
  throw new UsageError(`No Sales or Total Income line in ${meta.id}. Check: nsx results filter ${meta.id} --where "kind=section". Then set it: nsx profile set ttm_revenue_consolidated=<amount>`);
}
function interactive(env = process.env) {
  if (env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID) return false;
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}
function showConfig(ctx) {
  const cfg = loadConfig(ctx.data);
  const val = (k) => k === "ttl_overrides" ? Object.entries(cfg.ttl_days).filter(([n, d]) => DEFAULT_TTL_DAYS[n] !== d).map(([n, d]) => `${n}=${d}`).join(", ") || "(none)" : String(cfg[k] === "" ? "(empty)" : cfg[k]);
  return textTable(["setting", "value", "from"], SETTING_KEYS.map((k) => [k, val(k), configSource(k, ctx.data)]), SETTING_KEYS.length);
}
function cmdConfig(ctx, argv, isTty = interactive()) {
  const a = parseArgs(argv);
  if (!ctx.data) throw new UsageError("No data dir yet: start a Claude Code session with su-ns-harness enabled first.");
  const sub = a.pos[1] ?? "show";
  if (sub === "show") return showConfig(ctx);
  if (sub !== "set") throw new UsageError(`usage: ${USAGE.config}
Settings: ${SETTING_KEYS.join(", ")}`);
  const pairs = {};
  for (const kv of a.pos.slice(2)) {
    const i = kv.indexOf("=");
    if (i <= 0) throw new UsageError(`Expected key=value, got '${kv}'`);
    pairs[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
  }
  if (!Object.keys(pairs).length) throw new UsageError("usage: nsx config set key=value [key=value\u2026]");
  if (pairs.read_only !== void 0 && /^(false|no|off|0)$/i.test(pairs.read_only) && !isTty) {
    throw new UsageError(
      `Turning NetSuite writes on has to be done by the user, in their own terminal, outside Claude Code (this is refused from Claude's Bash tool, a ! command, or anything else run by Claude Code):
  ${cliCommand()} config set read_only=false
It applies to the next NetSuite call; no restart needed.`
    );
  }
  try {
    saveSettings(ctx.data, pairs);
  } catch (e) {
    throw new UsageError(e.message);
  }
  return `Saved. Applies to the next NetSuite call (no restart).
${showConfig(ctx)}`;
}
function getResult(ctx, id, anyAccount = false) {
  if (!id) throw new UsageError("missing result id (see: nsx results list)");
  const dirs = anyAccount ? acctDirs(ctx.data) : [needAcct(ctx)];
  const m = findResult(dirs, id);
  if (!m) {
    throw new UsageError(
      `Result ${id} not found in ${anyAccount ? "any account" : ctx.acct} (expired after ${ctx.cfg.results_retention_days}d?). See: nsx results list${anyAccount ? "" : "   (other accounts/environments: add --any-account)"}`
    );
  }
  return m;
}
var flagValues = (a, k) => (a.multi?.[k] ?? (a.flags[k] === void 0 ? [] : [a.flags[k]])).filter((v) => typeof v === "string");
var REPEATABLE = /* @__PURE__ */ new Set(["where", "sum", "avg", "min", "max", "count"]);
function refuseRepeats(a) {
  for (const [k, vs] of Object.entries(a.multi ?? {})) {
    if (vs.length < 2 || REPEATABLE.has(k)) continue;
    throw new UsageError(`--${k} given ${vs.length} times (${vs.map((v) => v === true ? `--${k}` : `'${v}'`).join(", ")}): give it once${["cols", "by", "on"].includes(k) ? `, with a comma list: --${k} a,b` : ""}`);
  }
}
function filtered(meta, a) {
  let rows = loadRows(meta);
  for (const w of flagValues(a, "where")) {
    let pred;
    try {
      pred = parseWhere(w, meta.columns.map((c) => c.name));
    } catch (e) {
      throw new UsageError(e.message);
    }
    rows = rows.filter(pred);
  }
  return rows;
}
function columnsOf2(meta, names, side) {
  try {
    return resolveColumns(meta.columns.map((c) => c.name), names, side);
  } catch (e) {
    throw new UsageError(e.message);
  }
}
function usage(f) {
  try {
    return f();
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(e.message);
  }
}
function sortedRows(meta, a, rows) {
  const s = a.flags.sort;
  if (s === void 0) {
    if (a.flags.asc) throw new UsageError('--asc only applies with --sort: --sort "<column>" --asc');
    return rows;
  }
  if (s === true || !s.trim()) throw new UsageError('--sort needs a column: --sort "Last Run On" [--asc]');
  const cols = meta.columns.map((c) => c.name);
  const name = s.trim().replace(/^(["`])(.*)\1$/, "$2");
  const col2 = resolveColumn(cols, name);
  if (!col2) throw new UsageError(`Unknown column for --sort: ${name}. Available: ${cols.join(", ")}`);
  return sortRows(rows, col2, meta.columns.find((c) => c.name === col2)?.type, !!a.flags.asc);
}
function gitignoreNote(file) {
  try {
    const r = spawnSync("git", ["check-ignore", "-q", file], { cwd: path13.dirname(file), stdio: "ignore", timeout: 3e3 });
    if (r.status === 1) return `
Note: this file is inside a git repository and not ignored. Add ${path13.basename(path13.dirname(file))}/ to .gitignore so NetSuite data isn't committed.`;
  } catch {
  }
  return "";
}
function exportPath(meta, a, ext) {
  const explicit = flag(a, ext) ?? flag(a, "out");
  const p = explicit ?? path13.join(process.cwd(), "exports", `${meta.id}.${ext}`);
  ensureDir(path13.dirname(path13.resolve(p)));
  return path13.resolve(p);
}
function naReasons(rows, cols) {
  const seen = /* @__PURE__ */ new Set();
  for (const r of rows) {
    for (const v of (Array.isArray(cols) ? cols : [cols]).flatMap((col2) => [r[`${col2}_delta`], r[`${col2}_a`], r[`${col2}_b`]])) {
      const m = typeof v === "string" ? /^n\/a \((.*)\)$/.exec(v.trim()) : null;
      if (m) seen.add(m[1]);
    }
  }
  const all = [...seen];
  return all.length ? all.slice(0, 3).join("; ") + (all.length > 3 ? "; \u2026" : "") : "no numeric delta";
}
var RESULTS_SUBS = ["list", "schema", "head", "filter", "agg", "pivot", "diff", "concat", "export", "raw", "path"];
function topFlag(a) {
  const t = flag(a, "top");
  if (t === void 0) {
    if (a.flags.top === true) throw new UsageError("--top needs a number: --top 20");
    return void 0;
  }
  if (!/^\d+$/.test(t.trim()) || Number(t) < 1) throw new UsageError(`--top must be a positive whole number, got '${t}'`);
  return Number(t);
}
var noRows = (meta, a) => `No rows match (0 of ${fmtNum(meta.rowCount)} rows${flagValues(a, "where").length ? ` after --where ${flagValues(a, "where").map((w) => `"${w}"`).join(" and ")}` : ""}): nothing to aggregate.`;
function cmdResults(ctx, a) {
  const sub = a.pos[1] ?? "list";
  if (!RESULTS_SUBS.includes(sub)) {
    if (/^r_[0-9a-f]+$/i.test(sub)) throw new UsageError(`missing subcommand before ${sub}: nsx results schema|head|filter|agg|pivot|export|raw|path ${sub} \u2026`);
    throw new UsageError(`unknown results subcommand '${sub}'. usage: nsx results list|schema|head|filter|agg|pivot|diff|concat|export|raw|path <id> \u2026`);
  }
  refuseRepeats(a);
  const max = num2(a, "max", 60);
  const anyAccount = !!a.flags["any-account"];
  if (sub === "list") {
    const dirs = anyAccount ? acctDirs(ctx.data) : [needAcct(ctx)];
    const all = dirs.flatMap((d) => listResults(d).map((m) => ({ m, acct: path13.basename(d) }))).sort((x, y) => x.m.createdAt.localeCompare(y.m.createdAt)).slice(-num2(a, "n", 20)).reverse();
    if (!all.length) return anyAccount ? "No saved results in any account." : "No saved results.   (other accounts/environments: add --any-account)";
    const head = ["id", ...anyAccount ? ["account"] : [], "created", "tool", "rows", "cols", "query"];
    return textTable(
      head,
      all.map(({ m, acct }) => [m.id, ...anyAccount ? [acct] : [], m.createdAt.slice(5, 16).replace("T", " "), m.tool.replace(/^ns_/, ""), String(m.rowCount), String(m.columns.length), m.query.replace(/\s+/g, " ").slice(0, 60)]),
      all.length
    );
  }
  const meta = getResult(ctx, a.pos[2], anyAccount);
  const cols = meta.columns.map((c) => c.name);
  const types = Object.fromEntries(meta.columns.map((c) => [c.name, c.type]));
  switch (sub) {
    case "schema": {
      const rows = loadRows(meta);
      const prof = profileColumns(cols, rows);
      const n = (v, c) => v === void 0 ? "" : typeof v === "number" ? fmtValue(v, c) : String(v);
      return [
        `${meta.id}: ${fmtNum(meta.rowCount)} rows \xB7 ${meta.tool} \xB7 ${meta.createdAt}${meta.truncated ? `
\u26A0 ${meta.truncated}` : ""}`,
        `Query: ${meta.query.slice(0, 500)}`,
        textTable(
          ["column", "type", "distinct", "nulls", "sum", "min", "max"],
          prof.map((p) => [p.name, p.type, String(p.distinct), String(p.nulls), p.sum === void 0 ? p.sumNa ? `n/a (${p.sumNa})` : "" : fmtValue(p.sum, p.name), n(p.min, p.name), n(p.max, p.name)]),
          prof.length
        ),
        ...prof.filter((p) => p.note).map((p) => `\u26A0 ${p.name}: ${p.note}`)
      ].join("\n");
    }
    case "head": {
      const n = a.pos[3] !== void 0 && Number.isFinite(Number(a.pos[3])) ? Number(a.pos[3]) : num2(a, "n", 10);
      const show2 = columnsOf2(meta, list(flag(a, "cols")));
      const rows = sortedRows(meta, a, filtered(meta, a));
      return renderRows(show2.length ? show2 : cols, rows.slice(0, n), Math.min(max, n));
    }
    case "filter": {
      if (!flagValues(a, "where").length) throw new UsageError('usage: nsx results filter <id> --where "amount>10000" [--cols a,b] [--sort col [--asc]]');
      const show2 = columnsOf2(meta, list(flag(a, "cols")));
      const rows = sortedRows(meta, a, filtered(meta, a));
      return `${fmtNum(rows.length)} of ${fmtNum(meta.rowCount)} rows match
${renderRows(show2.length ? show2 : cols, rows, max)}`;
    }
    case "agg": {
      const by = columnsOf2(meta, list(flag(a, "by")));
      const metrics = [];
      const seen = /* @__PURE__ */ new Set();
      const add = (fn, col2) => {
        const k = `${fn}\0${col2 ?? ""}`;
        if (!seen.has(k)) seen.add(k), metrics.push(col2 === void 0 ? { fn } : { fn, col: col2 });
      };
      for (const fn of ["sum", "avg", "min", "max", "count"]) {
        for (const v of a.multi?.[fn] ?? (a.flags[fn] === void 0 ? [] : [a.flags[fn]])) {
          if (v === true) add(fn);
          else for (const c of columnsOf2(meta, list(v))) add(fn, c);
        }
      }
      const top = topFlag(a);
      const rows = filtered(meta, a);
      if (!rows.length) return noRows(meta, a);
      const res = usage(() => aggregate(rows, { by, metrics, top, sort: flag(a, "sort"), asc: !!a.flags.asc, types }));
      const totalLine = `TOTAL (${fmtNum(rows.length)} rows): ${Object.entries(res.totals).map(([k, v]) => `${k}=${typeof v === "number" && !idLikeName(k) ? fmtValue(v, k) : v}`).join("  ")}`;
      const groups = new Set(rows.map((r) => JSON.stringify(by.map((b) => r[b])))).size;
      return `${renderRows(res.columns, res.rows, max)}
${groups > res.rows.length ? `(showing ${res.rows.length} of ${groups} groups)
` : ""}${totalLine}${res.warnings.map((w) => `
\u26A0 ${w}`).join("")}${meta.truncated ? `
\u26A0 source result is incomplete: ${meta.truncated}` : ""}`;
    }
    case "pivot": {
      const r = flag(a, "rows");
      const c = flag(a, "cols");
      if (!r || !c) throw new UsageError("usage: nsx results pivot <id> --rows col --cols col (--sum col|--avg col|--min col|--max col|--count [col])");
      const given = ["sum", "avg", "min", "max"].flatMap((f) => flagValues(a, f).map((v) => ({ fn: f, v })));
      const counts = a.multi?.count ?? (a.flags.count === void 0 ? [] : [a.flags.count]);
      const all = [...given.map((g) => `--${g.fn} ${g.v}`), ...counts.map((v) => v === true ? "--count" : `--count ${v}`)];
      if (all.length > 1 || given.some((g) => list(g.v).length > 1)) throw new UsageError(`pivot takes one metric, got ${all.join(", ")}: run one pivot per metric, or use results agg --by ${r},${c} for several`);
      const fn = given[0]?.fn ?? "count";
      const rawVal = given[0]?.v ?? (typeof counts[0] === "string" ? counts[0] : void 0);
      const [rc, cc, val] = [...columnsOf2(meta, [r, c]), ...rawVal ? columnsOf2(meta, [rawVal]) : [void 0]];
      const rows = filtered(meta, a);
      if (!rows.length) return noRows(meta, a);
      const p = usage(() => pivot(rows, rc, cc, fn, val, 12, types));
      const what = fn === "count" && val ? `(count of non-empty ${val})
` : "";
      return what + renderRows(p.columns, p.rows, max) + p.warnings.map((w) => `
\u26A0 ${w}`).join("") + (meta.truncated ? `
\u26A0 source result is incomplete: ${meta.truncated}` : "");
    }
    case "diff": {
      const other = getResult(ctx, a.pos[3], anyAccount);
      const onRaw = list(flag(a, "on"));
      const valsRaw = list(flag(a, "cols"));
      if (!onRaw.length || !valsRaw.length) {
        const missing = [!onRaw.length && "--on (the key column(s) to match rows on)", !valsRaw.length && "--cols (the value column(s) to compare)"].filter(Boolean).join(" and ");
        throw new UsageError(`results diff is missing ${missing}. usage: nsx results diff <idA> <idB> --on key[,key] --cols amount[,col]`);
      }
      const tolRaw = flag(a, "tolerance");
      if (a.flags.tolerance === true) throw new UsageError("--tolerance needs an amount: --tolerance 0.01");
      const tol = tolRaw === void 0 ? 0 : Number(tolRaw.trim());
      if (tolRaw !== void 0 && (!/^\d*\.?\d+$/.test(tolRaw.trim()) || !Number.isFinite(tol) || tol < 0)) {
        throw new UsageError(`--tolerance takes an absolute amount \u2265 0 in the value column's units (e.g. --tolerance 0.01), not '${tolRaw}'`);
      }
      const onA = columnsOf2(meta, onRaw, `a (${meta.id})`);
      const valsA = columnsOf2(meta, valsRaw, `a (${meta.id})`);
      const onB = columnsOf2(other, onRaw, `b (${other.id})`);
      const valsB = columnsOf2(other, valsRaw, `b (${other.id})`);
      const differs = [...onA, ...valsA].filter((x, i) => x !== [...onB, ...valsB][i]);
      if (differs.length) throw new UsageError(`the columns are named differently in a (${meta.id}: ${[...onA, ...valsA].join(", ")}) and b (${other.id}: ${[...onB, ...valsB].join(", ")}); diff needs the same names on both sides`);
      const [on, vals] = [onA, valsA];
      const profOf = (m) => {
        const dir = acctDirOf(m);
        return dir ? loadProfile(dir) : void 0;
      };
      const d = usage(() => diff(filtered(meta, a), filtered(other, a), on, vals, { reportCurrency: { a: reportCurrencyOf(meta, profOf(meta)), b: reportCurrencyOf(other, profOf(other)) }, tolerance: tol }));
      const rows = d.rows.filter((r) => diffChanged(r, vals, tol));
      const na = d.counts.incomparable ? `; ${fmtNum(d.counts.incomparable)} can't be compared (n/a: ${naReasons(d.rows, vals)})` : "";
      return `${fmtNum(d.counts.changed)} of ${fmtNum(d.rows.length)} keys differ on ${d.on.join(",")} (a=${meta.id}, b=${other.id}${tol ? `, tolerance ${tol}` : ""})${na}
${renderRows(d.columns, rows, Math.min(max, num2(a, "top", 40)))}${d.notes.map((n) => `
Note: ${n}`).join("")}${d.warnings.map((w) => `
\u26A0 ${w}`).join("")}`;
    }
    case "concat": {
      const ids = a.pos.slice(2);
      if (ids.length < 2) throw new UsageError("usage: nsx results concat <id> <id> [<id>\u2026]");
      const r = concatResults(ids.map((id) => getResult(ctx, id, anyAccount)));
      return [`Combined ${ids.length} results \u2192 ${r.meta.id} (${fmtNum(r.meta.rowCount)} rows \xD7 ${r.meta.columns.length} cols)`, ...r.notes.map((n) => `\xB7 ${n}`), ...r.meta.truncated ? [`\u26A0 ${r.meta.truncated}`] : [], `Next: ${cliCommand()} results schema ${r.meta.id}`].join("\n");
    }
    case "export": {
      const rows = sortedRows(meta, a, filtered(meta, a));
      if (a.flags.xlsx !== void 0) {
        const p2 = exportPath(meta, a, "xlsx");
        const num3 = new Set(meta.columns.filter((c) => c.type === "num").map((c) => c.name));
        fs12.writeFileSync(p2, toXlsx(cols, rows, num3));
        return `Exported ${fmtNum(rows.length)} rows \u2192 ${p2}${gitignoreNote(p2)}`;
      }
      const p = exportPath(meta, a, "csv");
      fs12.writeFileSync(p, toCsv(cols, rows, true));
      return `Exported ${fmtNum(rows.length)} rows \u2192 ${p}${gitignoreNote(p)}`;
    }
    case "raw": {
      const raw = fs12.readFileSync(meta.files.raw, "utf8");
      const g = flag(a, "grep");
      if (g) {
        const lines = raw.split(/\n|(?<=\},)/).filter((l) => l.toLowerCase().includes(g.toLowerCase()));
        return `${lines.length} matching chunks
${lines.slice(0, 40).map((l) => l.slice(0, 300)).join("\n")}`;
      }
      const head = Number(flag(a, "head") ?? 40);
      return raw.slice(0, head * 100);
    }
    case "path":
      return `${meta.files.csv}
${meta.files.raw}`;
    default:
      throw new UsageError("usage: nsx results list|schema|head|filter|agg|pivot|diff|concat|export|raw|path <id> \u2026");
  }
}
function cmdSql(ctx, a) {
  let sub = a.pos[1];
  let src = a.pos.length > 3 ? a.pos.slice(2).join(" ") : a.pos[2];
  if (sub && sub !== "lint" && sub !== "fix-rownum") {
    src = a.pos.slice(1).join(" ");
    sub = "lint";
  }
  const sql = readInput(src);
  if (sub === "lint") {
    const r = lintSuiteQL(sql, lintContextFor(ctx));
    if (r.errors.length) process.exitCode = 1;
    return formatLint(r);
  }
  if (sub === "fix-rownum") {
    const fixed = fixRownum(sql);
    if (fixed !== sql) return fixed;
    const rownum = lintSuiteQL(sql).errors.some((e) => e.rule.startsWith("rownum-"));
    if (!rownum) return "No ROWNUM placement problem found; nothing to rewrite.";
    process.exitCode = 1;
    return "No safe automatic rewrite. Remove the ROWNUM condition and end the query with ORDER BY \u2026 FETCH FIRST N ROWS ONLY (never an outer ROWNUM: NetSuite applies it before the inner GROUP BY).";
  }
  throw new UsageError('usage: nsx sql lint <file|-|"query"> | nsx sql fix-rownum <file|-|"query">');
}
function cmdPreview(ctx, a) {
  const tool = a.pos[1];
  const usage2 = `usage: ${USAGE.preview}`;
  if (!tool || !/^ns_/.test(tool)) throw new UsageError(usage2);
  if (!isWriteTool(tool)) throw new UsageError(`${tool} is not a NetSuite write tool, so it needs no preview (previews are for ns_createRecord, ns_updateRecord, \u2026 before the user approves the write). ${usage2}`);
  if (a.pos[2] === void 0) throw new UsageError(`${usage2}
(give - to read the JSON from stdin)`);
  const input = parseJsonInput(readInput(a.pos[2]), "the tool input");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new UsageError(`The tool input must be a JSON object ({"recordType": \u2026}). ${usage2}`);
  const beforeFile = flag(a, "before");
  let before;
  if (beforeFile) {
    if (!fs12.existsSync(beforeFile)) throw new UsageError(`No such file: ${beforeFile}`);
    before = parseJsonInput(fs12.readFileSync(beforeFile, "utf8"), beforeFile);
  }
  const { file, preview } = writePreview(ctx.acctDir ?? ctx.data, tool, input, before);
  return [
    `Preview saved (${path13.basename(file)}). Show this to the user before calling ${tool}:`,
    // diffLines says "(no field changes detected …)" itself for a no-op.
    ...preview.diff.slice(0, 60),
    preview.diff.length > 60 ? `\u2026 ${preview.diff.length - 60} more` : "",
    tool.includes("update") && !before ? "(No --before given: showing new values only. For updates, pass the current record from ns_getRecord.)" : "",
    `Then call ${tool} with exactly the same input; the user will be asked to approve.`
  ].filter(Boolean).join("\n");
}
function parseJsonInput(text, what) {
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new UsageError(`Could not read JSON from ${what}: ${e.message}`);
  }
}
function cmdAudit(ctx, a) {
  const acctDir = needAcct(ctx);
  const sub = a.pos[1] ?? "export";
  const session = flag(a, "session") ?? (a.flags.session === true ? currentSession() : void 0);
  if (a.flags.session !== void 0 && !session) throw new UsageError("--session needs an id: this shell has no CLAUDE_CODE_SESSION_ID (it is set in Claude Code's Bash tool). Use --session <id>.");
  const entries = readAudit(acctDir, { session, days: flag(a, "days") ? Number(flag(a, "days")) : void 0 });
  if (sub === "export") {
    const out2 = path13.resolve(flag(a, "out") ?? path13.join(process.cwd(), "exports", `netsuite-audit-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)}.csv`));
    ensureDir(path13.dirname(out2));
    fs12.writeFileSync(out2, auditCsv(entries));
    return `Wrote ${entries.length} audit entries \u2192 ${out2}${gitignoreNote(out2)}`;
  }
  if (sub === "tail") {
    const n = num2(a, "n", 15);
    return textTable(
      ["ts", "tool", "outcome", "rows", "ms", "result", "note"],
      (n > 0 ? entries.slice(-n) : []).map((e) => [e.ts.slice(11, 19), e.tool, e.outcome + (e.errorClass ? `:${e.errorClass}` : ""), String(e.rows ?? ""), String(e.durationMs ?? ""), e.resultId ?? "", (e.note ?? "").slice(0, 50)]),
      n
    );
  }
  throw new UsageError(`usage: ${USAGE.audit}`);
}
function currentSession(env = process.env) {
  return env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_SESSION_ID || void 0;
}
var shortSession = (id) => id ? `\u2026${id.slice(-4)}` : "unknown session";
function hookStatusNote(hb) {
  const tool = ["pre", "post", "failure"].some((e) => hb[e]?.at);
  if (hb["session-start"]?.at) return tool ? "" : "No NetSuite tool call seen yet, so the tool hooks haven't had a chance to fire.";
  if (tool) return "Tool hooks have fired but SessionStart hasn't (the plugin was probably installed or enabled mid-session). Run /reload-plugins or start a new session before relying on it; the profile context arrives with the next session start.";
  return "Hooks have not fired. In Cowork/claude.ai this is expected (plugin hooks don't run there). In Claude Code: if the plugin was just installed, run /reload-plugins or start a new session; otherwise check /hooks and that the plugin is enabled.";
}
function heartbeatSessions(hb, now = Date.now()) {
  const seen = /* @__PURE__ */ new Map();
  for (const e of Object.values(hb)) {
    if (!e?.at) continue;
    const all = e.sessions && typeof e.sessions === "object" ? Object.entries(e.sessions) : [[e.session ?? "", e.at]];
    for (const [id, at] of all) {
      const t = Date.parse(at);
      if (Number.isFinite(t) && now - t <= 864e5) seen.set(id, Math.max(seen.get(id) ?? 0, t));
    }
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
function heartbeatLines(hb, now = Date.now(), current) {
  const ok = (b) => b ? "\u2713" : "\u2717";
  const lines = [];
  for (const ev of ["session-start", "pre", "post", "failure"]) {
    const e = hb[ev];
    const where = e?.at ? ` in session ${shortSession(e.session)}${current && e.session === current ? " (this session)" : ""}` : "";
    lines.push(`${ev === "failure" ? " " : ok(!!e?.at)} hook ${ev}: ${e?.at ? `last fired ${ageLabel(now - Date.parse(e.at))} ago${where}` : "never fired"}`);
  }
  const sessions = heartbeatSessions(hb, now);
  if (sessions.length > 1) {
    const cur = current && sessions.includes(current) ? ` This session is ${shortSession(current)}.` : current ? ` This session (${shortSession(current)}) has no heartbeat: its hooks haven't fired.` : " nsx can't tell which one is this session, so these lines don't prove this session's hooks run; a `[su-ns-harness]` line on the next NetSuite result does.";
    lines.push(`  Hooks fired in ${sessions.length} sessions in the last day (${sessions.map(shortSession).join(", ")}).${cur}`);
  }
  return lines;
}
function splitDataDirNote(inUse, dirs = markedDataDirs(), why, explicitEnv = process.env.NSX_DATA_DIR) {
  if (dirs.length < 2) return void 0;
  const same = (d) => !!inUse && path13.resolve(d) === path13.resolve(inUse);
  const named = dirs.map((d) => `${d}${same(d) ? " (in use)" : ""}`).join(", ");
  const picked = why ? ` nsx CLI commands use ${why}: a dir with a cache beats one without, then the one whose hooks fired last.` : "";
  return `\u26A0 ${dirs.length} su-ns-harness data dirs: ${named}. The cache is split between them (different Claude apps can give the plugin different data dirs), so init and refreshes run once per dir.${inUse && !dirs.some(same) ? ` In use: ${inUse}.` : ""}${picked} ${explicitEnv ? `NSX_DATA_DIR is set here, so this nsx uses it; apps without it keep their own dir. To share one cache, set NSX_DATA_DIR to ${path13.resolve(explicitEnv)} in every app.` : "To share one cache, set NSX_DATA_DIR to the same dir in every app."}`;
}
function noticeDue(note, choice, session = currentSession(), now = /* @__PURE__ */ new Date()) {
  let base = choice.dir;
  try {
    if (!fs12.statSync(base).isDirectory()) throw new Error("not a dir");
  } catch {
    base = path13.join(os3.tmpdir(), `su-ns-harness-notices-${createHash2("sha256").update(path13.resolve(choice.dir)).digest("hex").slice(0, 12)}`);
  }
  const file = session ? path13.join(sessionDir(base, session), "data-dir-notice") : path13.join(base, "notices", `data-dir-notice-${now.toISOString().slice(0, 10)}`);
  try {
    if (fs12.readFileSync(file, "utf8") === note) return false;
  } catch {
  }
  try {
    ensureDir(path13.dirname(file));
    fs12.writeFileSync(file, note);
  } catch {
  }
  return true;
}
function choiceWhy(inUse) {
  if (!inUse) return void 0;
  try {
    const c = dataDirChoice();
    return c.auto && path13.resolve(c.dir) === path13.resolve(inUse) ? describeChoice(c) : void 0;
  } catch {
    return void 0;
  }
}
function cmdDoctor(ctx, a, dataDirError) {
  const lines = [`nsx ${PLUGIN_VERSION} at ${path13.resolve(process.argv[1] ?? "scripts/nsx.mjs")}`];
  const ok = (b) => b ? "\u2713" : "\u2717";
  const major = Number(process.versions.node.split(".")[0]);
  lines.push(`${ok(major >= 18)} Node ${process.versions.node}${major < 18 ? " \u2014 su-ns-harness needs Node \u2265 18 (https://nodejs.org or `brew install node`)" : ""}`);
  const seen = lastConnector(ctx.data || null);
  if (ctx.cfg.account_id) lines.push(`\u2713 account_id ${ctx.cfg.account_id} (${ctx.cfg.environment}) from ${configSource("account_id", ctx.data || null)}; it keys the cache instead of the connector`);
  else if (ctx.server) lines.push(`\u2713 cache keyed by connector ${ctx.server}${seen ? ` (last NetSuite call ${seen.lastSeen.slice(0, 10)})` : ""}`);
  else lines.push("\u2013 no NetSuite call seen yet: the first ns_* call picks the cache (no account_id needed)");
  let writable = !!ctx.data;
  let why = "";
  try {
    if (ctx.data) fs12.accessSync(ctx.data, fs12.constants.W_OK);
  } catch (e) {
    writable = false;
    why = ` \u2014 not writable (${e.code ?? "access denied"}): the cache and results can't be saved. Fix its permissions or point NSX_DATA_DIR elsewhere.`;
  }
  let choice;
  try {
    const c = dataDirChoice();
    if (c.auto && ctx.data && path13.resolve(c.dir) === path13.resolve(ctx.data)) choice = c;
  } catch {
  }
  const fresh = choice?.exists === false;
  if (fresh) {
    writable = true;
    why = "";
  }
  const ignored = choice && othersIgnored(choice);
  lines.push(
    dataDirError ? `\u2717 data dir: ${dataDirError.message}` : fresh ? `\u2713 data dir ${path13.basename(ctx.data)} (new, created on the first NetSuite call) at ${ctx.data}${ignored ? `; ${ignored}` : ""}` : ctx.data ? `${ok(writable)} data dir ${ctx.data}${why}${choice?.reason === "install" || choice?.reason === "same-install" ? ` (this install's)` : choice?.reason === "session" ? " (this session's hooks write here)" : ""}${ignored ? `; ${ignored}` : ""}` : "\u2013 data dir none yet: normal before the first NetSuite call in a session where the plugin's hooks are loaded (the hooks create it). If you just installed the plugin, run /reload-plugins or start a new session first."
  );
  const split = ignored && choice?.reason !== "session" ? void 0 : splitDataDirNote(ctx.data || void 0, markedDataDirs(), choiceWhy(ctx.data || void 0));
  if (split) lines.push(split);
  if (a.flags.preflight || !ctx.data) return lines.join("\n");
  lines.push(`  mode: ${ctx.cfg.read_only ? "read-only" : "writes allowed (preview + approval)"} \xB7 inline_max_chars ${ctx.cfg.inline_max_chars}`);
  if (ctx.acctDir) {
    const m = loadManifest(ctx.acctDir);
    const n = Object.keys(m.sections).length;
    const stale = staleSections(m, ctx.cfg);
    const unparsed = Object.entries(m.sections).filter(([, e]) => e.status === "unparsed").map(([k]) => k);
    lines.push(`${ok(n > 0)} cache: ${n} sections, ${stale.length} stale${stale.length ? ` (${stale.slice(0, 6).map((s) => s.name).join(", ")})` : ""}${unparsed.length ? `, unparsed: ${unparsed.join(", ")}` : ""}`);
    lines.push(`  profile: ${loadProfile(ctx.acctDir) ? "built" : "missing (run the su-ns-harness:init skill yourself; it needs nothing from the user)"}`);
    const size = dirSize(path13.join(ctx.acctDir, "results"));
    lines.push(`  results: ${listResults(ctx.acctDir).length} saved, ${(size / 1e6).toFixed(1)} MB, retention ${ctx.cfg.results_retention_days}d`);
    const byRule = {};
    for (const e of readAudit(ctx.acctDir, { days: 7 })) {
      if (e.outcome === "denied") for (const r of (e.note ?? "other").split(",")) byRule[r] = (byRule[r] ?? 0) + 1;
    }
    const denials = Object.entries(byRule).sort((x, y) => y[1] - x[1]);
    lines.push(`  guard denials (last 7 days with activity): ${denials.length ? denials.map(([r, n2]) => `${r} ${n2}`).join(", ") : "none"}`);
  }
  const hb = readJson(path13.join(ctx.data, "heartbeat.json"), {});
  lines.push(...heartbeatLines(hb, Date.now(), currentSession()));
  const hbNote = hookStatusNote(hb);
  if (hbNote) lines.push(`  ${hbNote}`);
  try {
    const log = fs12.readFileSync(path13.join(ctx.data, "logs", "hook.log"), "utf8").trim().split("\n").filter((l) => /^\d{4}-/.test(l));
    if (log.length) lines.push(`  hook errors logged: ${log.length}; last: ${log[log.length - 1].slice(0, 200)}`);
  } catch {
    lines.push("  hook errors logged: none");
  }
  lines.push(`  Connector: ${seen ? `last used ${seen.lastSeen.slice(0, 10)} via ${seen.server}. ` : ""}Only Claude's tool list shows whether it's enabled in this session (tools ending in ns_*); if a call fails with 'couldn't reach the MCP server', re-authenticate via /mcp.`);
  return lines.join("\n");
}
var HELP = `nsx ${PLUGIN_VERSION} \u2014 su-ns-harness CLI
  reports search <terms\u2026>          searches search <terms\u2026>        recordtypes [--grep t|t2]   (--max N)
  fields <table> [term\u2026] [--grep t] [--record] [--max N]           periods [--open|--years] [--grep t] [--max N]
  cache status|show <section>|build|invalidate <section|all>       profile show|set k=v\u2026|ttm-report|from-report <id>
  results list [--n N] | schema|head|filter|agg|pivot|export|raw|path <id> \u2026   results diff <idA> <idB> --on k --cols c   results concat <id> <id>\u2026
      head:   <id> [N] [--cols a,b] [--max N]      agg: --by col[,col] --sum|--avg|--min|--max col[,col] [--count] [--top N]
      filter: --where "amount>10000 and status~open"   export: --csv [path] | --xlsx [path]   raw: [--grep t] [--head N]
      head/filter/export: --sort col [--asc] (numbers largest first, dates latest first, text A\u2192Z)
  sql lint <file|-|"sql">         sql fix-rownum <file|-|"sql">   (- reads stdin)
  preview <ns_write_tool> <file|-> [--before current.json]
  audit export [--session [id]] [--days N] [--out file]            audit tail [--n N] [--session [id]] [--days N]
  config show | config set key=value\u2026  (read_only=false only from your own terminal)
  doctor [--preflight]      version (--version, -v)      <command> --help`;
var HOOKS = {
  "session-start": [(i) => handleSessionStart(i)],
  pre: [(i) => handlePre(i), failClosedForWrites],
  post: [(i) => handlePost(i)],
  failure: [(i) => handleFailure(i)]
};
function helpFor(cmd) {
  return cmd && Object.hasOwn(USAGE, cmd) && cmd !== "help" ? `usage: ${USAGE[cmd]}` : HELP;
}
var STATELESS = ["sql", "version", "doctor", "help"];
function main(rawArgv) {
  const argv = normalizeArgv(rawArgv);
  const a = parseArgs(argv);
  const cmd = a.pos[0];
  if (cmd === "hook") {
    const which = a.pos[1] ?? "";
    const h = Object.hasOwn(HOOKS, which) ? HOOKS[which] : void 0;
    return h ? runHook(which, h[0], h[1]) : Promise.resolve();
  }
  if (a.flags.help || cmd === "help") {
    const topic = cmd === "help" ? a.pos[1] : cmd;
    if (topic && !COMMANDS.includes(topic)) checkFlags({ pos: [topic], flags: {} });
    return helpFor(topic);
  }
  if (a.flags.version && (!cmd || cmd === "version")) return PLUGIN_VERSION;
  if (!cmd) {
    if (Object.keys(a.flags).length) throw new UsageError(`unknown flag${Object.keys(a.flags).length > 1 ? "s" : ""} ${Object.keys(a.flags).map((f) => `--${f}`).join(", ")} (no command given). ${HELP}`);
    return HELP;
  }
  checkFlags(a);
  let ctx;
  let dataDirError;
  try {
    ctx = context();
  } catch (e) {
    if ((e instanceof NoDataDirError || e instanceof DataDirError) && STATELESS.includes(cmd)) {
      ctx = statelessContext();
      if (e instanceof DataDirError) dataDirError = e;
    } else throw e;
  }
  switch (cmd) {
    case "reports":
      return search(ctx, needAcct(ctx), "reports", a.pos.slice(a.pos[1] === "search" ? 2 : 1), num2(a, "max", 30), "call ns_listAllReports once (it is cached automatically).");
    case "searches":
      return search(ctx, needAcct(ctx), "searches", a.pos.slice(a.pos[1] === "search" ? 2 : 1), num2(a, "max", 30), "call ns_listSavedSearches once (it is cached automatically).");
    case "recordtypes":
      return search(ctx, needAcct(ctx), "recordtypes", [flag(a, "grep"), ...a.pos.slice(1)].filter((t) => !!t), num2(a, "max", 60), "call ns_getSuiteQLMetadata with no arguments once.");
    case "fields":
      return cmdFields(ctx, a);
    case "periods":
      return cmdPeriods(ctx, a);
    case "cache":
      return cmdCache(ctx, a);
    case "profile":
      return cmdProfile(ctx, a);
    case "results":
      return cmdResults(ctx, a);
    case "sql":
      return cmdSql(ctx, a);
    case "preview":
      return cmdPreview(ctx, a);
    case "audit":
      return cmdAudit(ctx, a);
    case "config":
      return cmdConfig(ctx, argv);
    case "doctor":
      return cmdDoctor(ctx, a, dataDirError);
    case "version":
      return PLUGIN_VERSION;
    default:
      throw new UsageError(`unknown command '${cmd}' (nsx --help)`);
  }
}
function errorMessage(e) {
  const err = e;
  if (err && (err.code === "EACCES" || err.code === "EPERM" || err.code === "EROFS")) {
    return `can't write ${err.path ?? "a file"} (${err.code}: permission denied). Check the data dir's permissions (nsx doctor shows it) or set NSX_DATA_DIR to a writable dir.`;
  }
  return e instanceof Error ? e.message : String(e);
}
var isEntry = (() => {
  try {
    return !!process.argv[1] && /nsx(\.mjs)?$|cli\.ts$/.test(process.argv[1]);
  } catch {
    return false;
  }
})();
if (isEntry) {
  ignoreEpipe();
  try {
    const argv = process.argv.slice(2);
    if (argv[0] !== "hook" && argv[0] !== "doctor") {
      const note = dataDirNotice();
      let due = !!note;
      try {
        if (note) due = noticeDue(note, dataDirChoice());
      } catch {
      }
      if (note && due) process.stderr.write(`${note}
`);
    }
    const r = main(argv);
    if (typeof r === "string") process.stdout.write(expandNsx(r.endsWith("\n") ? r : `${r}
`, cliCommand()));
  } catch (e) {
    process.stderr.write(`nsx: ${expandNsx(errorMessage(e), cliCommand())}
`);
    process.exitCode = e instanceof UsageError || e?.name === "UsageError" || e instanceof SyntaxError ? 2 : 1;
  }
}
export {
  COMMAND_FLAGS,
  HOOKS,
  checkFlags,
  cmdConfig,
  consolidatedRevenue,
  currentSession,
  heartbeatLines,
  heartbeatSessions,
  hookStatusNote,
  interactive,
  main,
  naReasons,
  normalizeArgv,
  noticeDue,
  parseArgs,
  readInput,
  searchRows,
  splitDataDirNote,
  ttmReportInput,
  ttmWindow
};
