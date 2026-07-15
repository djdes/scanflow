# Business control and 1C onboarding implementation plan

1. Add migration 46 and repositories for bank statements, correction memory,
   secure 1C connections, payment plans, verification metadata and approval
   batches.
2. Extend operations aggregates with root causes, daily calendar and management
   reports; reconcile invoices against both Sber drafts and imported bank rows.
3. Add capped bulk exception/approval endpoints, bank CSV import, calendar edit
   and automatic DaData supplier verification.
4. Add scoped 1C exchange authentication, catalog/pending/photo/status endpoints
   and admin lifecycle/status endpoints for connection tokens.
5. Remove embedded credentials from the tracked 1C source, read connection
   settings from 1C common settings, and publish a Russian step-by-step setup
   guide and source template.
6. Record and apply supplier-aware OCR header corrections and extend the OCR
   document type contract.
7. Add selection, bulk actions, root causes, calendar, reports, bank import and
   the 1C setup wizard to the Operations UI.
8. Validate TypeScript, browser JavaScript and whitespace; smoke-test desktop
   and mobile in a real browser, publish only intended files to `main`, monitor
   CI and verify production health.
