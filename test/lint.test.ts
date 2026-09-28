import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handlePre } from "../src/hooks/pre.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { PROBES } from "../src/cache/probes.ts";
import { HARD_RULES, fixLimit, fixRownum, formatLint, nolintOf, offsetPaging, isReadQuery, lintSuiteQL, pagingOrderMissing, topFetchRows, unknownColumns } from "../src/sql/lint.ts";
import { tokenize } from "../src/sql/tokenize.ts";
import { hso, tmpCtx } from "./helpers.ts";

const rules = (sql: string, ctx = {}) => {
  const r = lintSuiteQL(sql, ctx);
  return { errors: r.errors.map((e) => e.rule), warnings: r.warnings.map((w) => w.rule), fixed: r.fixed };
};

describe("ROWNUM placement", () => {
  it("denies ROWNUM at the same level as GROUP BY and suggests FETCH FIRST", () => {
    const r = rules("SELECT entity, SUM(foreigntotal) t FROM transaction WHERE type = 'CustInvc' AND ROWNUM <= 1000 GROUP BY entity");
    assert.deepEqual(r.errors, ["rownum-with-aggregate"]);
    assert.equal(r.fixed, "SELECT entity, SUM(foreigntotal) t FROM transaction WHERE type = 'CustInvc' GROUP BY entity FETCH FIRST 1000 ROWS ONLY");
    assert.deepEqual(rules(r.fixed!).errors, [], "the fix itself must lint clean");
  });

  it("denies ROWNUM with aggregates even without GROUP BY", () => {
    assert.deepEqual(rules("SELECT COUNT(*) FROM transaction WHERE ROWNUM < 50").errors, ["rownum-with-aggregate"]);
  });

  it("denies ROWNUM with ORDER BY at the same level", () => {
    const r = rules("SELECT tranid, foreigntotal FROM transaction WHERE ROWNUM <= 10 ORDER BY foreigntotal DESC");
    assert.deepEqual(r.errors, ["rownum-with-order-by"]);
    assert.equal(r.fixed, "SELECT tranid, foreigntotal FROM transaction ORDER BY foreigntotal DESC FETCH FIRST 10 ROWS ONLY");
  });

  it("keeps other WHERE conditions when removing ROWNUM (leading position)", () => {
    const fixed = fixRownum("SELECT a, COUNT(*) FROM t WHERE ROWNUM <= 5 AND a > 1 GROUP BY a");
    assert.equal(fixed, "SELECT a, COUNT(*) FROM t WHERE a > 1 GROUP BY a FETCH FIRST 5 ROWS ONLY");
  });

  it("drops WHERE when ROWNUM was the only condition and converts < N to <= N-1", () => {
    assert.equal(fixRownum("SELECT a FROM t WHERE ROWNUM < 11 ORDER BY a"), "SELECT a FROM t ORDER BY a FETCH FIRST 10 ROWS ONLY");
  });

  it("fixes a nested subquery in place", () => {
    const fixed = fixRownum("SELECT x.a FROM (SELECT a, SUM(b) s FROM t WHERE ROWNUM <= 3 GROUP BY a) x");
    assert.equal(fixed, "SELECT x.a FROM (SELECT a, SUM(b) s FROM t GROUP BY a FETCH FIRST 3 ROWS ONLY) x");
  });

  it("denies moving ROWNUM into a subquery that feeds an aggregate", () => {
    assert.deepEqual(rules("SELECT entity, SUM(amount) FROM (SELECT entity, amount FROM transaction WHERE ROWNUM <= 10) GROUP BY entity").errors, ["rownum-before-aggregate"]);
    assert.deepEqual(rules("SELECT COUNT(*) FROM transaction t JOIN (SELECT id FROM customer WHERE ROWNUM <= 5) c ON c.id = t.entity").errors, ["rownum-before-aggregate"]);
  });

  it("allows aggregating a sorted top-N capped with FETCH FIRST", () => {
    assert.deepEqual(rules("SELECT SUM(x.amount) FROM (SELECT amount FROM transaction ORDER BY amount DESC FETCH FIRST 10 ROWS ONLY) x").errors, []);
  });

  // Live-verified 2026-09-27: NetSuite applied the outer ROWNUM before the inner GROUP BY (partial sums,
  // unsorted). The e2e fake connector can't catch this; only a live check can.
  it("denies ROWNUM over an aggregated or sorted subquery and unwraps it to FETCH FIRST", () => {
    const sql = "SELECT * FROM (\n  SELECT entity, currency, SUM(foreigntotal) t FROM transaction GROUP BY entity, currency ORDER BY 3 DESC\n) WHERE ROWNUM <= 10";
    const r = rules(sql);
    assert.deepEqual(r.errors, ["rownum-over-subquery"]);
    assert.equal(r.fixed, "SELECT entity, currency, SUM(foreigntotal) t FROM transaction GROUP BY entity, currency ORDER BY 3 DESC\nFETCH FIRST 10 ROWS ONLY");
    assert.deepEqual(rules("SELECT * FROM (SELECT amount FROM transaction ORDER BY amount DESC) x WHERE ROWNUM <= 5").errors, ["rownum-over-subquery"]);
    assert.deepEqual(rules("SELECT * FROM (SELECT * FROM (SELECT entity, COUNT(*) n FROM transaction GROUP BY entity)) WHERE ROWNUM <= 5").errors, ["rownum-over-subquery"], "through a pass-through wrapper");
    const agg = rules("SELECT SUM(x.amount) FROM (SELECT * FROM (SELECT amount FROM transaction ORDER BY amount DESC) WHERE ROWNUM <= 10) x");
    assert.deepEqual(agg.errors, ["rownum-over-subquery"]);
    assert.equal(agg.fixed, "SELECT SUM(x.amount) FROM (SELECT amount FROM transaction ORDER BY amount DESC FETCH FIRST 10 ROWS ONLY) x");
  });

  it("only unwraps a bare SELECT * wrapper", () => {
    const sql = "SELECT entity FROM (SELECT entity, SUM(foreigntotal) t FROM transaction GROUP BY entity) WHERE t > 0 AND ROWNUM <= 10";
    assert.deepEqual(rules(sql).errors, ["rownum-over-subquery"]);
    assert.equal(lintSuiteQL(sql).fixed, undefined);
  });

  it("allows ROWNUM over an unsorted, unaggregated subquery", () => {
    assert.deepEqual(rules("SELECT * FROM (SELECT id FROM transaction WHERE type = 'CustInvc') WHERE ROWNUM <= 50").errors, []);
  });

  it("ignores ORDER BY inside window functions and ROWNUM in the select list", () => {
    assert.deepEqual(rules("SELECT ROWNUM rn, tranid FROM transaction").errors, []);
    assert.deepEqual(rules("SELECT tranid, RANK() OVER (ORDER BY foreigntotal) r FROM transaction WHERE ROWNUM <= 5").errors, []);
  });

  it("is not fooled by ROWNUM inside string literals or comments", () => {
    assert.deepEqual(rules("SELECT memo, COUNT(*) FROM transaction WHERE memo = 'ROWNUM <= 5' GROUP BY memo").errors, []);
    assert.deepEqual(rules("SELECT memo, COUNT(*) FROM transaction -- ROWNUM <= 5\nGROUP BY memo").errors, []);
  });
});

describe("SELECT *", () => {
  it("denies SELECT * and t.* on tables", () => {
    assert.deepEqual(rules("SELECT * FROM transaction").errors, ["select-star"]);
    assert.deepEqual(rules("SELECT t.* FROM transaction t").errors, ["select-star"]);
  });
  it("allows probes and wrappers over subqueries", () => {
    assert.deepEqual(rules("SELECT * FROM transaction FETCH FIRST 1 ROWS ONLY").errors, []);
    assert.deepEqual(rules("SELECT * FROM transaction WHERE ROWNUM <= 1").errors, []);
    assert.deepEqual(rules("SELECT * FROM (SELECT id FROM transaction) WHERE ROWNUM <= 50").errors, []);
  });
  it("does not treat COUNT(*) as SELECT *", () => {
    assert.deepEqual(rules("SELECT COUNT(*) FROM transaction").errors, []);
  });
});

describe("type / recordtype literals", () => {
  it("denies record ids in transaction.type", () => {
    const r = lintSuiteQL("SELECT id FROM transaction t WHERE t.type = 'invoice'");
    assert.equal(r.errors[0].rule, "type-literal");
    assert.match(r.errors[0].message, /type = 'CustInvc'/);
  });
  it("denies type codes in recordtype", () => {
    const r = lintSuiteQL("SELECT id FROM transaction WHERE recordtype IN ('vendorbill', 'VendBill')");
    assert.deepEqual(r.errors.map((e) => e.rule), ["recordtype-literal"]);
    assert.match(r.errors[0].message, /recordtype = 'vendorbill'/);
  });
  it("accepts correct pairs and warns on unknown codes", () => {
    assert.deepEqual(rules("SELECT id FROM transaction WHERE type IN ('CustInvc','CustCred') AND recordtype <> 'journalentry'").errors, []);
    assert.deepEqual(rules("SELECT id FROM transaction WHERE type = 'Bogus'").warnings, ["type-literal-unknown"]);
  });
  it("does not check type columns on other tables", () => {
    assert.deepEqual(rules("SELECT id FROM account a WHERE a.type = 'Bank'").warnings, []);
  });
});

describe("approvalstatus", () => {
  const ctx = { approvalWorkflows: { VendBill: true, CustInvc: false } };
  it("denies approvalstatus filters on types without workflows", () => {
    assert.deepEqual(rules("SELECT id FROM transaction WHERE type = 'CustInvc' AND approvalstatus = 2", ctx).errors, ["approvalstatus-no-workflow"]);
  });
  it("allows it where a workflow exists or the type is unknown", () => {
    assert.deepEqual(rules("SELECT id FROM transaction WHERE type = 'VendBill' AND approvalstatus = 2", ctx).errors, []);
    assert.deepEqual(rules("SELECT id FROM transaction WHERE approvalstatus = 2", ctx).errors, []);
  });
});

