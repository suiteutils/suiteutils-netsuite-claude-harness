import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSection } from "../src/cache/catalog.ts";
import { decodeToolResponse, nsToolName } from "../src/mcp.ts";
import { extractRows, identicalReportColumns } from "../src/rows.ts";
import { fixture } from "./helpers.ts";

const json = (name: string) => decodeToolResponse(fixture(name)).json;

describe("decodeToolResponse", () => {
  it("handles content-block arrays, {content}, strings, structuredContent and double wrapping", () => {
    assert.deepEqual(decodeToolResponse([{ type: "text", text: '{"a":1}' }]).json, { a: 1 });
    assert.deepEqual(decodeToolResponse({ content: [{ type: "text", text: "[1]" }], isError: false }).json, [1]);
    assert.deepEqual(decodeToolResponse('{"a":2}').json, { a: 2 });
    assert.deepEqual(decodeToolResponse({ structuredContent: { b: 1 } }).json, { b: 1 });
    assert.deepEqual(decodeToolResponse(JSON.stringify([{ type: "text", text: '{"c":3}' }])).json, { c: 3 });
    assert.equal(decodeToolResponse({ content: [{ type: "text", text: "boom" }], isError: true }).isError, true);
    assert.equal(decodeToolResponse("plain text").json, undefined);
  });
});

