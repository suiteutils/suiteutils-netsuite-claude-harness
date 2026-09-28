/**
 * Connector error classification. Some patterns are live-verified (claude.ai connector), the
 * rest are best guesses; unknown errors get class "unknown" and a
 * generic "don't retry blindly" line. Live strings:
 * - bad column: `Error executing SuiteQL query: An unexpected SuiteScript error has occurred`
 *   (the field isn't named, so it's "unknown", or "bad_field_likely" when the guard flagged a column)
 * - hidden table: `Search error occurred: Record 'subsidiary' was not found.` → not_found
 * - syntax: `Failed to parse SQL [<the query>]: syntax error … near: …` → bad_syntax
 * - rate limit: `HTTP 429: {… "Concurrent request limit exceeded" …}`, also as `{"success":false,"error":…}`
 * - saved search, as a JSON string in a successful result: `Error loading saved search with params {…}.
 *   Error: Permission Violation: You need …` → permission; `… Unable to determine record type for saved
 *   search id 1233` → bad_record_type (a standalone search type needs `type`)
 */
import { isWriteTool } from "./preview.ts";
import { scopes, tokenize } from "./sql/tokenize.ts";

export type ErrorClass = "unreachable" | "rate_limit" | "auth" | "permission" | "bad_field" | "bad_record_type" | "bad_syntax" | "timeout" | "not_found" | "bad_field_likely" | "unknown";

const RULES: [ErrorClass, RegExp][] = [
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
  ["bad_syntax", /syntax|parse error|invalid or unsupported search|unexpected token|ORA-009\d\d|missing (right|left) parenthesis|invalid (sql|query)/i],
];

/** NetSuite's text for a SuiteQL failure it doesn't explain; on the claude.ai connector a bad column gives exactly this. */
export const GENERIC_SUITESCRIPT = /unexpected SuiteScript error/i;

export function classifyError(msg: string): ErrorClass {
  for (const [cls, re] of RULES) if (re.test(msg)) return cls;
  return "unknown";
}

/** Words after FROM/JOIN that aren't tables. */
const NOT_TABLE = new Set(["select", "lateral", "dual"]);
const FROM_END = new Set(["where", "group", "order", "having", "fetch", "union", "minus", "intersect", "connect", "start", "on", "join", "left", "right", "inner", "outer", "full", "cross", "offset"]);

/**
 * Tables a query reads (lower-case): FROM/JOIN targets and comma-joined tables, in every
 * (sub)query. `EXTRACT(YEAR FROM t.trandate)` and string literals don't count; `dual` isn't a table.
 */
export function tablesInSql(sql: string): string[] {
  const out = new Set<string>();
  let toks;
  try {
    toks = tokenize(sql);
  } catch {
    for (const m of sql.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_]*)\b(?!\s*\.)/gi)) if (!NOT_TABLE.has(m[1].toLowerCase())) out.add(m[1].toLowerCase());
    return [...out];
  }
  for (const s of scopes(toks)) {
    if (!s.isQuery) continue;
    const d = s.direct;
    const take = (k: number) => {
      const t = toks[d[k]];
      const next = toks[d[k + 1]];
      if (t?.type === "word" && next?.type !== "dot" && !NOT_TABLE.has(t.value)) out.add(t.value);
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
  return [...out];
}

/** Table named in "Field 'amout' for record 'transactionLine' was not found" (lower-cased). */
export function fieldErrorTable(msg: string): string | undefined {
  return /\b(?:field|column) '[^']*' (?:for|on|in) (?:record|table) '([a-z0-9_]+)'/i.exec(msg)?.[1]?.toLowerCase();
}

export const MAX_RATE_LIMIT_TRIES = 3;

/**
 * Seconds to wait before rate-limit retry `attempt` (1-based): 5, 10, 20 plus 0–3s of jitter.
 * The account's integration concurrency is shared with other integrations, and 2/4/8s often
 * wasn't enough on a busy production account.
 */
export function rateLimitWait(attempt: number, rand = Math.random): number {
  return 5 * 2 ** (attempt - 1) + Math.floor(rand() * 4);
}

/** Table named in "Record 'subsidiary' was not found" (SuiteQL's message for a table the role can't see). */
export function missingTable(msg: string): string | undefined {
  return /record '([a-z0-9_]+)' was not found/i.exec(msg)?.[1];
}

/**
 * Saved-search record types the connector needs `type` for, as the searches cache names them →
 * the value ns_runSavedSearch takes. Only live-verified entries: `System Note` → `SystemNote`,
 * `Saved Search` → `SavedSearch`.
 */
export const STANDALONE_SEARCH_TYPES: Record<string, string> = { "system note": "SystemNote", "saved search": "SavedSearch" };

/** `Unable to determine record type for saved search id 900` → "900". */
export function searchTypeErrorId(msg: string): string | undefined {
  return /unable to determine record type for saved search id\s+([\w-]+)/i.exec(msg)?.[1];
}