describe("unknown columns", () => {
  const fields = (t: string) => (t === "transaction" ? new Set(["id", "tranid", "trandate", "entity", "foreigntotal", "type"]) : undefined);
  it("warns (does not deny) on standard columns missing from the metadata, with a suggestion", () => {
    const r = lintSuiteQL("SELECT t.tranid, t.total FROM transaction t", { fields });
    assert.deepEqual(r.errors, []);
    assert.equal(r.warnings[0].rule, "unknown-column");
    assert.match(r.warnings[0].message, /transaction\.total is not in the connector's metadata.*may still exist.*Similar: foreigntotal/);
  });
  // Live 2026-09-27: on the claude.ai connector a bad column fails with the generic "An unexpected
  // SuiteScript error has occurred"; the field isn't named, so the warning must point at it.
  it("says a generic error points at the column, and suggests the closest name", () => {
    const f = (t: string) => (t === "transactionline" ? new Set(["id", "netamount", "foreignamount", "mainline", "transaction"]) : undefined);
    const r = lintSuiteQL("SELECT tl.amout, tl.mainlnie, tl.zz FROM transactionline tl WHERE tl.mainline = 'F'", { fields: f });
    assert.deepEqual(r.errors, []);
    const [amout, mainl, zz] = r.warnings;
    assert.doesNotMatch(amout.message, /error will say so/);
    assert.match(amout.message, /fails with a generic error \("An unexpected SuiteScript error has occurred"\), this column is the likely cause/);
    assert.match(amout.message, /Did you mean amount\?/, "hidden allowlist columns count as candidates");
    assert.match(amout.message, /nsx fields transactionline --grep amou/);
    assert.match(mainl.message, /Did you mean mainline\?/, "adjacent swap is one edit");
    assert.doesNotMatch(zz.message, /Did you mean/, "no match within 2 edits (and not on half a short name)");
    assert.deepEqual(amout.columns, ["transactionline.amout"]);
    assert.deepEqual(unknownColumns(r), ["transactionline.amout", "transactionline.mainlnie", "transactionline.zz"]);
    const c = lintSuiteQL("SELECT t.custbody_new, t.tranid FROM transaction t", { fields });
    assert.deepEqual(unknownColumns(c), ["transaction.custbody_new"], "custom fields too");
    assert.deepEqual(unknownColumns(lintSuiteQL("SELECT t.tranid FROM transaction t", { fields })), []);
    assert.deepEqual(unknownColumns(lintSuiteQL("SELECT t.nope FROM transaction t")), [], "no field cache, no findings");
  });
  it("knows columns the connector's metadata leaves out (live-verified)", () => {
    const f = (t: string) => new Set(t === "transactionline" ? ["id", "netamount", "foreignamount", "mainline"] : ["id"]);
    const r = rules("SELECT a.acctname, p.parent, SUM(tl.amount) FROM transactionline tl JOIN account a ON a.id = tl.id JOIN accountingperiod p ON p.id = 1 WHERE tl.mainline = 'F' GROUP BY a.acctname, p.parent", { fields: f });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
  });
  it("only warns for custom fields and ignores uncached tables", () => {
    const r = rules("SELECT t.custbody_new, c.whatever FROM transaction t JOIN customer c ON c.id = t.entity", { fields });
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, ["unknown-custom-field"]);
  });
  it("resolves aliases per scope", () => {
    const r = rules("SELECT x.tranid FROM (SELECT t.tranid FROM transaction t) x", { fields });
    assert.deepEqual(r.errors, []);
  });
});

describe("warnings", () => {
  it("warns on unfiltered transactionline sums, not when mainline is filtered", () => {
    assert.deepEqual(rules("SELECT SUM(tl.amount) FROM transactionline tl").warnings, ["transactionline-sum-unfiltered"]);
    assert.deepEqual(rules("SELECT SUM(tl.amount) FROM transactionline tl WHERE tl.mainline = 'F'").warnings, []);
    // section_158039627694: Oracle's own example uses the NVL form
    assert.deepEqual(rules("SELECT SUM(tl.amount) FROM transactionline tl WHERE NVL(tl.mainline,'F') = 'F' AND NVL(tl.taxline,'F') = 'F'").warnings, []);
  });
  it("warns on date filters in LEFT JOIN ON with aggregates", () => {
    const sql = "SELECT c.id, SUM(c.balance), COUNT(t.id) FROM customer c LEFT JOIN transaction t ON t.entity = c.id AND t.trandate >= SYSDATE - 30 GROUP BY c.id";
    assert.deepEqual(rules(sql).warnings, ["left-join-aggregate"]);
    const budget = "SELECT b.account, SUM(b.total), SUM(tal.amount) FROM budgets b LEFT JOIN transactionaccountingline tal ON tal.account = b.account AND tal.postingperiod = b.period GROUP BY b.account";
    assert.deepEqual(rules(budget).warnings, ["budget-fanout"], "budget-fanout replaces the generic warning");
  });
  it("FETCH FIRST is the recommended cap", () => {
    assert.deepEqual(rules("SELECT id FROM transaction ORDER BY id FETCH FIRST 5 ROWS ONLY").warnings, []);
  });
  it("warns on SUM(foreigntotal/foreignamount) without currency grouping", () => {
    assert.deepEqual(rules("SELECT SUM(t.foreigntotal) FROM transaction t").warnings, ["sum-mixed-currency"]);
    assert.deepEqual(rules("SELECT t.entity, SUM(tl.foreignamount) FROM transactionline tl JOIN transaction t ON t.id = tl.transaction WHERE tl.mainline = 'F' GROUP BY t.entity").warnings, ["sum-mixed-currency"]);
    assert.deepEqual(rules("SELECT t.currency, SUM(t.foreigntotal) FROM transaction t GROUP BY t.currency").warnings, []);
    assert.deepEqual(rules("SELECT BUILTIN.DF(t.currency), SUM(t.foreigntotal) FROM transaction t GROUP BY BUILTIN.DF(t.currency)").warnings, []);
    assert.deepEqual(rules("SELECT SUM(foreigntotal) FROM transaction WHERE currency = 1").warnings, []);
    assert.deepEqual(rules("SELECT c, s FROM (SELECT currency c, SUM(foreigntotal) s FROM transaction GROUP BY currency)").warnings, [], "grouped in the block that sums");
  });
  it("warns on budgets and actuals aggregated over one join (budget-fanout)", () => {
    // The live-test query: the date filter sits in a subquery inside ON, so left-join-aggregate can't see it.
    const sql = "SELECT b.account, SUM(b.total), SUM(tal.amount) FROM budgets b LEFT JOIN transactionaccountingline tal ON tal.account=b.account AND tal.transaction IN (SELECT id FROM transaction WHERE trandate >= TO_DATE('2026-01-01','YYYY-MM-DD')) GROUP BY b.account";
    assert.deepEqual(rules(sql).warnings, ["budget-fanout"]);
    assert.deepEqual(rules("SELECT bm.period, SUM(bm.amount), SUM(tal.amount) FROM budgetsmachine bm JOIN transactionaccountingline tal ON tal.postingperiod = bm.period GROUP BY bm.period").warnings, ["budget-fanout"]);
    const sep = "SELECT b.account, b.budget, a.actual FROM (SELECT account, SUM(total) budget FROM budgets GROUP BY account) b LEFT JOIN (SELECT account, SUM(amount) actual FROM transactionaccountingline WHERE posting = 'T' GROUP BY account) a ON a.account = b.account";
    assert.deepEqual(rules(sep).warnings, [], "separate subqueries are the fix");
    assert.deepEqual(rules("SELECT a.acctname, SUM(b.total) FROM budgets b JOIN account a ON a.id = b.account GROUP BY a.acctname").warnings, [], "dimension joins don't fan out");
  });
});

describe("ROWNUM rewrites, parentheses, UNION branches and type rules", () => {
  it("never rewrites OR-joined or non-upper-bound ROWNUM predicates", () => {
    const orSql = "SELECT id, COUNT(*) FROM transaction WHERE ROWNUM <= 10 OR status='A' GROUP BY id";
    const r = lintSuiteQL(orSql);
    assert.deepEqual(r.errors.map((e) => e.rule), ["rownum-with-aggregate"]);
    assert.equal(r.fixed, undefined);
    assert.equal(fixRownum(orSql), orSql);
    for (const sql of ["SELECT id FROM t WHERE ROWNUM > 5 ORDER BY id", "SELECT id FROM t WHERE ROWNUM = 5 ORDER BY id", "SELECT id FROM t WHERE ROWNUM >= 1 ORDER BY id"]) {
      assert.equal(fixRownum(sql), sql, sql);
    }
  });

  it("still rewrites reversed and equality-to-one bounds", () => {
    assert.equal(fixRownum("SELECT a FROM t WHERE 10 >= ROWNUM ORDER BY a"), "SELECT a FROM t ORDER BY a FETCH FIRST 10 ROWS ONLY");
    assert.equal(fixRownum("SELECT a FROM t WHERE x = 1 AND ROWNUM = 1 ORDER BY a"), "SELECT a FROM t WHERE x = 1 ORDER BY a FETCH FIRST 1 ROWS ONLY");
  });

  it("never adds a second FETCH", () => {
    const sql = "SELECT a FROM t WHERE ROWNUM <= 5 ORDER BY a FETCH FIRST 3 ROWS ONLY";
    assert.equal(fixRownum(sql), sql);
  });

  it("sees ROWNUM and aggregates inside parentheses", () => {
    assert.deepEqual(rules("SELECT id, COUNT(*) FROM transaction WHERE (ROWNUM <= 10) GROUP BY id").errors, ["rownum-with-aggregate"]);
    assert.deepEqual(rules("SELECT id FROM transaction WHERE (x = 1 AND (ROWNUM <= 10)) ORDER BY id").errors, ["rownum-with-order-by"]);
    assert.deepEqual(rules("SELECT NVL(SUM(foreigntotal), 0) FROM transaction WHERE ROWNUM <= 10").errors, ["rownum-with-aggregate"]);
    assert.equal(lintSuiteQL("SELECT id, COUNT(*) FROM transaction WHERE (ROWNUM <= 10) GROUP BY id").fixed, undefined, "no unsafe rewrite");
  });

  it("still ignores window ORDER BY and ROWNUM inside subqueries in parens", () => {
    assert.deepEqual(rules("SELECT id, SUM(x) OVER (ORDER BY id) FROM t").errors, []);
    assert.deepEqual(rules("SELECT COUNT(*) FROM transaction WHERE entity IN (SELECT id FROM customer WHERE ROWNUM <= 5)").errors, []);
  });

  it("analyses UNION branches separately", () => {
    const sql = "SELECT id FROM a WHERE ROWNUM <= 10 UNION ALL SELECT id FROM b ORDER BY id";
    const r = lintSuiteQL(sql);
    assert.deepEqual(r.errors, []);
    assert.equal(fixRownum(sql), sql);
    assert.deepEqual(rules("SELECT id FROM a UNION ALL SELECT id, COUNT(*) FROM b WHERE ROWNUM <= 3 GROUP BY id").errors, ["rownum-with-aggregate"]);
    assert.deepEqual(rules("SELECT id FROM a WHERE ROWNUM <= 3 UNION ALL SELECT id, COUNT(*) FROM b GROUP BY id").errors, [], "ROWNUM and GROUP BY are in different branches");
  });

  it("only applies type/recordtype rules to transaction columns", () => {
    assert.deepEqual(rules("SELECT x.type FROM (SELECT 'invoice' AS type FROM transaction WHERE ROWNUM <= 1) x WHERE x.type = 'invoice'").errors, []);
    assert.deepEqual(rules("SELECT id FROM (SELECT id, type FROM transaction) WHERE type = 'invoice'").errors, [], "unqualified type in a block over a subquery");
    assert.deepEqual(rules("SELECT id FROM transaction t WHERE t.type = 'invoice'").errors, ["type-literal"]);
    assert.deepEqual(rules("SELECT id FROM transaction WHERE type = 'invoice'").errors, ["type-literal"]);
  });

  it("treats SELECT ALL * like SELECT *", () => {
    assert.deepEqual(rules("SELECT ALL * FROM transaction").errors, ["select-star"]);
  });
});

