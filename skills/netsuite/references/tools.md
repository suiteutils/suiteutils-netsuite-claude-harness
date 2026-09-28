<!-- Derived in part from Oracle NetSuite "netsuite-ai-connector-instructions" (UPL 1.0); see NOTICE. -->

# Tool details

Any `ns_*` tool other than the read tools (`ns_runCustomSuiteQL`, `ns_runSavedSearch`,
`ns_runReport`, and any `ns_get…` / `ns_list…`) is treated as a write: blocked under `read_only`, and with writes on its approval prompt warns it's an unknown tool.

What the connector tools do beyond their descriptions. Live-verified on a production account
(2026-09-27) unless noted.

## ns_getRecord

- Always pass `fields`, comma-separated **without spaces** (`"tranid,trandate,total"`). With spaces
  NetSuite silently returns only the first field. The guard strips the spaces, but write it without.
- Names are case-insensitive. Empty fields and names that aren't fields are both left out of the
  result silently; the guard names any requested field missing from the result.
- Reference fields come back as `{id, refName}`. A record's own `total` field is not a row count.
- A bad record type: `HTTP 404 … Record type '<x>' does not exist … NONEXISTENT_ID` inside a
  `success:false` body.

## ns_runSavedSearch

- Always pass `range_end` (the guard adds a 200-row cap when it's missing). The next slice is
  `range_start: 200, range_end: 400`.
- A standalone search type needs `type`: `type: "SystemNote"` for a System Note search,
  `type: "SavedSearch"` for a Saved Search search. "Unable to determine record type for saved
  search id N" means call again with `type`. The guard adds it itself when the searches cache knows
  the record type.
- Errors arrive as a plain string in a successful result ("Error loading saved search …").
  "Permission Violation …": name the missing permission, don't retry.
- Reference fields are bare internal ids; dates are unpadded (`2026-3-2`); datetimes are 12-hour
  (`2026-5-3 1:11 pm`); blank cells are a single space.

## ns_runCustomSuiteQL paging

- One call returns one page. The guard adds `pageSize` (default 500; for a query ending in
  `FETCH FIRST N ROWS ONLY` with N ≤ 1000, N, at least 5) and `pageIndex: 0` when missing (null or
  `""` count as missing; a non-numeric value is denied). `hasNextPage` / `totalResults` show whether there's more; get the next page with the
  same `sqlQuery` and `pageSize` and `pageIndex: 1, 2, …`.
- Don't drop `pageIndex` to "get everything": `pageSize` without `pageIndex` returns every page in
  one response. (Oracle documents only `sqlQuery`, `description` and `pageSize` for this tool; the
  `pageIndex` behaviour is live-verified.)
- Paged queries need a unique `ORDER BY` (e.g. `ORDER BY t.id`), or pages overlap or skip rows.
- The minimum `pageSize` is 5 (smaller values return 5 rows). A paged query returns at most 100,000
  rows in total; for big pulls batch by id range (`WHERE t.id > <last id> … ORDER BY t.id`).
- Prefer aggregating in SQL to paging through detail rows. If you do fetch several pages, combine
  the saved results with `nsx results concat <id1> <id2> …` before aggregating: it puts them in
  page order and says when a page is missing.

## ns_runReport

- Account lines carry their P&L sign (income +, expense −). Expense sections show the opposite sign
  of their lines: positive for a net expense, negative for a net credit (Purchases −1,250.00 over an
  account line of +1,250.00). The result summary names the sections that flip.
- Subsidiaries can use different Income Statement layouts (e.g. Ordinary Income/Expense … Net Income
  on one, Sales … Net Profit/(Loss) on another); read the section names from the result.
- `range` splits a report into period columns. It's case-sensitive: use lowercase `month` or
  `quarter` (live-verified 2026-09-28; `MONTH`, `Month`, `period`, `Accounting Period` … are
  silently ignored and return one column). The guard lowercases `MONTH` → `month` and removes
  `range` for reports whose cached `supports_range` is false, saying so in a `[su-ns-harness]`
  note; other values (`period`, `Accounting Period`) are passed as sent and have no effect. The result has one column per period plus `Total` (named `2026-01` … / `2026-Q1` …).
  `month` means calendar months, which equal accounting periods only on a calendar-month period
  layout (not on 4-4-5 calendars). For monthly or quarterly figures, one call with `range` replaces
  one report per period: `{"reportId": -200, "subsidiaryId": -1, "dateFrom": "2026-01-01",
  "dateTo": "2026-08-31", "range": "month"}` (its Total column is the YTD).
- Aging reports: the bucket columns come without names; the harness names them by position
  (`Current, 1-30, 31-60, 61-90, Over 90, Total`, NetSuite's defaults — inferred, say so if you
  quote them).
- `book: 2` / `book: 3` returned the default book's figures; whether the connector honours `book`
  is undetermined.
- Subsidiary filter ids come from `nsx cache show subsidiaries`; `subsidiaryId: -1` is the
  consolidated view, in the parent subsidiary's currency.
