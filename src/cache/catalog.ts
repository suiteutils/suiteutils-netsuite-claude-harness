/**
 * Parsers from catalog/metadata tool responses to cache sections.
 * Field-name candidates follow the shapes pinned by the sanitized live fixtures in test/fixtures;
 * every parser returns undefined when it cannot make sense of a payload, and the caller then
 * stores the raw JSON with status "unparsed".
 */
import { tablesInSql } from "../errors.ts";
import { extractRows, type Row } from "../rows.ts";
import { isCanonicalProbe, PROBES, probeKey } from "./probes.ts";
import { INDEX_VERSION, type Index, loadManifest, readIndex, readRaw, rewriteIndex } from "./store.ts";

export interface CatalogTarget {
  section: string;
  label: string;
  /** Hint Claude gets back instead of the raw payload. */
  hint: string;
}

const lc = (s: string) => s.toLowerCase();

export function pick(row: Row, candidates: string[]): unknown {
  const keys = Object.keys(row);
  for (const c of candidates) {
    const k = keys.find((key) => lc(key) === lc(c));
    if (k !== undefined && row[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
  }
  return undefined;
}

const str = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Which cache section a tool call feeds, if any. `tag` comes from a `[su-ns-harness:<tag>]` description. */
export function catalogTarget(tool: string, input: Record<string, unknown>, tag?: string): CatalogTarget | undefined {
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
      const t = str(input.recordType).trim();
      return t
        ? { section: `fields/${lc(t)}`, label: `fields for ${lc(t)}`, hint: `${cli} fields ${lc(t)} [--grep <term>]` }
        : { section: "recordtypes", label: "record types", hint: `${cli} recordtypes [--grep <term>]` };
    }
    case "ns_getRecordTypeMetadata": {
      const t = str(input.recordType ?? input.type ?? input.recordTypeName).trim();
      return t
        ? { section: `recordmeta/${lc(t)}`, label: `fields (record metadata) for ${lc(t)}`, hint: `${cli} fields ${lc(t)} --record` }
        : { section: "recordmeta/_all", label: "record types (record API)", hint: `${cli} cache show recordmeta/_all` };
    }
    case "ns_runCustomSuiteQL":
      if (tag === "periods") return { section: "periods", label: "accounting periods", hint: `${cli} periods [--open]` };
      if (tag?.startsWith("profile:")) {
        const key = probeKey(tag).slice("profile:".length);
        return { section: `probe/${key}`, label: `profile probe '${key}'`, hint: `${cli} cache build` };
      }
      return undefined;
    default:
      return undefined;
  }
}

/** `[su-ns-harness:periods]` in a SuiteQL description marks a cache-fill call. */
export function descriptionTag(input: Record<string, unknown>): string | undefined {
  const m = /\[su-ns-harness:([a-z0-9_:.-]+)\]/i.exec(str(input.description));
  return m?.[1].toLowerCase();
}

/** What each tagged cache-fill query must look like; derived from PROBES (src/cache/probes.ts). */
interface TagSpec {
  table: string;
  required: string[];
  optional?: string[];
}

export const TAG_SPECS: Record<string, TagSpec> = Object.fromEntries(PROBES.map((p) => [p.tag, { table: p.table, required: p.required, ...(p.optional ? { optional: p.optional } : {}) }]));

/**
 * Why a tagged result must not be cached (undefined = it's the init query and its result fits).
 * A tag is only a description string: without this check any query tagged `[su-ns-harness:periods]`
 * would replace the periods cache (live: a customer list did, then an empty result and a filtered
 * subset did).
 */