describe("LIMIT and non-SELECT statements", () => {
  it("denies LIMIT and suggests FETCH FIRST", () => {
    const r = rules("SELECT t.id FROM transaction t LIMIT 10");
    assert.deepEqual(r.errors, ["limit-clause"]);
    assert.equal(r.fixed, "SELECT t.id FROM transaction t FETCH FIRST 10 ROWS ONLY");
    // NetSuite ignores OFFSET (live-verified): no rewrite, point at pageSize + pageIndex instead.
    const off = "SELECT id FROM t ORDER BY id LIMIT 10 OFFSET 20";
    assert.equal(fixLimit(off), off);
    assert.equal(fixLimit("SELECT id FROM t ORDER BY id OFFSET 20 LIMIT 10"), "SELECT id FROM t ORDER BY id OFFSET 20 LIMIT 10");
    const r2 = lintSuiteQL(off);
    assert.deepEqual(r2.errors.map((e) => e.rule), ["limit-clause", "offset-ignored"]);
    assert.equal(r2.fixed, undefined);
    assert.match(r2.errors[0].message, /pageSize \+ pageIndex with a unique ORDER BY/);
    assert.equal(fixLimit("SELECT id FROM t LIMIT 5, 10"), "SELECT id FROM t LIMIT 5, 10", "MySQL form is left alone");
    assert.deepEqual(rules("SELECT c.creditlimit, x.limit FROM customer c JOIN y x ON x.id = c.id").errors, [], "limit as a column name");
  });

  it("fixes LIMIT and ROWNUM together", () => {
    assert.equal(lintSuiteQL("SELECT a, COUNT(*) FROM t WHERE ROWNUM <= 5 GROUP BY a").fixed, "SELECT a, COUNT(*) FROM t GROUP BY a FETCH FIRST 5 ROWS ONLY");
  });

  it("denies anything that isn't a single SELECT/WITH query", () => {
    for (const sql of ["DELETE FROM customer WHERE id = 1", "update customer set x = 1", "INSERT INTO t VALUES (1)", "MERGE INTO t USING s ON (1=1)", "DROP TABLE t", "SELECT id FROM t; DELETE FROM t", "BEGIN NULL; END;", "(DELETE FROM t)", "((UPDATE t SET x = 1))", "SELECT id FROM t; (DROP TABLE t)"]) {
      assert.deepEqual(rules(sql).errors, ["not-select"], sql);
      assert.equal(isReadQuery(sql), false, sql);
    }
    for (const sql of ["SELECT id FROM t;", "with x as (select 1 a from dual) select a from x", "(SELECT id FROM a) UNION (SELECT id FROM b)", "-- note\nSELECT id FROM t"]) {
      assert.equal(isReadQuery(sql), true, sql);
    }
  });

  it("names the statement even when it's wrapped in parentheses", () => {
    assert.match(lintSuiteQL("(DELETE FROM t)").errors[0].message, /this one runs DELETE/);
  });

  it("the pre hook denies non-SELECT statements even with [nolint]", () => {
    const ctx = tmpCtx();
    const out = hso(handlePre({ session_id: "s", tool_use_id: "d", tool_name: "mcp__netsuite__ns_runCustomSuiteQL", tool_input: { sqlQuery: "DELETE FROM customer WHERE id = 1", description: "[nolint]" } }, ctx));
    assert.equal(out.permissionDecision, "deny");
    assert.match(String(out.permissionDecisionReason), /not-select/);
    assert.equal(out.updatedInput, undefined);
  });
});

