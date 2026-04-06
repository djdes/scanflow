# Invoice Photos: API, Frontend Tab, 1C Attached Files

**Date:** 2026-04-06

## Summary

Add photo viewing for invoices: API endpoints to serve photos, a "Фото" tab in the web dashboard, and 1C code to download photos into "Присоединённые файлы".

## Backend: Photo API

### `GET /api/invoices/:id/photos`

Returns list of photos for an invoice. Parses `file_name` (comma-separated) from DB.

Response:
```json
[
  { "filename": "photo1.jpg", "url": "/api/invoices/123/photos/photo1.jpg" },
  { "filename": "photo2.jpg", "url": "/api/invoices/123/photos/photo2.jpg" }
]
```

### `GET /api/invoices/:id/photos/:filename`

Serves the actual image file from `data/processed/` directory.

- Validates that `filename` belongs to the invoice (exists in `file_name` field)
- Returns image with appropriate `Content-Type` header (image/jpeg)
- Returns 404 if file not found on disk or doesn't belong to invoice

Both endpoints require API key auth (same as existing routes).

**File:** `src/api/routes/invoices.ts` (add to existing routes)

## Frontend: "Фото" Tab

In invoice detail view, add a tab "Фото" alongside existing "Товары" tabs.

Content: all photos displayed vertically, one after another, full container width. For multi-page invoices — all pages stacked top to bottom.

**File:** `public/js/invoices.js` (modify invoice detail rendering)

## 1C: Download Photos to Attached Files

After creating ПриходнаяНакладная document:

1. `GET /api/invoices/:id/photos` — get file list
2. For each file: `GET /api/invoices/:id/photos/:filename` — download binary
3. Create record in the attached files mechanism and link to the document

**File:** `1c/КНД_ЗагрузкаНакладныхСканер/КНД_ЗагрузкаНакладныхСканер/Ext/ObjectModule.bsl`