describe("extractRows", () => {
  it("saved-search list: pads datetimes and keeps ' ' blanks as sent (profiling treats them as null)", () => {
    const ex = extractRows(json("saved_search_list_blanks.json"))!;
    assert.equal(ex.rows.length, 40);
    assert.deepEqual(ex.columns, ["Internal ID", "Title", "Record Type", "Last Run On", "Last Run By", "From Bundle", "Date Created"]);
    assert.equal(ex.rows[0]["Last Run On"], "2026-09-01 01:00");
    assert.equal(ex.rows[3]["Last Run On"], " ");
  });

  it("finds rows under common containers and reads paging metadata", () => {
    const ex = extractRows({ items: [{ a: 1 }, { a: 2 }], hasMore: true, totalResults: 10 })!;
    assert.equal(ex.rows.length, 2);
    assert.equal(ex.hasMore, true);
    assert.equal(ex.totalResults, 10);
  });
  it("maps column/row matrices", () => {
    const ex = extractRows({ columns: ["id", { name: "amt" }], rows: [[1, 5], [2, 6]] })!;
    assert.deepEqual(ex.rows, [{ id: 1, amt: 5 }, { id: 2, amt: 6 }]);
  });
  it("flattens nested objects and drops links", () => {
    const ex = extractRows([{ id: 1, entity: { id: 7, refName: "Acme" }, links: [{ rel: "self" }] }])!;
    assert.deepEqual(ex.rows[0], { id: 1, "entity.id": 7, "entity.refName": "Acme" });
  });
  it("flattens generic label/children trees with a section path", () => {
    const tree = { sections: [{ label: "Income", children: [{ account: "4000 Sales", amount: 125000.5 }], total: 125000.5 }, { label: "Expenses", children: [{ label: "Opex", children: [{ account: "6000 Rent", amount: 12000 }] }] }] };
    const ex = extractRows(tree)!;
    const rent = ex.rows.find((r) => r.account === "6000 Rent")!;
    assert.equal(rent.section, "Expenses > Opex");
    assert.equal(rent.amount, 12000);
    assert.equal(ex.rows.find((r) => r.label === "Income")!.total, 125000.5);
  });
  it("flattens ns_runReport reportData in key order with depth from the parent-alias chain", () => {
    const ex = extractRows(json("report_income_statement.json"))!;
    assert.equal(ex.rows.length, 46, "every reportData entry is a row, not just row 0");
    assert.deepEqual(ex.columns, ["line", "depth", "is_detail", "kind", "Amount"]);
    assert.deepEqual(ex.report, { title: "Income Statement", valueColumns: ["Amount"], columns: [{ name: "Amount", id: "Amount", path: "Amount", label: "Amount" }] });
    // The untitled container row is structural, below depth 0, so `depth>=0` drops it.
    assert.deepEqual(ex.rows[0], { line: "Financial Row", depth: -1, is_detail: false, kind: "structural", Amount: 987654.32 });
    assert.equal(ex.rows.filter((r) => (r.depth as number) < 0).length, 1);
    // NetSuite's blank lines (no label, no value) are spacers, not account lines.
    assert.deepEqual(ex.rows.filter((r) => r.kind === "spacer").map((r) => [r.line, r.depth, r.is_detail, r.Amount]), [
      [null, 1, false, null], [null, 2, true, null], [null, 1, false, null], [null, 2, true, null], [null, 1, false, null], [null, 2, true, null],
    ]);
    const sections = ex.rows.filter((r) => r.kind === "section").map((r) => [r.line, r.Amount]);
    assert.deepEqual(sections, [
      ["Sales", 747900.5], ["Purchases", 0], ["Gross Profit", 747900.5], ["Overheads", 785700.5],
      ["Operating Profit", -37800], ["Other Income", 24700], ["Other Expenses", -7550.5], ["Net Profit/(Loss)", -20650.5],
    ]);
    const at = (line: string) => ex.rows.find((r) => r.line === line && r.kind !== "detail")!;
    assert.equal(at("G100 - Tour Commission").depth, 1);
    // `parent` names the parent's alias, and siblings share it: the second account is still depth 2.
    assert.equal(at("4000 - Account 3").depth, 2);
    assert.equal(at("4007 - Account 5").depth, 2);
    assert.equal(at("G110 - Platform Fees").depth, 1);
    assert.equal(at("4070 - Account 38").depth, 1, "an account directly under a section");
    const detail = ex.rows[ex.rows.indexOf(at("4000 - Account 3")) + 1];
    assert.deepEqual(detail, { line: "4000 - Account 3", depth: 3, is_detail: true, kind: "detail", Amount: 120000 });
    // Each group equals the sum of its direct children.
    const g = ex.rows.indexOf(at("G200 - Marketing"));
    const kids = ex.rows.slice(g + 1).filter((r, i, a) => r.depth === 2 && a.slice(0, i).every((x) => (x.depth as number) > 1));
    assert.equal(kids.reduce((s, r) => s + (r.Amount as number), 0), at("G200 - Marketing").Amount);
  });
  it("reads SuiteQL paging from list envelopes, never a record's own total/count", () => {
    const ex = extractRows(json("suiteql_invoices_page.json"))!;
    assert.equal(ex.rows.length, 5);
    assert.deepEqual([ex.hasMore, ex.totalResults, ex.pageIndex, ex.pageSize, ex.numberOfPages], [true, 1203, 0, 5, 241]);
    const rec = extractRows({ id: "90000011", tranid: "INV-1", total: 1234.56, count: 3, hasMore: true })!;
    assert.equal(rec.rows.length, 1);
    assert.equal(rec.totalResults, undefined);
    assert.equal(rec.hasMore, undefined);
  });
  it("normalises unpadded saved-search dates to ISO", () => {
    const ex = extractRows(json("saved_search_open_bills.json"))!;
    assert.equal(ex.rows[0].Date, "2026-03-02");
    assert.equal(ex.rows[1]["Due Date/Receive By"], "2026-04-12");
    assert.equal(ex.rows[0]["Document Number"], "INV-A-0001");
    assert.equal(extractRows([{ d: "2026-13-4" }])!.rows[0].d, "2026-13-4", "not a date: left alone");
  });
  it("normalises saved-search and SuiteQL datetimes to a sortable form", () => {
    const ex = extractRows([
      { d: "2018-9-17 7:18 am", e: "2018-9-16 12:25 am", f: "2018-10-16 12:05 pm", g: "2026-9-20 19:08", h: "2026-9-20 7:08:05 PM", i: "2026-09-20T19:08:00", j: "2016-7-31" },
    ])!;
    assert.deepEqual(ex.rows[0], { d: "2018-09-17 07:18", e: "2018-09-16 00:25", f: "2018-10-16 12:05", g: "2026-09-20 19:08", h: "2026-09-20 19:08:05", i: "2026-09-20 19:08:00", j: "2016-07-31" });
    const bad = extractRows([{ a: "2018-9-17 13:18 pm", b: "2018-2-30 7:18 am", c: "2018-9-17 24:00", d: "2026-09-20T19:08:00Z", e: "2018-9-17 7:18 am extra" }])!;
    assert.deepEqual(bad.rows[0], { a: "2018-9-17 13:18 pm", b: "2018-2-30 7:18 am", c: "2018-9-17 24:00", d: "2026-09-20T19:08:00Z", e: "2018-9-17 7:18 am extra" }, "not real datetimes: left alone");
  });
  it("falls back to the largest array of objects", () => {
    const ex = extractRows({ meta: { x: 1 }, payload: { deep: { list: [{ a: 1 }, { a: 2 }, { a: 3 }] } } })!;
    assert.equal(ex.rows.length, 3);
    assert.equal(ex.path, "$.payload.deep.list");
  });
});