describe("Oracle SuiteQL docs rules", () => {
  it("cte-unsupported: WITH is an error, not a not-select", () => {
    const r = lintSuiteQL("WITH x AS (SELECT id FROM transaction) SELECT id FROM x");
    assert.deepEqual(r.errors.map((e) => e.rule), ["cte-unsupported"]);
    assert.match(r.errors[0].message, /doesn't support WITH clauses; rewrite each CTE as a FROM subquery/);
    assert.deepEqual(rules("SELECT id FROM (WITH x AS (SELECT 1 a FROM dual) SELECT a FROM x)").errors, ["cte-unsupported"]);
    assert.deepEqual(rules("SELECT id FROM account START WITH parent IS NULL CONNECT BY PRIOR id = parent").errors, [], "START WITH is not a CTE");
    assert.doesNotMatch(lintSuiteQL("DELETE FROM t").errors[0].message, /WITH/, "not-select no longer suggests WITH");
  });

  it("unsupported-function: named alternatives, JOINs and strings untouched", () => {
    const r = lintSuiteQL("SELECT LEFT(t.tranid, 3), RIGHT(t.tranid, 2), CEILING(t.foreigntotal), UCASE(t.memo) FROM transaction t");
    assert.deepEqual(r.errors.map((e) => e.rule), ["unsupported-function", "unsupported-function", "unsupported-function", "unsupported-function"]);
    assert.match(r.errors[0].message, /LEFT\(\) isn't supported in SuiteQL: use SUBSTR\(s, 1, n\)/);
    assert.match(r.errors[2].message, /use CEIL/);
    assert.match(r.errors[3].message, /use UPPER/);
    const cases: [string, RegExp][] = [
      ["SUBSTRING(memo, 1, 2)", /SUBSTR/], ["CHARINDEX('a', memo)", /INSTR/], ["LOCATE('a', memo)", /INSTR/], ["POSITION('a' IN memo)", /INSTR/],
      ["LCASE(memo)", /LOWER/], ["CHAR_LENGTH(memo)", /LENGTH/], ["CHARACTER_LENGTH(memo)", /LENGTH/], ["DATEDIFF(day, trandate, duedate)", /subtract dates/],
      ["CONVERT(memo, 1)", /TO_CHAR/], ["REPEAT('x', 3)", /no SuiteQL equivalent/],
    ];
    for (const [fn, alt] of cases) {
      const x = lintSuiteQL(`SELECT ${fn} FROM transaction`);
      assert.deepEqual(x.errors.map((e) => e.rule), ["unsupported-function"], fn);
      assert.match(x.errors[0].message, alt, fn);
    }
    assert.deepEqual(rules("SELECT tranid, LISTAGG(memo, ',') FROM transaction GROUP BY tranid").errors, ["unsupported-function"]);
    assert.deepEqual(rules("SELECT t.id FROM transaction t LEFT JOIN customer c ON c.id = t.entity RIGHT JOIN (SELECT id FROM vendor) v ON v.id = t.entity").errors, []);
    assert.deepEqual(rules("SELECT id FROM transaction WHERE memo = 'LEFT(x)' -- RIGHT(y)").errors, []);
    assert.deepEqual(rules("SELECT SUBSTR(tranid, 1, 3), CEIL(foreigntotal) FROM transaction").errors, []);
  });

  it("date-literal and string-date-compare", () => {
    const r = lintSuiteQL("SELECT id FROM transaction WHERE trandate >= DATE '2026-01-01'");
    assert.deepEqual(r.errors.map((e) => e.rule), ["date-literal"]);
    assert.match(r.errors[0].message, /TO_DATE\('2026-01-01','YYYY-MM-DD'\)/);
    assert.deepEqual(rules("SELECT id FROM transaction WHERE lastmodifieddate > TIMESTAMP '2026-01-01 00:00:00'").errors, ["date-literal"]);
    assert.deepEqual(rules("SELECT id FROM transaction WHERE memo = 'x' -- DATE '2026-01-01'").errors, []);
    for (const sql of [
      "SELECT id FROM transaction t WHERE t.trandate >= '2026-01-01'",
      "SELECT id FROM transaction WHERE duedate < '01/31/2026'",
      "SELECT id FROM transaction t WHERE t.trandate BETWEEN '2026-01-01' AND '2026-01-31'",
      "SELECT id FROM transaction t WHERE '2026-01-01' <= t.trandate",
      "SELECT id FROM customer c WHERE c.custentity_renewaldate = '2026-01-01'",
    ]) assert.deepEqual(rules(sql).warnings, ["string-date-compare"], sql);
    assert.deepEqual(rules("SELECT id FROM transaction t WHERE t.trandate >= TO_DATE('2026-01-01','YYYY-MM-DD')").warnings, []);
    assert.deepEqual(rules("SELECT id FROM transaction t WHERE t.memo = '2026-01-01'").warnings, [], "not a date column");
  });

  it("rownum-greater-than: conditions that can never be true", () => {
    for (const sql of ["SELECT id FROM transaction WHERE ROWNUM > 10", "SELECT id FROM transaction WHERE ROWNUM > 1", "SELECT id FROM transaction WHERE ROWNUM >= 2", "SELECT id FROM transaction WHERE ROWNUM = 5", "SELECT id FROM transaction WHERE ROWNUM BETWEEN 11 AND 20", "SELECT id FROM transaction WHERE 10 < ROWNUM"]) {
      const r = lintSuiteQL(sql);
      assert.deepEqual(r.errors.map((e) => e.rule), ["rownum-greater-than"], sql);
      assert.match(r.errors[0].message, /always returns no rows; page with pageSize \+ pageIndex \(and a unique ORDER BY\)/);
    }
    for (const sql of ["SELECT id FROM transaction WHERE ROWNUM <= 10", "SELECT id FROM transaction WHERE ROWNUM = 1", "SELECT id FROM transaction WHERE ROWNUM >= 1", "SELECT id FROM transaction WHERE ROWNUM BETWEEN 1 AND 10", "SELECT x.id FROM (SELECT ROWNUM rn, id FROM transaction) x WHERE x.rn > 10"]) {
      assert.deepEqual(rules(sql).errors, [], sql);
    }
  });

  it("status-without-cf", () => {
    const r = lintSuiteQL("SELECT id FROM transaction t WHERE t.type = 'CustInvc' AND t.status = 'A'");
    assert.deepEqual(r.warnings.map((w) => w.rule), ["status-without-cf"]);
    assert.match(r.warnings[0].message, /Raw t\.status holds only the status letter; filter with BUILTIN\.CF\(t\.status\) = 'CustInvc:A' \(type:letter\)/);
    assert.deepEqual(rules("SELECT id FROM transaction WHERE status IN ('A', 'B')").warnings, ["status-without-cf"]);
    assert.deepEqual(rules("SELECT id FROM transaction x WHERE x.status <> 'B'").warnings, ["status-without-cf"]);
    assert.deepEqual(rules("SELECT id FROM transaction t WHERE BUILTIN.CF(t.status) = 'CustInvc:A'").warnings, []);
    assert.deepEqual(rules("SELECT id FROM transaction WHERE BUILTIN.CF(status) IN ('CustInvc:A','CustInvc:B')").warnings, []);
    assert.deepEqual(rules("SELECT id FROM transaction t WHERE BUILTIN.DF(t.status) = 'Open'").warnings, []);
    assert.deepEqual(rules("SELECT id FROM transaction t WHERE t.approvalstatus = '2'").warnings, []);
  });

  it("approvalstatus-no-workflow points at BUILTIN.CF", () => {
    const r = lintSuiteQL("SELECT id FROM transaction WHERE type = 'CustInvc' AND approvalstatus = 2", { approvalWorkflows: { CustInvc: false } });
    assert.match(r.errors[0].message, /BUILTIN\.CF\(t\.status\) = 'CustInvc:<letter>'/);
  });

  it("in-list-too-long", () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1).join(", ");
    const r = lintSuiteQL(`SELECT id FROM transaction WHERE id IN (${ids(1001)})`);
    assert.deepEqual(r.errors.map((e) => e.rule), ["in-list-too-long"]);
    assert.match(r.errors[0].message, /1001 items; SuiteQL allows at most 1000/);
    assert.deepEqual(rules(`SELECT id FROM transaction WHERE id IN (${ids(1000)})`).errors, []);
    assert.deepEqual(rules(`SELECT id FROM transaction WHERE memo NOT IN (${Array.from({ length: 1001 }, (_, i) => `'m${i}'`).join(",")})`).errors, ["in-list-too-long"]);
  });

  it("mixed-join-syntax and right-outer-plus", () => {
    assert.deepEqual(rules("SELECT t.id FROM transaction t JOIN account a ON a.id = t.id, customer c WHERE c.id = t.entity (+)").errors, ["mixed-join-syntax"]);
    assert.deepEqual(rules("SELECT t.id FROM transaction t, customer c WHERE c.id = t.entity (+)").errors, [], "Oracle style alone is fine");
    assert.deepEqual(rules("SELECT t.id FROM transaction t JOIN customer c ON c.id = t.entity, account a WHERE a.id = t.id").errors, [], "comma + JOIN is left alone");
    assert.deepEqual(rules("SELECT x.id FROM (SELECT t.id FROM transaction t, customer c WHERE c.id = t.entity (+)) x JOIN account a ON a.id = x.id").errors, [], "per query block");
    const r = lintSuiteQL("SELECT a1.id FROM account a1, account a2 WHERE a1.id (+) = a2.id");
    assert.deepEqual(r.errors.map((e) => e.rule), ["right-outer-plus"]);
    assert.match(r.errors[0].message, /move \(\+\) to the other side \(swap the operands\)/);
    assert.deepEqual(rules("SELECT a1.id FROM account a1, account a2 WHERE a2.id = a1.id (+)").errors, []);
  });

  it("string-plus-concat and bracket-identifier", () => {
    const r = lintSuiteQL("SELECT tranid + '-' + memo FROM transaction");
    assert.deepEqual(r.errors.map((e) => e.rule), ["string-plus-concat"]);
    assert.match(r.errors[0].message, /use \|\| to concatenate/);
    assert.deepEqual(rules("SELECT tranid || '-' || memo, foreigntotal + 1 FROM transaction").errors, []);
    assert.deepEqual(rules("SELECT foreigntotal + '5', '1.5' + foreigntotal FROM transaction").errors, [], "numeric strings are arithmetic");
    assert.deepEqual(rules("SELECT [tranid] FROM transaction").errors, ["bracket-identifier"]);
    assert.deepEqual(rules("SELECT tranid FROM transaction WHERE memo = '[x]'").errors, []);
  });

  it("sum-mixed-currency offers BUILTIN.CURRENCY_CONVERT", () => {
    const w = lintSuiteQL("SELECT SUM(t.foreigntotal) FROM transaction t").warnings[0];
    assert.match(w.message, /BUILTIN\.CURRENCY_CONVERT\(amount, <target currency id>, <rate date>\).*defaults to today/);
  });

  it("pagingOrderMissing: multi-row queries without ORDER BY", () => {
    assert.equal(pagingOrderMissing("SELECT id FROM transaction"), true);
    assert.equal(pagingOrderMissing("SELECT id FROM transaction ORDER BY id"), false);
    assert.equal(pagingOrderMissing("SELECT entity, COUNT(*) FROM transaction GROUP BY entity"), true, "grouped rows page too");
    assert.equal(pagingOrderMissing("SELECT entity, COUNT(*) FROM transaction GROUP BY entity ORDER BY entity"), false);
    assert.equal(pagingOrderMissing("SELECT COUNT(*) FROM transaction"), false, "one row");
    assert.equal(pagingOrderMissing("SELECT x.id FROM (SELECT id FROM transaction ORDER BY id) x"), true);
  });

  it("the pre hook warns when paging past page 0 without ORDER BY", () => {
    const ctx = tmpCtx();
    const call = (sqlQuery: string, pageIndex: number) =>
      hso(handlePre({ session_id: "s", tool_use_id: `p${pageIndex}-${sqlQuery.length}`, tool_name: "mcp__netsuite__ns_runCustomSuiteQL", tool_input: { sqlQuery, pageSize: 100, pageIndex } }, ctx));
    assert.match(String(call("SELECT id FROM transaction", 1).additionalContext), /Paging needs a unique ORDER BY \(e\.g\. ORDER BY t\.id\)/);
    assert.doesNotMatch(String(call("SELECT id FROM transaction ORDER BY id", 1).additionalContext ?? ""), /Paging needs/);
    assert.doesNotMatch(String(call("SELECT id FROM transaction", 0).additionalContext ?? ""), /Paging needs/);
  });
});

describe("OFFSET (ignored by NetSuite)", () => {
  // Live-verified 2026-09-27: ORDER BY t.id OFFSET 3 ROWS FETCH NEXT 3 ROWS ONLY returned the first 3
  // rows, with or without pageSize/pageIndex.
  it("offset-ignored: denies OFFSET n > 0; the fix is pageSize + pageIndex for the same page", () => {
    const r = lintSuiteQL("SELECT t.id FROM transaction t WHERE t.type = 'CustInvc' ORDER BY t.id OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY");
    assert.deepEqual(r.errors.map((e) => e.rule), ["offset-ignored"]);
    assert.match(r.errors[0].message, /NetSuite ignores OFFSET \(live-verified 2026-09-27\).*pageSize \+ pageIndex and a unique ORDER BY.*WHERE t\.id > <last id>/);
    assert.equal(r.fixed, "SELECT t.id FROM transaction t WHERE t.type = 'CustInvc' ORDER BY t.id");
    assert.deepEqual(r.paging, { pageSize: 5, pageIndex: 2 });
    assert.deepEqual(rules(r.fixed!).errors, [], "the fix itself must lint clean");
    assert.match(formatLint(r), /Suggested fix: call with pageSize: 5, pageIndex: 2 and this query[^\n]*\nSELECT t\.id FROM transaction t WHERE t\.type = 'CustInvc' ORDER BY t\.id$/);
    assert.deepEqual(offsetPaging("SELECT id FROM transaction ORDER BY id\nOFFSET 20 ROWS\nFETCH FIRST 10 ROWS ONLY;"), { sql: "SELECT id FROM transaction ORDER BY id", pageSize: 10, pageIndex: 2 });
  });

  it("offset-ignored: no Suggested fix when no page matches (rows 1–m would be the wrong page)", () => {
    for (const sql of [
      "SELECT t.id FROM transaction t ORDER BY t.id OFFSET 5 ROWS FETCH NEXT 3 ROWS ONLY", // not a multiple
      "SELECT t.id FROM transaction t ORDER BY t.id OFFSET 3 ROWS FETCH NEXT 3 ROWS ONLY", // pageSize < 5
      "SELECT id FROM transaction ORDER BY id OFFSET 1 ROW", // no FETCH
      "SELECT x.id FROM (SELECT id FROM transaction ORDER BY id OFFSET 5 ROWS FETCH NEXT 5 ROWS ONLY) x", // not top level
    ]) {
      const r = lintSuiteQL(sql);
      assert.deepEqual(r.errors.map((e) => e.rule), ["offset-ignored"], sql);
      assert.equal(r.fixed, undefined, sql);
      assert.doesNotMatch(formatLint(r), /Suggested fix/, sql);
    }
  });

  it("offset-ignored: bare OFFSET n and parameters too, but not OFFSET 0 or an offset column", () => {
    assert.deepEqual(rules("SELECT id FROM transaction ORDER BY id OFFSET 20").errors, ["offset-ignored"]);
    const p = lintSuiteQL("SELECT id FROM transaction ORDER BY id OFFSET :n ROWS FETCH NEXT 5 ROWS ONLY");
    assert.deepEqual(p.errors.map((e) => e.rule), ["offset-ignored"]);
    assert.equal(p.fixed, undefined, "only a literal OFFSET is rewritten");
    assert.deepEqual(rules("SELECT id FROM transaction ORDER BY id OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY").errors, []);
    assert.deepEqual(rules("SELECT x.offset FROM (SELECT 1 AS offset FROM dual) x").errors, []);
    assert.deepEqual(rules("SELECT id FROM transaction WHERE memo = 'OFFSET 5 ROWS' -- OFFSET 5\nORDER BY id").errors, []);
  });

  it("no message suggests OFFSET for paging", () => {
    for (const sql of ["SELECT id FROM t ORDER BY id LIMIT 10 OFFSET 20", "SELECT id FROM t LIMIT 10", "SELECT id FROM transaction WHERE ROWNUM > 10", "SELECT id FROM transaction ORDER BY id OFFSET 5 ROWS"]) {
      const r = lintSuiteQL(sql);
      for (const e of r.errors.filter((x) => x.rule !== "offset-ignored")) assert.doesNotMatch(e.message, /OFFSET … FETCH|OFFSET n ROWS|use OFFSET/i, sql);
      assert.doesNotMatch(r.fixed ?? "", /offset/i, sql);
    }
  });

  it("TOP n is left alone (live-verified: TOP n … ORDER BY returns the right top n)", () => {
    assert.deepEqual(rules("SELECT TOP 3 t.id FROM transaction t ORDER BY t.id DESC").errors, []);
  });
});

