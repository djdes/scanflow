# Mapping Refactor: Many-to-One + Grouped UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor mapping system so multiple scanned names map to one 1C item (many-to-one), remove per-supplier logic, add auto-save for fuzzy matches, and display mappings grouped by 1C item.

**Architecture:** Remove `mapping_supplier_usage` table and supplier-related fields. Keep `nomenclature_mappings` with `scanned_name` UNIQUE → `onec_guid`. When fuzzy match confidence ≥ 0.7, auto-save as learned mapping. Frontend shows compact grouped table: one row per 1C item, scanned variants as chips.

**Tech Stack:** SQLite, Express, Fuse.js, vanilla JS

---

### Task 1: Clean up database — remove supplier tracking

**Files:**
- Modify: `src/database/repositories/mappingRepo.ts`

- [ ] **Step 1: Remove `recordUsage()` method**

Delete lines 104-125 (`recordUsage` function) and lines 155-171 (`getSupplierList`, `getUnmappedCount`).

Replace `getAllFiltered()` (lines 133-153) with a simpler version:

```typescript
getAllGrouped(): Array<{ onec_guid: string; mapped_name: string; variants: NomenclatureMapping[] }> {
  const db = getDb();
  const all = db.prepare(
    `SELECT * FROM nomenclature_mappings
     WHERE onec_guid IS NOT NULL AND onec_guid != ''
     ORDER BY mapped_name_1c, scanned_name`
  ).all() as NomenclatureMapping[];

  const groups = new Map<string, { onec_guid: string; mapped_name: string; variants: NomenclatureMapping[] }>();
  for (const m of all) {
    const key = m.onec_guid || m.mapped_name_1c;
    if (!groups.has(key)) {
      groups.set(key, { onec_guid: m.onec_guid || '', mapped_name: m.mapped_name_1c, variants: [] });
    }
    groups.get(key)!.variants.push(m);
  }
  return Array.from(groups.values());
},

getUnmapped(): NomenclatureMapping[] {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM nomenclature_mappings
     WHERE onec_guid IS NULL OR onec_guid = ''
     ORDER BY scanned_name`
  ).all() as NomenclatureMapping[];
},
```

- [ ] **Step 2: Simplify `create()` — remove supplier fields from insert**

Remove `last_seen_supplier` from insert. Keep `times_seen` for stats.

- [ ] **Step 3: Commit**

```bash
git add src/database/repositories/mappingRepo.ts
git commit -m "refactor(mapping): remove supplier tracking, add grouped query"
```

---

### Task 2: Auto-save fuzzy matches in nomenclatureMapper

**Files:**
- Modify: `src/mapping/nomenclatureMapper.ts`

- [ ] **Step 1: Auto-create learned mapping when fuzzy match is confident**

In the `map()` method, after a successful fuzzy match (confidence ≥ 0.7), auto-save it as a learned mapping so next time it's an exact match:

```typescript
// After line ~129 (fuzzy match found with confidence >= MIN_FUZZY_CONFIDENCE)
if (confidence >= MIN_FUZZY_CONFIDENCE) {
  // Auto-save as learned mapping for future exact match
  try {
    const existing = mappingRepo.getByScannedName(scannedName);
    if (!existing) {
      mappingRepo.create({
        scanned_name: scannedName,
        mapped_name_1c: best.item.name,
        onec_guid: best.item.guid,
      });
    }
    // Also save cleaned name variant if different
    if (cleanName !== scannedName) {
      const existingClean = mappingRepo.getByScannedName(cleanName);
      if (!existingClean) {
        mappingRepo.create({
          scanned_name: cleanName,
          mapped_name_1c: best.item.name,
          onec_guid: best.item.guid,
        });
      }
    }
  } catch (e) {
    // Don't fail mapping if auto-save fails
    logger.warn('Auto-save mapping failed', { scannedName, error: (e as Error).message });
  }

  return {
    original_name: scannedName,
    mapped_name: best.item.name,
    onec_guid: best.item.guid,
    confidence,
    source: 'onec_fuzzy',
    mapping_id: null,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/mapping/nomenclatureMapper.ts
git commit -m "feat(mapping): auto-save fuzzy matches as learned mappings"
```

---

### Task 3: Remove supplier logic from fileWatcher

**Files:**
- Modify: `src/watcher/fileWatcher.ts`

- [ ] **Step 1: Remove `recordUsage()` calls**

Remove both `recordUsage` calls:
- Line ~269: `if (mapping.mapping_id !== null) { mappingRepo.recordUsage(...) }` 
- Line ~335: `if (mapping.mapping_id !== null) { mappingRepo.recordUsage(...) }`

Delete these blocks entirely. Auto-save now happens inside `map()` (Task 2).

- [ ] **Step 2: Remove `mappingRepo` import if no longer used**

Check if `mappingRepo` is still imported/used elsewhere in the file. If only for `recordUsage`, remove the import.

- [ ] **Step 3: Commit**

```bash
git add src/watcher/fileWatcher.ts
git commit -m "refactor: remove recordUsage calls, mapping auto-saved in mapper"
```

---

### Task 4: Simplify API routes

**Files:**
- Modify: `src/api/routes/mappings.ts`

- [ ] **Step 1: Replace GET /api/mappings with grouped endpoint**

```typescript
// GET /api/mappings — grouped by 1C item
router.get('/', (_req: Request, res: Response) => {
  const grouped = mappingRepo.getAllGrouped();
  const unmapped = mappingRepo.getUnmapped();
  res.json({ data: { grouped, unmapped } });
});
```

- [ ] **Step 2: Remove supplier-related endpoints**

Remove `getSupplierList()` call and supplier filter logic from GET /api/mappings.
Remove GET /api/nomenclature/suppliers endpoint if it only served supplier tab.

- [ ] **Step 3: Commit**

```bash
git add src/api/routes/mappings.ts
git commit -m "refactor(api): grouped mappings endpoint, remove supplier filters"
```

---

### Task 5: Rewrite frontend — grouped compact table

**Files:**
- Modify: `public/index.html`
- Rewrite: `public/js/mappings.js`

- [ ] **Step 1: Replace HTML — remove supplier tab, update table structure**

Replace the mappings section in `index.html` (lines 214-298):

```html
<section id="view-mappings">
  <div class="section-header" style="margin-bottom:16px">
    <div>
      <h2>Номенклатурные соответствия</h2>
      <div id="mappings-catalog-status" class="section-subtitle">Загрузка...</div>
    </div>
  </div>

  <div class="tabs" style="margin-bottom:16px">
    <button class="tab-btn active" id="mappings-mode-all" onclick="Mappings.setMode('all')">Соответствия</button>
    <button class="tab-btn" id="mappings-mode-unmapped" onclick="Mappings.setMode('unmapped')">Не сопоставлено</button>
    <button class="tab-btn" id="mappings-mode-catalog" onclick="Mappings.setMode('catalog')">Справочник 1С</button>
  </div>

  <!-- Grouped mappings -->
  <div id="mappings-mode-all-pane">
    <div class="filters">
      <input type="text" id="mappings-search" placeholder="Поиск по товару или варианту..." oninput="Mappings.filter(this.value)">
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th style="width:30%">Товар 1С</th>
            <th>Варианты из накладных</th>
            <th style="width:80px;text-align:right">Всего</th>
            <th style="width:40px"></th>
          </tr>
        </thead>
        <tbody id="mappings-tbody"></tbody>
      </table>
    </div>
  </div>

  <!-- Unmapped items -->
  <div id="mappings-mode-unmapped-pane" style="display:none">
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Название из накладной</th>
            <th>Сопоставить с 1С</th>
            <th style="width:80px"></th>
          </tr>
        </thead>
        <tbody id="unmapped-tbody"></tbody>
      </table>
    </div>
  </div>

  <!-- 1C Catalog -->
  <div id="mappings-mode-catalog-pane" style="display:none">
    <div class="filters">
      <input type="text" id="catalog-search" placeholder="Поиск по названию..." oninput="Mappings.filterCatalog(this.value)">
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Код</th>
            <th>Наименование</th>
            <th>Полное наименование</th>
            <th>Ед.</th>
            <th>GUID</th>
          </tr>
        </thead>
        <tbody id="catalog-tbody"></tbody>
      </table>
    </div>
  </div>
</section>
```

- [ ] **Step 2: Rewrite mappings.js — grouped view**

Complete rewrite of `public/js/mappings.js`:

```javascript
/* global App, OnecCatalog, Mappings */
const Mappings = {
  mode: 'all',
  grouped: [],    // [{ onec_guid, mapped_name, variants: [...] }]
  unmapped: [],   // [{ id, scanned_name, ... }]
  expandedGuid: null,

  async load() {
    await OnecCatalog.load();
    this.updateCatalogStatus();
    if (this.mode === 'all') {
      await this.loadGrouped();
    } else if (this.mode === 'unmapped') {
      await this.loadGrouped(); // same endpoint, render differently
    } else {
      this.renderCatalog();
    }
  },

  updateCatalogStatus() {
    const el = document.getElementById('mappings-catalog-status');
    if (!el) return;
    if (OnecCatalog.items.length === 0) {
      el.innerHTML = '<span style="color:#b91c1c">Справочник не выгружен.</span>';
    } else {
      const ts = OnecCatalog.lastSyncedAt ? new Date(OnecCatalog.lastSyncedAt).toLocaleString('ru-RU') : '—';
      el.innerHTML = `Справочник из 1С: <strong>${OnecCatalog.items.length}</strong> товаров · Последняя выгрузка: ${ts}`;
    }
  },

  setMode(mode) {
    this.mode = mode;
    document.getElementById('mappings-mode-all').classList.toggle('active', mode === 'all');
    document.getElementById('mappings-mode-unmapped').classList.toggle('active', mode === 'unmapped');
    document.getElementById('mappings-mode-catalog').classList.toggle('active', mode === 'catalog');
    document.getElementById('mappings-mode-all-pane').style.display = mode === 'all' ? 'block' : 'none';
    document.getElementById('mappings-mode-unmapped-pane').style.display = mode === 'unmapped' ? 'block' : 'none';
    document.getElementById('mappings-mode-catalog-pane').style.display = mode === 'catalog' ? 'block' : 'none';
    this.load();
  },

  async loadGrouped() {
    try {
      const { data } = await App.apiJson('/mappings');
      this.grouped = data.grouped || [];
      this.unmapped = data.unmapped || [];
      if (this.mode === 'all') this.renderGrouped();
      else this.renderUnmapped();
    } catch (e) {
      console.error('Failed to load mappings', e);
    }
  },

  filter(query) { this.renderGrouped(query); },

  renderGrouped(filterQuery = '') {
    const tbody = document.getElementById('mappings-tbody');
    let items = this.grouped;
    if (filterQuery) {
      const q = filterQuery.toLowerCase();
      items = items.filter(g =>
        g.mapped_name.toLowerCase().includes(q) ||
        g.variants.some(v => v.scanned_name.toLowerCase().includes(q))
      );
    }
    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state">
        <div class="empty-icon">&#128218;</div>
        <div>${filterQuery ? 'Ничего не найдено' : 'Соответствия ещё не добавлены'}</div>
      </div></td></tr>`;
      return;
    }
    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    tbody.innerHTML = items.map(g => {
      const total = g.variants.reduce((s, v) => s + (v.times_seen || 0), 0);
      const isExpanded = this.expandedGuid === g.onec_guid;
      const shown = isExpanded ? g.variants : g.variants.slice(0, 3);
      const more = g.variants.length - 3;

      const chips = shown.map(v =>
        `<span class="mapping-chip" title="${esc(v.scanned_name)}">${esc(v.scanned_name)}</span>`
      ).join('');
      const moreHtml = !isExpanded && more > 0
        ? `<span class="mapping-chip mapping-chip-more">+${more}</span>`
        : '';

      let expandedRows = '';
      if (isExpanded) {
        expandedRows = g.variants.map(v => `
          <tr class="mapping-expanded-row">
            <td></td>
            <td>${esc(v.scanned_name)}</td>
            <td style="text-align:right">${v.times_seen || 0}×</td>
            <td><button class="btn-icon-danger" title="Удалить вариант" onclick="Mappings.removeVariant(${v.id}, event)">&#10005;</button></td>
          </tr>
        `).join('');
      }

      return `
        <tr class="clickable" onclick="Mappings.toggleExpand('${esc(g.onec_guid)}')">
          <td><strong>${esc(g.mapped_name)}</strong></td>
          <td>${chips}${moreHtml}</td>
          <td style="text-align:right">${total}×</td>
          <td><span class="expand-arrow">${isExpanded ? '▼' : '▶'}</span></td>
        </tr>
        ${expandedRows}
      `;
    }).join('');
  },

  toggleExpand(guid) {
    this.expandedGuid = this.expandedGuid === guid ? null : guid;
    this.renderGrouped(document.getElementById('mappings-search')?.value || '');
  },

  async removeVariant(id, event) {
    if (event) { event.stopPropagation(); event.preventDefault(); }
    if (!confirm('Удалить этот вариант сопоставления?')) return;
    try {
      const res = await App.api(`/mappings/${id}`, { method: 'DELETE' });
      if (res.ok) {
        App.notify('Вариант удалён', 'success');
        this.loadGrouped();
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  },

  renderUnmapped() {
    const tbody = document.getElementById('unmapped-tbody');
    if (this.unmapped.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3"><div class="empty-state">
        <div class="empty-icon">&#9989;</div>
        <div>Все товары сопоставлены!</div>
      </div></td></tr>`;
      return;
    }
    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    tbody.innerHTML = this.unmapped.map(m => `
      <tr>
        <td>${esc(m.scanned_name)}</td>
        <td>
          <div class="nom-picker">
            <input type="text" class="nom-picker-input" id="unmap-input-${m.id}"
                   placeholder="Начните вводить..."
                   oninput="Mappings.onUnmapInput(${m.id})"
                   onfocus="Mappings.onUnmapInput(${m.id})"
                   onblur="setTimeout(() => { const dd = document.getElementById('unmap-dd-${m.id}'); if(dd) dd.style.display='none'; }, 150)">
            <div class="nom-picker-dropdown" id="unmap-dd-${m.id}"></div>
          </div>
        </td>
        <td><button class="btn btn-sm btn-danger" onclick="Mappings.removeVariant(${m.id}, event)">Удалить</button></td>
      </tr>
    `).join('');
  },

  onUnmapInput(id) {
    const input = document.getElementById(`unmap-input-${id}`);
    const dd = document.getElementById(`unmap-dd-${id}`);
    if (!input || !dd) return;
    const q = input.value.trim();
    if (!q) { dd.style.display = 'none'; return; }
    const results = OnecCatalog.search(q, 10);
    if (results.length === 0) { dd.style.display = 'none'; return; }
    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    dd.innerHTML = results.map(r => `
      <div class="nom-picker-option" data-guid="${esc(r.guid)}" data-name="${esc(r.name)}"
           onmousedown="event.preventDefault(); Mappings.pickUnmap(${id}, '${esc(r.guid)}', '${esc(r.name)}')">
        <strong>${esc(r.name)}</strong>
        ${r.unit ? '<span class="nom-unit">' + esc(r.unit) + '</span>' : ''}
      </div>
    `).join('');
    dd.style.display = 'block';
  },

  async pickUnmap(id, guid, name) {
    try {
      const res = await App.api(`/mappings/${id}`, {
        method: 'PUT',
        body: { mapped_name_1c: name, onec_guid: guid },
      });
      if (res.ok) {
        App.notify(`Сопоставлено: ${name}`, 'success');
        this.loadGrouped();
      }
    } catch (e) {
      App.notify('Ошибка: ' + e.message, 'error');
    }
  },

  // --- Catalog tab (unchanged) ---
  filterCatalog(query) { this.renderCatalog(query); },

  renderCatalog(filterQuery = '') {
    const tbody = document.getElementById('catalog-tbody');
    if (!tbody) return;
    let items = OnecCatalog.items || [];
    if (filterQuery) {
      const q = filterQuery.toLowerCase();
      items = items.filter(it =>
        (it.name || '').toLowerCase().includes(q) ||
        (it.full_name || '').toLowerCase().includes(q) ||
        (it.code || '').toLowerCase().includes(q)
      );
    }
    if (items.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6"><div class="empty-state">
        <div class="empty-icon">&#128230;</div>
        <div>${filterQuery ? 'Ничего не найдено' : 'Справочник пуст.'}</div>
      </div></td></tr>`;
      return;
    }
    tbody.innerHTML = items.map((it, i) => {
      const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const guidShort = it.guid ? it.guid.substring(0, 8) + '…' : '—';
      return `<tr>
        <td>${i + 1}</td>
        <td>${esc(it.code) || '—'}</td>
        <td><strong>${esc(it.name)}</strong></td>
        <td>${esc(it.full_name) || '—'}</td>
        <td>${esc(it.unit) || '—'}</td>
        <td><code style="font-size:11px" title="${esc(it.guid)}">${guidShort}</code></td>
      </tr>`;
    }).join('');
  },
};
```

- [ ] **Step 3: Add CSS for chips and expanded rows**

Add to `public/css/style.css`:

```css
.mapping-chip {
  display: inline-block;
  padding: 2px 8px;
  margin: 2px;
  background: var(--bg, #f1f5f9);
  border: 1px solid var(--border, #e2e8f0);
  border-radius: 12px;
  font-size: 12px;
  color: var(--text, #334155);
  white-space: nowrap;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mapping-chip-more {
  background: var(--primary, #2563eb);
  color: white;
  border-color: var(--primary, #2563eb);
  cursor: pointer;
}
.mapping-expanded-row td {
  background: var(--bg-elevated, #f8fafc);
  border-top: none;
  padding-top: 4px;
  padding-bottom: 4px;
  font-size: 13px;
}
.expand-arrow {
  color: var(--text-muted, #94a3b8);
  font-size: 11px;
}
```

- [ ] **Step 4: Commit**

```bash
git add public/index.html public/js/mappings.js public/css/style.css
git commit -m "feat(ui): grouped mappings view — one 1C item, many variants as chips"
```

---

### Task 6: Remove supplier-related API and DB artifacts

**Files:**
- Modify: `src/api/routes/nomenclature.ts`
- Modify: `src/api/routes/mappings.ts`

- [ ] **Step 1: Remove GET /api/nomenclature/suppliers endpoint**

In `src/api/routes/nomenclature.ts`, remove the `/suppliers` route.

- [ ] **Step 2: Remove supplier filter from GET /api/mappings**

Already done in Task 4 — verify the supplier/unmapped query params are gone.

- [ ] **Step 3: Commit**

```bash
git add src/api/routes/nomenclature.ts src/api/routes/mappings.ts
git commit -m "refactor: remove supplier-related API endpoints"
```

---

### Task 7: Deploy and verify

- [ ] **Step 1: Push to main**

```bash
git push
```

- [ ] **Step 2: Verify on scan.magday.ru**

1. Open Номенклатура tab → "Соответствия" shows grouped table
2. Click a row → expands to show variants with delete buttons
3. Upload a test photo → check that mapping auto-saves
4. "Не сопоставлено" tab → shows unmapped items with picker
5. "Справочник 1С" tab → unchanged, shows catalog

---
