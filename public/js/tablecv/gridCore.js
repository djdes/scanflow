var TableCVGrid = (typeof window !== 'undefined' ? (window.TableCVGrid = {}) : {});

(function (g) {
  g.clusterCoords = function (values, tol) {
    if (!values || values.length === 0) return [];
    const sorted = values.slice().sort((a, b) => a - b);
    const clusters = [];
    let bucket = [sorted[0]];
    let mean = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - mean <= tol) {
        bucket.push(sorted[i]);
        mean = bucket.reduce((s, v) => s + v, 0) / bucket.length;
      } else {
        clusters.push(Math.floor(mean));
        bucket = [sorted[i]];
        mean = sorted[i];
      }
    }
    clusters.push(Math.floor(mean));
    return clusters;
  };

  // Union-find over base cells; edge exists where the separating border is absent.
  g.mergeCells = function (R, C, vBorder, hBorder) {
    const parent = new Array(R * C);
    for (let i = 0; i < parent.length; i++) parent[i] = i;
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
    const idx = (r, c) => r * C + c;

    for (let r = 0; r < R; r++) {
      for (let c = 1; c < C; c++) {
        if (!vBorder[r][c]) union(idx(r, c - 1), idx(r, c));
      }
    }
    for (let r = 1; r < R; r++) {
      for (let c = 0; c < C; c++) {
        if (!hBorder[r][c]) union(idx(r - 1, c), idx(r, c));
      }
    }

    const boxes = {};
    for (let r = 0; r < R; r++) {
      for (let c = 0; c < C; c++) {
        const root = find(idx(r, c));
        const b = boxes[root];
        if (!b) boxes[root] = { r0: r, c0: c, r1: r, c1: c };
        else {
          b.r0 = Math.min(b.r0, r); b.c0 = Math.min(b.c0, c);
          b.r1 = Math.max(b.r1, r); b.c1 = Math.max(b.c1, c);
        }
      }
    }
    return Object.values(boxes);
  };

  g.regionsToCells = function (regions, xs, ys) {
    return regions.map((rg) => {
      const x = xs[rg.c0];
      const y = ys[rg.r0];
      const w = xs[rg.c1 + 1] - x;
      const h = ys[rg.r1 + 1] - y;
      return {
        row: rg.r0, col: rg.c0,
        rowSpan: rg.r1 - rg.r0 + 1, colSpan: rg.c1 - rg.c0 + 1,
        x, y, w, h, text: '',
      };
    });
  };
})(TableCVGrid);

if (typeof module !== 'undefined' && module.exports) { module.exports = TableCVGrid; }