describe("undefined-alias", () => {
  const bad = (sql: string) => assert.deepEqual(rules(sql).errors, ["undefined-alias"], sql);
  const ok = (sql: string) => assert.deepEqual(rules(sql).errors, [], sql);

  it("denies a qualifier no FROM/JOIN declares", () => {
    const r = lintSuiteQL("SELECT x.foo FROM transactionline tl JOIN account a ON a.id = tl.id");
    assert.deepEqual(r.errors.map((e) => e.rule), ["undefined-alias"]);
    assert.match(r.errors[0].message, /x\.foo: 'x' isn't a table or alias in this query's FROM\/JOIN.*in scope: tl, a/);
    bad("SELECT t.id FROM transaction t WHERE c.id = 1");
    bad("SELECT t.id, SUM(tl.netamount) FROM transaction t GROUP BY t.id");
    bad("SELECT t.id FROM transaction t ORDER BY z.id");
    bad("SELECT t.id FROM transaction t JOIN account a ON a.id = q.id");
    bad("SELECT z.* FROM transaction t FETCH FIRST 1 ROWS ONLY");
    bad("SELECT BUILTIN.DF(y.entity) FROM transaction t");
  });

  it("aliases inside a FROM subquery aren't visible outside it", () => {
    bad("SELECT t.id FROM (SELECT t.id FROM transaction t) x");
    ok("SELECT x.id FROM (SELECT t.id FROM transaction t) x");
    ok("SELECT x.id FROM (SELECT t.id FROM transaction t) AS x JOIN (SELECT a.id FROM account a) y ON y.id = x.id");
    bad("SELECT t.id FROM transaction t WHERE t.entity IN (SELECT c.id FROM customer c) AND c.id > 0");
  });

  it("correlated subqueries see enclosing aliases", () => {
    ok("SELECT t.id FROM transaction t WHERE EXISTS (SELECT 1 FROM transactionline tl WHERE tl.transaction = t.id AND tl.mainline = 'F')");
    ok("SELECT t.id, (SELECT COUNT(*) FROM transactionline tl WHERE tl.transaction = t.id) n FROM transaction t");
    ok("SELECT t.id FROM transaction t JOIN account a ON a.id IN (SELECT tal.account FROM transactionaccountingline tal WHERE tal.transaction = t.id)");
    ok("SELECT t.id FROM transaction t WHERE t.id IN (SELECT x.id FROM (SELECT tl.transaction id FROM transactionline tl WHERE tl.transaction = t.id) x)");
  });

  it("no false positives on namespaces, table names, select aliases, strings, comments and schema prefixes", () => {
    ok("SELECT BUILTIN.DF(t.entity), BUILTIN.CF(t.status), BUILTIN.CURRENCY_CONVERT(t.foreigntotal, 1, t.trandate) FROM transaction t WHERE t.currency = 1");
    ok("SELECT BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 1, 2, 'DEFAULT') FROM transactionaccountingline tal");
    ok("SELECT transaction.id, transaction.tranid FROM transaction");
    ok("SELECT transaction.id FROM transaction JOIN transactionline ON transactionline.transaction = transaction.id");
    ok("SELECT t.entity AS customer, COUNT(*) AS n FROM transaction t GROUP BY t.entity ORDER BY n DESC, customer");
    ok("SELECT t.id FROM transaction t WHERE t.memo = 'x.foo' -- y.bar\n/* z.baz */");
    ok("SELECT s.transaction.id FROM transaction");
    ok("SELECT \"T\".id FROM transaction \"T\"");
    ok("SELECT a1.id FROM account a1, account a2 WHERE a2.id = a1.id (+)");
    ok("SELECT t.id, x.id FROM transaction t, (SELECT a.id FROM account a) x WHERE x.id = t.id");
    ok("SELECT t.id FROM transaction AS t LEFT OUTER JOIN customer AS c ON c.id = t.entity");
    ok("SELECT t.id FROM transaction t UNION ALL SELECT a.id FROM account a");
    ok("SELECT t.id, SUM(t.foreigntotal) OVER (PARTITION BY t.entity ORDER BY t.trandate) FROM transaction t WHERE t.currency = 1");
    ok("SELECT EXTRACT(YEAR FROM t.trandate) y FROM transaction t");
    ok("SELECT a.id FROM account a START WITH a.parent IS NULL CONNECT BY PRIOR a.id = a.parent");
  });
});

describe("string-plus-concat with metadata types", () => {
  // account.acctnumber is typed string in live field metadata (2026-09-27); acctname is accepted by SuiteQL but unlisted.
  const types: Record<string, Record<string, string>> = { account: { acctnumber: "string", id: "integer" }, transactionline: { memo: "string", foreignamount: "double" } };
  const ctx = { fieldType: (t: string, c: string) => types[t]?.[c] };

  it("denies + next to a column the metadata types as string", () => {
    const r = lintSuiteQL("SELECT a.acctnumber + a.acctname FROM account a", ctx);
    assert.deepEqual(r.errors.map((e) => e.rule), ["string-plus-concat"]);
    assert.match(r.errors[0].message, /use \|\| to concatenate \(account\.acctnumber is a string column\)/);
    assert.deepEqual(rules("SELECT a.acctname + a.acctnumber FROM account a", ctx).errors, ["string-plus-concat"], "right operand");
    assert.deepEqual(rules("SELECT acctnumber + id FROM account", ctx).errors, ["string-plus-concat"], "unqualified, single source");
    assert.deepEqual(rules("SELECT tl.memo + tl.foreignamount FROM transactionline tl WHERE tl.mainline = 'F'", ctx).errors, ["string-plus-concat"]);
  });

  it("no false positives", () => {
    assert.deepEqual(rules("SELECT a.acctnumber + a.acctname FROM account a").errors, [], "no types cached");
    assert.deepEqual(rules("SELECT a.acctnumber || a.acctname, a.id + a.id FROM account a", ctx).errors, []);
    assert.deepEqual(rules("SELECT a.acctnumber + 1, '5' + a.acctnumber FROM account a", ctx).errors, [], "numeric operand is arithmetic");
    assert.deepEqual(rules("SELECT tl.foreignamount + tl.foreignamount FROM transactionline tl WHERE tl.mainline = 'F'", ctx).errors, []);
    assert.deepEqual(rules("SELECT acctnumber + id FROM account a JOIN transactionline tl ON tl.id = a.id", ctx).errors, [], "bare column, two sources");
    assert.deepEqual(rules("SELECT x.acctnumber + 1 FROM (SELECT a.acctnumber FROM account a) x", ctx).errors, [], "subquery alias");
  });
});

describe("order-by-alias-group-by", () => {
  const warn = (sql: string) => rules(sql).warnings.filter((w) => w === "order-by-alias-group-by");

  it("warns on ORDER BY an aggregate's alias with GROUP BY (live: Invalid or unsupported search)", () => {
    const sql =
      "SELECT tl.subsidiary AS sub, BUILTIN.DF(tl.subsidiary) AS subname, BUILTIN.DF(t.currency) AS currency, COUNT(*) AS n FROM transaction t JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'T' WHERE t.exchangerate = 1 GROUP BY tl.subsidiary, BUILTIN.DF(tl.subsidiary), BUILTIN.DF(t.currency) ORDER BY tl.subsidiary, n DESC";
    const w = lintSuiteQL(sql).warnings.find((x) => x.rule === "order-by-alias-group-by");
    assert.ok(w);
    assert.match(w.message, /NetSuite may reject ORDER BY on an alias with GROUP BY \("Invalid or unsupported search"\): order by the full expression \(COUNT\(\*\) DESC instead of n DESC\)/);
    assert.deepEqual(warn("SELECT t.entity, SUM(t.foreigntotal) total FROM transaction t GROUP BY t.entity, t.currency ORDER BY total DESC FETCH FIRST 5 ROWS ONLY"), ["order-by-alias-group-by"], "alias without AS");
    assert.deepEqual(warn("SELECT BUILTIN.DF(t.entity) AS customer, COUNT(*) AS n FROM transaction t GROUP BY BUILTIN.DF(t.entity) ORDER BY customer"), ["order-by-alias-group-by"], "expression alias");
    assert.deepEqual(warn("SELECT x.e FROM (SELECT t.entity AS e, COUNT(*) AS n FROM transaction t GROUP BY t.entity ORDER BY n DESC) x"), ["order-by-alias-group-by"], "subquery");
  });

  it("no false positives", () => {
    assert.deepEqual(warn("SELECT t.entity, COUNT(*) AS n FROM transaction t GROUP BY t.entity ORDER BY COUNT(*) DESC"), [], "full expression");
    assert.deepEqual(warn("SELECT t.entity AS customer, COUNT(*) AS n FROM transaction t GROUP BY t.entity ORDER BY customer"), [], "plain column alias");
    assert.deepEqual(warn("SELECT t.id, t.foreigntotal * 2 AS x FROM transaction t ORDER BY x"), [], "no GROUP BY");
    assert.deepEqual(warn("SELECT COUNT(*) AS n FROM transaction t ORDER BY n"), [], "aggregate without GROUP BY");
    assert.deepEqual(warn("SELECT t.entity, COUNT(*) AS n FROM transaction t GROUP BY t.entity UNION ALL SELECT a.id, COUNT(*) AS n FROM account a GROUP BY a.id ORDER BY n"), [], "compound");
    assert.deepEqual(warn("SELECT t.entity, COUNT(*) AS n, SUM(t.foreigntotal) OVER (ORDER BY n) FROM transaction t GROUP BY t.entity"), [], "window ORDER BY");
    assert.deepEqual(warn("SELECT t.entity, CASE WHEN t.id > 1 THEN 1 ELSE 0 END FROM transaction t GROUP BY t.entity, t.id ORDER BY t.entity"), [], "CASE … END isn't an alias");
  });
});

describe("HARD_RULES", () => {
  it("lists the rules [nolint] can't override", () => {
    assert.deepEqual([...HARD_RULES].sort(), ["html-entity", "multi-statement", "not-select", "offset-ignored", "rownum-greater-than", "rownum-over-subquery", "rownum-with-aggregate"]);
  });
});

