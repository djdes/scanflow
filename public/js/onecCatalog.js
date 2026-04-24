/* global App, Fuse, OnecCatalog */
// Client-side cache of Справочник.Номенклатура from the server.
// Used by invoice detail autocomplete and mapping add/edit forms.
const OnecCatalog = {
  items: [],
  fuse: null,
  loaded: false,
  lastSyncedAt: null,

  async load(force = false) {
    if (this.loaded && !force) return;
    try {
      const { data, last_synced_at } = await App.apiJson('/nomenclature?exclude_folders=true');
      this.items = data || [];
      this.lastSyncedAt = last_synced_at;
      // Keep fuse.js around for typo-tolerance, but loosen the threshold so
      // partial matches survive. The primary matcher below is a substring
      // scan — fuse is only a fallback for misspellings.
      this.fuse = new Fuse(this.items, {
        keys: ['name', 'full_name'],
        threshold: 0.5,
        minMatchCharLength: 1,
        ignoreLocation: true,
        includeScore: true,
      });
      this.loaded = true;
    } catch (e) {
      console.error('Failed to load onec catalog', e);
    }
  },

  /**
   * Ranked hybrid search designed so that "Буты" finds "Бутылка" and
   * "подложк d-21" finds "Подложка D-21(квадратная)":
   *
   *  1) Whole-query substring scan (fast path for short one-word queries
   *     like "буты" → "Бутылка …").
   *  2) Token-prefix scan: split the query on whitespace/punctuation, then
   *     require that every token appears as a word-prefix inside the item's
   *     name or full_name. Handles stems like "подложк" / "перчатк" that
   *     aren't full words in the catalog.
   *  3) Code substring scan (for SKU lookups).
   *  4) fuse.js fuzzy results appended for typo-tolerance, skipping guids
   *     already returned above.
   *
   * Names and queries are normalised through _normalize() so noisy scan
   * prefixes ("М/с ", "Ч/с ") and punctuation (slashes, parens, dashes)
   * never block a match.
   */
  search(query, limit = 10) {
    if (!this.items.length || !query) return [];
    const q = String(query).trim().toLowerCase();
    if (!q) return [];
    const qNorm = this._normalize(q);
    const tokens = qNorm.split(' ').filter((t) => t.length > 0);

    const seen = new Set();
    const hits = [];

    for (const item of this.items) {
      const name = (item.name || '').toLowerCase();
      const full = (item.full_name || '').toLowerCase();
      const code = (item.code || '').toLowerCase();
      const nameNorm = this._normalize(name);
      const fullNorm = this._normalize(full);

      let score = 0;

      // (1) whole-query substring — strongest signal.
      if (name.startsWith(q) || nameNorm.startsWith(qNorm)) score = 1.0;
      else if (new RegExp('(^|\\s)' + this._escapeRegex(qNorm)).test(nameNorm)) score = 0.9;
      else if (nameNorm.includes(qNorm)) score = 0.8;
      else if (fullNorm.includes(qNorm)) score = 0.65;

      // (2) token-prefix: every token must appear as a word-prefix somewhere
      // in name or full_name. Lets stems match inflected forms.
      if (score === 0 && tokens.length >= 1) {
        const nameTokens = nameNorm.split(' ');
        const fullTokens = fullNorm.split(' ');
        const allHit = tokens.every(
          (t) =>
            nameTokens.some((nt) => nt.startsWith(t)) ||
            fullTokens.some((ft) => ft.startsWith(t)),
        );
        if (allHit) {
          // Slightly prefer hits that come from `name` over `full_name`.
          const inName = tokens.every((t) => nameTokens.some((nt) => nt.startsWith(t)));
          score = inName ? 0.75 : 0.55;
        }
      }

      // (3) fallback: code match.
      if (score === 0 && code && code.includes(q)) score = 0.5;

      if (score > 0) {
        hits.push({
          guid: item.guid,
          name: item.name,
          full_name: item.full_name,
          unit: item.unit,
          confidence: score,
        });
        seen.add(item.guid);
      }
    }

    hits.sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));

    // (4) fuse.js fuzzy for typos, only if we still have headroom.
    if (hits.length < limit && this.fuse) {
      const fuseHits = this.fuse.search(q, { limit: limit * 2 });
      for (const r of fuseHits) {
        if (seen.has(r.item.guid)) continue;
        hits.push({
          guid: r.item.guid,
          name: r.item.name,
          full_name: r.item.full_name,
          unit: r.item.unit,
          confidence: Math.max(0.1, 1 - (r.score || 1)),
        });
        if (hits.length >= limit) break;
      }
    }

    return hits.slice(0, limit);
  },

  // Strip noisy scan-side prefixes ("М/с", "Ч/с", "с/с", "м/с") and collapse
  // punctuation to spaces. Short (≤2 char) tokens that look like size/class
  // markers get Cyrillic→Latin transliteration — "М" (Cyrillic) vs "M"
  // (Latin) otherwise never match, and 1C catalogs mix both encodings.
  // Limited to short tokens so "мясо" never becomes "mясо".
  _normalize(s) {
    let out = String(s).toLowerCase();
    // Strip noisy "X/с" prefixes (м/с — моющее средство, ч/с — чистящее,
    // с/с — стиральное). \b doesn't fire reliably around Cyrillic in JS
    // regexes without the /u flag, so anchor explicitly on start/whitespace.
    out = out.replace(/(^|\s)[мчс]\/с(\s|$)/g, '$1$2');
    out = out.replace(/[.,;:()\[\]/\\-]+/g, ' ');
    out = out.replace(/\s+/g, ' ').trim();
    const map = { а: 'a', с: 'c', е: 'e', о: 'o', р: 'p', х: 'x', у: 'y',
                  т: 't', м: 'm', н: 'h', к: 'k', в: 'b', і: 'i', ѕ: 's' };
    return out
      .split(' ')
      .map((tok) => {
        if (tok.length > 2) return tok;
        let r = '';
        for (const ch of tok) r += map[ch] || ch;
        return r;
      })
      .join(' ');
  },

  _escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  },

  getByGuid(guid) {
    return this.items.find(it => it.guid === guid) || null;
  },

  isEmpty() {
    return this.loaded && this.items.length === 0;
  },
};