export function tagMismatch(tag: string, sql: string, json: unknown): string | undefined {
  const key = probeKey(tag);
  const spec = TAG_SPECS[key];
  if (!spec) return `not a query su-ns-harness runs (known tags: ${Object.keys(TAG_SPECS).map((k) => `[su-ns-harness:${k}]`).join(", ")})`;
  const expected = `expected ${spec.required.join(", ")}${spec.optional?.length ? ` (optional: ${spec.optional.join(", ")})` : ""} from ${spec.table}`;
  if (!tablesInSql(sql).includes(spec.table)) return `the query doesn't read ${spec.table} (${expected})`;
  if (!isCanonicalProbe(key, sql)) return "not the init query (a tagged query must use the SQL from the su-ns-harness:init skill, step 3, or the su-ns-harness:refresh skill's table, exactly, with no extra filters or paging)";
  const ex = extractRows(json);
  if (!ex) return `the result isn't a table (${expected})`;
  // One page of a paged result isn't the whole list (pageSize 5 must not cache 5 periods).
  if (ex.hasMore || (ex.totalResults !== undefined && ex.totalResults > ex.rows.length)) {
    return `the result is one page (${ex.rows.length} of ${ex.totalResults ?? "more"} rows); a tagged query must return every row, so call it without pageSize/pageIndex`;
  }
  if (!ex.rows.length) return key === "periods" ? "the result is empty (an account always has accounting periods)" : undefined;
  const cols = ex.columns.map(lc);
  const allowed = new Set([...spec.required, ...(spec.optional ?? [])]);
  const missing = spec.required.filter((c) => !cols.includes(c));
  const extra = cols.filter((c) => !allowed.has(c));
  if (missing.length || extra.length) return `columns don't match (${expected}; got ${ex.columns.join(", ")})`;
  return undefined;
}

/**
 * A refresh that would empty a cached catalog section, or shrink it to less than half its rows, is
 * refused: catalogs (periods, reports, searches, subsidiaries, fields…) don't shrink like that in
 * real life, but an error body or a partial result does (an empty `[]` must not replace 10 saved
 * searches). A stale section is replaced as usual; `nsx cache invalidate <section>` first accepts
 * the new result. Probe sections are exempt (their row counts legitimately change).
 */
export function shrinkRefusal(acctDir: string, section: string, newCount: number): string | undefined {
  if (section.startsWith("probe/")) return undefined;
  const e = loadManifest(acctDir).sections[section];
  if (!e || e.status === "stale" || e.count <= 0) return undefined;
  if (newCount > 0 && (e.count < 4 || newCount * 2 >= e.count)) return undefined;
  return `${section} ${e.count} → ${newCount}: not replaced, the cached copy was kept. If that's intended, run \`nsx cache invalidate ${section}\` and the call again (or run the su-ns-harness:refresh skill (sections: ${section}), which does this).`;
}

function simpleIndex(json: unknown, header: string[], cols: string[][]): Index | undefined {
  const ex = extractRows(json);
  if (!ex || !ex.rows.length) return ex ? { header, rows: [] } : undefined;
  const rows = ex.rows.map((r) => cols.map((c) => str(pick(r, c))));
  // A parse that yields no ids/names at all is a parse we don't understand.
  if (rows.every((r) => r.every((c) => c === ""))) return undefined;
  return { header, rows };
}

/** Drop columns (from index `keep` on) that are empty in every row. */
function dropEmptyColumns(ix: Index, keep: number): Index {
  const cols = ix.header.map((_, i) => i).filter((i) => i < keep || ix.rows.some((r) => r[i]));
  return { header: cols.map((i) => ix.header[i]), rows: ix.rows.map((r) => cols.map((i) => r[i] ?? "")) };
}