describe("html-entity, statement starts, multi-statement", () => {
  const agent =
    "SELECT COUNT(*) AS total, SUM(CASE WHEN ABS(tal.amount - (tl.foreignamount * tal.exchangerate)) &lt;= 0.01 THEN 1 ELSE 0 END) AS matching FROM transactionaccountingline tal JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline";

  it("names the HTML entity instead of blaming CASE", () => {
    const r = lintSuiteQL(agent);
    assert.deepEqual(r.errors.map((e) => e.rule), ["html-entity"]);
    assert.match(r.errors[0].message, /contains &lt; \(HTML-escaped '<'\): write the operator itself/);
    assert.doesNotMatch(r.errors[0].message, /CASE/);
    assert.match(lintSuiteQL("SELECT t.id FROM transaction t WHERE t.foreigntotal &gt; 5 AND t.id &#60; 9").errors[0].message, /&gt; \(HTML-escaped '>'\), &#60; \(HTML-escaped '<'\)/);
    assert.match(lintSuiteQL("SELECT a.id FROM account a WHERE a.id &#x3E;= 1").errors[0].message, /&#x3e;/);
    assert.match(lintSuiteQL("SELECT a.id FROM account a WHERE a.acctname = &quot;x&quot;").errors[0].message, /write the character itself/);
    assert.deepEqual(rules("SELECT a.id, 'R&amp;D &lt; x' AS s FROM account a WHERE a.acctname = 'A &amp; B' -- &lt;\n").errors, [], "entities inside strings and comments are fine");
    assert.deepEqual(rules("SELECT a.id FROM account a WHERE a.acctname LIKE 'R&D%'").errors, []);
    assert.ok(HARD_RULES.has("html-entity"));
  });

  it("only statement starts name the verb", () => {
    const real = agent.replace("&lt;=", "<=");
    assert.ok(!rules(real).errors.includes("not-select"), "SUM(CASE …) with a real <=");
    assert.ok(!rules("SELECT SUM(CASE WHEN t.foreigntotal <= 0.01 THEN 1 ELSE 0 END) AS n FROM transaction t").errors.length);
    assert.match(lintSuiteQL("(DELETE FROM t)").errors[0].message, /this one runs DELETE/);
    assert.match(lintSuiteQL("SELECT id FROM t; (DROP TABLE t)").errors[0].message, /this one runs DROP/);
  });

  it("multi-statement: two SELECTs are rejected, a trailing ; is fine", () => {
    const r = lintSuiteQL("SELECT 1 AS a FROM dual; SELECT 2 AS b FROM dual");
    assert.deepEqual(r.errors.map((e) => e.rule), ["multi-statement"]);
    assert.match(r.errors[0].message, /send one query; the connector runs a single statement/i);
    assert.deepEqual(rules("SELECT 1 AS a FROM dual;").errors, []);
    assert.deepEqual(rules("SELECT 1 AS a FROM dual ;  ;").errors, []);
    assert.deepEqual(rules("SELECT id FROM t; DELETE FROM t").errors, ["not-select"], "a write is still not-select");
  });

  it("the pre hook denies html-entity and multi-statement even with [nolint]", () => {
    for (const sqlQuery of [agent, "SELECT 1 AS a FROM dual; SELECT 2 AS b FROM dual"]) {
      const out = hso(handlePre({ session_id: "s", tool_use_id: "d", tool_name: "mcp__netsuite__ns_runCustomSuiteQL", tool_input: { sqlQuery, description: "[nolint]" } }, tmpCtx()));
      assert.equal(out.permissionDecision, "deny", sqlQuery);
    }
  });
});

describe("string-date-compare with BETWEEN", () => {
  it("TO_DATE operands are fine; plain strings still warn", () => {
    const w = (sql: string) => rules(sql).warnings.filter((x) => x === "string-date-compare");
    assert.deepEqual(w("SELECT COUNT(*) FROM transaction t WHERE t.trandate BETWEEN TO_DATE('2026-09-01','YYYY-MM-DD') AND TO_DATE('2026-09-30','YYYY-MM-DD')"), []);
    assert.deepEqual(w("SELECT COUNT(*) FROM transaction t WHERE t.trandate BETWEEN '2026-09-01' AND '2026-09-30'"), ["string-date-compare"]);
    assert.deepEqual(w("SELECT COUNT(*) FROM transaction t WHERE t.trandate BETWEEN TO_DATE('2026-09-01','YYYY-MM-DD') AND '2026-09-30'"), ["string-date-compare"]);
    assert.deepEqual(w("SELECT COUNT(*) FROM transaction t WHERE (t.trandate BETWEEN TO_DATE('2026-09-01','YYYY-MM-DD') AND TO_DATE('2026-09-30','YYYY-MM-DD')) AND t.memo = '2026-09-01'"), []);
  });
});

describe("indicator sums", () => {
  const w = (sql: string) => rules(sql).warnings.filter((x) => x === "transactionline-sum-unfiltered" || x === "sum-mixed-currency");
  it("SUM of a CASE/DECODE with constant results isn't an amount sum", () => {
    assert.deepEqual(w("SELECT SUM(CASE WHEN ABS(tal.amount - tl.foreignamount * tal.exchangerate) <= 0.01 THEN 1 ELSE 0 END) AS n FROM transactionaccountingline tal JOIN transactionline tl ON tl.transaction = tal.transaction"), []);
    assert.deepEqual(w("SELECT SUM(DECODE(GREATEST(ABS(tl.amount - tl.foreignamount), 0.01), 0.01, 1, 0)) AS n FROM transactionline tl"), []);
    assert.deepEqual(w("SELECT SUM(CASE WHEN tl.foreignamount > 0 THEN 1 WHEN tl.amount < 0 THEN -1 END) AS n FROM transactionline tl"), []);
  });
  it("amount-valued CASE/DECODE still warns", () => {
    assert.deepEqual(w("SELECT SUM(CASE WHEN tl.id > 0 THEN tl.foreignamount ELSE 0 END) AS n FROM transactionline tl"), ["transactionline-sum-unfiltered", "sum-mixed-currency"]);
    assert.deepEqual(w("SELECT SUM(DECODE(tl.id, 1, tl.foreignamount, 0)) AS n FROM transactionline tl"), ["transactionline-sum-unfiltered", "sum-mixed-currency"]);
    assert.deepEqual(w("SELECT SUM(CASE WHEN tl.id > 0 THEN 1 ELSE 0 END * tl.foreignamount) AS n FROM transactionline tl"), ["transactionline-sum-unfiltered", "sum-mixed-currency"]);
    assert.deepEqual(w("SELECT SUM(CASE WHEN tl.id > 0 THEN CASE WHEN tl.id > 1 THEN tl.foreignamount ELSE 1 END ELSE 0 END) AS n FROM transactionline tl"), ["transactionline-sum-unfiltered", "sum-mixed-currency"]);
  });
});

describe("entity scanner", () => {
  it("honours doubled quotes in quoted identifiers", () => {
    assert.deepEqual(lintSuiteQL('SELECT t.id AS "a""&lt;b" FROM transaction t').errors.filter((e) => e.rule === "html-entity"), []);
    assert.deepEqual(lintSuiteQL('SELECT t.id AS "a""b" FROM transaction t WHERE t.id &lt; 5').errors.map((e) => e.rule), ["html-entity"]);
  });
});

describe("SuiteQL checker rules and fixers", () => {
  const Q = "mcp__netsuite__ns_runCustomSuiteQL";
  const pre = (tool_input: Record<string, unknown>, ctx = tmpCtx()) => hso(handlePre({ session_id: "rs", tool_use_id: `u${Math.random()}`, tool_name: Q, tool_input }, ctx));
  const withProfile = (profile: Record<string, unknown>) => {
    const ctx = tmpCtx();
    fs.mkdirSync(ctx.acctDir!, { recursive: true });
    fs.writeFileSync(path.join(ctx.acctDir!, "profile.json"), JSON.stringify({ builtAt: "", ...profile }));
    return ctx;
  };
  const noWorkflows = { CustInvc: false, VendBill: false, PurchOrd: false, Journal: false, ExpRept: false, SalesOrd: false, VendPymt: false, CustCred: false };
  const fetchCount = (sql: string) => tokenize(sql).filter((t) => t.type === "word" && t.value === "fetch").length;

  it("approvalstatus-no-workflow fires only on a value comparison in WHERE/HAVING of a selected type", () => {
    const ctx = { approvalWorkflows: noWorkflows };
    const e = (sql: string) => rules(sql, ctx).errors.filter((x) => x === "approvalstatus-no-workflow");
    assert.deepEqual(e("SELECT t.id, t.approvalstatus FROM transaction t WHERE t.type='CustInvc'"), [], "selected only");
    assert.deepEqual(e("SELECT t.id FROM transaction t WHERE t.type='CustInvc' AND t.approvalstatus IS NULL"), [], "IS NULL");
    assert.deepEqual(e("SELECT t.id FROM transaction t WHERE t.type='CustInvc' AND t.approvalstatus IS NOT NULL"), [], "IS NOT NULL");
    assert.deepEqual(e("SELECT t.id FROM transaction t WHERE t.type <> 'CustInvc' AND t.approvalstatus = 2"), [], "<> excludes the type");
    assert.deepEqual(e("SELECT t.id FROM transaction t WHERE t.type NOT IN ('CustInvc') AND t.approvalstatus = 2"), [], "NOT IN excludes the type");
    assert.deepEqual(e("SELECT t.id FROM transaction t WHERE t.type='CustInvc' AND t.approvalstatus = 2"), ["approvalstatus-no-workflow"]);
    assert.deepEqual(e("SELECT t.id FROM transaction t WHERE t.type IN ('CustInvc') AND t.approvalstatus IN (1, 2)"), ["approvalstatus-no-workflow"]);
    assert.deepEqual(e("SELECT t.id FROM transaction t WHERE t.type='CustInvc' AND (2 = t.approvalstatus)"), ["approvalstatus-no-workflow"]);
    // The canonical probe: lints clean, and the pre hook lets it through even with every workflow off.
    const probe = PROBES.find((p) => p.tag === "profile:approval_workflows")!;
    assert.deepEqual(e(probe.sql), []);
    const out = pre({ sqlQuery: probe.sql, description: probe.description }, withProfile({ approvalWorkflows: noWorkflows }));
    assert.notEqual(out.permissionDecision, "deny");
    // An ordinary query with a real approvalstatus filter is still denied through the hook.
    const deny = pre({ sqlQuery: "SELECT t.id FROM transaction t WHERE t.type='CustInvc' AND t.approvalstatus = 2" }, withProfile({ approvalWorkflows: noWorkflows }));
    assert.equal(deny.permissionDecision, "deny");
  });

  it("[nolint] can't override always-wrong ROWNUM, lists what it overrode, and [nolint:rule] overrides one rule", () => {
    const agg = pre({ sqlQuery: "SELECT t.type, COUNT(*) FROM transaction t WHERE t.type='CustInvc' AND ROWNUM <= 1000 GROUP BY t.type", description: "[nolint]" });
    assert.equal(agg.permissionDecision, "deny");
    assert.match(String(agg.permissionDecisionReason), /rownum-with-aggregate[\s\S]*\[nolint\] doesn't apply/);
    assert.match(String(agg.permissionDecisionReason), /FETCH FIRST 1000 ROWS ONLY/, "the fix is still offered");
    const gt = pre({ sqlQuery: "SELECT t.id FROM transaction t WHERE ROWNUM > 10", description: "[nolint]" });
    assert.equal(gt.permissionDecision, "deny");
    const sub = pre({ sqlQuery: "SELECT * FROM (SELECT t.type, COUNT(*) n FROM transaction t GROUP BY t.type ORDER BY n DESC) WHERE ROWNUM <= 5", description: "[nolint]" });
    assert.equal(sub.permissionDecision, "deny");
    // An overridable error runs under [nolint], and the override is listed in the context.
    const star = pre({ sqlQuery: "SELECT * FROM transaction", description: "[nolint]" });
    assert.notEqual(star.permissionDecision, "deny");
    assert.match(String(star.additionalContext), /\[nolint\] overrode these SuiteQL errors[\s\S]*\[select-star\]/);
    // Per rule: only the named rule is overridden.
    assert.notEqual(pre({ sqlQuery: "SELECT * FROM transaction", description: "probe [nolint:select-star]" }).permissionDecision, "deny");
    const other = pre({ sqlQuery: "SELECT * FROM transaction", description: "[nolint:type-literal]" });
    assert.equal(other.permissionDecision, "deny");
    assert.match(String(other.permissionDecisionReason), /\[nolint:<rule>\]/);
    assert.deepEqual(nolintOf("x [nolint: a-b, c-d] [nolint:e]"), { all: false, rules: new Set(["a-b", "c-d", "e"]) });
    assert.deepEqual(nolintOf("[NOLINT]").all, true);
  });

  it("SUM(tal.amount) across subsidiaries with different currencies warns; sum-mixed-currency points at per-subsidiary sums", () => {
    const multi = { multiCurrencySubsidiaries: true };
    const w = (sql: string, ctx: object = multi) => rules(sql, ctx).warnings.filter((x) => x === "sum-across-subsidiaries");
    const q = "SELECT a.acctnumber, SUM(tal.amount) FROM transactionaccountingline tal JOIN account a ON a.id=tal.account WHERE tal.posting='T' GROUP BY a.acctnumber";
    assert.deepEqual(w(q), ["sum-across-subsidiaries"]);
    assert.deepEqual(w(q, {}), [], "no profile info: no warning");
    assert.deepEqual(w("SELECT SUM(tal.debit) FROM transactionaccountingline tal WHERE tal.posting='T'"), ["sum-across-subsidiaries"]);
    const bySub = "SELECT tl.subsidiary, SUM(tal.amount) FROM transactionaccountingline tal JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline WHERE tal.posting='T' GROUP BY tl.subsidiary";
    assert.deepEqual(w(bySub), []);
    assert.deepEqual(w("SELECT SUM(tal.amount) FROM transactionaccountingline tal JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline WHERE tl.subsidiary = 1"), []);
    assert.deepEqual(w("SELECT SUM(tal.amount) FROM transactionaccountingline tal JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline WHERE tl.subsidiary = 1 OR tl.subsidiary = 2"), ["sum-across-subsidiaries"]);
    const probe = PROBES.find((p) => p.tag === "profile:ttm_revenue")!;
    assert.deepEqual(w(probe.sql), [], "the TTM probe groups by subsidiary");
    const mixed = lintSuiteQL("SELECT SUM(t.foreigntotal) FROM transaction t").warnings.find((x) => x.rule === "sum-mixed-currency")!;
    assert.match(mixed.message, /per subsidiary \(group or filter by tl\.subsidiary/);
    assert.match(mixed.message, /BUILTIN\.CONSOLIDATE/);
    // The pre hook sets the flag from the profile's subsidiary currencies.
    const out = pre({ sqlQuery: q }, withProfile({ subsidiaryCurrencies: { 1: "EUR", 2: "USD" } }));
    assert.match(String(out.additionalContext), /adds each subsidiary's base-currency amounts together/);
    const one = pre({ sqlQuery: q }, withProfile({ subsidiaryCurrencies: { 1: "EUR", 2: "EUR" } }));
    assert.doesNotMatch(String(one.additionalContext ?? ""), /adds each subsidiary's base-currency amounts/);
  });

  it("fixRownum never puts FETCH FIRST inside a trailing -- comment", () => {
    const f = fixRownum("select t.id from transaction t where rownum <= 5 order by t.id -- x");
    assert.equal(f, "select t.id from transaction t order by t.id -- x\nFETCH FIRST 5 ROWS ONLY");
    assert.equal(fetchCount(f), 1);
    const g = fixRownum("select t.type, count(*) from transaction t where rownum <= 5 group by t.type -- top");
    assert.equal(fetchCount(g), 1);
    assert.match(g, /-- top\nFETCH FIRST 5 ROWS ONLY$/);
    const r = lintSuiteQL("select t.id from transaction t where rownum <= 5 order by t.id -- x");
    assert.equal(fetchCount(r.fixed!), 1, "the suggested fix really caps the rows");
    // The unwrap path, with a comment at the end of the inner query.
    const u = fixRownum("SELECT * FROM (SELECT t.id FROM transaction t ORDER BY t.id -- inner\n) x WHERE ROWNUM <= 3");
    assert.equal(fetchCount(u), 1);
  });

  it("nsx sql fix-rownum / lint: honest fallback, no fake fix, unquoted and bare queries", async () => {
    tmpCtx();
    const nsx = async (...argv: string[]) => String((await import("../src/cli.ts")).main(argv));
    const none = await nsx("sql", "fix-rownum", "SELECT t.type, COUNT(*) FROM transaction t WHERE ROWNUM <= 5 OR t.id > 1 GROUP BY t.type");
    assert.match(none, /No safe automatic rewrite\. Remove the ROWNUM condition and end the query with ORDER BY … FETCH FIRST N ROWS ONLY/);
    assert.doesNotMatch(none, /apply ROWNUM <= N outside/);
    process.exitCode = 0;
    const nothing = await nsx("sql", "fix-rownum", "SELECT t.id FROM transaction t ORDER BY t.id;");
    assert.match(nothing, /nothing to rewrite/);
    assert.equal(fixRownum("SELECT t.id FROM transaction t ORDER BY t.id;"), "SELECT t.id FROM transaction t ORDER BY t.id;", "no rewrite returns the input unchanged");
    // Unquoted: every word is part of the query.
    assert.match(await nsx("sql", "lint", "SELECT", "*", "FROM", "transaction"), /select-star/);
    assert.match(await nsx("sql", "SELECT", "*", "FROM", "transaction"), /select-star/);
    // A bare word is not a query.
    assert.match(await nsx("sql", "lint", "select"), /incomplete-query/);
    assert.deepEqual(rules("SELECT FROM transaction").errors, ["incomplete-query"]);
    process.exitCode = 0;
  });

  it("OFFSET / LIMIT are checked when the query starts with (", () => {
    assert.deepEqual(rules("(SELECT t.id FROM transaction t) UNION ALL (SELECT t.id FROM transaction t) ORDER BY 1 OFFSET 10 ROWS FETCH NEXT 10 ROWS ONLY").errors, ["offset-ignored"]);
    const lim = rules("(SELECT t.id FROM transaction t) ORDER BY 1 LIMIT 10");
    assert.deepEqual(lim.errors, ["limit-clause"]);
    assert.equal(lim.fixed, "(SELECT t.id FROM transaction t) ORDER BY 1 FETCH FIRST 10 ROWS ONLY");
    assert.deepEqual(rules("(SELECT t.id FROM transaction t ORDER BY t.id) OFFSET 20 ROWS FETCH NEXT 10 ROWS ONLY").errors, ["offset-ignored"]);
    assert.deepEqual(rules("(SELECT t.id FROM transaction t ORDER BY t.id) FETCH FIRST 10 ROWS ONLY").errors, []);
    // A parenthesized compound inside FROM is a query block too.
    assert.deepEqual(rules("SELECT x.id FROM ((SELECT t.id FROM transaction t) UNION ALL (SELECT t.id FROM transaction t) ORDER BY 1 LIMIT 5) x").errors, ["limit-clause"]);
  });

  it("one currency only for an AND-only WHERE picking one value", () => {
    const w = (sql: string) => rules(sql).warnings.filter((x) => x === "sum-mixed-currency");
    assert.deepEqual(w("SELECT SUM(t.foreigntotal) FROM transaction t WHERE t.currency = 1 OR t.currency = 2"), ["sum-mixed-currency"]);
    assert.deepEqual(w("SELECT SUM(t.foreigntotal) FROM transaction t WHERE (t.currency = 1 OR t.currency = 2) AND t.id > 0"), ["sum-mixed-currency"]);
    assert.deepEqual(w("SELECT SUM(t.foreigntotal) FROM transaction t WHERE t.currency IN (1, 2)"), ["sum-mixed-currency"]);
    assert.deepEqual(w("SELECT SUM(t.foreigntotal) FROM transaction t WHERE BUILTIN.DF(t.currency) = 'EUR'"), []);
    assert.deepEqual(w("SELECT SUM(t.foreigntotal) FROM transaction t WHERE t.currency IN (1)"), []);
    assert.deepEqual(w("SELECT SUM(t.foreigntotal) FROM transaction t WHERE t.currency = 1 AND t.id > 0"), []);
    assert.deepEqual(w("SELECT t.currency, SUM(t.foreigntotal) FROM transaction t GROUP BY t.currency"), []);
    assert.deepEqual(w("SELECT SUM(t.foreigntotal) FROM transaction t, currency c WHERE t.currency = c.id"), ["sum-mixed-currency"], "a join condition isn't a filter");
  });

  it("left-join-aggregate only for aggregates over the left table; left-side filters in ON get their own warning", () => {
    const w = (sql: string) => rules(sql).warnings.filter((x) => x.startsWith("left-join"));
    assert.deepEqual(w("SELECT a.id, SUM(tal.amount) FROM account a LEFT JOIN transactionaccountingline tal ON tal.account=a.id AND tal.posting='T' GROUP BY a.id"), []);
    assert.deepEqual(w("SELECT a.id, SUM(t.foreigntotal) FROM transaction t LEFT JOIN transactionline tl ON tl.transaction = t.id AND tl.posting = 'T' GROUP BY a.id"), ["left-join-aggregate"]);
    const on = lintSuiteQL("SELECT t.id, tl.id FROM transaction t LEFT JOIN transactionline tl ON tl.transaction = t.id AND t.trandate >= TO_DATE('2026-01-01','YYYY-MM-DD')");
    assert.deepEqual(on.warnings.map((x) => x.rule), ["left-join-on-filter"]);
    assert.match(on.warnings[0].message, /t\.trandate is filtered inside LEFT JOIN … ON[\s\S]*Move the condition to WHERE/);
  });

  it("fixRownum unwraps every pass-through level down to the sorted query", () => {
    const f = fixRownum("SELECT * FROM (SELECT * FROM (SELECT t.id FROM transaction t ORDER BY t.id)) WHERE ROWNUM <= 10");
    assert.equal(f, "SELECT t.id FROM transaction t ORDER BY t.id\nFETCH FIRST 10 ROWS ONLY");
    assert.equal(fixRownum("SELECT * FROM (SELECT * FROM (SELECT t.id FROM transaction t ORDER BY t.id) x) y WHERE ROWNUM <= 10"), "SELECT t.id FROM transaction t ORDER BY t.id\nFETCH FIRST 10 ROWS ONLY");
    // A wrapper that filters isn't pass-through: no fix.
    const q = "SELECT * FROM (SELECT * FROM (SELECT t.id FROM transaction t ORDER BY t.id) x WHERE x.id > 5) WHERE ROWNUM <= 10";
    assert.equal(fixRownum(q), q);
  });

  it("status-without-cf only for transaction status", () => {
    const w = (sql: string) => rules(sql).warnings.filter((x) => x === "status-without-cf");
    assert.deepEqual(w("SELECT j.id FROM job j WHERE j.status = '2'"), []);
    assert.deepEqual(w("SELECT c.id FROM customer c WHERE c.status = '13'"), []);
    assert.deepEqual(w("SELECT t.id FROM transaction t WHERE t.status = 'B'"), ["status-without-cf"]);
    assert.deepEqual(w("SELECT id FROM transaction WHERE status = 'B'"), ["status-without-cf"]);
  });

  it("null/empty pageIndex counts as absent; non-numeric paging is rejected", () => {
    const upd = (ti: Record<string, unknown>) => pre({ sqlQuery: "SELECT t.id FROM transaction t ORDER BY t.id", ...ti }).updatedInput as Record<string, unknown>;
    assert.equal(upd({ pageSize: 50, pageIndex: null }).pageIndex, 0);
    assert.equal(upd({ pageSize: 50, pageIndex: "" }).pageIndex, 0);
    assert.equal(upd({ pageSize: null }).pageIndex, 0);
    for (const bad of [{ pageIndex: "abc" }, { pageSize: "abc" }, { pageIndex: -1 }, { pageIndex: 1.5 }, { pageSize: {} }]) {
      const out = pre({ sqlQuery: "SELECT t.id FROM transaction t ORDER BY t.id", ...bad });
      assert.equal(out.permissionDecision, "deny", JSON.stringify(bad));
      assert.match(String(out.permissionDecisionReason), /must be a whole number/);
    }
    assert.equal(pre({ sqlQuery: "SELECT t.id FROM transaction t ORDER BY t.id", pageSize: "50", pageIndex: "1" }).permissionDecision, undefined, "numeric strings are fine");
  });

  it("OFFSET as a column alias is not an OFFSET clause", () => {
    assert.deepEqual(rules("SELECT a.acctnumber offset FROM account a").errors, []);
    assert.deepEqual(rules("SELECT a.acctnumber AS offset FROM account a").errors, []);
    assert.deepEqual(rules("SELECT t.id FROM transaction t ORDER BY t.id OFFSET 5 ROWS FETCH NEXT 5 ROWS ONLY").errors, ["offset-ignored"]);
  });

  it("[nolint] inside sqlQuery says to move it to the description", () => {
    const r = lintSuiteQL("SELECT a.id FROM account a [nolint]");
    assert.match(r.errors.find((e) => e.rule === "bracket-identifier")!.message, /\[nolint\] goes in the tool call's description, not in sqlQuery/);
  });

  it("fixLimit doesn't add a second FETCH", () => {
    const q = "SELECT t.id FROM transaction t ORDER BY t.id FETCH FIRST 10 ROWS ONLY LIMIT 5";
    assert.equal(fixLimit(q), q);
    assert.equal(lintSuiteQL(q).fixed, undefined);
  });

  it("ROWNUM in HAVING with an OR is not rewritten", () => {
    const q = "SELECT t.type, COUNT(*) FROM transaction t GROUP BY t.type HAVING COUNT(*) > 1 OR COUNT(*) < 0 AND ROWNUM <= 5";
    assert.equal(fixRownum(q), q);
    assert.equal(lintSuiteQL(q).fixed, undefined);
    assert.equal(fixRownum("SELECT t.type, COUNT(*) FROM transaction t GROUP BY t.type HAVING COUNT(*) > 1 AND ROWNUM <= 5"), "SELECT t.type, COUNT(*) FROM transaction t GROUP BY t.type HAVING COUNT(*) > 1 FETCH FIRST 5 ROWS ONLY");
  });

  it("ROWNUM in JOIN … ON is seen (and not rewritten)", () => {
    const q = "SELECT t.id FROM transaction t JOIN transactionline tl ON tl.transaction = t.id AND ROWNUM <= 5 ORDER BY t.id";
    const r = rules(q);
    assert.deepEqual(r.errors, ["rownum-with-order-by"]);
    assert.equal(r.fixed, undefined);
    assert.deepEqual(rules("SELECT t.type, COUNT(*) FROM transaction t JOIN transactionline tl ON (tl.transaction = t.id AND ROWNUM <= 5) GROUP BY t.type").errors, ["rownum-with-aggregate"]);
  });

  it("a non-string sqlQuery says it must be a string", () => {
    const out = pre({ sqlQuery: 42 });
    assert.equal(out.permissionDecision, "deny");
    assert.match(String(out.permissionDecisionReason), /`sqlQuery` must be a string \(got a number\)/);
    assert.match(String(pre({ sqlQuery: "  " }).permissionDecisionReason), /`sqlQuery` is empty/);
  });

  it("a double-quoted string compared to a column warns", () => {
    const w = (sql: string) => rules(sql).warnings.filter((x) => x === "double-quoted-string");
    assert.deepEqual(w('SELECT t.id FROM transaction t WHERE t.memo = "abc"'), ["double-quoted-string"]);
    assert.match(lintSuiteQL('SELECT t.id FROM transaction t WHERE t.memo = "abc"').warnings[0].message, /use single quotes: 'abc'/);
    assert.deepEqual(w('SELECT "t".id FROM transaction "t" WHERE "t".id = "t".id'), []);
    assert.deepEqual(w('SELECT t.id AS "Id" FROM transaction t'), []);
  });

  it("ROWNUM <> 1 / != 1 is rownum-greater-than (no rows)", () => {
    assert.deepEqual(rules("SELECT t.id FROM transaction t WHERE ROWNUM != 1").errors, ["rownum-greater-than"]);
    assert.deepEqual(rules("SELECT t.id FROM transaction t WHERE ROWNUM <> 1").errors, ["rownum-greater-than"]);
    assert.deepEqual(rules("SELECT t.id FROM transaction t WHERE 1 <> ROWNUM").errors, ["rownum-greater-than"]);
    assert.deepEqual(rules("SELECT t.id FROM transaction t WHERE ROWNUM <> 5").errors, [], "<> 5 returns 4 rows");
  });

  it("string-date-compare covers TRUNC(date) = '…' and date IN ('…')", () => {
    const w = (sql: string) => rules(sql).warnings.filter((x) => x === "string-date-compare");
    assert.deepEqual(w("SELECT t.id FROM transaction t WHERE TRUNC(t.trandate) = '2026-01-01'"), ["string-date-compare"]);
    assert.deepEqual(w("SELECT t.id FROM transaction t WHERE t.trandate IN ('2026-01-01', '2026-01-02')"), ["string-date-compare"]);
    assert.deepEqual(w("SELECT t.id FROM transaction t WHERE t.trandate NOT IN ('2026-01-01')"), ["string-date-compare"]);
    assert.deepEqual(w("SELECT t.id FROM transaction t WHERE TRUNC(t.trandate) = TO_DATE('2026-01-01','YYYY-MM-DD')"), []);
  });

  it("unknown type codes / record types don't claim to be wrong", () => {
    const t = lintSuiteQL("SELECT t.id FROM transaction t WHERE t.type = 'Build'").warnings.find((w) => w.rule === "type-literal-unknown")!;
    assert.match(t.message, /isn't in the harness's list of type codes[\s\S]*If the query returns nothing, check the code/);
    assert.doesNotMatch(t.message, /is not a known/);
    const r = lintSuiteQL("SELECT t.id FROM transaction t WHERE t.recordtype = 'somerecord'", { recordTypes: new Set(["transaction"]) }).warnings.find((w) => w.rule === "recordtype-unknown")!;
    assert.match(r.message, /may still be right[\s\S]*If the query returns nothing/);
  });

  it("FETCH FIRST N (N ≤ 1000) sets pageSize to N, not the default", () => {
    assert.equal(topFetchRows("SELECT t.id FROM transaction t ORDER BY t.id FETCH FIRST 1000 ROWS ONLY"), 1000);
    assert.equal(topFetchRows("SELECT x.id FROM (SELECT t.id FROM transaction t FETCH FIRST 3 ROWS ONLY) x"), undefined);
    const size = (sqlQuery: string, extra: Record<string, unknown> = {}) => (pre({ sqlQuery, ...extra }).updatedInput as Record<string, unknown>).pageSize;
    assert.equal(size("SELECT t.id FROM transaction t ORDER BY t.id FETCH FIRST 1000 ROWS ONLY"), 1000);
    assert.equal(size("SELECT t.id FROM transaction t ORDER BY t.id FETCH FIRST 20 ROWS ONLY"), 20);
    assert.equal(size("SELECT t.id FROM transaction t ORDER BY t.id FETCH FIRST 2 ROWS ONLY"), 5);
    assert.equal(size("SELECT t.id FROM transaction t ORDER BY t.id FETCH FIRST 5000 ROWS ONLY"), tmpCtx().cfg.suiteql_default_page_size);
    assert.equal(size("SELECT t.id FROM transaction t ORDER BY t.id FETCH FIRST 1000 ROWS ONLY", { pageSize: 100 }), 100, "a given pageSize is kept");
  });
});
