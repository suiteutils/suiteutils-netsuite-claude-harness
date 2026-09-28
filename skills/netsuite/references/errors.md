# Error playbook

The su-ns-harness hooks classify connector errors and add a recovery line to the result. This is the
full table. Strings marked "live" were seen on a production account through the claude.ai
connector; the others are best guesses.

| Class | Typical message | What to do |
|---|---|---|
| unreachable | "couldn't reach the MCP server" | Stop; don't retry in a loop. User re-authenticates: `/mcp` → NetSuite → Authenticate (claude.ai connector: reconnect under Settings → Connectors). |
| rate_limit (the recovery line says `hit N time(s) in a row`; the count resets after 5 quiet minutes) | "Too Many Requests", 429, "Concurrent request limit exceeded", "rate-limiting requests"; live: `HTTP 429: {… "Concurrent request limit exceeded. Request blocked." …}`, as a tool error or inside `{"success":false,"error":…}` (the hook then replaces the payload with the recovery line) | Wait about 5s, retry once; then about 10s, 20s (the hook gives the exact `sleep`; if `sleep` is refused, run it in the background or just wait). Max 3 tries. Strictly one call at a time. After 3, tell the user the account's integration concurrency is saturated (other integrations share it). |
| auth | 401, invalid_token, re-authenticate | Stop. User reconnects the NetSuite connector (`/mcp` → NetSuite → authenticate). |
| permission | INSUFFICIENT_PERMISSION, "You do not have permission"; live (saved search, as a string in a successful result): `Error loading saved search with params {…}. Error: Permission Violation: You need  the 'SuiteScript' permission …` | Don't retry. Name the record/report and the permission the connector role needs. |
| bad_field | Unknown identifier, Invalid field, "Field 'amout' for record 'transactionLine' was not found" | The field cache is marked stale: the table the error names, else every table in FROM/JOIN. `nsx fields <table> --grep <term>`, or call `ns_getSuiteQLMetadata` for the table. Fix, retry once. |
| bad_record_type (SuiteQL) | invalid record type | `nsx recordtypes --grep <term>`. Transactions are all in `transaction` (filter by `type`). |
| bad_record_type (REST: `ns_getRecord`, `ns_getRecordTypeMetadata`) | live: `HTTP 404 … Record type '<x>' does not exist … NONEXISTENT_ID` inside `{"success":false,…}` | REST record types are lower-case record ids (`invoice`, `vendorbill`, `journalentry`, `customer`). Check the name with `ns_getRecordTypeMetadata` (no arguments), then call again with the exact name. |
| bad_record_type (saved search) | live, as a string in a successful result: `… Error: Unable to determine record type for saved search id 900` | A standalone search type needs `type`. The hook looks up the search's record type in the searches cache: a `System Note` search is called again with `type: "SystemNote"` and a `Saved Search` search with `type: "SavedSearch"` (the guard adds it before the call when the cache knows). For other record types, try the record type without spaces if the tool's `type` parameter accepts it. |
| bad_syntax | syntax / parse errors; live: `Failed to parse SQL [<the query>]: syntax error … near: =(1,45, token code:0)` | The recovery line quotes the position ("near column 45") and the query text there. `nsx sql lint -`. Retry once after fixing. If still failing, look for a saved search. |
| bad_syntax | live: `Invalid or unsupported search` | Often an ORDER BY on a column alias or a non-grouped expression with GROUP BY: order by the full expression (e.g. `COUNT(*) DESC`) or drop ORDER BY. |
| timeout | timed out; also `SSS_USAGE_LIMIT_EXCEEDED` / "usage limit exceeded" (NetSuite's governance limit: the call did too much work, not a rate limit) | Don't repeat the call. Narrow the date range, filter by subsidiary, aggregate in SQL, split by period or id range. If the query uses ANSI `JOIN … ON`, rewrite it with Oracle-syntax joins (comma joins, `(+)` for outer joins; never both styles in one query): Oracle warns ANSI syntax risks "time outs that aren't operationally remediable". |
| not_found | report/search/record not found | Reports/searches cache is marked stale. Refresh it (`ns_listAllReports` / `ns_listSavedSearches`) and search again. |
| not_found (SuiteQL) | live: `Search error occurred: Record 'subsidiary' was not found.` | The table isn't exposed to the connector role. Don't retry. Skip it, use another table, or ask an admin to grant access. When the record-type list is cached, the guard denies such a query before the call (`isn't in this account's SuiteQL record-type list`); add `[nolint]` only if you know the list is outdated. `[nolint]` doesn't skip the first-use metadata step (`Field metadata for '<table>' isn't cached yet`): call `ns_getSuiteQLMetadata` for the table once, then run the query. |
| bad_field_likely | live: `Error executing SuiteQL query: An unexpected SuiteScript error has occurred` on a query where the guard warned that a column isn't in the connector's metadata | NetSuite doesn't name the bad field, so the flagged column is the likely cause. Check it with `nsx fields <table> --grep <prefix>`, fix it, retry once. |
| unknown (SuiteQL, generic) | "An unexpected SuiteScript error has occurred" when the guard flagged nothing (a misspelled column or an alias missing from FROM/JOIN gives exactly this) | Check each column with `nsx fields <table> --grep <term>`, run the query through `nsx sql lint -` (or `nsx sql lint "<sql>"`), then retry once. |
| unknown | anything else | Don't retry blindly. Show the user the error text; change and re-run the call only if the message says what's wrong. |

Empty field metadata (`The connector exposes no field metadata for 'transaction'`) is not an
error: the table still works in SuiteQL and still has its columns (live: `transaction.exchangerate`
works), only the column checks are skipped. Test a column with `FETCH FIRST 1 ROWS ONLY` before
saying it doesn't exist. A table missing from the record-type list is the real visibility gap.

Saved-search errors don't come back as tool errors: the connector returns a successful result that
is a single string starting `Error loading saved search`. The hook treats it as an error (audited
as `error`, with a recovery line).

## Other recovery rules

- No data returned: widen the date range or remove a filter, and tell the user what you changed.
- A failed create is **never** retried automatically. Ask the user to check NetSuite; retry with a new externalId.
- An outlier: "This figure looks unusual — please verify in NetSuite."

## NetSuite UI fallbacks

| Data | Path |
|---|---|
| Income Statement | Reports → Financial → Income Statement |
| Balance Sheet | Reports → Financial → Balance Sheet |
| Cash Flow | Reports → Financial → Cash Flow Statement |
| AR Aging | Reports → Receivables → A/R Aging |
| AP Aging | Reports → Payables → A/P Aging |
| Budget vs Actual | Reports → Financial → Budget vs. Actual |
| Open invoices | Transactions → Sales → Create Invoices → List, filter Open |
