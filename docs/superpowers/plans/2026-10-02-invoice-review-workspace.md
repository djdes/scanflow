# Implementation

1. Add migration and source-region repository; image locator and supplier comparison service.
2. Add authenticated review endpoints for queue, regions, on-demand locator, oriented images, comparison and atomic edits.
3. Add review entry point, decision panel, source workspace and confirmed editor; link table fields in both directions.
4. Add side-by-side supply comparison and source navigation.
5. Verify isolated API/service tests, compile, browser interactions/mobile layout, then publish and verify HTTPS availability.

Implemented entry points: list button «Проверить следующую», decision panel inside each invoice, «Проверить по оригиналу», row/header «На оригинале» links and «Сравнить с прошлой поставкой».

Raster source regions are stored in migration 80 and carried through invoice merges. AI location is on demand for the selected field/row and selected image, with a two-job concurrency cap and manual correction. Existing PDF/XML viewers stay available; they do not expose raster-region editing. No background OCR backfill is scheduled.

Verified with real API/browser on localhost scanflow_test: explicit photo-overlay correction, row recalculation and audit, touch rectangle binding, source zoom/scroll, previous-supply original, next-document navigation and mobile widths 320/360/390. AI requests are mocked in automated tests; actual external model availability is determined by the existing production analyzer configuration.
