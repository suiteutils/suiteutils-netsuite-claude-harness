import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { aggregate, diff, diffChanged, fmtValue, parseWhere, pivot, renderRows, resolveColumn, sortRows, whereColumns } from "../src/results/engine.ts";
import { currencyCheck, headerRepeats, inferType, isCurrencyBearing, isCurrencyColumn, profileColumns, toNumber } from "../src/results/profile.ts";
import { acctDirOf, cleanupResults, concatResults, listResults, loadRows, parseValue, reportCurrencyInfo, reportCurrencyOf, saveResult } from "../src/results/store.ts";
import { buildSummary, detectTruncation, pagingKeyHint, sectionSignNote, sqlRowCap } from "../src/results/summary.ts";
import { toXlsx } from "../src/results/xlsx.ts";
import { decodeToolResponse } from "../src/mcp.ts";
import { extractRows, type Row } from "../src/rows.ts";
import { bigRows, fixture, tmpCtx } from "./helpers.ts";

const COLS = ["tranid", "trandate", "entity", "amount", "status", "subsidiary", "currency", "memo", "id"];

describe("summary", () => {
  it("keeps a 3,000-row × 9-col result under 1,500 chars", () => {
    const ctx = tmpCtx();
    const rows = bigRows(3000);
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runCustomSuiteQL", query: "SELECT … FROM transaction", columns: COLS, rows, raw: "[]" });
    const s = buildSummary({ meta, rows, columns: COLS });
    assert.ok(s.length < 1500, `summary is ${s.length} chars`);
    assert.match(s, /3,000 rows × 9 cols/);
    // A base amount across 4 subsidiaries has no plain sum, whatever `currency` says.
    assert.match(s, /amount\(num, sum n\/a: 4 subsidiaries/);
    assert.match(s, /Next: nsx results agg r_[0-9a-f]+ --by subsidiary --sum amount/);
    const one = rows.map((r) => ({ ...r, subsidiary: "Sub 0" }));
    const m1 = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runCustomSuiteQL", query: "SELECT … FROM transaction", columns: COLS, rows: one, raw: "[]" });
    const s1 = buildSummary({ meta: m1, rows: one, columns: COLS });
    assert.ok(s1.length < 1500, `summary is ${s1.length} chars`);
    assert.match(s1, /amount\(num, sum 13,248,000/);
    assert.match(s1, /Next: nsx results agg r_[0-9a-f]+ --by entity --sum amount/);
  });

  it("stays within budget for very wide results", () => {
    const cols = Array.from({ length: 120 }, (_, i) => `custbody_field_number_${i}`);
    const rows = Array.from({ length: 50 }, (_, r) => Object.fromEntries(cols.map((c, i) => [c, `value-${r}-${i}-with-some-length`])));
    const ctx = tmpCtx();
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_getRecord", query: "{}", columns: cols, rows, raw: "{}" });
    assert.ok(buildSummary({ meta, rows, columns: cols }).length <= 1400);
  });

  it("detects truncation from ROWNUM caps, range_end and list-envelope paging", () => {
    assert.equal(sqlRowCap("SELECT * FROM (x) WHERE ROWNUM <= 1000"), 1000);
    assert.equal(sqlRowCap("SELECT a FROM t FETCH FIRST 50 ROWS ONLY"), 50);
    assert.match(detectTruncation("ns_runCustomSuiteQL", { sqlQuery: "SELECT * FROM (q) WHERE ROWNUM <= 1000" }, 1000, undefined)!, /ROWNUM/);
    // rows == pageSize says nothing (without pageIndex the connector returns every page).
    assert.equal(detectTruncation("ns_runCustomSuiteQL", { sqlQuery: "SELECT a FROM t", pageSize: 500 }, 500, undefined), undefined);
    assert.match(detectTruncation("ns_runSavedSearch", { range_start: 0, range_end: 200 }, 200, undefined)!, /range_end/);
    assert.match(detectTruncation("ns_runSavedSearch", {}, 10, { rows: [], columns: [], path: "$", hasMore: true })!, /more rows/);
  });

  it("one page + hasNextPage tells Claude the next pageIndex", () => {
    const ex = extractRows(decodeToolResponse(fixture("suiteql_invoices_page.json")).json)!;
    const w = detectTruncation("ns_runCustomSuiteQL", { sqlQuery: "SELECT …", pageSize: 5, pageIndex: 0 }, ex.rows.length, ex)!;
    assert.match(w, /page 1 of 241 \(5 of 1,203 rows\)/);
    assert.match(w, /pageIndex: 1/);
    // All pages in one response (live: pageSize without pageIndex): totalResults == rows, no warning.
    const all = { rows: [], columns: [], path: "$.data", totalResults: 4011, pageSize: 500, numberOfPages: 9 };
    assert.equal(detectTruncation("ns_runCustomSuiteQL", { sqlQuery: "SELECT …", pageSize: 500 }, 4011, all), undefined);
    assert.match(detectTruncation("ns_runCustomSuiteQL", { sqlQuery: "SELECT …", pageSize: 500, pageIndex: 2 }, 500, { ...all, pageIndex: 2 })!, /page 3 of 9.*pageIndex: 3/);
  });

  it("a record's total field is not a result count", () => {
    const ex = extractRows({ id: 90000011, tranid: "INV-1", total: 1234.56, count: 2 })!;
    assert.equal(detectTruncation("ns_getRecord", { recordType: "invoice", recordId: "90000011" }, 1, ex), undefined);
    // Even if a parser attached envelope fields, non-list tools ignore them.
    assert.equal(detectTruncation("ns_getRecord", {}, 1, { ...ex, totalResults: 1234.56, hasMore: true }), undefined);
    assert.equal(detectTruncation("ns_runReport", {}, 10, { rows: [], columns: [], path: "$", hasMore: true }), undefined);
  });
});

describe("report summary", () => {
  it("shows the section lines, not the structural root row or column sums", () => {
    const ctx = tmpCtx();
    const ex = extractRows(decodeToolResponse(fixture("report_income_statement.json")).json)!;
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runReport", query: '{"reportId":-200}', columns: ex.columns, rows: ex.rows, raw: "{}" });
    const s = buildSummary({ meta, rows: ex.rows, columns: ex.columns });
    assert.ok(s.length <= 1400, `summary is ${s.length} chars`);
    assert.match(s, /Sections \(Amount\): Sales 747,900.5 · Purchases 0 · Gross Profit 747,900.5 · Overheads 785,700.5/);
    assert.match(s, /Net Profit\/\(Loss\) -20,650.5/);
    assert.doesNotMatch(s, /987,654/, "root Financial Row is structural");
    assert.doesNotMatch(s, /Amount\(num/, "no column stats");
    assert.match(s, /don't sum a value column across rows/);
    // Blank spacer lines are left out of the suggested filter; signs are explained.
    assert.match(s, /Next: nsx results filter r_[0-9a-f]+ --where "depth>=0 and depth<=1 and is_detail=false and kind!=spacer"/);
    // The sign rule is checked per section (Overheads is minus its lines; Sales matches).
    assert.match(s, /Account lines carry their P&L sign \(income \+, expense −\); these sections show the opposite sign of their account lines \(positive = net expense, negative = net credit\): Overheads\./);
    assert.doesNotMatch(s, /section totals are shown positive/);
    assert.doesNotMatch(s, /range had no effect/);
    assert.match(s, /kind=structural row \(depth -1\) is NetSuite's container row, not a grand total/);
    assert.match(s, /Amounts are in the report currency \(the parent subsidiary's for consolidated reports\)/);
    // The suggested filter leaves the structural row out.
    const shown = ex.rows.filter(parseWhere("depth>=0 and depth<=1 and is_detail=false and kind!=spacer"));
    assert.ok(shown.length > 0);
    assert.ok(shown.every((r) => r.kind !== "structural" && r.kind !== "spacer" && r.line !== null));
    assert.equal(shown[0].line, "Sales");
  });

  it("schema profiles of a report carry no sums", () => {
    const ex = extractRows(decodeToolResponse(fixture("report_income_statement.json")).json)!;
    const amount = profileColumns(ex.columns, ex.rows).find((p) => p.name === "Amount")!;
    assert.equal(amount.sum, undefined);
    assert.equal(amount.sumNa, "report rows nest");
    assert.match(amount.note!, /double-counts subtotals/);
  });
});

describe("ids and currencies", () => {
  const ss = () => extractRows(decodeToolResponse(fixture("saved_search_open_bills.json")).json)!;

  it("classifies reference/id columns as ids and pads saved-search dates", () => {
    const ex = ss();
    const t = Object.fromEntries(profileColumns(ex.columns, ex.rows).map((p) => [p.name, p.type]));
    assert.deepEqual(
      [t.Subsidiary, t.Period, t.Name, t.Currency, t.Date, t["Due Date/Receive By"], t["Amount (Foreign Currency)"], t["Amount Paid (Foreign Currency)"]],
      ["id", "id", "id", "id", "date", "date", "num", "num"],
    );
    const sq = profileColumns(["id", "subsidiary", "foreigntotal", "paid", "custentity_x"], [{ id: 90000013, subsidiary: 7, foreigntotal: 294, paid: 1, custentity_x: 3 }, { id: 90000011, subsidiary: 1, foreigntotal: 1234.56, paid: 0, custentity_x: 4 }]);
    assert.deepEqual(sq.map((p) => p.type), ["id", "id", "num", "num", "num"]);
    const hi = Array.from({ length: 30 }, (_, i) => ({ ref: String(9000 + i * 17) }));
    assert.equal(profileColumns(["ref"], hi)[0].type, "id", "high-cardinality integer strings");
  });

  it("summary doesn't sum ids, hides cross-currency sums and hints with an amount metric", () => {
    const ctx = tmpCtx();
    const ex = ss();
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runSavedSearch", query: "{}", columns: ex.columns, rows: ex.rows, raw: "[]" });
    const s = buildSummary({ meta, rows: ex.rows, columns: ex.columns, budget: 3000 });
    assert.match(s, /Subsidiary\(id, 3 distinct\)/);
    assert.match(s, /Name\(id, 4 distinct\)/);
    assert.match(s, /Date\(date 2026-03-02\.\.2026-09-15\)/);
    assert.match(s, /Amount \(Foreign Currency\)\(num, sum n\/a: mixed currencies/);
    assert.match(s, /Mixed currencies in Currency \(1, 2, 3\)/);
    assert.match(s, /Next: nsx results agg r_[0-9a-f]+ --by Currency --sum "Amount \(Foreign Currency\)"/);
    assert.equal(loadRows(meta)[0].Name, "7700101", "ids reload as strings");
  });

  it("no hint metric without an amount-like column", () => {
    const ctx = tmpCtx();
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, entity: `E${i % 5}`, qty: i }));
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runCustomSuiteQL", query: "q", columns: ["id", "entity", "qty"], rows, raw: "[]" });
    assert.match(buildSummary({ meta, rows, columns: ["id", "entity", "qty"] }), /Next: nsx results head/);
  });

  it("agg blanks cross-currency TOTALs and renderRows prints ids without separators", () => {
    const ex = extractRows(decodeToolResponse(fixture("suiteql_invoices_page.json")).json)!;
    const byCur = aggregate(ex.rows, { by: ["currency"], metrics: [{ fn: "sum", col: "foreigntotal" }, { fn: "count" }] });
    assert.equal(byCur.rows.find((r) => r.currency === "EUR")!.sum_foreigntotal, 1170.4);
    assert.equal(byCur.totals.sum_foreigntotal, "n/a (3 currencies)");
    assert.equal(byCur.totals.count, 5);
    assert.match(byCur.warning!, /per-group amounts are fine/);
    const byCust = aggregate(ex.rows, { by: ["customer"], metrics: [{ fn: "sum", col: "foreigntotal" }] });
    assert.match(String(byCust.totals.sum_foreigntotal), /add --by currency/);
    const single = aggregate(ex.rows.filter((r) => r.currency === "EUR"), { by: ["customer"], metrics: [{ fn: "sum", col: "foreigntotal" }] });
    assert.equal(single.totals.sum_foreigntotal, 1170.4);
    assert.equal(single.warning, undefined);
    const out = renderRows(["id", "foreigntotal"], [{ id: 90000013, foreigntotal: 1234.56 }, { id: 90000011, foreigntotal: 12345.5 }]);
    assert.match(out, /90000013/);
    assert.match(out, /12,345.5/);
  });
});

describe("result store + engine", () => {
  it("round-trips rows through CSV with types", () => {
    const ctx = tmpCtx();
    const rows = [{ a: "x,y", n: 1.5, d: "2026-01-01" }, { a: 'q"uote', n: null, d: "2026-02-01" }];
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "t", query: "q", columns: ["a", "n", "d"], rows, raw: "[]" });
    assert.deepEqual(loadRows(meta), rows);
    assert.equal(listResults(ctx.acctDir!).length, 1);
  });

  it("aggregates with correct totals, top and sort", () => {
    const rows = bigRows(3000);
    const r = aggregate(rows, { by: ["subsidiary"], metrics: [{ fn: "sum", col: "amount" }, { fn: "count" }], top: 2 });
    assert.equal(r.rows.length, 2);
    // Per-subsidiary sums are fine; their TOTAL mixes base currencies.
    assert.equal(r.totals.sum_amount, "n/a (4 subsidiaries)");
    const all = aggregate(rows, { by: ["subsidiary"], metrics: [{ fn: "sum", col: "amount" }] });
    assert.equal(all.rows.reduce((t, g) => t + (g.sum_amount as number), 0), 13248000);
    assert.equal(aggregate(rows.map((x) => ({ ...x, subsidiary: "Sub 0" })), { by: [], metrics: [{ fn: "sum", col: "amount" }] }).totals.sum_amount, 13248000);
    assert.equal(r.totals.count, 3000);
    assert.ok((r.rows[0].sum_amount as number) >= (r.rows[1].sum_amount as number));
  });

  it("filters with and/or/contains/null", () => {
    const rows = [{ a: 5, s: "Open" }, { a: 20, s: "Paid" }, { a: null, s: "open item" }];
    assert.equal(rows.filter(parseWhere("a>10")).length, 1);
    assert.equal(rows.filter(parseWhere("a<10 or s='Paid'")).length, 2);
    assert.equal(rows.filter(parseWhere("s~open and a is null")).length, 1);
    assert.throws(() => parseWhere("nonsense"));
  });

  it("pivots and diffs", () => {
    const rows = [{ e: "A", m: "Jan", v: 1 }, { e: "A", m: "Feb", v: 2 }, { e: "B", m: "Jan", v: 3 }];
    const p = pivot(rows, "e", "m", "sum", "v");
    assert.deepEqual(p.columns, ["e", "Feb", "Jan"]);
    assert.equal(p.rows.find((r) => r.e === "A")!.Jan, 1);
    const d = diff([{ k: "x", v: 10 }, { k: "y", v: 5 }], [{ k: "x", v: 12 }, { k: "z", v: 1 }], ["k"], ["v"]);
    const x = d.rows.find((r) => r.k === "x")!;
    assert.equal(x.v_delta, 2);
    assert.equal(x.v_pct, 20);
    const z = d.rows.find((r) => r.k === "z")!;
    assert.equal(z._presence, "only_b");
    // Missing on one side: blank, not 0 and a delta.
    assert.deepEqual([z.v_a, z.v_b, z.v_delta, z.v_pct], [null, 1, null, null]);
    const y = d.rows.find((r) => r.k === "y")!;
    assert.deepEqual([y.v_a, y.v_b, y.v_delta], [5, null, null]);
  });

  it("infers types conservatively", () => {
    assert.equal(inferType(["1", "2.5", "-3", "1,000"]), "num");
    assert.equal(inferType(["00123", "00124"]), "str");
    assert.equal(inferType(["2026-01-01", "3/31/2026"]), "date");
    assert.equal(inferType(["T", "F"]), "bool");
    assert.equal(inferType([".00", "2689.00"]), "num", "saved-search zero amounts");
    assert.equal(inferType(["2026-3-2", "2026-10-12"]), "date");
  });

  it("cleans up results past retention", () => {
    const ctx = tmpCtx();
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "old", tool: "t", query: "q", columns: ["a"], rows: [{ a: 1 }], raw: "[]" });
    const past = new Date(Date.now() - 10 * 86_400_000);
    for (const f of Object.values(meta.files)) fs.utimesSync(f, past, past);
    assert.equal(cleanupResults(ctx.acctDir!, 7), 3);
    assert.equal(listResults(ctx.acctDir!).length, 0);
  });
});

describe("xlsx", () => {
  it("writes a zip that unzip accepts", { skip: !hasUnzip() }, () => {
    const buf = toXlsx(["a", "n"], [{ a: "x & <y>", n: 1.5 }], new Set(["n"]));
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "xlsx-")), "t.xlsx");
    fs.writeFileSync(f, buf);
    const out = execFileSync("unzip", ["-t", f]).toString();
    assert.match(out, /No errors detected/);
    const sheet = execFileSync("unzip", ["-p", f, "xl/worksheets/sheet1.xml"]).toString();
    assert.match(sheet, /x &amp; &lt;y&gt;/);
    assert.match(sheet, /<v>1.5<\/v>/);
  });

  it("deflates entries (method 8) with correct sizes", { skip: !hasUnzip() }, () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ a: `Customer ${i % 50}`, n: i }));
    const buf = toXlsx(["a", "n"], rows, new Set(["n"]));
    assert.equal(buf.readUInt16LE(8), 8, "first local header uses deflate");
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "xlsx-")), "t.xlsx");
    fs.writeFileSync(f, buf);
    assert.match(execFileSync("unzip", ["-t", f]).toString(), /No errors detected/);
    const listing = execFileSync("unzip", ["-v", f]).toString();
    assert.match(listing, /Defl/);
    const sheet = execFileSync("unzip", ["-p", f, "xl/worksheets/sheet1.xml"]);
    assert.ok(buf.length * 4 < sheet.length, `zip ${buf.length} B vs sheet ${sheet.length} B`);
  });
});

