<!-- Derived from Oracle NetSuite "netsuite-ai-connector-instructions" (UPL 1.0). -->

# NetSuite domain reference

## Record hierarchy

```
Transactions
├── Sales:      Opportunity → Estimate → Sales Order → Item Fulfillment → Invoice → Customer Payment
├── Purchasing: Purchase Order → Item Receipt → Vendor Bill → Bill Payment
├── Finance:    Journal Entry, Deposit, Transfer, Expense Report
└── Inventory:  Transfer Order, Inventory Adjustment, Work Order
Entities: Customer (incl. prospects/leads), Vendor, Employee, Contact, Partner
```

## Normal balances

| Account type | Normal balance | Debit | Credit |
|---|---|---|---|
| Asset | Debit | + | − |
| Liability | Credit | − | + |
| Equity | Credit | − | + |
| Revenue | Credit | − | + |
| Expense | Debit | + | − |

`transactionaccountingline.amount` is debit − credit, so revenue sums are negative; flip the sign
for presentation and say so. Closed periods accept no postings. Intercompany needs elimination in
consolidation. Deferred revenue is a liability until recognised.

Standard reports sign differently (live-verified 2026-09-27, Income Statement): account lines
carry their P&L sign, income + and expense −, while expense sections show the opposite sign of
their lines: positive for a net expense, negative for a net credit (Purchases −1,250.00 over an
account line of +1,250.00). So "Advertising −1.2M" under "Overheads 5.8M" is an ordinary
expense, not a credit; say so when you quote a line. The report summary names the sections that
flip.

## Consolidated figures

For group totals (revenue, P&L) run the standard report with `subsidiaryId: -1`, the consolidated
view, which reports in the parent subsidiary's currency. Don't add SuiteQL sums across
subsidiaries: each is in its own base currency. The parent is named in the id `-1` entry of
`ns_getSubsidiaries` (`<parent name> (Consolidated)`). A subsidiary's base currency can be read
from its transactions at `exchangerate = 1` (see references/suiteql.md).

## Links

Use the account's own domain when known (`https://<accountid>.app.netsuite.com`), else
`https://system.netsuite.com`. Internal numeric id only.

| Record | Path |
|---|---|
| Invoice | /app/accounting/transactions/custinvc.nl?id=ID |
| Sales Order | /app/accounting/transactions/salesord.nl?id=ID |
| Purchase Order | /app/accounting/transactions/purchord.nl?id=ID |
| Vendor Bill | /app/accounting/transactions/vendbill.nl?id=ID |
| Customer Payment | /app/accounting/transactions/custpymt.nl?id=ID |
| Journal Entry | /app/accounting/transactions/journal.nl?id=ID |
| Credit Memo | /app/accounting/transactions/custcred.nl?id=ID |
| Any transaction | /app/accounting/transactions/transaction.nl?id=ID |
| Customer | /app/common/entity/custjob.nl?id=ID |
| Vendor | /app/common/entity/vendor.nl?id=ID |
| Employee | /app/common/entity/employee.nl?id=ID |
| Report | /app/reporting/reportrunner.nl?cr=ID |

## Fiscal periods

Accounting periods aren't always calendar months. Use `nsx periods` (cached) for ids, open/closed
status and fiscal years; the profile has the fiscal year start month. "Current period" means the
open period, not today's calendar month.
