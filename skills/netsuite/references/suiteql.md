<!-- Derived in part from Oracle NetSuite "netsuite-ai-connector-instructions" (UPL 1.0); corrected by Suite Utils. -->

# SuiteQL patterns

Lint any draft first: `nsx sql lint "<sql>"`. Items marked *(verify)* have not yet been
confirmed against the connector's SuiteQL endpoint.

## Row limits: FETCH FIRST, never ROWNUM

```sql
-- WRONG: caps 1000 input rows, then groups them → silently wrong totals
SELECT entity, SUM(foreigntotal) FROM transaction WHERE ROWNUM <= 1000 GROUP BY entity

-- WRONG too: NetSuite applies the outer ROWNUM before the inner GROUP BY → partial sums, unsorted
SELECT * FROM (
  SELECT BUILTIN.DF(t.entity) AS customer, SUM(t.foreigntotal) AS total
  FROM transaction t WHERE t.type = 'CustInvc'
  GROUP BY BUILTIN.DF(t.entity) ORDER BY SUM(t.foreigntotal) DESC
) WHERE ROWNUM <= 20

-- RIGHT: aggregate and sort, then FETCH FIRST at the end
SELECT BUILTIN.DF(t.entity) AS customer, BUILTIN.DF(t.currency) AS currency, SUM(t.foreigntotal) AS total
FROM transaction t
WHERE t.type = 'CustInvc' AND t.trandate >= TO_DATE('2026-01-01','YYYY-MM-DD')
GROUP BY BUILTIN.DF(t.entity), BUILTIN.DF(t.currency)
ORDER BY SUM(t.foreigntotal) DESC
FETCH FIRST 20 ROWS ONLY
```

Verified on a live account (2026-09-27): the outer-`ROWNUM` form returned the same customer three
times with partial totals, in no order; `FETCH FIRST` and `pageSize` + `pageIndex: 0` returned the
right rows. The plugin's fake-connector tests can't catch this; only a live query can.
`nsx sql fix-rownum -` rewrites a `ROWNUM` cap to `FETCH FIRST` where that's safe; otherwise it says
"No safe automatic rewrite": remove the `ROWNUM` condition and end the query with `ORDER BY … FETCH
FIRST N ROWS ONLY` yourself. `FETCH FIRST` is live-verified
but not in Oracle's SuiteQL docs. `LIMIT` isn't SuiteQL. `TOP n … ORDER BY` returns the right top n
(live-verified 2026-09-27) and is in Oracle's syntax docs, but Oracle warns it can hurt performance
because the query runs on a virtual schema; prefer `ORDER BY … FETCH FIRST n ROWS ONLY` and a tight
`WHERE`. `ROWNUM > n` or `ROWNUM = n` (n > 1) never matches a row; page instead.

## GROUP BY with ORDER BY: order by the expression, not its alias

Live (2026-09-27): `… GROUP BY tl.subsidiary, BUILTIN.DF(tl.subsidiary), BUILTIN.DF(t.currency)
ORDER BY tl.subsidiary, n DESC`, where `n` is `COUNT(*)`, failed with "Invalid or unsupported
search"; the same query without `ORDER BY` ran. In a `GROUP BY` query, repeat the full expression:
`ORDER BY tl.subsidiary, COUNT(*) DESC`. The guard warns (`order-by-alias-group-by`) when `ORDER BY`
names the alias of an aggregate or expression.

## Paging

**Never use `OFFSET`.** NetSuite silently ignores it: `ORDER BY t.id OFFSET 3 ROWS FETCH NEXT 3 ROWS ONLY`
returned the first 3 rows, with or without `pageSize`/`pageIndex` (live-verified 2026-09-27). The
guard blocks `OFFSET n` for any n > 0, even with `[nolint]`. (`[nolint]` does let through a table missing from the cached record-type list, in case the list is out of date.)

`[nolint]` in the description overrides every overridable error; `[nolint:<rule>]` (e.g.
`[nolint:select-star]`, several rules comma-separated) only those. The overridden errors come back
in the context: check the result against them. Never overridable: `OFFSET`, a non-SELECT, HTML
entities, a second statement, and the always-wrong `ROWNUM` forms (`ROWNUM` with `GROUP BY` or
aggregates, over a sorted or aggregated subquery, or `ROWNUM > n`).