/** `{#Sales Orders#} Pending Fulfillment` → `Sales Orders Pending Fulfillment` (NetSuite's renameable-record placeholders). */
export function reportTitle(t: string): string {
  return t.replace(/\{#([^#}]*)#\}/g, "$1");
}

const flagOn = (r: Row, k: string) => r[k] === true || /^(t|true|y|yes|1)$/i.test(str(r[k]));

/**
 * ns_listAllReports flags → compact params: `as-of` (dateTo only) or `from+to` (dateFrom + dateTo),
 * then `sub(consol)` = subsidiaryId, negative (consolidated) ids allowed; `book`; `range`; …
 */
export function reportParams(r: Row): string {
  const p = [flagOn(r, "as_of_format") ? "as-of" : "from+to"];
  const sub = flagOn(r, "has_subsidiary_filter");
  const consol = flagOn(r, "supports_consolidation");
  if (sub) p.push(consol ? "sub(consol)" : "sub");
  else if (consol) p.push("consol");
  for (const [k, label] of [["supports_book", "book"], ["supports_book2", "book2"], ["supports_range", "range"], ["supports_accounting_context", "acct-ctx"], ["supports_nexus", "nexus"], ["supports_cash_basis_mode", "cash-basis"], ["supports_period_end_mode", "period-end"]]) {
    if (flagOn(r, k)) p.push(label);
  }
  return p.join(" · ");
}

/**
 * The cached `supports_range` flag of one report, from the raw ns_listAllReports payload: true or
 * false only when the cache has the report and NetSuite sent the flag for it; undefined otherwise
 * (no cache, unknown report, older payload shape), so a caller never drops `range` on a guess.
 */
export function reportSupportsRange(acctDir: string, reportId: unknown): boolean | undefined {
  const want = str(reportId).trim();
  if (!want) return undefined;
  const ex = extractRows(readRaw(acctDir, "reports"));
  const r = ex?.rows.find((row) => str(row.id).trim() === want);
  if (!r || !("supports_range" in r)) return undefined;
  return flagOn(r, "supports_range");
}

function parseReports(json: unknown): Index | undefined {
  const header = ["id", "title", "params"];
  const ex = extractRows(json);
  if (!ex) return undefined;
  if (!ex.rows.length) return { header, rows: [] };
  // Live shape: bare array of {id, title, as_of_format, has_subsidiary_filter, supports_*}.
  if (ex.rows.some((r) => "as_of_format" in r || "has_subsidiary_filter" in r || Object.keys(r).some((k) => k.startsWith("supports_")))) {
    return { header, rows: ex.rows.map((r) => [str(r.id), reportTitle(str(pick(r, ["title", "name"]))), reportParams(r)]) };
  }
  const ix = simpleIndex(json, header, [
    ["id", "reportId", "internalId", "reportid"],
    ["title", "name", "reportName", "label"],
    ["params", "parameters", "filters", "supportedParameters"],
  ]);
  return ix && { header, rows: ix.rows.map((r) => [r[0], reportTitle(str(r[1])), r[2]]) };
}

/** Join target of one schema property. NetSuite marks joins with `x-n:joinable` + `x-n:recordType`. */
function joinTarget(p: Record<string, unknown> | undefined): string {
  if (p?.["x-n:joinable"] && p["x-n:recordType"]) return str(p["x-n:recordType"]);
  return str(p?.["x-ns-join"] ?? p?.["x-ns-referenceType"] ?? p?.$ref ?? "");
}

/**
 * JSON-Schema-like metadata: `{ properties: { field: { type, title, nullable, ... } } }`.
 * The index keeps the title only; descriptions (often a paragraph each) stay in the raw JSON.
 */
function fromSchema(json: unknown): Index | undefined {
  const props = (json as { properties?: unknown } | undefined)?.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return undefined;
  const rows = Object.entries(props as Record<string, Record<string, unknown>>).map(([field, p]) => [
    field,
    str(p?.format ?? p?.type),
    str(p?.title),
    str(p?.nullable),
    joinTarget(p),
  ]);
  return { header: FIELD_HEADER, rows };
}

const FIELD_HEADER = ["field", "type", "label", "nullable", "joinTarget"];

/** Where the schema sits: top level, `schema`, or the connector's `{ success, metadata, message }` envelope. */
function schemaCandidates(json: unknown): unknown[] {
  const o = json as { schema?: unknown; metadata?: unknown } | undefined;
  return [json, o?.schema, o?.metadata];
}

/**
 * `{ success: true, metadata: { type: "object" } }` with no properties: the call worked but the
 * connector returned no fields for that table (see emptyFieldsNote).
 */
export function isEmptySchema(json: unknown): boolean {
  return schemaCandidates(json).some((c) => {
    const s = c as { type?: unknown; properties?: unknown } | undefined;
    return !!s && typeof s === "object" && s.type === "object" && s.properties === undefined;
  });
}

/**
 * Message for an empty field schema. A table in the record-type list with no metadata is still
 * queryable (live: transaction, approvalstatus); only a table missing from the list is a visibility gap.
 */
export function emptyFieldsNote(acctDir: string, table: string, kind: "fields" | "recordmeta" = "fields"): string {
  const t = lc(table);
  // A REST record type isn't a SuiteQL table, so the SuiteQL table list says nothing about it.
  if (kind === "recordmeta") {
    return `The connector returned no record metadata for '${t}' (REST record API); nsx fields ${t} --record has nothing to show. Check the record type name with ns_getRecordTypeMetadata (no arguments; REST names are lower-case, e.g. vendorbill). Don't retry the same call.`;
  }
  const types = readIndex(acctDir, "recordtypes").rows;
  if (types.length && !types.some((r) => lc(r[0] ?? "") === t)) {
    return `No fields for '${t}', and it isn't in this account's SuiteQL record-type list: the connector role probably can't see this table. Don't retry; queries on it will likely fail with "Record '${t}' was not found".`;
  }
  return `The connector exposes no field metadata for '${t}'; queries still work, column checks are skipped. Don't retry.`;
}

export function parseFields(json: unknown): Index | undefined {
  for (const c of schemaCandidates(json)) {
    const schema = fromSchema(c);
    if (schema) return schema;
  }
  return simpleIndex(json, FIELD_HEADER, [
    ["id", "name", "fieldId", "field", "columnName", "column"],
    ["type", "dataType", "fieldType", "datatype"],
    ["label", "title", "displayName", "description"],
    ["nullable", "isNullable", "mandatory"],
    ["joinTarget", "join", "references", "recordType", "target", "joinRecordType"],
  ]);
}

export function parseSection(section: string, json: unknown): Index | undefined {
  const kind = section.split("/")[0];
  switch (kind) {
    case "reports":
      return parseReports(json);
    case "searches":
      return simpleIndex(json, ["id", "title", "recordtype", "public"], [
        ["id", "searchId", "scriptId", "internalId"],
        ["title", "name", "label"],
        ["recordType", "recordtype", "searchType", "type"],
        ["public", "isPublic"],
      ]);
    case "subsidiaries": {
      // The connector sends only {id, name}; optional columns are kept only when some row has them.
      const ix = simpleIndex(json, ["id", "name", "currency", "parent", "country", "iselimination"], [
        ["id", "internalId", "subsidiaryId"],
        ["name", "fullName", "fullname", "legalName"],
        ["currency", "currencyName", "baseCurrency", "currency.refName"],
        ["parent", "parentId", "parent.id"],
        ["country", "country.refName"],
        ["isElimination", "iselimination"],
      ]);
      return ix && dropEmptyColumns(ix, 2);
    }
    case "books":
    case "contexts":
    case "nexus":
      return simpleIndex(json, ["id", "name", "extra"], [
        ["id", "internalId", "nexusId", "bookId"],
        ["name", "label", "description", "country"],
        ["isPrimary", "isprimary", "state", "status", "type"],
      ]);
    case "recordtypes": {
      const ex = extractRows(json);
      if (!ex) return undefined;
      const rows = ex.rows
        .map((r) => [str(pick(r, ["id", "name", "recordType", "value", "tableName", "table"])), str(pick(r, ["label", "title", "displayName"]))])
        .filter((r) => r[0]);
      return rows.length || !ex.rows.length ? { header: ["recordtype", "label"], rows } : undefined;
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
        ["isadjust", "isAdjust"],
      ]);
    case "probe": {
      const ex = extractRows(json);
      if (!ex) return undefined;
      return { header: ex.columns, rows: ex.rows.map((r) => ex.columns.map((c) => str(r[c]))) };
    }
    default:
      return undefined;
  }
}

/**
 * Re-parse sections indexed by an older parser from their stored raw payload, so a plugin update
 * that changes an index format needs no refresh. `empty` sections stay as they are. Returns the
 * names re-indexed.
 */
export function reindexOutdated(acctDir: string): string[] {
  const done: string[] = [];
  for (const [name, e] of Object.entries(loadManifest(acctDir).sections)) {
    if ((e.indexVersion ?? 1) >= INDEX_VERSION || e.status === "empty") continue;
    const raw = readRaw(acctDir, name);
    if (raw === undefined) continue;
    rewriteIndex(acctDir, name, parseSection(name, raw));
    done.push(name);
  }
  return done;
}
