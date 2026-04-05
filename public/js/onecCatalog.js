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
      this.fuse = new Fuse(this.items, {
        keys: ['name', 'full_name'],
        threshold: 0.3,
        minMatchCharLength: 2,
        includeScore: true,
      });
      this.loaded = true;
    } catch (e) {
      console.error('Failed to load onec catalog', e);
    }
  },

  search(query, limit = 10) {
    if (!this.fuse || !query) return [];
    return this.fuse.search(query, { limit }).map(r => ({
      guid: r.item.guid,
      name: r.item.name,
      full_name: r.item.full_name,
      unit: r.item.unit,
      confidence: 1 - (r.score || 1),
    }));
  },

  getByGuid(guid) {
    return this.items.find(it => it.guid === guid) || null;
  },

  isEmpty() {
    return this.loaded && this.items.length === 0;
  },
};