/** `near: =(1,45, token code:0)` → { near: "=", line: 1, column: 45 }. */
export function syntaxPosition(msg: string): { near: string; line: number; column: number } | undefined {
  // The last one: the message echoes the query first, which could contain the same text.
  const m = [...msg.matchAll(/near:\s*(.*?)\((\d+),(\d+)\b/g)].pop();
  return m ? { near: m[1].trim(), line: Number(m[2]), column: Number(m[3]) } : undefined;
}

function syntaxHint(msg: string, sql: string | undefined): string {
  const parts: string[] = [];
  const pos = syntaxPosition(msg);
  if (pos) {
    const line = sql?.split("\n")[pos.line - 1];
    const at = line !== undefined && pos.column <= line.length + 1 ? line.slice(Math.max(0, pos.column - 25), pos.column + 15).trim() : "";
    parts.push(`NetSuite points near column ${pos.column}${pos.line > 1 ? ` of line ${pos.line}` : ""}${pos.near ? ` ("${pos.near}")` : ""}${at ? `: …${at}…` : ""}.`);
  }
  if (/invalid or unsupported search/i.test(msg)) {
    parts.push("This is often an ORDER BY on a column alias or a non-grouped expression with GROUP BY: order by the full expression (e.g. COUNT(*) DESC) or drop ORDER BY.");
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
}

export function advice(cls: ErrorClass, opts: { attempt?: number; tables?: string[]; tool?: string; message?: string; columns?: string[]; rand?: () => number; sql?: string; searchRecordType?: string } = {}): string {
  const attempt = opts.attempt ?? 1;
  switch (cls) {
    case "unreachable":
      return "Claude Code couldn't reach the NetSuite MCP server (connector disconnected or its login expired). Don't retry in a loop. Tell the user to re-authenticate: /mcp → NetSuite → Authenticate (a claude.ai connector: reconnect it under Settings → Connectors), then ask again.";
    case "rate_limit": {
      if (attempt > MAX_RATE_LIMIT_TRIES) {
        return `NetSuite rate limit (concurrency) hit ${attempt} times in a row on this call. Stop retrying; tell the user the account's integration concurrency limit is saturated (other integrations may be running) and try again later.`;
      }
      const wait = rateLimitWait(attempt, opts.rand);
      return `NetSuite rate limit: the account shares a small integration concurrency limit. Run \`sleep ${wait}\` then retry this exact call ONCE (attempt ${attempt} of ${MAX_RATE_LIMIT_TRIES}). Make NetSuite calls strictly one at a time — never in parallel.`;
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
        const std = rt ? STANDALONE_SEARCH_TYPES[rt.toLowerCase()] : undefined;
        if (std) return `This saved search is a '${rt}' search (from the searches cache), a standalone type the connector can't infer. Call again with type: "${std}" (same searchId and range).`;
        if (rt) return `NetSuite can't infer this saved search's record type. The searches cache says it's a '${rt}' search: if ns_runSavedSearch's \`type\` parameter accepts it, call again with type: "${rt.replace(/\s+/g, "")}" (the record type without spaces); otherwise tell the user this search can't be run through the connector. Don't retry without \`type\`.`;
        return "NetSuite can't infer this saved search's record type. Look it up with `nsx searches search <id or title>` (recordtype column) and call again with `type` set to that record type without spaces (e.g. System Note → \"SystemNote\"). Don't retry without `type`.";
      }
      if (opts.tool === "ns_getRecord" || opts.tool === "ns_getRecordTypeMetadata") {
        return "Unknown record type. REST record types are lower-case (invoice, vendorbill, journalentry, customer); check the name with ns_getRecordTypeMetadata (no arguments), then call again with the exact name.";
      }
      return "Unknown record type. Check the cached list with `nsx recordtypes --grep <term>`; SuiteQL table names are lower-case record ids (e.g. transaction, customer, vendorbill is NOT a table — use transaction with type = 'VendBill').";
    }
    case "bad_syntax":
      return `SuiteQL syntax error.${syntaxHint(opts.message ?? "", opts.sql)} Run the query through \`nsx sql lint -\` first (ORDER BY … FETCH FIRST n ROWS ONLY instead of ROWNUM/LIMIT, no WITH, dates via TO_DATE('2026-01-31','YYYY-MM-DD'), || to concatenate, BUILTIN.DF(field) for display names). Retry once after fixing.`;
    case "timeout":
      if (/SSS_USAGE_LIMIT_EXCEEDED|usage limit exceeded/i.test(opts.message ?? "")) {
        return "NetSuite stopped the call at its governance (script usage) limit: the request did too much work, it's not a rate limit. Don't retry the same call. Narrow it: shorter date range, subsidiary filter, fewer rows (smaller pageSize or range), aggregate in SQL instead of pulling detail, or split by period or id range.";
      }
      // section_156257790831: ANSI SQL-92 risks "time outs that aren't operationally remediable"; Oracle recommends Oracle syntax
      return "The NetSuite call timed out. Don't retry the same call. Narrow it: shorter date range, subsidiary filter, aggregate in SQL instead of pulling detail, or split by period or id range. If it uses ANSI JOIN … ON, rewrite the joins in Oracle syntax (comma joins, (+) for outer joins; never both styles in one query).";
    case "not_found":
      if (opts.tool === "ns_runCustomSuiteQL") {
        const t = missingTable(opts.message ?? "") ?? opts.tables?.[0] ?? "this table";
        return `SuiteQL table '${t}' isn't exposed to the connector role (or doesn't exist). Don't retry and don't refresh reports or searches: skip what needs '${t}', find the data in another table (nsx recordtypes --grep <term>), or ask a NetSuite admin to grant the role access.`;
      }
      // Per tool: only reports and saved searches have a cached list to refresh.
      if (opts.tool === "ns_runReport") return "Report not found: the cached report list may be outdated (it's now marked stale). Call ns_listAllReports to refresh it, then find the report again with nsx reports search <term>.";
      if (opts.tool === "ns_runSavedSearch") return "Saved search not found: the cached list may be outdated (it's now marked stale). Call ns_listSavedSearches to refresh it, then find the search again with nsx searches search <term>.";
      if (opts.tool === "ns_getRecord") return "Record not found: no record of that type has this id (or the role can't see it). Don't retry the same id: confirm the internal id with a SuiteQL lookup (e.g. SELECT id, tranid FROM transaction WHERE tranid = '…'), and check the record type matches.";
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