describe("multi-column reports", () => {
  const vals = (ex: ReturnType<typeof extractRows>, line: string, kind = "line") => {
    const r = ex!.rows.find((x) => x.line === line && x.kind === kind)!;
    return ex!.report!.valueColumns.map((c) => r[c]);
  };

  it("aging buckets that share a path each get their own value (id first, then position)", () => {
    const ex = extractRows(json("report_ap_aging.json"))!;
    assert.deepEqual(ex.columns, ["line", "depth", "is_detail", "kind", "Current", "1-30", "31-60", "61-90", "Over 90", "Total"]);
    assert.deepEqual(vals(ex, "Alpine Trails GmbH"), [8200.5, -75.25, null, null, null, 8125.25]);
    assert.deepEqual(vals(ex, "Alpine Trails GmbH", "detail"), [8200.5, -75.25, null, null, null, 8125.25]);
    assert.deepEqual(vals(ex, "Vendor", "section"), [10350.5, 279.95, 186.25, 88, 2202, 13106.7]);
    assert.deepEqual(vals(ex, "- No Vendor -", "section"), [null, 0, 0, null, 2500, 2500]);
    // Names are inferred (NetSuite sends none); the raw ids are kept per column.
    assert.deepEqual(ex.report!.columns!.map((c) => [c.name, c.id]), [
      ["Current", "Current > Open Balance"], ["1-30", "Current > Open Balance (2)"], ["31-60", "Current > Open Balance (3)"],
      ["61-90", "Current > Open Balance (4)"], ["Over 90", "Current > Open Balance (5)"], ["Total", "empty > Open Balance"],
    ]);
    assert.match(ex.report!.notes!.join(" "), /NetSuite's defaults, inferred from column order \(not sent\)/);
    assert.deepEqual(identicalReportColumns(ex.rows, ex.report!.columns!), []);
  });

  it("position is the fallback when no key matches; a shared path is never read", () => {
    const cols = ["A > X", "A > X (2)"].map((id) => ({ id, label: "X", path: "A > X" }));
    // Keys renamed: no id matches, and the shared path must not copy the first value into both.
    const ex = extractRows({ reportColumns: cols, reportData: { "0": { alias: "a", value: "S", parent: null, summaryLineValues: [{ "A > X": 1 }, { "A > X #2": 2 }] } } })!;
    assert.deepEqual(vals(ex, "S", "section"), [1, 2]);
    assert.deepEqual(ex.report!.valueColumns, ["X 1", "X 2"], "not an aging report: numbered, not bucket names");
    assert.equal(ex.report!.notes, undefined);
  });

  it("range month and quarter columns are named by period, the total Total", () => {
    const m = extractRows(json("report_income_statement_month.json"))!;
    assert.deepEqual(m.report!.valueColumns, ["2026-01", "2026-02", "2026-03", "Total"]);
    assert.deepEqual(vals(m, "Sales", "section"), [1300, 1150, 900, 3350]);
    assert.deepEqual(m.report!.columns!.map((c) => c.id), ["2026-01 > Amount", "2026-02 > Amount", "2026-03 > Amount", "empty > Amount"]);
    const q = extractRows(json("report_income_statement_quarter.json"))!;
    assert.deepEqual(q.report!.valueColumns, ["2026-Q1", "2026-Q2", "Total"]);
    assert.deepEqual(vals(q, "Net Profit/(Loss)", "section"), [1800, 1150.25, 2950.25]);
  });

  it("several labels per period keep the label; other prefixes are `<prefix> <label>`", () => {
    const cols = ["2026-01 > Amount", "2026-01 > Budget", "empty > Amount", "empty > Budget"].map((id) => ({ id, label: id.split(" > ")[1], path: id }));
    const ex = extractRows({ reportColumns: cols, reportData: { "0": { alias: "a", value: "S", parent: null, summaryLineValues: cols.map((c, i) => ({ [c.id]: i })) } } })!;
    assert.deepEqual(ex.report!.valueColumns, ["2026-01 Amount", "2026-01 Budget", "Total Amount", "Total Budget"]);
    const other = ["East > Amount", "West > Amount"].map((id) => ({ id, label: "Amount", path: id }));
    assert.deepEqual(extractRows({ reportColumns: other, reportData: { "0": { alias: "a", value: "S", summaryLineValues: [] } } })!.report!.valueColumns, ["East Amount", "West Amount"]);
  });

  it("identicalReportColumns flags differently-keyed columns that match on every row", () => {
    const cols = [{ name: "a", id: "x" }, { name: "b", id: "y" }, { name: "c", id: "z" }];
    const rows = [{ a: 1, b: 1, c: 2 }, { a: null, b: null, c: null }, { a: 5, b: 5, c: 5 }];
    assert.deepEqual(identicalReportColumns(rows, cols), [["a", "b"]]);
    assert.deepEqual(identicalReportColumns([{ a: null, b: null }], cols.slice(0, 2)), [], "all empty proves nothing");
  });
});

describe("catalog parsers", () => {
  it("parses reports (live shape: bare array of flags)", () => {
    const ix = parseSection("reports", json("reports_list.json"))!;
    assert.deepEqual(ix.header, ["id", "title", "params"]);
    assert.equal(ix.rows.length, 6);
    assert.deepEqual(ix.rows[0], ["110", "Income Statement", "from+to · book · range · acct-ctx"]);
    assert.deepEqual(ix.rows.find((r) => r[0] === "-200"), ["-200", "Income Statement", "from+to · sub(consol) · book · range · acct-ctx · cash-basis"]);
    assert.equal(ix.rows.find((r) => r[0] === "148")![1], "Sales Orders Pending Fulfillment", "placeholders stripped");
    assert.match(String(ix.rows.find((r) => r[0] === "292")![2]), /^as-of · sub\(consol\)/);
  });
  it("parses saved searches", () => {
    const ix = parseSection("searches", json("searches_list.json"))!;
    assert.deepEqual(ix.header, ["id", "title", "recordtype", "public"]);
    assert.deepEqual(ix.rows[0], ["customsearch_open_po", "Open Purchase Orders", "Transaction", "true"]);
  });
  it("parses JSON-schema field metadata", () => {
    const ix = parseSection("fields/transaction", json("suiteql_metadata_transaction.json"))!;
    assert.equal(ix.rows.length, 10);
    assert.deepEqual(ix.rows.find((r) => r[0] === "entity"), ["entity", "integer", "Entity", "", "entity"]);
  });
  it("parses subsidiaries and periods", () => {
    const subs = parseSection("subsidiaries", json("subsidiaries.json"))!;
    assert.equal(subs.rows.length, 6);
    assert.deepEqual(subs.header, ["id", "name"], "always-empty columns are dropped");
    assert.equal(parseSection("periods", json("periods.json"))!.rows[2][1], "Sep 2025");
  });
  it("returns undefined for payloads it cannot understand", () => {
    assert.equal(parseSection("reports", "not json"), undefined);
    assert.equal(parseSection("reports", [{ foo: 1 }]), undefined);
  });
});

describe("nsToolName", () => {
  it("extracts the connector tool whatever the server is called", () => {
    assert.equal(nsToolName("mcp__ns__ns_createRecord"), "ns_createRecord");
    assert.equal(nsToolName("mcp__netsuite__ns_runCustomSuiteQL"), "ns_runCustomSuiteQL");
    assert.equal(nsToolName("mcp__my_ns_server__ns_getRecord"), "ns_getRecord");
    assert.equal(nsToolName("ns_listAllReports"), "ns_listAllReports");
    assert.equal(nsToolName("mcp__other__query"), undefined);
  });
});

describe("slash dates", () => {
  it("M/D and D/M columns are rewritten to ISO only when the order is certain", () => {
    const ex = extractRows({
      items: [
        { md: "12/31/2025", dm: "27/09/2026", amb: "3/4/2026", mdt: "1/10/2026 10:05 pm", bad: "2/30/2026", mixed: "12/31/2025" },
        { md: "1/10/2026", dm: "3/10/2026", amb: "4/3/2026", mdt: "12/31/2025 7:00 am", bad: "1/13/2026", mixed: "31/12/2025" },
      ],
    })!;
    assert.deepEqual(ex.rows.map((r) => r.md), ["2025-12-31", "2026-01-10"]);
    assert.deepEqual(ex.rows.map((r) => r.dm), ["2026-09-27", "2026-10-03"]);
    assert.deepEqual(ex.rows.map((r) => r.amb), ["3/4/2026", "4/3/2026"], "ambiguous: left as sent");
    assert.deepEqual(ex.rows.map((r) => r.mdt), ["2026-01-10 22:05", "2025-12-31 07:00"]);
    assert.deepEqual(ex.rows.map((r) => r.bad), ["2/30/2026", "1/13/2026"], "an impossible date leaves the column alone");
    assert.deepEqual(ex.rows.map((r) => r.mixed), ["12/31/2025", "31/12/2025"], "fits neither order: left alone");
  });
});
