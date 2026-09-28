# Changelog

Versions follow [semver](https://semver.org). Before 1.0, a minor version may change behaviour or
settings.

## 0.5.1 (2026-09-28)

Initial release.

- **Metadata cache.** Report and saved-search lists, record types, field metadata, subsidiaries,
  books and accounting periods are fetched once, cached per connector and searched with the `nsx`
  CLI. A Profile Card (base currency, fiscal year, subsidiaries, open periods, materiality) is
  added to every session's context.
- **Large results stay out of context.** Results over the inline limit are saved to a file and
  replaced by a short summary; `nsx results` filters, sorts, aggregates, pivots, diffs,
  concatenates pages and exports them (CSV, XLSX). Totals that would mix currencies or
  subsidiaries, double-count nested report rows or repeated header amounts, or sum ids are shown
  as `n/a` with the fix.
- **SuiteQL guard.** Queries are checked before they run against rules taken from Oracle's SuiteQL
  documentation and from live tests: row caps (`ROWNUM`, `OFFSET`, `LIMIT` → `FETCH FIRST`),
  unsupported syntax and functions, undefined aliases, swapped `type`/`recordtype` values, currency
  mixing, and more. Suggested fixes are included; `[nolint]` overrides a false positive.
- **Reports.** Report output is flattened into lines with depth and kind, readable column names
  (months, quarters, aging buckets) and a section summary; `range` is normalised to the lowercase
  values the connector accepts.
- **Errors.** Rate limits, permissions, missing tables, syntax errors and likely bad columns are
  classified, with a recovery step.
- **Write safety.** Creates and updates are blocked by default. When enabled, each write needs a
  preview, an exact-input match and your approval, and is audited. Any tool not known to only read
  is guarded as a write.
- **Skills and agent.** A `netsuite` skill derived from Oracle's `netsuite-ai-connector-instructions`
  skill, `init`, `refresh` and `doctor` skills, and an `ns-explorer` agent for open-ended
  metadata questions.