function hasUnzip(): boolean {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("quoted filters, text sort and preview retention", () => {
  it("and/or inside quoted values don't split the filter", () => {
    const rows = [{ status: "open or paid" }, { status: "open" }, { status: "paid and done" }];
    assert.equal(rows.filter(parseWhere("status='open or paid'")).length, 1);
    assert.equal(rows.filter(parseWhere(`status="paid and done" or status=open`)).length, 2);
  });

  it("--sort on a text column sorts A→Z", () => {
    const r = aggregate([{ e: "b", v: 1 }, { e: "a", v: 2 }, { e: "c", v: 3 }], { by: ["e"], metrics: [{ fn: "sum", col: "v" }], sort: "e" });
    assert.deepEqual(r.rows.map((x) => x.e), ["a", "b", "c"]);
  });

  it("previews expire with the retention window", async () => {
    const { cleanupPreviews, writePreview } = await import("../src/preview.ts");
    const ctx = tmpCtx();
    const { file } = writePreview(ctx.acctDir!, "ns_updateRecord", { recordType: "customer", recordId: "1", values: { phone: "1" } });
    const past = new Date(Date.now() - 10 * 86_400_000);
    fs.utimesSync(file, past, past);
    assert.equal(cleanupPreviews(ctx.acctDir!, 7), 1);
    assert.equal(fs.existsSync(file), false);
  });
});

describe("currencies, report rows, datetimes, paging hint", () => {
  const inv = () => extractRows(decodeToolResponse(fixture("suiteql_invoices_mixed_currency.json")).json)!;
  const summarise = (tool: string, columns: string[], rows: Record<string, unknown>[], query = "q") => {
    const ctx = tmpCtx();
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s", tool, query, columns, rows, raw: "[]" });
    return buildSummary({ meta, rows, columns, budget: 3000 });
  };
  /** The same invoices with the currency columns renamed or dropped. */
  const variant = (f: (r: Record<string, unknown>) => Record<string, unknown>) => {
    const rows = inv().rows.map(f);
    return { rows, columns: Object.keys(rows[0]) };
  };

  it("names currency-bearing and currency columns", () => {
    for (const c of ["foreigntotal", "t.foreignamountunpaid", "foreignamount", "Amount (Foreign Currency)", "amount", "netamount"]) assert.ok(isCurrencyBearing(c), c);
    for (const c of ["exchangerate", "currency", "curr", "id", "quantity"]) assert.ok(!isCurrencyBearing(c), c);
    for (const c of ["currency", "Currency", "t.currency", "curr", "ccy", "currencycode", "basecurrency", "txn_curr"]) assert.ok(isCurrencyColumn(c), c);
    for (const c of ["currentbalance", "exchangerate", "iscurrent", "recurringbill", "Amount (Foreign Currency)", "currencyprecision"]) assert.ok(!isCurrencyColumn(c), c);
  });

  it("prefers the display column (USD) over the id column (2) in messages", () => {
    const ex = inv();
    assert.equal(ex.rows[0].trandate, "2026-09-20", "unpadded SuiteQL dates are padded");
    const c = currencyCheck(ex.columns, ex.rows);
    assert.deepEqual([c.status, c.column, c.values, c.columns], ["mixed", "curr", ["AUD", "CAD", "EUR", "GBP", "NZD", "USD"], ["currency", "curr"]]);
    const s = summarise("ns_runCustomSuiteQL", ex.columns, ex.rows);
    assert.match(s, /foreigntotal\(num, sum n\/a: mixed currencies/);
    assert.match(s, /Mixed currencies in curr \(AUD, CAD, EUR, GBP, NZD, USD\)/);
    assert.doesNotMatch(s, /Mixed currencies in currency/);
    assert.match(s, /Next: nsx results agg r_[0-9a-f]+ --by curr --sum foreigntotal/);
  });

  it("finds a renamed currency column (ccy) by name, and any ISO-coded column by value", () => {
    const ccy = variant(({ currency, curr, ...r }) => ({ ...r, ccy: curr }));
    assert.match(summarise("ns_runCustomSuiteQL", ccy.columns, ccy.rows), /Mixed currencies in ccy \(AUD, CAD/);
    const odd = variant(({ currency, curr, ...r }) => ({ ...r, x_code: curr }));
    const s = summarise("ns_runCustomSuiteQL", odd.columns, odd.rows);
    assert.match(s, /foreigntotal\(num, sum n\/a: mixed currencies/);
    assert.match(s, /Mixed currencies in x_code/);
  });

  it("a base amount with no currency column keeps its sum unless it spans subsidiaries", () => {
    const cols = ["account", "amount"];
    const one = [{ account: "4000", amount: 10 }, { account: "4100", amount: 5 }];
    assert.equal(currencyCheck(cols, one).status, "single", "one subsidiary: one base currency");
    const many = [{ subsidiary: "1", account: "4000", amount: 10 }, { subsidiary: "2", account: "4000", amount: 5 }];
    assert.equal(currencyCheck(["subsidiary", ...cols], many).status, "unknown", "each subsidiary has its own base currency");
  });

  it("no currency column at all: currency unknown, no plain sum", () => {
    const none = variant(({ currency, curr, ...r }) => r);
    assert.equal(currencyCheck(none.columns, none.rows).status, "unknown");
    const s = summarise("ns_runCustomSuiteQL", none.columns, none.rows);
    assert.match(s, /foreigntotal\(num, sum n\/a: currency unknown/);
    assert.match(s, /Currency unknown: no currency column beside foreigntotal, so a total may mix currencies/);
    const p = profileColumns(none.columns, none.rows).find((x) => x.name === "foreigntotal")!;
    assert.equal(p.sum, undefined);
    assert.match(p.note!, /currency unknown: .*may mix currencies/);
    const a = aggregate(none.rows, { by: [], metrics: [{ fn: "sum", col: "foreigntotal" }] });
    assert.equal(a.rows[0].sum_foreigntotal, "n/a (currency unknown)");
    assert.equal(a.totals.sum_foreigntotal, "n/a (currency unknown)");
    assert.match(a.warning!, /currency unknown/);
    // One row can't mix anything.
    assert.equal(currencyCheck(none.columns, none.rows.slice(0, 1)).status, "single");
  });

  it("schema profiles drop the sum of a mixed-currency amount and explain min/max", () => {
    const ex = inv();
    const p = profileColumns(ex.columns, ex.rows).find((x) => x.name === "foreigntotal")!;
    assert.equal(p.sum, undefined);
    assert.equal(p.sumNa, "mixed currencies");
    assert.match(p.note!, /6 currencies \(curr: AUD, CAD, EUR, GBP, NZD, USD\).*min\/max compare different currencies/);
    assert.equal(typeof p.min, "number", "min/max stay, with the note");
    const one = ex.rows.filter((r) => r.curr === "EUR");
    assert.equal(profileColumns(ex.columns, one).find((x) => x.name === "foreigntotal")!.sum, 2454.5);
  });

  it("agg without --by blanks the single group row too, including avg; min/max get a note", () => {
    const ex = inv();
    const a = aggregate(ex.rows, { by: [], metrics: [{ fn: "sum", col: "foreigntotal" }, { fn: "avg", col: "foreigntotal" }, { fn: "max", col: "foreigntotal" }, { fn: "count" }] });
    assert.equal(a.rows.length, 1);
    assert.equal(a.rows[0].sum_foreigntotal, "n/a (6 currencies)");
    assert.equal(a.rows[0].avg_foreigntotal, "n/a (6 currencies)");
    assert.equal(a.rows[0].max_foreigntotal, 2400);
    assert.equal(a.rows[0].count, 8);
    assert.match(String(a.totals.sum_foreigntotal), /n\/a/);
    assert.match(a.warning!, /6 currencies \(curr: AUD, CAD, EUR, GBP, NZD, USD\).*min\/max compare amounts in different currencies.*--by curr/);
    // Grouping by the id column still groups by currency.
    const byId = aggregate(ex.rows, { by: ["currency"], metrics: [{ fn: "sum", col: "foreigntotal" }] });
    assert.equal(byId.rows.find((r) => r.currency === 1)!.sum_foreigntotal, 2454.5);
    assert.match(byId.warning!, /per-group amounts are fine/);
    // Groups that span currencies show n/a; single-currency groups keep their sums.
    const bySub = aggregate(ex.rows, { by: ["subsidiary"], metrics: [{ fn: "sum", col: "foreigntotal" }] });
    assert.equal(bySub.rows.find((r) => r.subsidiary === 7)!.sum_foreigntotal, 740.3, "two USD invoices");
    assert.equal(bySub.rows.find((r) => r.subsidiary === 1)!.sum_foreigntotal, 2454.5);
    assert.equal(bySub.rows.find((r) => r.subsidiary === 3)!.sum_foreigntotal, 1210);
    assert.match(bySub.warning!, /Add curr to --by/);
  });

  it("a customer list with a currency column but no amounts gets no currency warning", () => {
    const ex = extractRows(decodeToolResponse(fixture("suiteql_customers_currency.json")).json)!;
    assert.equal(currencyCheck(ex.columns, ex.rows).status, "none");
    const s = summarise("ns_runCustomSuiteQL", ex.columns, ex.rows);
    assert.doesNotMatch(s, /Mixed currencies|Currency unknown/);
  });

  it("saved-search datetimes type as dates and sort", () => {
    const ex = extractRows(decodeToolResponse(fixture("saved_search_bills_datetime.json")).json)!;
    assert.equal(ex.rows[0]["Date Created"], "2019-09-17 07:18");
    assert.equal(ex.rows[2]["Date Created"], "2019-09-16 00:25");
    const p = profileColumns(ex.columns, ex.rows).find((x) => x.name === "Date Created")!;
    assert.deepEqual([p.type, p.min, p.max], ["date", "2019-09-16 00:25", "2019-10-16 12:05"]);
    assert.equal(profileColumns(ex.columns, ex.rows).find((x) => x.name === "Due Date/Receive By")!.min, "2016-05-31");
    assert.equal(ex.rows.filter((r) => String(r["Date Created"]) >= "2019-10-01").length, 4, "padded values compare as strings");
    assert.equal(inferType(["2026-09-20T19:08:00Z", "2026-09-20T19:08:00.000+02:00", "2026-9-2 7:08 pm"]), "date");
  });

  it("the paging hint cites the query's own ORDER BY, else its first alias", () => {
    const ex = inv();
    const w = detectTruncation("ns_runCustomSuiteQL", { sqlQuery: String(ex.rows.length && "SELECT t.id FROM transaction t WHERE t.x = 'order by y' ORDER BY t.id"), pageSize: 8, pageIndex: 0 }, ex.rows.length, ex)!;
    assert.match(w, /keep the same unique ORDER BY \(t\.id\)/);
    assert.equal(pagingKeyHint("SELECT c.id, c.companyname FROM customer c WHERE c.isinactive = 'F'"), "add a unique ORDER BY, e.g. c.id");
    assert.equal(pagingKeyHint("SELECT id FROM customer"), "add a unique ORDER BY, e.g. id");
    assert.equal(pagingKeyHint("SELECT t.id FROM transaction t ORDER BY t.trandate DESC FETCH FIRST 10 ROWS ONLY"), "keep a unique ORDER BY, e.g. t.trandate DESC, t.id");
    assert.equal(pagingKeyHint("SELECT x.id FROM (SELECT t.id FROM transaction t ORDER BY t.id) x"), "add a unique ORDER BY, e.g. x.id", "a subquery's ORDER BY doesn't order the page");
    assert.equal(pagingKeyHint("SELECT c.id FROM customer AS c JOIN transaction t ON t.entity = c.id ORDER BY c.id, t.id"), "keep the same unique ORDER BY (c.id, t.id)");
  });
});

describe("diff keys, pivot currencies, list ids, report notes, concat", () => {
  const report = () => extractRows(decodeToolResponse(fixture("report_income_statement.json")).json)!;
  const inv = () => extractRows(decodeToolResponse(fixture("suiteql_invoices_mixed_currency.json")).json)!;

  it("report diff leaves out detail/structural/spacer rows instead of doubling each account", () => {
    const a = report().rows;
    const b = a.map((r) => ({ ...r, Amount: typeof r.Amount === "number" ? r.Amount * 0.5 : r.Amount }));
    const line = a.find((r) => r.line === "4000 - Account 3" && r.kind === "line")!;
    assert.ok(a.some((r) => r.line === "4000 - Account 3" && r.kind === "detail"), "the fixture repeats the account as a detail row");
    const d = diff(a, b, ["line"], ["Amount"]);
    assert.equal(d.warning, undefined);
    assert.deepEqual(d.on, ["line"]);
    assert.match(d.notes[0], /left out \d+ \(a\) and \d+ \(b\) detail\/structural\/spacer rows/);
    const row = d.rows.find((r) => r.line === "4000 - Account 3")!;
    assert.equal(row.Amount_a, line.Amount, "not doubled");
    assert.equal(row.Amount_b, (line.Amount as number) * 0.5);
    assert.equal(row.Amount_pct, -50);
    assert.ok(!d.rows.some((r) => r.line === null || r.line === "Financial Row" && r.Amount_a === 987654.32), "no spacer or structural keys");
    // Saved before the spacer kind existed: blank lines still drop out.
    const old = a.map((r) => (r.kind === "spacer" ? { ...r, kind: r.is_detail ? "detail" : "line" } : r));
    assert.equal(diff(old, b, ["line"], ["Amount"]).warning, undefined);
  });

  it("report lines that still repeat are keyed on depth, then refused", () => {
    const r = (line: string, depth: number, Amount: number, kind = "line") => ({ line, depth, is_detail: kind === "detail", kind, Amount });
    const a = [r("Sales", 0, 100, "section"), r("Sales", 1, 60), r("Other", 1, 40)];
    const b = [r("Sales", 0, 110, "section"), r("Sales", 1, 70), r("Other", 1, 40)];
    const d = diff(a, b, ["line"], ["Amount"]);
    assert.deepEqual(d.on, ["line", "depth"]);
    assert.match(d.notes.join(" "), /keyed on line,depth/);
    assert.equal(d.rows.find((x) => x.line === "Sales" && x.depth === 0)!.Amount_a, 100);
    assert.deepEqual(d.columns.slice(0, 2), ["line", "depth"]);
    const dup = [...a, r("Other", 1, 1)];
    assert.throws(() => diff(dup, b, ["line"], ["Amount"]), /key 'line,depth' isn't unique among the report lines: 1 keys repeat \(e\.g\. "Other, 1" ×2\)/);
  });

  it("a repeating key elsewhere is summed with a warning; composite keys work", () => {
    const a = [{ acct: "4000", sub: "1", v: 10 }, { acct: "4000", sub: "2", v: 5 }, { acct: "4100", sub: "1", v: 3 }];
    const b = [{ acct: "4000", sub: "1", v: 12 }, { acct: "4000", sub: "2", v: 5 }, { acct: "4100", sub: "1", v: 3 }];
    const d = diff(a, b, ["acct"], ["v"]);
    assert.equal(d.warning, `key 'acct' isn't unique: 1 keys repeat (e.g. "4000" ×2); values were summed — use a unique key or --on a,b`);
    assert.equal(d.rows.find((r) => r.acct === "4000")!.v_a, 15);
    const c = diff(a, b, ["acct", "sub"], ["v"]);
    assert.equal(c.warning, undefined);
    assert.equal(c.rows.find((r) => r.acct === "4000" && r.sub === "1")!.v_delta, 2);
  });

  it("the percentage is n/a on a zero or near-zero base", () => {
    const d = diff([{ k: "x", v: 0.01 }, { k: "y", v: 0 }, { k: "z", v: -2 }], [{ k: "x", v: 1234567.89 }, { k: "y", v: 5 }, { k: "z", v: -1 }], ["k"], ["v"]);
    const pct = Object.fromEntries(d.rows.map((r) => [r.k, r.v_pct]));
    assert.deepEqual(pct, { x: "n/a", y: "n/a", z: 50 });
  });

  it("pivot cells spanning currencies show n/a, with a warning unless an axis is the currency", () => {
    const ex = inv();
    // The live case: --rows trandate --cols trandate. One extra USD-only day keeps a plain cell.
    const p = pivot([...ex.rows, { ...ex.rows[0], trandate: "2026-09-23" }], "trandate", "trandate", "sum", "foreigntotal");
    assert.equal(p.rows.find((r) => r.trandate === "2026-09-20")!["2026-09-20"], "n/a (2 currencies)");
    assert.equal(p.rows.find((r) => r.trandate === "2026-09-23")!["2026-09-23"], 640.4);
    const cells = p.rows.flatMap((r) => p.columns.slice(1).map((c) => r[c]));
    assert.ok(cells.some((v) => typeof v === "string" && /^n\/a \(\d currencies\)$/.test(v)), JSON.stringify(p.rows));
    assert.ok(cells.some((v) => typeof v === "number"), "single-currency cells keep their sums");
    assert.match(p.warning!, /curr has 6 values \(AUD, CAD, EUR, GBP, NZD, USD\) and neither --rows nor --cols is curr: \d+ cell\(s\) spanning several currencies show n\/a/);
    const onCur = pivot(ex.rows, "subsidiary", "curr", "sum", "foreigntotal");
    assert.equal(onCur.warning, undefined);
    assert.ok(onCur.rows.every((r) => onCur.columns.slice(1).every((c) => r[c] === undefined || typeof r[c] === "number")));
    assert.equal(pivot(ex.rows, "currency", "trandate", "sum", "foreigntotal").warning, undefined, "the id column groups by currency too");
    assert.match(pivot(ex.rows, "subsidiary", "trandate", "max", "foreigntotal").warning!, /min\/max compare amounts in different currencies/);
    assert.equal(pivot(ex.rows, "subsidiary", "trandate", "count").warning, undefined);
  });

  it("with no currency column, agg --by and pivot both show n/a for groups that may mix", () => {
    const rows = inv().rows.map(({ currency, curr, ...r }) => r);
    const a = aggregate(rows, { by: ["trandate"], metrics: [{ fn: "sum", col: "foreigntotal" }] });
    const multi = a.rows.filter((r) => rows.filter((x) => x.trandate === r.trandate).length > 1);
    assert.ok(multi.length > 0);
    assert.ok(multi.every((r) => r.sum_foreigntotal === "n/a (currency unknown)"), JSON.stringify(a.rows));
    assert.equal(a.totals.sum_foreigntotal, "n/a (currency unknown)");
    assert.match(a.warning!, /currency unknown: .*groups that may span currencies show n\/a/);
    const p = pivot(rows, "trandate", "subsidiary", "sum", "foreigntotal");
    assert.match(p.warning!, /currency unknown: no currency column, so foreigntotal may mix currencies/);
    // A base amount on one subsidiary is one currency: plain sums, no warning.
    const base = [{ account: "4000", amount: 10 }, { account: "4000", amount: 5 }, { account: "4100", amount: 1 }];
    const b = aggregate(base, { by: ["account"], metrics: [{ fn: "sum", col: "amount" }] });
    assert.equal(b.warning, undefined);
    assert.equal(b.rows.find((r) => r.account === "4000")!.sum_amount, 15);
    assert.equal(pivot(base, "account", "account", "sum", "amount").warning, undefined);
    // Several subsidiaries, grouped by subsidiary: each group is one base currency.
    const subs = [{ subsidiary: "1", amount: 10 }, { subsidiary: "1", amount: 5 }, { subsidiary: "2", amount: 7 }];
    const bs = aggregate(subs, { by: ["subsidiary"], metrics: [{ fn: "sum", col: "amount" }] });
    assert.equal(bs.rows.find((r) => r.subsidiary === "1")!.sum_amount, 15);
    assert.equal(bs.totals.sum_amount, "n/a (2 subsidiaries)");
  });

  it("a saved-search list column of small integers is a category, not a measure", () => {
    const ex = extractRows(decodeToolResponse(fixture("saved_search_accounts_listid.json")).json)!;
    const t = Object.fromEntries(profileColumns(ex.columns, ex.rows).map((p) => [p.name, p]));
    assert.equal(t["Handling Type"].type, "id");
    assert.equal(t["Handling Type"].sum, undefined);
    assert.equal(t.Quantity.type, "num", "a quantity stays a measure");
    const ctx = tmpCtx();
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runSavedSearch", query: "{}", columns: ex.columns, rows: ex.rows, raw: "[]" });
    const s = buildSummary({ meta, rows: ex.rows, columns: ex.columns, budget: 3000 });
    assert.match(s, /Handling Type\(id, 2 distinct\)/);
    assert.doesNotMatch(s, /Handling Type\(num/);
  });

  it("a report run with range but one value column says range had no effect", () => {
    const ctx = tmpCtx();
    const ex = report();
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runReport", query: '{"range":"MONTH","reportId":-200}', columns: ex.columns, rows: ex.rows, raw: "{}" });
    // Only lowercase month/quarter work live; say so.
    assert.match(buildSummary({ meta, rows: ex.rows, columns: ex.columns }), /range "MONTH" had no effect\. Accepted values \(lowercase\): month, quarter\./);
  });

  it("blank report lines get kind spacer", () => {
    const ex = report();
    const spacers = ex.rows.filter((r) => r.kind === "spacer");
    assert.ok(spacers.length > 0);
    assert.ok(spacers.every((r) => r.line === null && r.Amount === null && (r.depth as number) >= 0));
    assert.ok(!ex.rows.some((r) => r.kind !== "spacer" && r.kind !== "structural" && r.line === null));
  });

  describe("results concat", () => {
    const sql = "SELECT t.id, t.trandate FROM transaction t ORDER BY t.id";
    const page = (acctDir: string, idx: number, ids: number[], q = sql, total = 7) => {
      const rows = ids.map((id) => ({ id, trandate: "2026-09-01" }));
      const raw = JSON.stringify({ queryExecuted: q, resultCount: rows.length, totalResults: total, data: rows, pageSize: 3, pageIndex: idx, numberOfPages: 3, hasNextPage: idx < 2 });
      return saveResult({ acctDir, session: "s", tool: "ns_runCustomSuiteQL", query: q, columns: ["id", "trandate"], rows, raw, truncated: `page ${idx + 1} of 3` });
    };

    it("stacks SuiteQL pages in page order and says when pages are still missing", () => {
      const ctx = tmpCtx();
      const p0 = page(ctx.acctDir!, 0, [1, 2, 3]);
      const p1 = page(ctx.acctDir!, 1, [4, 5, 6]);
      const p2 = page(ctx.acctDir!, 2, [7]);
      const all = concatResults([p2, p0, p1]);
      assert.deepEqual(loadRows(all.meta).map((r) => Number(r.id)), [1, 2, 3, 4, 5, 6, 7]);
      assert.equal(all.meta.query, sql);
      assert.equal(all.meta.truncated, undefined, "every page is there");
      assert.match(all.notes[0], /pages 1, 2, 3 of 3/);
      const part = concatResults([p0, p2]);
      assert.match(part.notes.join(" "), /page 2 is missing \(between/);
      assert.doesNotMatch(part.notes.join(" "), /pages 2–2/);
      assert.match(concatResults([p0, page(ctx.acctDir!, 3, [10])]).notes.join(" "), /pages 2–3 are missing/);
      assert.match(part.meta.truncated!, /4 of 7 rows.*missing/);
      assert.throws(() => concatResults([p0, page(ctx.acctDir!, 0, [1, 2, 3])]), /both page 1/);
      assert.throws(() => concatResults([p0, page(ctx.acctDir!, 1, [4], "SELECT t.id, t.trandate FROM transaction t ORDER BY t.trandate")]), /different query/);
      assert.throws(() => concatResults([p0]), /at least two/);
      assert.equal(listResults(ctx.acctDir!).filter((m) => m.id === all.meta.id).length, 1, "saved like any result");
    });

    it("stacks saved-search slices by range_start and refuses overlaps", () => {
      const ctx = tmpCtx();
      const slice = (start: number, n: number) => {
        const rows = Array.from({ length: n }, (_, i) => ({ Number: String(start + i), v: 1 }));
        return saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runSavedSearch", query: JSON.stringify({ range_end: start + n, range_start: start, searchId: "customsearch1" }), columns: ["Number", "v"], rows, raw: "[]", truncated: `result hit range_end (${start + n})` });
      };
      const a = slice(0, 2);
      const b = slice(2, 2);
      const r = concatResults([b, a]);
      assert.equal(r.meta.rowCount, 4);
      assert.equal(r.meta.query, '{"searchId":"customsearch1"}');
      assert.match(r.notes[0], /0–2, 2–4/);
      assert.match(r.meta.truncated!, /last part .* itself incomplete/);
      assert.throws(() => concatResults([a, slice(1, 2)]), /overlap/);
    });
  });
});

describe("diff currencies, quoted filter columns, blanks, id sums, report schema", () => {
  const inv = () => extractRows(decodeToolResponse(fixture("suiteql_invoices_mixed_currency.json")).json)!;
  const ss = () => extractRows(decodeToolResponse(fixture("saved_search_list_blanks.json")).json)!;
  // Two pages of `SELECT t.id, t.type, BUILTIN.DF(t.currency) AS currency, t.foreigntotal …` (synthetic).
  const CURS = ["AUD", "CAD", "EUR", "GBP", "NZD", "USD"];
  const page = (start: number) =>
    Array.from({ length: 36 }, (_, i) => ({ id: start + i, type: ["VendPymt", "CustPymt", "CustInvc"][i % 3], currency: CURS[i % 6], foreigntotal: ((i % 3) - 1) * (100 + i * 7.25) }));

  it("diff shows n/a for keys whose rows span currencies, and says to add the currency to --on", () => {
    const d = diff(page(1), page(1001), ["type"], ["foreigntotal"]);
    assert.ok(d.rows.length === 3);
    for (const r of d.rows) {
      assert.match(String(r.foreigntotal_a), /^n\/a \(\d currencies\)$/, JSON.stringify(r));
      assert.match(String(r.foreigntotal_b), /^n\/a \(\d currencies\)$/);
      assert.equal(r.foreigntotal_delta, null);
      assert.equal(r.foreigntotal_pct, null);
      assert.ok(diffChanged(r, "foreigntotal", 0), "n/a rows are shown, not filtered as unchanged");
    }
    assert.ok(d.warnings.some((w) => /currency has 6 values \(AUD, CAD, EUR, GBP, NZD, USD\): 3 key\(s\) spanning several currencies show n\/a\. Add currency to --on\./.test(w)), String(d.warning));
    assert.match(d.warning!, /key 'type' isn't unique/);
    // Keyed on type and currency: plain per-currency deltas, no currency warning.
    const k = diff(page(1), page(1001), ["type", "currency"], ["foreigntotal"]);
    assert.ok(k.rows.every((r) => typeof r.foreigntotal_delta === "number"));
    assert.ok(!k.warnings.some((w) => /has \d+ values|currency unknown/.test(w)), String(k.warning));
  });

  it("one currency per side but different ones: values shown, delta n/a", () => {
    const d = diff([{ k: "x", currency: "EUR", amount: 10 }, { k: "y", currency: "EUR", amount: 3 }], [{ k: "x", currency: "USD", amount: 12 }, { k: "y", currency: "EUR", amount: 4 }], ["k"], ["amount"]);
    const x = d.rows.find((r) => r.k === "x")!;
    assert.deepEqual([x.amount_a, x.amount_b, x.amount_delta, x.amount_pct], [10, 12, "n/a (EUR vs USD)", null]);
    assert.equal(d.rows.find((r) => r.k === "y")!.amount_delta, 1);
    assert.match(d.warning!, /1 key\(s\) in a different currency on each side show an n\/a delta/);
  });

  it("no currency column: keys that may mix show n/a (currency unknown); a base amount on one subsidiary doesn't", () => {
    const strip = (rows: ReturnType<typeof page>) => rows.map(({ currency, ...r }) => r);
    const d = diff(strip(page(1)), strip(page(1001)), ["type"], ["foreigntotal"]);
    assert.ok(d.rows.every((r) => r.foreigntotal_a === "n/a (currency unknown)" && r.foreigntotal_delta === null), JSON.stringify(d.rows[0]));
    assert.ok(d.warnings.some((w) => /^currency unknown: no currency column, so foreigntotal may mix currencies; 3 key\(s\)/.test(w)), String(d.warning));
    // Keyed on id: each key is one document, compared with itself.
    const byId = diff(strip(page(1)), strip(page(1)), ["id"], ["foreigntotal"]);
    assert.ok(byId.rows.every((r) => r.foreigntotal_delta === 0));
    assert.equal(byId.warning, undefined);
    // Base amounts (not foreign*), one subsidiary: one currency.
    const base = [{ account: "4000", subsidiary: "1", amount: 10 }, { account: "4000", subsidiary: "1", amount: 5 }];
    const b = diff(base, base.map((r) => ({ ...r, amount: r.amount * 2 })), ["account"], ["amount"]);
    assert.equal(b.rows[0].amount_delta, 15);
    assert.ok(!b.warnings.some((w) => /has \d+ values|currency unknown/.test(w)));
    // Several subsidiaries: base amounts may be in different currencies.
    const subs = [{ account: "4000", subsidiary: "1", amount: 10 }, { account: "4000", subsidiary: "7", amount: 5 }];
    assert.equal(diff(subs, subs, ["account"], ["amount"]).rows[0].amount_a, "n/a (2 subsidiaries)");
  });

  it("two report results in different currencies warn; same currency doesn't", () => {
    const rows = extractRows(decodeToolResponse(fixture("report_income_statement.json")).json)!.rows;
    const d = diff(rows, rows, ["line"], ["Amount"], { reportCurrency: { a: "EUR", b: "USD" } });
    assert.ok(d.warnings.includes("a is in EUR, b is in USD: the figures are shown side by side, with no delta. Diff reports run in the same currency (subsidiaries that share one, or both consolidated)."), String(d.warning));
    // No numeric delta across currencies; the figures stay readable side by side.
    assert.ok(d.rows.every((r) => r.Amount_delta === "n/a (EUR vs USD)" && r.Amount_pct === "n/a (EUR vs USD)"), JSON.stringify(d.rows[0]));
    assert.ok(d.rows.some((r) => typeof r.Amount_a === "number" && typeof r.Amount_b === "number"));
    assert.deepEqual(d.counts, { changed: 0, incomparable: d.rows.length, same: 0 });
    assert.equal(diff(rows, rows, ["line"], ["Amount"], { reportCurrency: { a: "EUR", b: "EUR" } }).warning, undefined);
    assert.equal(diff(rows, rows, ["line"], ["Amount"], { reportCurrency: { a: "EUR" } }).warning, undefined);
  });

  it("reportCurrencyOf reads subsidiaryId from the result query and the profile", () => {
    const prof = { builtAt: "", baseCurrency: "EUR", subsidiaryCurrencies: { "1": "EUR", "2": "AUD", "7": "USD" }, parentSubsidiaryId: "1" };
    const meta = (query: string, tool = "ns_runReport") => ({ id: "r_x", createdAt: "", session: "s", tool, query, rowCount: 0, columns: [], files: { raw: "", csv: "", meta: "" } });
    assert.equal(reportCurrencyOf(meta('{"reportId":-200,"subsidiaryId":-1}'), prof), "EUR");
    assert.equal(reportCurrencyOf(meta('{"reportId":-200}'), prof), "EUR", "no subsidiaryId: consolidated");
    assert.equal(reportCurrencyOf(meta('{"reportId":-200,"subsidiaryId":7}'), prof), "USD");
    assert.equal(reportCurrencyOf(meta('{"reportId":-200,"subsidiaryId":"2"}'), prof), "AUD");
    assert.equal(reportCurrencyOf(meta('{"reportId":-200,"subsidiaryId":9}'), prof), undefined);
    assert.equal(reportCurrencyOf(meta("SELECT 1", "ns_runCustomSuiteQL"), prof), undefined);
    assert.equal(reportCurrencyOf(meta('{"reportId":-200}'), undefined), undefined);
  });

  it("filter columns with spaces: double quotes, backticks, bare labels with the column list, and loose names", () => {
    const ex = ss();
    const sept = ex.rows.filter((r) => typeof r["Last Run On"] === "string" && (r["Last Run On"] as string) >= "2026-09-01").length;
    assert.ok(sept > 0 && sept < ex.rows.length);
    assert.equal(ex.rows.filter(parseWhere(`"Last Run On" >= '2026-09-01'`)).length, sept);
    assert.equal(ex.rows.filter(parseWhere("`Last Run On` >= '2026-09-01'")).length, sept);
    assert.equal(ex.rows.filter(parseWhere("Last Run On >= 2026-09-01", ex.columns)).length, sept);
    assert.equal(ex.rows.filter(parseWhere("last_run_on >= '2026-09-01' and \"Record Type\" = 'Customer'", ex.columns)).length, ex.rows.filter((r) => (r["Last Run On"] as string) >= "2026-09-01" && r["Record Type"] === "Customer").length);
    assert.equal(ex.rows.filter(parseWhere("LAST RUN ON is null", ex.columns)).length, 9, "blank ' ' cells are null");
    assert.equal(resolveColumn(["Amount (Foreign Currency)"], "amount_foreign_currency"), "Amount (Foreign Currency)");
    assert.equal([{ "Amount (Foreign Currency)": 5 }, { "Amount (Foreign Currency)": 50 }].filter(parseWhere(`"Amount (Foreign Currency)" > 10`)).length, 1);
    assert.deepEqual(whereColumns(`"Last Run On" >= '2026-09-01' and \`From Bundle\` is not null or amount>5`), ["Last Run On", "From Bundle", "amount"]);
    assert.throws(() => parseWhere("nosuch > 1", ex.columns), /Unknown column\(s\): nosuch\. Available: Internal ID, .*quote one with spaces/);
    assert.throws(() => parseWhere("Last Run On >= 2026-09-01"), /quote a column name with spaces: "Last Run On"/);
    assert.throws(() => parseWhere("nonsense"), /Cannot parse condition: nonsense .*"Last Run On" >= '2026-09-01' or `Last Run On`/);
    // Quoted values with and/or still don't split; old unquoted syntax is unchanged.
    assert.equal([{ s: "a and b" }, { s: "c" }].filter(parseWhere("s='a and b' or s=`c`".replace("`c`", "'c'"))).length, 2);
  });

  it("whitespace-only saved-search blanks are nulls, so the datetime column types as a date", () => {
    const ex = ss();
    const p = Object.fromEntries(profileColumns(ex.columns, ex.rows).map((c) => [c.name, c]));
    assert.equal(p["Last Run On"].type, "date");
    assert.equal(p["Last Run On"].nulls, 9);
    assert.match(String(p["Last Run On"].min), /^2026-08-\d\d \d\d:\d\d$/);
    assert.equal(ex.rows.filter(parseWhere("`Last Run On` <= '2026-12-31'")).length, 31, "blanks never match a comparison");
    const ctx = tmpCtx();
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runSavedSearch", query: "{}", columns: ex.columns, rows: ex.rows, raw: "[]" });
    assert.equal(loadRows(meta).filter((r) => r["Last Run On"] === null).length, 9, "reloaded blanks are null");
    const s = buildSummary({ meta, rows: ex.rows, columns: ex.columns, budget: 3000 });
    assert.match(s, /Last Run On\(date 2026-08-\d\d \d\d:\d\d\.\.2026-09-\d\d \d\d:\d\d, nulls 9\)/);
  });

  it("reference columns (Last Run By, From Bundle) are ids; other integer columns get no sum", () => {
    const ex = ss();
    const p = Object.fromEntries(profileColumns(ex.columns, ex.rows).map((c) => [c.name, c]));
    assert.equal(p["Last Run By"].type, "id");
    assert.equal(p["From Bundle"].type, "id");
    assert.equal(p["Last Run By"].sum, undefined);
    const rows = Array.from({ length: 30 }, (_, i) => ({ "Status Code": 200 + (i % 3) * 100 + i, Quantity: i % 4, Amount: i * 1.5, Weight: i, Ratio: i / 4 }));
    const q = Object.fromEntries(profileColumns(Object.keys(rows[0]), rows).map((c) => [c.name, c]));
    assert.equal(q["Status Code"].type, "num");
    assert.equal(q["Status Code"].sum, undefined, "an integer column that isn't an amount or a count");
    assert.equal(q["Status Code"].min, 200);
    assert.equal(q.Quantity.sum, 43);
    assert.equal(q.Weight.sum, 435);
    assert.equal(q.Amount.sum, 652.5);
    // Rates: a ratio column isn't summed; other fractions are measures.
    assert.equal(q.Ratio.sum, undefined, "ratios don't add up");
    assert.equal(profileColumns(["hours"], rows.map((r) => ({ hours: r.Ratio })))[0].sum, 108.75, "fractions are measures");
    const ctx = tmpCtx();
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runCustomSuiteQL", query: "q", columns: Object.keys(rows[0]), rows, raw: "[]" });
    const s = buildSummary({ meta, rows, columns: Object.keys(rows[0]), budget: 3000 });
    assert.match(s, /Status Code\(num, min 200, max 429\)/);
    for (const name of ["Set By", "lastmodifiedby", "Approved By", "Role", "Owner", "bundle"]) {
      const r = Array.from({ length: 5 }, (_, i) => ({ [name]: 3000000 + i }));
      assert.equal(profileColumns([name], r)[0].type, "id", name);
    }
  });

  it("agg min/max over mixed currencies doesn't claim n/a; the currency-unknown warning mentions min/max", () => {
    const ex = inv();
    const col = ex.columns.find((c) => c === "trandate")!;
    const a = aggregate(ex.rows, { by: [col], metrics: [{ fn: "max", col: "foreigntotal" }] });
    assert.ok(a.rows.every((r) => typeof r.max_foreigntotal === "number"));
    assert.match(a.warning!, /min\/max compare amounts in different currencies\. Add curr to --by\./);
    assert.doesNotMatch(a.warning!, /show n\/a/);
    const mixed = aggregate(ex.rows, { by: [col], metrics: [{ fn: "sum", col: "foreigntotal" }, { fn: "max", col: "foreigntotal" }] });
    assert.match(mixed.warning!, /groups spanning several currencies show n\/a\. min\/max compare/);
    const bare = ex.rows.map(({ currency, curr, ...r }) => r);
    const u = aggregate(bare, { by: [], metrics: [{ fn: "max", col: "foreigntotal" }] });
    assert.match(u.warning!, /^currency unknown: no currency column, so foreigntotal may mix currencies; min\/max may compare amounts in different currencies\./);
  });

  it("report schema: structural columns get no nesting note, min/max skip structural and spacer rows", () => {
    const ex = extractRows(decodeToolResponse(fixture("report_income_statement.json")).json)!;
    const p = Object.fromEntries(profileColumns(ex.columns, ex.rows).map((c) => [c.name, c]));
    assert.equal(p.depth.note, undefined);
    assert.equal(p.depth.sumNa, undefined);
    assert.equal(p.depth.sum, undefined);
    assert.equal(p.Amount.sumNa, "report rows nest");
    assert.notEqual(p.Amount.max, 987654.32, "the structural row's value isn't the max");
    assert.equal(p.Amount.max, 785700.5);
  });

  it("the P&L sign note is computed per section, negative sections included", () => {
    const r = (line: string, depth: number, Amount: number | null, kind = "line") => ({ line, depth, is_detail: kind === "detail", kind, Amount });
    const rows = [
      r("Sales", 0, 1000, "section"), r("4000 - Revenue", 1, 1000), r("4000 - Revenue", 2, 1000, "detail"),
      r("Purchases", 0, -120.5, "section"), r("5100 - Supplier rebate", 1, 120.5), r("5100 - Supplier rebate", 2, 120.5, "detail"),
      r("Gross Profit", 0, 1120.5, "section"),
      r("Other Expenses", 0, 40, "section"), r("7000 - Bank fees", 1, -40), r("7000 - Bank fees", 2, -40, "detail"),
      r("Net Profit/(Loss)", 0, 1080.5, "section"),
    ];
    assert.equal(sectionSignNote(rows, "Amount"), "Account lines carry their P&L sign (income +, expense −); these sections show the opposite sign of their account lines (positive = net expense, negative = net credit): Purchases, Other Expenses.");
    assert.equal(sectionSignNote(rows.slice(0, 3), "Amount"), "Account lines carry their P&L sign (income +, expense −); section totals match the sign of their lines.");
    assert.match(sectionSignNote([r("Sales", 0, 10, "section")], "Amount"), /expense sections are shown with the opposite sign of their account lines \(positive = net expense, negative = net credit\)/);
  });
});

describe("result account dirs and duration sums", () => {
  it("acctDirOf finds a saved result's account dir", () => {
    const ctx = tmpCtx();
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s1", tool: "ns_runCustomSuiteQL", query: "SELECT 1", columns: ["a"], rows: [{ a: 1 }], raw: "[]" });
    assert.equal(acctDirOf(meta), ctx.acctDir);
    assert.equal(acctDirOf({ ...meta, files: { ...meta.files, meta: "/tmp/x/y.meta.json" } }), undefined);
  });

  it("integer duration columns are still summed", () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ duration: (i % 5) + 1 }));
    assert.equal(profileColumns(["duration"], rows)[0].sum, 90);
  });
});

describe("date min/max, row sort, diff counts, blank groups, nested sign note", () => {
  const ss = () => extractRows(decodeToolResponse(fixture("saved_search_list_blanks.json")).json)!;
  const inv = () => extractRows(decodeToolResponse(fixture("suiteql_invoices_mixed_currency.json")).json)!;
  const latest = (rows: Row[], col: string) => rows.map((r) => r[col]).filter((v): v is string => typeof v === "string" && v.trim() !== "").sort().pop();

  it("agg --min/--max on a date column compares dates and prints them", () => {
    const ex = ss();
    const rows = loadRowsOf(ex);
    const max = latest(rows, "Last Run On")!;
    assert.match(max, /^2026-\d\d-\d\d \d\d:\d\d$/);
    const all = aggregate(rows, { by: [], metrics: [{ fn: "min", col: "Last Run On" }, { fn: "max", col: "Last Run On" }, { fn: "count" }] });
    assert.equal(all.rows[0]["max_Last Run On"], max);
    assert.equal(all.totals["max_Last Run On"], max);
    assert.match(String(all.totals["min_Last Run On"]), /^2026-08-/);
    assert.equal(all.warning, undefined);
    // The live "done when": --by Type --max … --sort max_… --top 3 lists types with dates, latest first.
    const by = aggregate(rows, { by: ["Record Type"], metrics: [{ fn: "max", col: "Last Run On" }], sort: "max_Last Run On", top: 3 });
    const got = by.rows.map((r) => r["max_Last Run On"] as string);
    assert.equal(got.length, 3);
    assert.ok(got.every((v) => /^2026-/.test(v)), JSON.stringify(by.rows));
    assert.deepEqual(got, [...got].sort().reverse(), "latest first");
    assert.equal(got[0], max);
    // Typed from the meta too; raw unpadded datetimes are normalised before comparing.
    const raw = [{ k: "a", d: "2026-9-3 1:00 pm" }, { k: "a", d: "2026-10-1 9:00 am" }, { k: "b", d: null }];
    const t = aggregate(raw, { by: ["k"], metrics: [{ fn: "max", col: "d" }], types: { d: "date" } });
    assert.equal(t.rows.find((r) => r.k === "a")!.max_d, "2026-10-01 9:00 am");
    assert.equal(t.rows.find((r) => r.k === "b")!.max_d, null, "no dates: blank");
  });

  it("--sum/--avg on a date or text column is refused", () => {
    const rows = loadRowsOf(ss());
    assert.throws(() => aggregate(rows, { by: [], metrics: [{ fn: "sum", col: "Last Run On" }] }), /^Error: --sum needs a number column; "Last Run On" is a date \(use --min\/--max\)$/);
    assert.throws(() => aggregate(rows, { by: [], metrics: [{ fn: "avg", col: "Title" }] }), /--avg needs a number column; "Title" is text/);
    assert.throws(() => aggregate([{ n: "5" }], { by: [], metrics: [{ fn: "sum", col: "n" }], types: { n: "date" } }), /is a date/);
  });

  it("a min/max-only agg over mixed currencies doesn't say amounts don't add up", () => {
    const ex = inv();
    const mm = aggregate(ex.rows, { by: [], metrics: [{ fn: "max", col: "foreigntotal" }, { fn: "min", col: "foreigntotal" }] });
    assert.doesNotMatch(mm.warning!, /don't add up/);
    assert.match(mm.warning!, /^the rows are in 6 currencies \(curr: .*\): min\/max compare amounts in different currencies\. Add --by curr\.$/);
    const sum = aggregate(ex.rows, { by: [], metrics: [{ fn: "sum", col: "foreigntotal" }] });
    assert.match(sum.warning!, /amounts don't add up\. Add --by curr\./);
  });

  it("sortRows by type, blanks last, stable, --asc inverts", () => {
    const rows = [
      { id: 1, amt: "10", d: "2026-9-3 1:00 pm", s: "beta" },
      { id: 2, amt: null, d: " ", s: "" },
      { id: 3, amt: "2,500.5", d: "2026-10-01 09:00", s: "Alpha" },
      { id: 4, amt: "10", d: null, s: "item 10" },
      { id: 5, amt: "-3", d: "2025-12-31", s: "item 9" },
    ];
    const ids = (r: Row[]) => r.map((x) => x.id);
    assert.deepEqual(ids(sortRows(rows, "amt", "num")), [3, 1, 4, 5, 2], "largest first, ties stable, blank last");
    assert.deepEqual(ids(sortRows(rows, "amt", "num", true)), [5, 1, 4, 3, 2]);
    assert.deepEqual(ids(sortRows(rows, "d", "date")), [3, 1, 5, 2, 4], "latest first (unpadded normalised), blanks last");
    assert.deepEqual(ids(sortRows(rows, "d", "date", true)), [5, 1, 3, 2, 4]);
    assert.deepEqual(ids(sortRows(rows, "s", "str")), [3, 1, 5, 4, 2], "A→Z, case-insensitive, digits by value");
    assert.deepEqual(ids(sortRows(rows, "s", "str", true)), [4, 5, 1, 3, 2]);
    assert.deepEqual(ids(sortRows(rows, "d", undefined)), [3, 1, 5, 2, 4], "type inferred when not given");
    assert.deepEqual(ids(sortRows([{ id: 1, v: "n/a (2 currencies)" }, { id: 2, v: 5 }], "v", "num")), [2, 1], "n/a sorts with blanks");
    assert.deepEqual(ids(rows), [1, 2, 3, 4, 5], "input untouched");
    const ex = ss();
    const top = sortRows(loadRowsOf(ex), "Last Run On", "date")[0];
    assert.equal(top["Last Run On"], latest(loadRowsOf(ex), "Last Run On"));
  });

  it("a self-diff never reports a difference; n/a keys are counted as incomparable", () => {
    const CURS = ["AUD", "CAD", "EUR", "GBP", "NZD", "USD"];
    const rows = Array.from({ length: 36 }, (_, i) => ({ id: i + 1, type: ["VendPymt", "CustPymt", "CustInvc", "Journal"][i % 4], currency: CURS[i % 6], foreigntotal: i % 4 === 3 ? null : 100 + i }));
    const bare = rows.map(({ currency, ...r }) => r);
    const self = diff(bare, bare, ["type"], ["foreigntotal"]);
    assert.equal(self.counts.changed, 0);
    assert.equal(self.counts.incomparable, 3, JSON.stringify(self.rows));
    assert.equal(self.counts.same, 1, "the all-blank Journal key");
    assert.ok(self.rows.filter((r) => diffChanged(r, "foreigntotal")).length >= 3, "n/a keys are still listed");
    const byId = diff(bare, bare, ["id"], ["foreigntotal"]);
    assert.deepEqual(byId.counts, { changed: 0, incomparable: 0, same: 36 });
    // Tolerance, presence-only keys, and blank vs value.
    const d = diff([{ k: "x", v: 10 }, { k: "y", v: 5 }, { k: "w", v: null }], [{ k: "x", v: 10.4 }, { k: "z", v: 1 }, { k: "w", v: 3 }], ["k"], ["v"], { tolerance: 0.5 });
    assert.deepEqual(d.counts, { changed: 3, incomparable: 0, same: 1 });
    assert.deepEqual(diff([{ k: "x", v: 10 }], [{ k: "x", v: 10.4 }], ["k"], ["v"]).counts, { changed: 1, incomparable: 0, same: 0 });
    // Crossed currencies (EUR vs USD) are incomparable, not changed.
    const c = diff([{ k: "x", currency: "EUR", amount: 10 }], [{ k: "x", currency: "USD", amount: 12 }], ["k"], ["amount"]);
    assert.deepEqual(c.counts, { changed: 0, incomparable: 1, same: 0 });
  });

  it("all-null groups are blank, not 0, and their currencies don't count", () => {
    const a = [{ id: 1, type: "Journal", currency: "EUR", foreigntotal: null }, { id: 2, type: "CustInvc", currency: "EUR", foreigntotal: 5 }];
    const b = [
      ...["AUD", "CAD", "EUR", "USD"].flatMap((c, i) => [{ id: 10 + i, type: "Journal", currency: c, foreigntotal: " " }, { id: 20 + i, type: "Journal", currency: c, foreigntotal: null }]),
      { id: 30, type: "CustInvc", currency: "EUR", foreigntotal: 7 },
    ];
    const d = diff(a, b, ["type"], ["foreigntotal"]);
    const j = d.rows.find((r) => r.type === "Journal")!;
    assert.deepEqual([j.foreigntotal_a, j.foreigntotal_b, j.foreigntotal_delta], [null, null, null], JSON.stringify(j));
    assert.equal(d.rows.find((r) => r.type === "CustInvc")!.foreigntotal_delta, 2);
    assert.deepEqual(d.counts, { changed: 1, incomparable: 0, same: 1 });
    const g = aggregate(b, { by: ["currency"], metrics: [{ fn: "sum", col: "foreigntotal" }, { fn: "avg", col: "foreigntotal" }, { fn: "count" }] });
    assert.equal(g.rows.find((r) => r.currency === "AUD")!.sum_foreigntotal, null);
    assert.equal(g.rows.find((r) => r.currency === "EUR")!.sum_foreigntotal, 7);
    const t = aggregate(b, { by: ["type"], metrics: [{ fn: "sum", col: "foreigntotal" }] });
    assert.equal(t.rows.find((r) => r.type === "Journal")!.sum_foreigntotal, null, "not n/a (4 currencies)");
    assert.equal(t.rows.find((r) => r.type === "CustInvc")!.sum_foreigntotal, 7);
    assert.equal(renderRows(t.columns, t.rows).split("\n").find((l) => l.startsWith("Journal"))!.trim(), "Journal");
  });

  it("the sign note checks every group against its direct children (nested US layout)", () => {
    const r = (line: string, depth: number, Amount: number | null, kind = "line") => ({ line, depth, is_detail: kind === "detail", kind, Amount });
    const rows = [
      r("Ordinary Income/Expense", 0, 600, "section"),
      r("Income", 1, 1000), r("Sales", 2, 1000), r("4000 - Revenue", 3, 1000), r("4000 - Revenue", 4, 1000, "detail"),
      r("Expense", 1, 400), r("Operating", 2, 400), r("Payroll", 3, 400),
      r("Expense", 4, 400), r("6000 - Wages", 5, -300), r("6000 - Wages", 6, -300, "detail"), r("6100 - Rent", 5, -100),
      r("Net Ordinary Income", 1, 600),
      r("Other Income and Expenses", 0, -50, "section"),
      r("Other Expense", 1, 50), r("8000 - FX loss", 2, -50),
      r("Net Income", 0, 550, "section"),
    ];
    const note = sectionSignNote(rows, "Amount");
    assert.match(note, /these sections show the opposite sign of their account lines \(positive = net expense, negative = net credit\): Expense, Other Expense\.$/, note);
    assert.doesNotMatch(note, /Operating|Payroll|Income,/);
  });

  it("a report summary names its currency when the caller knows it", () => {
    const ex = extractRows(decodeToolResponse(fixture("report_income_statement.json")).json)!;
    const ctx = tmpCtx();
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runReport", query: '{"reportId":-200,"subsidiaryId":7}', columns: ex.columns, rows: ex.rows, raw: "{}" });
    const s = buildSummary({ meta, rows: ex.rows, columns: ex.columns, budget: 3000, reportCurrency: { code: "USD", label: "Example Inc.'s base currency" } });
    assert.match(s, /^Amounts are in USD \(Example Inc\.'s base currency\)\.$/m);
    assert.match(buildSummary({ meta, rows: ex.rows, columns: ex.columns, budget: 3000 }), /Amounts are in the report currency/);
    const prof = { builtAt: "", baseCurrency: "EUR", subsidiaryCurrencies: { "1": "EUR", "7": "USD" }, parentSubsidiaryId: "1" };
    fs.mkdirSync(path.join(ctx.acctDir!, "idx"), { recursive: true });
    fs.writeFileSync(path.join(ctx.acctDir!, "idx", "subsidiaries.tsv"), "id\tname\n1\tExample GmbH\n7\tExample Inc.\n");
    assert.deepEqual(reportCurrencyInfo(meta, prof, ctx.acctDir!), { code: "USD", label: "Example Inc.'s base currency" });
    assert.deepEqual(reportCurrencyInfo(meta, prof), { code: "USD", label: "subsidiary 7's base currency" });
    assert.deepEqual(reportCurrencyInfo({ ...meta, query: '{"reportId":-200}' }, prof, ctx.acctDir!), { code: "EUR", label: "the base currency, consolidated" });
    assert.equal(reportCurrencyInfo({ ...meta, query: '{"reportId":-200,"subsidiaryId":9}' }, prof), undefined);
  });

  it("with currency unknown, the summary's Next hint counts instead of summing", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, type: ["VendPymt", "CustPymt", "CustInvc"][i % 3], foreigntotal: 100 + i * 3.5 }));
    const ctx = tmpCtx();
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runCustomSuiteQL", query: "SELECT t.id, t.type, t.foreigntotal FROM transaction t", columns: ["id", "type", "foreigntotal"], rows, raw: "[]" });
    const s = buildSummary({ meta, rows, columns: ["id", "type", "foreigntotal"], budget: 3000 });
    assert.match(s, /Currency unknown/);
    assert.match(s, new RegExp(`Next: nsx results agg ${meta.id} --by type --count --top 20 +\\(to sum foreigntotal, re-run with BUILTIN\\.DF\\(t\\.currency\\) AS currency\\)`), s);
    assert.doesNotMatch(s, /--sum/);
    const withCur = rows.map((r, i) => ({ ...r, currency: ["EUR", "USD"][i % 2] }));
    const m2 = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runCustomSuiteQL", query: "q", columns: Object.keys(withCur[0]), rows: withCur, raw: "[]" });
    assert.match(buildSummary({ meta: m2, rows: withCur, columns: Object.keys(withCur[0]), budget: 3000 }), /--sum foreigntotal/);
  });
});

/** Rows as a saved result reloads them (datetimes normalised, blanks null). */
function loadRowsOf(ex: { columns: string[]; rows: Row[] }): Row[] {
  const ctx = tmpCtx();
  return loadRows(saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runSavedSearch", query: "{}", columns: ex.columns, rows: ex.rows, raw: "[]" }));
}

describe("results engine edge cases", () => {
  const nsx = async (...argv: string[]) => String((await import("../src/cli.ts")).main(argv));
  const isUsage = (re: RegExp) => (e: Error) => e.constructor.name === "UsageError" && re.test(e.message);
  const report = () => extractRows(decodeToolResponse(fixture("report_income_statement.json")).json)!;
  const save = (rows: Row[], tool = "ns_runCustomSuiteQL", query = "q") => {
    const ctx = tmpCtx();
    const columns = Object.keys(rows[0]);
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s", tool, query, columns, rows, raw: "[]" });
    return { ctx, meta, columns };
  };
  /** GL lines of two subsidiaries (USD and EUR base), every transaction in EUR. */
  const gl = () =>
    Array.from({ length: 12 }, (_, i) => ({ id: 1000 + i, subsidiary: i % 2 ? "Example GmbH" : "Example Inc.", account: `40${i % 3}0`, currency: "EUR", amount: 100 + i, foreignamount: 90 + i }));
  /** transaction JOIN transactionline: foreigntotal repeats on every line. */
  const lines = () =>
    ["INV-1", "INV-2", "INV-3"].flatMap((tranid, t) =>
      [1, 2, 3].map((line) => ({ tranid, line, entity: `C${t}`, currency: "USD", foreigntotal: 300 * (t + 1), amount: 100 * (t + 1) + line })),
    );

  it("agg and pivot refuse to sum nested report rows; one level sums", async () => {
    const ex = report();
    const nest = /report rows nest; filter to one level: --where "depth=1 and is_detail=false"/;
    assert.throws(() => aggregate(ex.rows, { by: [], metrics: [{ fn: "sum", col: "Amount" }] }), nest);
    assert.throws(() => aggregate(ex.rows, { by: ["kind"], metrics: [{ fn: "avg", col: "Amount" }] }), nest);
    assert.throws(() => pivot(ex.rows, "kind", "depth", "sum", "Amount"), nest);
    const level = ex.rows.filter((r) => r.depth === 1 && r.is_detail === false);
    const want = level.reduce((t, r) => t + (r.Amount as number), 0);
    assert.equal(aggregate(level, { by: [], metrics: [{ fn: "sum", col: "Amount" }] }).totals.sum_Amount, want);
    // min/max/count don't add rows together.
    assert.equal(aggregate(ex.rows, { by: [], metrics: [{ fn: "max", col: "Amount" }, { fn: "count" }] }).totals.count, ex.rows.length);
    const { meta } = save(ex.rows, "ns_runReport", '{"reportId":-200}');
    await assert.rejects(nsx("results", "agg", meta.id, "--sum", "Amount"), isUsage(nest));
    assert.match(await nsx("results", "agg", meta.id, "--sum", "Amount", "--where", "depth=1 and is_detail=false"), new RegExp(`sum_Amount=${fmtValue(want).replace(/[.]/g, "\\.")}`));
  });

  it("base amounts across subsidiaries never add up, even with one transaction currency", () => {
    const rows = gl();
    const cur = currencyCheck(Object.keys(rows[0]), rows);
    assert.deepEqual(cur.baseAcrossSubs, ["amount"]);
    assert.equal(cur.status, "unknown");
    const p = Object.fromEntries(profileColumns(Object.keys(rows[0]), rows).map((c) => [c.name, c]));
    assert.equal(p.amount.sum, undefined);
    assert.equal(p.amount.sumNa, "2 subsidiaries");
    assert.equal(p.foreignamount.sum, rows.reduce((t, r) => t + r.foreignamount, 0), "transaction-currency amounts in one currency (EUR) still add up");
    const t = aggregate(rows, { by: [], metrics: [{ fn: "sum", col: "amount" }] });
    assert.equal(t.totals.sum_amount, "n/a (2 subsidiaries)");
    assert.match(t.warning!, /amount is in each subsidiary's base currency and the rows span 2 subsidiaries \(subsidiary\): they don't add up\. Group by subsidiary: --by subsidiary\./);
    const bySub = aggregate(rows, { by: ["subsidiary"], metrics: [{ fn: "sum", col: "amount" }] });
    assert.ok(bySub.rows.every((r) => typeof r.sum_amount === "number"), JSON.stringify(bySub.rows));
    assert.equal(bySub.totals.sum_amount, "n/a (2 subsidiaries)");
    assert.match(bySub.warning!, /per-subsidiary amounts are fine, the TOTAL isn't/);
    const byCur = aggregate(rows, { by: ["currency"], metrics: [{ fn: "sum", col: "amount" }] });
    assert.equal(byCur.rows[0].sum_amount, "n/a (2 subsidiaries)", "grouping by the transaction currency doesn't help");
    const pv = pivot(rows, "account", "currency", "sum", "amount");
    assert.ok(pv.rows.every((r) => r.EUR === "n/a (2 subsidiaries)"), JSON.stringify(pv.rows));
    assert.match(pv.warning!, /Put subsidiary on --rows or --cols/);
    assert.ok(pivot(rows, "account", "subsidiary", "sum", "amount").rows.every((r) => typeof r["Example Inc."] === "number"));
    assert.equal(diff(rows, rows, ["account"], ["amount"]).rows[0].amount_a, "n/a (2 subsidiaries)");
    const { meta, columns } = save(rows);
    const s = buildSummary({ meta, rows, columns, budget: 3000 });
    assert.match(s, /amount\(num, sum n\/a: 2 subsidiaries/);
    assert.match(s, /Several subsidiaries: amount is in each subsidiary's base currency across 2 subsidiaries \(subsidiary\)/);
    assert.match(s, /Next: nsx results agg r_[0-9a-f]+ --by subsidiary --sum amount/);
    assert.doesNotMatch(s, /BUILTIN\.DF/, "adding a currency column doesn't fix base amounts");
  });

  it("money-formatted numbers parse; the rest are counted, or refused when saved as text", async () => {
    assert.equal(toNumber("$1,234.00"), 1234);
    assert.equal(toNumber("EUR 1,234.00"), 1234);
    assert.equal(toNumber("1,234.00 USD"), 1234);
    assert.equal(toNumber("(1,234.00)"), -1234);
    assert.equal(toNumber("-$5.25"), -5.25);
    assert.equal(toNumber("€-3"), -3);
    for (const v of ["12%", "abc", "$", "EUR", "USD 12 34", "(-5)", "1.2.3", "ABC 5"]) assert.equal(toNumber(v), undefined, v);
    assert.equal(inferType(["12.00", "$1,234.00"]), "num");
    assert.equal(parseValue("$1,234.00", "num"), 1234);
    const rows = [{ k: "a", "Tax Amount": "12.00" }, { k: "a", "Tax Amount": "$1,234.00" }, { k: "b", "Tax Amount": "see memo" }, { k: "b", "Tax Amount": " " }];
    const a = aggregate(rows, { by: [], metrics: [{ fn: "sum", col: "Tax Amount" }] });
    assert.equal(a.totals["sum_Tax Amount"], 1246);
    assert.match(a.warning!, /sum_Tax Amount: skipped 1 non-numeric value\(s\) of Tax Amount \(e\.g\. "see memo"\)/);
    assert.match(pivot(rows, "k", "k", "sum", "Tax Amount").warning!, /skipped 1 non-numeric value/);
    // Saved as text (the meta type): refused, not silently partial.
    assert.throws(() => aggregate(rows, { by: [], metrics: [{ fn: "sum", col: "Tax Amount" }], types: { "Tax Amount": "str" } }), /"Tax Amount" is text \(1 of 3 values aren't numbers, e\.g\. "see memo"\)/);
    const { meta } = save(rows);
    await assert.rejects(nsx("results", "agg", meta.id, "--sum", "Tax Amount"), isUsage(/is text/));
    assert.match(await nsx("results", "agg", meta.id, "--sum", "Tax Amount", "--where", "k=a"), /sum_Tax Amount=1,246/);
  });

  it("a header amount repeated per line is not summed once per line", async () => {
    const rows = lines();
    assert.deepEqual([...headerRepeats(Object.keys(rows[0]), rows)], [["foreigntotal", "tranid"]]);
    const p = Object.fromEntries(profileColumns(Object.keys(rows[0]), rows).map((c) => [c.name, c]));
    assert.equal(p.foreigntotal.sum, undefined);
    assert.equal(p.foreigntotal.sumNa, "repeats per tranid");
    assert.equal(p.amount.sum, rows.reduce((t, r) => t + r.amount, 0), "line amounts still add up");
    const { meta, columns } = save(rows);
    const s = buildSummary({ meta, rows, columns, budget: 3000 });
    assert.match(s, /foreigntotal repeats per tranid \(a header amount on line rows\): sums count it once per line/);
    assert.doesNotMatch(s, /--sum foreigntotal/);
    const t = aggregate(rows, { by: [], metrics: [{ fn: "sum", col: "foreigntotal" }] });
    assert.equal(t.totals.sum_foreigntotal, "n/a (repeats per tranid)");
    assert.match(t.warning!, /foreigntotal repeats per tranid/);
    const g = aggregate(rows, { by: ["tranid"], metrics: [{ fn: "sum", col: "foreigntotal" }, { fn: "max", col: "foreigntotal" }] });
    assert.ok(g.rows.every((r) => r.sum_foreigntotal === "n/a (repeats per tranid)"), "a 3-line group would print 3×");
    assert.deepEqual(g.rows.map((r) => r.max_foreigntotal).sort(), [300, 600, 900], "max per document is the header amount");
    const oneLine = rows.filter((r) => r.line === 1);
    assert.equal(aggregate(oneLine, { by: [], metrics: [{ fn: "sum", col: "foreigntotal" }] }).totals.sum_foreigntotal, 1800, "one row per document sums");
    assert.match(pivot(rows, "entity", "currency", "sum", "foreigntotal").rows[0].USD as string, /repeats per tranid/);
    assert.match(await nsx("results", "agg", meta.id, "--sum", "foreigntotal"), /TOTAL \(9 rows\): sum_foreigntotal=n\/a \(repeats per tranid\)\n⚠ foreigntotal repeats per tranid/);
  });

  it("a very wide result keeps its warnings, truncation and Next lines", () => {
    const cols = [...Array.from({ length: 90 }, (_, i) => `custbody_some_long_field_name_${i}`), "currency", "foreigntotal", "entity"];
    const rows = Array.from({ length: 40 }, (_, r) => ({ ...Object.fromEntries(cols.slice(0, 90).map((c) => [c, `v${r}`])), currency: ["EUR", "USD"][r % 2], foreigntotal: r * 10.5, entity: `E${r % 4}` }));
    const ctx = tmpCtx();
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runCustomSuiteQL", query: "SELECT …", columns: cols, rows, raw: "[]", truncated: "result hit the ROWNUM/FETCH cap (40)" });
    const s = buildSummary({ meta, rows, columns: cols });
    assert.ok(s.length <= 1400, `${s.length}`);
    assert.match(s, /^Mixed currencies in currency/m);
    assert.match(s, /^Truncation warning: result hit the ROWNUM/m);
    assert.match(s, /^Next: nsx results agg/m);
    assert.match(s, /… \d+ more cols \(nsx results schema r_[0-9a-f]+\)/);
    for (const l of s.split("\n").filter((x) => x.startsWith("Columns:") || x.startsWith("         "))) assert.match(l, /\)$/, `cut mid-column: ${l}`);
  });

  it("--where compares dates as dates (unpadded, M/D/YYYY literals, day granularity)", () => {
    const rows = Array.from({ length: 31 }, (_, i) => ({ Date: `2026-12-${String(i + 1).padStart(2, "0")}` })).concat([{ Date: "2026-01-01" }, { Date: "2025-12-31" }, { Date: "2026-11-30 23:59" }]);
    const n = (w: string) => rows.filter(parseWhere(w, ["Date"])).length;
    assert.equal(n("Date >= '2026-12-1'"), 31);
    assert.equal(n("Date = '2026-1-1'"), 1);
    assert.equal(n("Date >= '12/1/2026'"), 31);
    assert.equal(n("Date >= '1/10/2026'"), 32, "12/31/2025 is before Jan 10 2026");
    assert.equal(n("Date <= '2026-11-30'"), 3, "the whole of Nov 30 is kept");
    assert.equal(n("Date > '2026-11-30 12:00'"), 32);
    // M/D cells, compared by date not text.
    const us = [{ d: "12/31/2025" }, { d: "1/10/2026" }, { d: "2/1/2026" }];
    assert.deepEqual(us.filter(parseWhere("d >= '1/10/2026'", ["d"])).map((r) => r.d), ["1/10/2026", "2/1/2026"]);
    // D/M/YYYY is not typed as a date when a "month" is above 12.
    assert.equal(inferType(["27/09/2026", "3/10/2026"]), "str");
    assert.equal(inferType(["9/27/2026", "10/3/2026"]), "date");
  });

  it("diff keys match whatever each side's key type (\"1\" = 1)", () => {
    const a = Array.from({ length: 25 }, (_, i) => ({ code: String(i + 1), amount: i }));
    const b = Array.from({ length: 25 }, (_, i) => ({ code: i + 1, amount: i }));
    const d = diff(a, b, ["code"], ["amount"]);
    assert.equal(d.rows.length, 25);
    assert.deepEqual(d.counts, { changed: 0, incomparable: 0, same: 25 });
    assert.equal(diff([{ k: " 7 ", v: 1 }, { k: "1.50", v: 2 }], [{ k: 7, v: 1 }, { k: 1.5, v: 2 }], ["k"], ["v"]).counts.same, 2);
  });

  it("a key changed in any --cols column counts and is listed", async () => {
    const a = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, currency: "EUR", foreigntotal: 100 + i, amountpaid: 0 }));
    const b = a.map((r) => ({ ...r, amountpaid: r.id % 2 ? 50 : 0 }));
    const d = diff(a, b, ["id"], ["foreigntotal", "amountpaid"]);
    assert.deepEqual(d.counts, { changed: 15, incomparable: 0, same: 15 });
    assert.equal(d.rows.filter((r) => diffChanged(r, ["foreigntotal", "amountpaid"])).length, 15);
    assert.equal(d.rows.filter((r) => diffChanged(r, "foreigntotal")).length, 0);
    const ctx = tmpCtx();
    const cols = Object.keys(a[0]);
    const ma = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runCustomSuiteQL", query: "q", columns: cols, rows: a, raw: "[]" });
    const mb = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runCustomSuiteQL", query: "q", columns: cols, rows: b, raw: "[]" });
    assert.match(await nsx("results", "diff", ma.id, mb.id, "--on", "id", "--cols", "foreigntotal,amountpaid"), /^15 of 30 keys differ/);
  });

  it("--tolerance must be an absolute amount ≥ 0", async () => {
    const rows = [{ id: 1, amount: 10 }, { id: 2, amount: 20 }];
    const { meta } = save(rows);
    for (const t of ["1%", "-1", "abc", "NaN"]) await assert.rejects(nsx("results", "diff", meta.id, meta.id, "--on", "id", "--cols", "amount", `--tolerance=${t}`), isUsage(/--tolerance takes an absolute amount/), t);
    assert.throws(() => diff(rows, rows, ["id"], ["amount"], { tolerance: Number.NaN }), /--tolerance must be a number/);
    assert.match(await nsx("results", "diff", meta.id, meta.id, "--on", "id", "--cols", "amount", "--tolerance", "0.5"), /^0 of 2 keys differ/);
  });

  it("repeated --where are ANDed, repeated metrics are joined, other repeats refused", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, status: i % 2 ? "Open" : "Paid", currency: "EUR", amount: 10 * (i + 1), fee: i }));
    const { meta } = save(rows);
    assert.match(await nsx("results", "filter", meta.id, "--where", "status=Open", "--where", "amount>50"), /^3 of 10 rows match/);
    const out = await nsx("results", "agg", meta.id, "--sum", "amount", "--sum", "fee");
    assert.match(out, /TOTAL \(10 rows\): sum_amount=550  sum_fee=45/);
    await assert.rejects(nsx("results", "head", meta.id, "--cols", "id", "--cols", "amount"), isUsage(/--cols given 2 times \('id', 'amount'\): give it once, with a comma list/));
    await assert.rejects(nsx("results", "agg", meta.id, "--by", "status", "--by", "currency", "--count"), isUsage(/--by given 2 times/));
  });

  it("agg --sort resolves against the output columns or is refused", async () => {
    const rows = [{ k: "a", foreigntotal: 5 }, { k: "b", foreigntotal: 50 }, { k: "c", foreigntotal: 20 }];
    const s = aggregate(rows, { by: ["k"], metrics: [{ fn: "sum", col: "foreigntotal" }, { fn: "count" }], sort: "foreigntotal", asc: true });
    assert.deepEqual(s.rows.map((r) => r.k), ["a", "c", "b"]);
    assert.deepEqual(aggregate(rows, { by: ["k"], metrics: [{ fn: "count" }], sort: "K" }).rows.map((r) => r.k), ["a", "b", "c"]);
    assert.throws(() => aggregate(rows, { by: ["k"], metrics: [{ fn: "sum", col: "foreigntotal" }], sort: "bogus" }), /--sort bogus isn't an output column\. Sort by one of: k, sum_foreigntotal/);
    assert.throws(() => aggregate(rows, { by: ["k"], metrics: [{ fn: "sum", col: "foreigntotal" }, { fn: "max", col: "foreigntotal" }], sort: "foreigntotal" }), /has 2 metrics/);
    const { meta } = save(rows);
    await assert.rejects(nsx("results", "agg", meta.id, "--by", "k", "--sum", "foreigntotal", "--sort", "amount"), isUsage(/isn't an output column/));
  });

  it("pivot uses agg's metric rules: dates, text refusals, one metric", async () => {
    const rows = [{ t: "A", s: "x", d: "2026-09-03", title: "one", amount: 1 }, { t: "A", s: "x", d: "2026-10-01", title: "two", amount: 2 }, { t: "B", s: "y", d: "2025-01-05", title: "three", amount: 3 }];
    const p = pivot(rows, "t", "s", "max", "d");
    assert.equal(p.rows.find((r) => r.t === "A")!.x, "2026-10-01");
    assert.equal(p.rows.find((r) => r.t === "B")!.y, "2025-01-05");
    assert.throws(() => pivot(rows, "t", "s", "sum", "title"), /--sum needs a number column; "title" is text/);
    assert.throws(() => pivot(rows, "t", "s", "avg", "d"), /is a date/);
    const { meta } = save(rows);
    await assert.rejects(nsx("results", "pivot", meta.id, "--rows", "t", "--cols", "s", "--sum", "amount", "--avg", "amount"), isUsage(/pivot takes one metric, got --sum amount, --avg amount/));
    assert.match(await nsx("results", "pivot", meta.id, "--rows", "t", "--cols", "s", "--max", "d"), /2026-10-01/);
  });

  it("ids can't be summed or averaged (min/max/count still work)", async () => {
    const rows = Array.from({ length: 24 }, (_, i) => ({ "Internal ID": String(5000 + i), Terms: String((i % 3) + 1), Amount: i }));
    const { meta } = save(rows);
    assert.equal(meta.columns.find((c) => c.name === "Terms")!.type, "id");
    await assert.rejects(nsx("results", "agg", meta.id, "--sum", "Terms"), isUsage(/"Terms" holds ids/));
    await assert.rejects(nsx("results", "pivot", meta.id, "--rows", "Terms", "--cols", "Terms", "--sum", "Internal ID"), isUsage(/"Internal ID" holds ids/));
    assert.throws(() => aggregate(rows, { by: [], metrics: [{ fn: "avg", col: "Internal ID" }] }), /holds ids/, "typed from the values too");
    assert.match(await nsx("results", "agg", meta.id, "--max", "Internal ID", "--count"), /max_Internal ID=5023/);
  });

  it("!= never matches blank cells", () => {
    const rows = [{ Status: "Open" }, { Status: "Paid" }, { Status: " " }, { Status: null }];
    assert.deepEqual(rows.filter(parseWhere("Status != 'Open'")).map((r) => r.Status), ["Paid"]);
    assert.equal(rows.filter(parseWhere("Status is null")).length, 2);
  });

  it("numbers print without -0; rates keep their decimals and aren't summed", async () => {
    assert.equal(fmtValue(-0.004), "0");
    assert.equal(fmtValue(-0), "0");
    assert.equal(fmtValue(1234.567), "1,234.57");
    assert.equal(fmtValue(0.912345, "exchangerate"), "0.912345");
    assert.match(renderRows(["exchangerate", "amount"], [{ exchangerate: 0.912345, amount: -0.001 }]), /0\.912345 +0\s*$/m);
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, currency: "EUR", exchangerate: 0.9 + i / 1000, amount: i }));
    const { meta, columns } = save(rows);
    assert.equal(profileColumns(columns, rows).find((p) => p.name === "exchangerate")!.sum, undefined);
    assert.doesNotMatch(buildSummary({ meta, rows, columns, budget: 3000 }), /exchangerate\(num, sum/);
    await assert.rejects(nsx("results", "agg", meta.id, "--sum", "exchangerate"), isUsage(/rates, ratios and percentages don't add up/));
    assert.match(await nsx("results", "agg", meta.id, "--avg", "exchangerate"), /avg_exchangerate=0\.9145/);
  });

  it("CLI usage errors: --top, column case, no rows, pivot --count col, bad operators, subcommands", async () => {
    const rows = [{ id: 1, Status: "Open", amount: 5 }, { id: 2, Status: "Paid", amount: null }, { id: 3, Status: "Open", amount: 7 }];
    const { meta } = save(rows);
    await assert.rejects(nsx("results", "agg", meta.id, "--by", "Status", "--count", "--top", "five"), isUsage(/--top must be a positive whole number, got 'five'/));
    assert.match(await nsx("results", "agg", meta.id, "--by", "status", "--sum", "AMOUNT"), /Open +12/);
    assert.match(await nsx("results", "head", meta.id, "--cols", "STATUS"), /^Status/);
    await assert.rejects(nsx("results", "head", meta.id, "--cols", "nope"), isUsage(/Unknown column\(s\): nope/));
    await assert.rejects(nsx("results", "filter", meta.id, "--where", "nope=1"), isUsage(/Unknown column\(s\): nope/));
    assert.match(await nsx("results", "agg", meta.id, "--sum", "amount", "--where", "amount>100"), /^No rows match \(0 of 3 rows after --where "amount>100"\): nothing to aggregate\.$/);
    assert.match(await nsx("results", "pivot", meta.id, "--rows", "Status", "--cols", "Status", "--count", "amount"), /^\(count of non-empty amount\)\n/);
    assert.equal(pivot(rows, "Status", "Status", "count", "amount").rows.find((r) => r.Status === "Paid")!.Paid, undefined, "the blank amount isn't counted");
    assert.throws(() => parseWhere("amount >> 1"), /Cannot parse condition: amount >> 1 \(unexpected ">" after >/);
    assert.throws(() => parseWhere("amount ="), /no value after the operator/);
    assert.equal(rows.filter(parseWhere("Status = '>x'")).length, 0, "a quoted value may start with an operator");
    await assert.rejects(nsx("results", "filter", meta.id, "--where", "amount >> 1"), isUsage(/Cannot parse/));
    await assert.rejects(nsx("results", "bogus"), isUsage(/results subcommand 'bogus'/));
    await assert.rejects(nsx("results", "r_491bfd"), (e: Error) => e.constructor.name === "UsageError" && /r_491bfd/.test(e.message) && !/missing result id/.test(e.message));
    // diff: say which side lacks a column.
    const other = saveResult({ acctDir: path.dirname(path.dirname(path.dirname(meta.files.meta))), session: "s", tool: "ns_runCustomSuiteQL", query: "q", columns: ["id", "Status", "total"], rows: [{ id: 1, Status: "Open", total: 5 }], raw: "[]" });
    await assert.rejects(nsx("results", "diff", meta.id, other.id, "--on", "id", "--cols", "amount"), isUsage(/Unknown column\(s\) in b \(r_[0-9a-f]+\): amount/));
  });

  it("results list --any-account lists every account's results", async () => {
    const ctx = tmpCtx();
    const other = path.join(path.dirname(ctx.acctDir!), "9999999");
    fs.mkdirSync(other, { recursive: true });
    const a = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runCustomSuiteQL", query: "SELECT a", columns: ["x"], rows: [{ x: 1 }], raw: "[]" });
    const b = saveResult({ acctDir: other, session: "s", tool: "ns_runCustomSuiteQL", query: "SELECT b", columns: ["x"], rows: [{ x: 1 }], raw: "[]" });
    const mine = await nsx("results", "list");
    assert.ok(mine.includes(a.id) && !mine.includes(b.id));
    const all = await nsx("results", "list", "--any-account");
    assert.ok(all.includes(a.id) && all.includes(b.id), all);
    assert.match(all, /^id +account/);
  });
});

describe("multi-column report summaries", () => {
  const load = (name: string) => {
    const raw = decodeToolResponse(fixture(name));
    return { ex: extractRows(raw.json)!, raw: raw.text };
  };

  it("aging summary shows each bucket, names the inferred buckets and the no-vendor section; meta keeps raw ids", () => {
    const ctx = tmpCtx();
    const { ex, raw } = load("report_ap_aging.json");
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runReport", query: '{"dateTo":"2026-09-28","reportId":286,"subsidiaryId":-1}', columns: ex.columns, rows: ex.rows, raw });
    const s = buildSummary({ meta, rows: ex.rows, columns: ex.columns });
    assert.ok(s.length <= 1400, `summary is ${s.length} chars`);
    assert.match(s, /Vendor: Current 10,350.5 \| 1-30 279.95 \| 31-60 186.25 \| 61-90 88 \| Over 90 2,202 \| Total 13,106.7/);
    assert.match(s, /- No Vendor -: Current – \| 1-30 0 \| 31-60 0 \| 61-90 – \| Over 90 2,500 \| Total 2,500/);
    assert.match(s, /Bucket names \(Current, 1-30, 31-60, 61-90, Over 90\) are NetSuite's defaults, inferred from column order \(not sent\)/);
    assert.match(s, /"- No Vendor -" holds open items with no vendor; it is not a vendor\./);
    assert.doesNotMatch(s, /Warning: columns/);
    assert.match(s, /Query: \{"reportId":286,"subsidiaryId":-1,"dateTo":"2026-09-28"\}/, "deciding parameters first");
    const saved = JSON.parse(fs.readFileSync(meta.files.meta, "utf8")) as { report: { title: string; columns: { name: string; id: string }[] } };
    assert.equal(saved.report.title, "A/P Aging Summary");
    assert.deepEqual(saved.report.columns.map((c) => [c.name, c.id]), [
      ["Current", "Current > Open Balance"], ["1-30", "Current > Open Balance (2)"], ["31-60", "Current > Open Balance (3)"],
      ["61-90", "Current > Open Balance (4)"], ["Over 90", "Current > Open Balance (5)"], ["Total", "empty > Open Balance"],
    ]);
    // The CSV reloads with the same distinct bucket values.
    const back = loadRows(meta).find((r) => r.line === "Alpine Trails GmbH" && r.kind === "line")!;
    assert.deepEqual(["Current", "1-30", "31-60", "61-90", "Over 90", "Total"].map((c) => back[c]), [8200.5, -75.25, null, null, null, 8125.25]);
  });

  it("range month summary prints every section per column with the full range in the Query line", () => {
    const ctx = tmpCtx();
    const { ex, raw } = load("report_income_statement_month.json");
    const q = '{"dateFrom":"2026-01-01","dateTo":"2026-03-31","range":"month","reportId":-200,"subsidiaryId":-1}';
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "dff0f9ae-cddd-415c-8274-6c7af164b162", tool: "ns_runReport", query: q, columns: ex.columns, rows: ex.rows, raw });
    const s = buildSummary({ meta, rows: ex.rows, columns: ex.columns });
    assert.ok(s.length <= 1400, `summary is ${s.length} chars`);
    assert.match(s, /Query: \{"reportId":-200,"range":"month","subsidiaryId":-1,"dateFrom":"2026-01-01","dateTo":"2026-03-31"\}/);
    assert.match(s, /Sales: 2026-01 1,300 \| 2026-02 1,150 \| 2026-03 900 \| Total 3,350/);
    assert.match(s, /Overheads: 2026-01 520.5 \| 2026-02 480 \| 2026-03 549.5 \| Total 1,550/);
    assert.match(s, /Net Profit\/\(Loss\): 2026-01 779.5 \| 2026-02 670 \| 2026-03 350.5 \| Total 1,800/);
    assert.doesNotMatch(s, /more sections/);
    assert.doesNotMatch(s, /had no effect/);
    assert.match(s, /--cols line,depth,2026-01,2026-02,2026-03,Total/);
  });

  it("when not every section fits, the bottom line is kept and the cut is marked", () => {
    const ctx = tmpCtx();
    const { ex, raw } = load("report_income_statement_quarter.json");
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runReport", query: '{"range":"quarter","reportId":-200}', columns: ex.columns, rows: ex.rows, raw });
    const full = buildSummary({ meta, rows: ex.rows, columns: ex.columns });
    assert.match(full, /Sales: 2026-Q1 3,350 \| 2026-Q2 2,725.5 \| Total 6,075.5/);
    const s = buildSummary({ meta, rows: ex.rows, columns: ex.columns, budget: full.length - 60 });
    assert.ok(s.length <= full.length - 60, `${s.length}`);
    assert.match(s, /… 1 more section\n {2}Net Profit\/\(Loss\): /);
  });

  it("value columns that come out identical though their raw ids differ get a warning", () => {
    const ctx = tmpCtx();
    const { ex, raw } = load("report_ap_aging.json");
    // The failure mode: the Current value copied into every bucket.
    const rows = ex.rows.map((r) => ({ ...r, "1-30": r.Current, "31-60": r.Current }));
    const meta = saveResult({ acctDir: ctx.acctDir!, session: "s", tool: "ns_runReport", query: '{"reportId":286}', columns: ex.columns, rows, raw });
    const s = buildSummary({ meta, rows, columns: ex.columns });
    assert.match(s, /Warning: columns Current = 1-30, Current = 31-60, 1-30 = 31-60 hold the same value on every row though NetSuite sent them as different columns; check the raw response \(nsx results raw r_[0-9a-f]+ --head 40\)/);
  });
});