- The guard adds `pageSize` + `pageIndex: 0`; get more with `pageIndex: 1, 2, …` (same `sqlQuery`
  and `pageSize`). Oracle's tool description documents only `sqlQuery`, `description` and
  `pageSize`; `pageIndex`, and "`pageSize` without `pageIndex` returns every page", are
  live-verified, undocumented behaviour.
- Paging needs a **unique** sort: end the query with `ORDER BY t.id` (or another unique key), or
  pages can overlap or skip rows (Oracle: paged queries "must provide a unique and unambiguous
  sorting order").
- The minimum `pageSize` is 5: `pageSize: 3` returned 5 rows, and `numberOfPages` was computed
  with 5 (live-verified 2026-09-27).
- A paged query returns at most 100,000 rows in total. For large pulls, batch by id range
  (`WHERE t.id > <last id> … ORDER BY t.id`) instead of paging through a whole table.

## Transaction type values

| Transaction | `type` (code) | `recordtype` (record id) |
|---|---|---|
| Invoice | CustInvc | invoice |
| Credit Memo | CustCred | creditmemo |
| Customer Payment | CustPymt | customerpayment |
| Sales Order | SalesOrd | salesorder |
| Cash Sale | CashSale | cashsale |
| Estimate / Quote | Estimate | estimate |
| Purchase Order | PurchOrd | purchaseorder |
| Vendor Bill | VendBill | vendorbill |
| Vendor Credit | VendCred | vendorcredit |
| Bill Payment | VendPymt | vendorpayment |
| Journal Entry | Journal | journalentry |
| Deposit | Deposit | deposit |
| Transfer | Transfer | transfer |
| Expense Report | ExpRept | expensereport |
| Item Receipt | ItemRcpt | itemreceipt |
| Item Fulfillment | ItemShip | itemfulfillment |
| Inventory Adjustment | InvAdjst | inventoryadjustment |
| Transfer Order | TrnfrOrd | transferorder |
| Work Order | WorkOrd | workorder |
| Return Authorization | RtnAuth | returnauthorization |

*(verify on the account: `SELECT DISTINCT type, recordtype FROM transaction FETCH FIRST 100 ROWS ONLY`.)*

## Which amount?

| Need | Use |
|---|---|
| GL / financial-statement amounts | `transactionaccountingline.amount` (base currency, debit − credit), `posting = 'T'`, join `account` |
| Header total in transaction currency | `transaction.foreigntotal` |
| Line amounts in transaction currency | `transactionline.foreignamount` / `netamount` with `NVL(tl.mainline,'F') = 'F' AND NVL(tl.taxline,'F') = 'F'` |
| Open balance (AR/AP) | `transaction.foreignamountunpaid` *(verify: `transaction` has no field metadata)*, transaction currency; the mainline's `transactionline.foreignamountunpaid` and `transactionaccountingline.amountunpaid` (base currency) are in the live field metadata |
| Not this | `transactionline.amount`: SuiteQL accepts it, but its currency is undocumented. Don't sum it; use `tl.foreignamount` (transaction currency) or `tal.amount` (base currency, per subsidiary) |

`transaction` and `transactionline` amounts are in the transaction's currency;
`transactionaccountingline` amounts are in the subsidiary's base currency
([Oracle](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1548805090.html)).
`SUM(foreigntotal)` or `SUM(foreignamount)` without `currency` in the `GROUP BY` adds currencies
together.

Multi-book accounts: add `AND tal.accountingbook = <primary book id>` unless the user asks for another
book. The connector's book list has no primary flag: use the id of `Primary Accounting Book` in
`nsx cache show books` (on the live account tested: id 1, and without the filter only book-1 rows
came back). The GL templates below include the filter.

Exchange rates (live-verified 2026-09-27): `transactionaccountingline.exchangerate` is per GL line,
and `tal.amount = tl.foreignamount × tal.exchangerate` held for 18,913 of 18,919 invoice GL lines.
`transaction.exchangerate` is queryable too, although the connector's `transaction` metadata is
empty.

### Base currency per subsidiary

When the role can't query `subsidiary`, a subsidiary's base currency is the currency of its
transactions at exchange rate 1 (the init profile probe does this). Live, the dominant currency per
subsidiary covered at least 99.8% of rows:

```sql
SELECT tl.subsidiary AS sub, BUILTIN.DF(t.currency) AS currency, COUNT(*) AS n
FROM transaction t
JOIN transactionline tl ON tl.transaction = t.id
WHERE tl.mainline = 'T' AND t.exchangerate = 1 AND t.trandate >= ADD_MONTHS(SYSDATE, -1)
GROUP BY tl.subsidiary, BUILTIN.DF(t.currency)
```

The parent is the subsidiary named in the id `-1` entry of `ns_getSubsidiaries`
(`<parent name> (Consolidated)`); its currency is the group's reporting currency.

## Currency and consolidation functions

- `BUILTIN.CURRENCY_CONVERT(amount [, target currency id [, rate date]])` converts a
  transaction-currency amount. Target defaults to the subsidiary's currency; the rate date
  defaults to **today**, so pass one for historical figures:
  `BUILTIN.CURRENCY_CONVERT(tl.foreignamount, 1, TO_DATE('2026-01-31','YYYY-MM-DD'))`.
- `BUILTIN.CURRENCY(amount)` returns the currency code of an amount (also of a `SUM(…)`,
  `BUILTIN.CONSOLIDATE(…)` or `BUILTIN.CURRENCY_CONVERT(…)`).
- `BUILTIN.CONSOLIDATE(amount, view, consolidation rate type, subsidiary rate type, target
  subsidiary id, period id, book)`, all seven required: view `'LEDGER'` or `'INCOME'`;
  consolidation rate type `'DEFAULT'`, `'STANDARD'` or `'BUDGET'`; subsidiary rate type
  `'DEFAULT'`, `'CURRENT'`, `'HISTORICAL'`, `'AVERAGE'` or an expression; book `'DEFAULT'` or an
  expression. Example: `BUILTIN.CONSOLIDATE(tal.amount, 'LEDGER', 'DEFAULT', 'DEFAULT', 1, <period id>, 'DEFAULT')`.
  Verify on the account before relying on it.
- Consolidated or financial statements (income statement, balance sheet, cash flow): use the
  standard report, not SuiteQL. Oracle: "Don't use SuiteQL or build new reports for financial
  reports. NetSuite standard reports use important business rules that SuiteQL can't apply."
  For a group figure (e.g. TTM revenue), run the Income Statement with `subsidiaryId: -1`
  (consolidated, in the parent's currency). A SuiteQL `SUM(tal.amount)` across subsidiaries adds
  each subsidiary's base currency together.

## Status

`transaction.status` holds only the status letter (`'B'`). Filter with `BUILTIN.CF`, which returns
type and letter:

```sql
SELECT t.tranid, BUILTIN.DF(t.status) AS status
FROM transaction t
WHERE t.type = 'CustInvc' AND BUILTIN.CF(t.status) = 'CustInvc:A'
ORDER BY t.id
FETCH FIRST 100 ROWS ONLY
```

## GL detail by subsidiary, account and period

```sql
SELECT tl.subsidiary AS subsidiary_id, BUILTIN.DF(tl.subsidiary) AS subsidiary,
       a.acctnumber, BUILTIN.DF(tal.account) AS account, BUILTIN.DF(t.postingperiod) AS period,
       SUM(tal.amount) AS amount
FROM transactionaccountingline tal
JOIN transaction t      ON t.id = tal.transaction
JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline
JOIN account a          ON a.id = tal.account
WHERE tal.posting = 'T'
  AND tal.accountingbook = <primary book id>
  AND t.postingperiod IN (<period ids from nsx periods>)
GROUP BY tl.subsidiary, BUILTIN.DF(tl.subsidiary), a.acctnumber, BUILTIN.DF(tal.account), BUILTIN.DF(t.postingperiod)
ORDER BY tl.subsidiary, a.acctnumber
FETCH FIRST 5000 ROWS ONLY
```

`tal.amount` is in each subsidiary's own base currency, so every row is one subsidiary's figure in
that subsidiary's currency; never add rows of different subsidiaries together. Group totals come
from the consolidated report (`subsidiaryId: -1`), not from summing this. For one subsidiary, add
`AND tl.subsidiary = <id>`. Amounts are debit − credit: income accounts show negative.

## Multi-subsidiary totals (corrected Oracle template)

```sql
SELECT tl.subsidiary AS subsidiary_id, BUILTIN.DF(tl.subsidiary) AS subsidiary,
       SUM(tal.amount)           AS base_amount
FROM transactionaccountingline tal
JOIN transaction t     ON t.id = tal.transaction
JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline
JOIN account a         ON a.id = tal.account
WHERE t.type = 'CustInvc'
  AND tal.posting = 'T'
  AND tal.accountingbook = <primary book id>
  AND UPPER(a.accttype) = 'INCOME'
  AND t.trandate >= TO_DATE('2026-01-01','YYYY-MM-DD')
  AND t.trandate <  TO_DATE('2026-04-01','YYYY-MM-DD')
GROUP BY tl.subsidiary, BUILTIN.DF(tl.subsidiary)
ORDER BY SUM(tal.amount)
FETCH FIRST 1000 ROWS ONLY
```

Invoices only (`t.type = 'CustInvc'`), income accounts only. `base_amount` is debit − credit, so
income is negative: multiply by −1 for presentation and say so. Each row is in that subsidiary's
base currency; don't add the rows up (group total: the consolidated report).

Differences from Oracle's original: ROWNUM replaced by `FETCH FIRST`; subsidiary from
`transactionline` (`transaction` has no `subsidiary` column); `recordtype = 'custinvc'` → `type = 'CustInvc'`;
`approvalstatus = 2` dropped (invoices don't carry it unless the account has invoice approval);
GL amounts from `transactionaccountingline`, not `transactionline` without a mainline filter;
primary-book filter added.

## Budget vs actual (no fan-out)

Prefer the standard Budget vs. Actual report (`nsx reports search budget`). In SuiteQL:

```sql
SELECT b.subsidiary, b.account, b.budget, NVL(a.actual, 0) AS actual, NVL(a.actual, 0) - b.budget AS variance
FROM (
  SELECT bg.subsidiary, bg.account, SUM(bm.amount) AS budget
  FROM budgetsmachine bm
  JOIN budgets bg ON bg.id = bm.budget
  WHERE bm.period IN (<period ids>)
  GROUP BY bg.subsidiary, bg.account
) b
LEFT JOIN (
  SELECT tl.subsidiary, tal.account, SUM(tal.amount) AS actual
  FROM transactionaccountingline tal
  JOIN transaction t      ON t.id = tal.transaction
  JOIN transactionline tl ON tl.transaction = tal.transaction AND tl.id = tal.transactionline
  WHERE tal.posting = 'T'
    AND tal.accountingbook = <primary book id>
    AND t.postingperiod IN (<period ids>)
  GROUP BY tl.subsidiary, tal.account
) a ON a.subsidiary = b.subsidiary AND a.account = b.account
ORDER BY b.subsidiary, b.account
```

- Aggregate each side first, then join the totals. Oracle's pattern (period filter inside the LEFT
  JOIN ON, SUM on the budget side) multiplies each budget row by its matching actual lines; the
  guard warns about it (`budget-fanout`).
- Both sides are grouped and joined by subsidiary **and** account: actuals are in each subsidiary's
  base currency, so one total per account would add currencies together.
- *(verify)* The `budgets` / `budgetsmachine` columns (`budgets`: id, account, subsidiary, year,
  currency; `budgetsmachine`: budget, period, amount) aren't confirmed: the connector's field
  metadata for them was empty in the live init. Run `nsx fields budgets` / `nsx fields
  budgetsmachine` (or a `FETCH FIRST 1 ROWS ONLY` probe) first. If the account keeps several budget
  categories or budgets per year, filter the budget side to one, or add that column to both
  `GROUP BY`s and the join; otherwise their amounts are summed together.
- Signs: actuals are debit − credit (income negative, expenses positive). The sign convention of
  budget amounts isn't verified: check one income account against the standard report before
  computing variances, and flip one side if they differ. Budget amounts are in the budget's
  currency; check it matches the subsidiary's base currency.

## Aging (AR)

Prefer the standard A/R Aging report (`nsx reports search aging`) when it answers the question.

```sql
SELECT BUILTIN.DF(t.entity) AS customer, BUILTIN.DF(t.currency) AS currency,
       SUM(CASE WHEN t.type = 'CustInvc' AND TRUNC(SYSDATE) - NVL(t.duedate, t.trandate) <= 0 THEN t.foreignamountunpaid ELSE 0 END) AS current_amt,
       SUM(CASE WHEN t.type = 'CustInvc' AND TRUNC(SYSDATE) - NVL(t.duedate, t.trandate) BETWEEN 1 AND 30 THEN t.foreignamountunpaid ELSE 0 END) AS d1_30,
       SUM(CASE WHEN t.type = 'CustInvc' AND TRUNC(SYSDATE) - NVL(t.duedate, t.trandate) BETWEEN 31 AND 60 THEN t.foreignamountunpaid ELSE 0 END) AS d31_60,
       SUM(CASE WHEN t.type = 'CustInvc' AND TRUNC(SYSDATE) - NVL(t.duedate, t.trandate) BETWEEN 61 AND 90 THEN t.foreignamountunpaid ELSE 0 END) AS d61_90,
       SUM(CASE WHEN t.type = 'CustInvc' AND TRUNC(SYSDATE) - NVL(t.duedate, t.trandate) > 90 THEN t.foreignamountunpaid ELSE 0 END) AS d90_plus,
       SUM(CASE WHEN t.type = 'CustCred' THEN -ABS(t.foreignamountunpaid) ELSE 0 END) AS unapplied_credits,
       SUM(CASE WHEN t.type = 'CustCred' THEN -ABS(t.foreignamountunpaid) ELSE t.foreignamountunpaid END) AS net_open
FROM transaction t
WHERE t.type IN ('CustInvc', 'CustCred') AND t.foreignamountunpaid <> 0
GROUP BY BUILTIN.DF(t.entity), BUILTIN.DF(t.currency)
ORDER BY SUM(CASE WHEN t.type = 'CustInvc' AND TRUNC(SYSDATE) - NVL(t.duedate, t.trandate) > 90 THEN t.foreignamountunpaid ELSE 0 END) DESC
FETCH FIRST 200 ROWS ONLY
```

- Transactions without a due date (no terms) age from `trandate` (`NVL(t.duedate, t.trandate)`);
  without the `NVL` they'd fall out of every bucket.
- Credit memos (`CustCred`) aren't aged: they're in `unapplied_credits`, always negative whatever
  sign NetSuite stores; `net_open` is invoices minus unapplied credits.
- *(verify)* `t.foreignamountunpaid` and `t.duedate`: `transaction` has no field metadata on the
  live account, so they aren't confirmed. If the query fails, test each with `FETCH FIRST 1 ROWS
  ONLY`; the mainline's `tl.foreignamountunpaid` and `tl.duedate` (join `transactionline tl ON
  tl.transaction = t.id AND tl.mainline = 'T'`) are in the live field metadata.
- Amounts are in transaction currency (hence the currency column); say so, or use the report for
  base currency.

## Oracle SQL reminders

`NVL` (not ISNULL/IFNULL) · `SUBSTR` · `INSTR` · `CURRENT_DATE` · `TO_DATE('…','YYYY-MM-DD')` ·
`ADD_MONTHS(d, n)` · `MONTHS_BETWEEN` · `||` for concatenation · `ORDER BY … FETCH FIRST n ROWS ONLY`
to cap rows · booleans are `'T'`/`'F'` · `createddate` / `lastmodifieddate` come back date-only
(live-verified): use `TO_CHAR(t.createddate, 'YYYY-MM-DD HH24:MI')` for the time. `SYSDATE`, `TRUNC(date)` and `TO_CHAR(date)` work
(live-verified) but aren't on Oracle's supported-function list. Oracle recommends Oracle join
syntax (comma joins, `(+)` for outer joins) over ANSI `JOIN … ON` for performance; don't mix the two
in one query. The ANSI templates here are fine unless a query times out; then rewrite it in Oracle
syntax.

## Not supported in SuiteQL

The guard blocks each of these (source: Oracle's SuiteQL docs, or a live test where noted).
A date column compared to a plain string (`t.trandate >= '2026-01-01'`) is only warned about, not
blocked: write `TO_DATE('2026-01-01','YYYY-MM-DD')`.

| Don't | Do |
|---|---|
| `WITH x AS (…) SELECT …` | a subquery: `FROM (SELECT …) x` |
| `LIMIT n` / `LIMIT n OFFSET m` | `ORDER BY … FETCH FIRST n ROWS ONLY`; pages via `pageSize` + `pageIndex` |
| `OFFSET n ROWS FETCH NEXT m ROWS ONLY` (NetSuite ignores the OFFSET; live-verified) | `pageSize` + `pageIndex` with `ORDER BY t.id`, or `WHERE t.id > <last id> ORDER BY t.id FETCH FIRST m ROWS ONLY` |
| `DATE '2026-01-01'`, `TIMESTAMP '…'` | `TO_DATE('2026-01-01','YYYY-MM-DD')` |
| `'a' + b`, or `+` next to a column the metadata types as string (`a.acctnumber + a.acctname`) | `'a' \|\| b` |
| more than 1000 items in one `IN (…)` | several `IN` lists joined by `OR`, a subquery or an id range |
| `a.id (+) = b.id` (Oracle right outer join) | `b.id = a.id (+)` |
| `(+)` and `JOIN … ON` in the same query | one style only |
| `[name]` | `name` |
| `LEFT`, `RIGHT`, `SUBSTRING` | `SUBSTR` |
| `CHARINDEX`, `LOCATE`, `POSITION` | `INSTR` |
| `CEILING` · `LCASE` · `UCASE` · `CHAR_LENGTH` | `CEIL` · `LOWER` · `UPPER` · `LENGTH` |
| `LISTAGG`, `DATEDIFF`, `CONVERT`, `REPEAT` | no equivalent: subtract dates (`d1 - d2` is days), `TO_CHAR`/`TO_NUMBER` |
| `ROWNUM > n`, `ROWNUM = n` (n > 1), `ROWNUM <> 1` | `pageSize` + `pageIndex` with `ORDER BY t.id` |
| `&lt;=`, `&gt;`, `&amp;` (HTML-escaped operators in `sqlQuery`) | the operator itself: `<=`, `>`, `&` |
| two statements in one call (`SELECT …; SELECT …`) | one query per call, or combine with `UNION ALL` / subqueries |

## Common tables

Field metadata can be empty for a table that works (`transaction` here), and it leaves out some
columns SuiteQL accepts (`transactionline.amount`, whose currency is undocumented, so don't sum it;
`account.acctname`). Before concluding a column
doesn't exist, test it: `SELECT t.exchangerate FROM transaction t FETCH FIRST 1 ROWS ONLY`.

| Record | Table | Key columns (check with `nsx fields <table>`) |
|---|---|---|
| Transaction | transaction | id, tranid, trandate, type, recordtype, entity, currency, foreigntotal, postingperiod, status, approvalstatus, duedate, foreignamountunpaid |
| Transaction line | transactionline | id, transaction, mainline, taxline, item, foreignamount, netamount, department, class, location, subsidiary |
| GL impact | transactionaccountingline | transaction, transactionline, account, amount, debit, credit, posting, accountingbook |
| Account | account | id, acctnumber, fullname, accountsearchdisplayname, accttype, parent |
| Customer / Vendor / Employee | customer / vendor / employee | id, entityid, companyname, email, subsidiary |
| Item | item | id, itemid, displayname, itemtype |
| Subsidiary | subsidiary | id, name, currency, parent, iselimination |
| Accounting period | accountingperiod | id, periodname, startdate, enddate, closed, isyear, isquarter, isadjust, parent |
| Budget | budgets / budgetsmachine | *(verify: metadata empty in the live init)* budgets: id, account, subsidiary, year, currency, total · budgetsmachine: budget, period, amount |
