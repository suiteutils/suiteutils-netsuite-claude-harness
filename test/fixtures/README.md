# Fixtures

Two kinds of fixture live here. **Sanitized live shapes** (below) keep the exact keys and nesting
of real NetSuite AI Connector responses with made-up values. The rest are **synthetic**:
hand-written, either in shapes seen live or in shapes expected before the first live run.
Replace a synthetic one with a sanitized capture when one is available, and keep it only if it
still exercises a distinct shape.

Each file holds the `tool_response` exactly as a hook would receive it.

**Sanitized live shapes** (keys and nesting exactly as captured from a live account on 2026-09-27;
names, ids and amounts replaced with made-up values):

- `reports_list.json`, `searches_list.json`, `subsidiaries.json`: the catalog lists as bare arrays
  (`{id, title, as_of_format, supports_*…}`, `{id, title, recordtype, public}`, `{id, name}`).
- `fields_envelope_department.json`: `ns_getSuiteQLMetadata` field metadata in its
  `{success, metadata, message}` envelope.
- `report_income_statement.json`: `ns_runReport` (`reportData` keyed "0".."n", `reportColumns`, `title`),
  trimmed to 46 rows. Group rows equal the sum of their children.
- `saved_search_open_bills.json`: `ns_runSavedSearch`, a bare array of label-keyed strings (ids as
  integer strings, unpadded dates, `.00`).
- `suiteql_invoices_page.json`: `ns_runCustomSuiteQL` envelope as captured (`method`, `queryExecuted`,
  `resultCount`, `totalResults`, `data`, `pageSize`, `numberOfPages`), plus the `pageIndex` /
  `hasNextPage` / `hasPreviousPage` fields seen live on single-page calls (not captured).

**Sanitized live shapes from 2026-09-28**: keys, nesting and `reportColumns` exactly as
captured; every vendor name, account and amount is made up (signs and subtotals kept consistent):

- `report_ap_aging.json`: A/P Aging Summary (report 286). The five bucket columns share `label` and
  `path` (`Current > Open Balance`); only `id` differs (`… (2)` … `(5)`); the total is
  `empty > Open Balance`. A structural `Vendor` root row, a `- No Vendor -` section with two detail
  lines, and a `Vendor` section over five vendors (each a line plus its detail line).
- `report_income_statement_month.json` / `report_income_statement_quarter.json`: Income Statement
  (report -200) run with `range: "month"` / `"quarter"`: ids `2026-01 > Amount` … / `2026-1 > Amount` …,
  plus `empty > Amount` for the total; `label` is `Amount` on every column.

**Synthetic, in live shapes seen on 2026-09-27**, with made-up ids, names, titles, amounts and timestamps:

- `suiteql_invoices_mixed_currency.json`: `ns_runCustomSuiteQL` invoices with a currency id column
  (`currency`: 1, 2…) *and* its display column (`curr`: USD, AUD…), `foreigntotal` in six currencies,
  unpadded `trandate`, and a query with `ORDER BY t.id`.
- `suiteql_customers_currency.json`: a customer list with a currency column and no amounts, no ORDER BY.
- `saved_search_bills_datetime.json`: `ns_runSavedSearch` with 12-hour datetimes (`2019-9-17 7:18 am`).
- `saved_search_accounts_listid.json`: `ns_runSavedSearch` account list with a list/select column sent
  as a small integer string (`Handling Type`: "1", "2") beside a real small-integer measure
  (`Quantity`).
- `saved_search_list_blanks.json`: `ns_runSavedSearch` saved-search list with label columns that
  contain spaces (`Last Run On`, `Last Run By`, `From Bundle`), blank cells sent as a single space
  `" "`, 12-hour datetimes, and employee/bundle internal ids as 6–7 digit integer strings (`-5` for
  the system user).

**Synthetic, in shapes guessed before the first live run** (kept because they exercise parser
fallbacks the live shapes don't):

- `periods.json`: the periods query result as an `{items: […]}` wrapper with US-style dates
  (`4/1/2025`), a fiscal-year row and closed/open months. The live periods probe returns ISO dates
  (`TO_CHAR(…,'YYYY-MM-DD')`) in the `ns_runCustomSuiteQL` envelope.
- `suiteql_metadata_transaction.json`: `ns_getSuiteQLMetadata` field metadata for `transaction` as
  a bare `{type, properties}` object (no `{success, metadata, message}` envelope), with an
  `x-ns-join` key and a `custbody_` field. Live, `transaction` metadata comes back with no
  properties at all.
