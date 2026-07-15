# Operations Suite implementation plan

1. Add migration 45 and repositories for automation, approvals, inbound
   channels, supplier-aware mappings and operations aggregates.
2. Add a shared autopilot quality gate and use it in watcher and dispatcher
   auto-send hooks.
3. Extend duplicate matching with item/bank/near-number evidence and persist the
   result for the UI.
4. Add supplier context to mapping lookup and persist manual supplier-specific
   corrections.
5. Add authenticated operations APIs for overview, exceptions, approvals,
   reconciliation, supplier scorecards, forecast and assistant queries.
6. Add public-secret Telegram/email intake endpoints plus authenticated channel
   configuration endpoints.
7. Add the `#/operations` SPA section, navigation, responsive styles and voice
   input.
8. Add focused unit tests for pure quality-gate and duplicate scoring logic;
   validate with TypeScript, syntax checks and CI (local DB-backed tests remain
   forbidden by project policy).
9. Browser-smoke desktop/mobile flows, publish the exact intended files to
   `main`, monitor GitHub Actions and verify production endpoints.
