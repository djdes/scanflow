# Invoice review workspace

Implement the five approved features in production: a next-document review queue, source-linked rows and header fields, confirmed editing beside the original, a decision panel, and previous-supply comparison.

Source regions use normalized coordinates on an EXIF-oriented, unrotated preview of a specific stored image. Locate regions on demand using the existing configured image model; return 202 and poll progress. AI suggestions are explicitly labelled. Manual rectangle selection is always available. No inferred geometry from row order. Regions reference stable item IDs and filenames; deleted/replaced items cannot reuse their coordinates. XML/PDF remain accessible with their existing viewers and explicitly lack raster-region editing.

Review edits are authenticated, tenant scoped, optimistic, and transactional. Edits are limited to unsent, unapproved, unpaid processed documents. Preview numeric effects before explicit save; write the audit record and invalidate relevant verification checks atomically. Preserve raw values and original images. Existing send and payment guards remain authoritative.

Next-document selection excludes reviewed/skipped IDs from this session and prioritizes existing list exceptions plus incomplete header verification. No automatic sends/payments or bulk confirmations.

Previous supply is the latest earlier processed/sent invoice of this company and supplier (INN, exact supplier fallback only without INN). Match unique catalog GUIDs then unique original names. Ambiguous rows are labelled, never paired arbitrarily. Price comparisons require equivalent canonical units, VAT, and conversion basis; unmatched rows display added/missing. Source links open the corresponding original.

Additive MariaDB-compatible table, no data rewrites. Tests use only localhost scanflow_test, mock AI. Verify owner isolation, stale edits, locked states, region validation, arithmetic and comparison semantics; browser-check desktop and 320/360/390 px mobile; deploy via existing main workflow.
