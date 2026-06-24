var TableCVExport = (typeof window !== 'undefined' ? (window.TableCVExport = {}) : {});

(function (g) {
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  g.cellsToJSON = function (cells, meta) {
    return JSON.stringify({ meta: meta || {}, cells: cells }, null, 2);
  };

  g.cellsToHTMLTable = function (cells) {
    const byRow = {};
    let maxRow = 0;
    cells.forEach((c) => {
      (byRow[c.row] = byRow[c.row] || []).push(c);
      if (c.row > maxRow) maxRow = c.row;
    });
    let html = '<table class="tablecv-result">';
    for (let r = 0; r <= maxRow; r++) {
      const row = (byRow[r] || []).slice().sort((a, b) => a.col - b.col);
      if (row.length === 0) continue;
      html += '<tr>';
      row.forEach((c) => {
        const cs = c.colSpan > 1 ? ` colspan="${c.colSpan}"` : '';
        const rs = c.rowSpan > 1 ? ` rowspan="${c.rowSpan}"` : '';
        html += `<td${cs}${rs}>${esc(c.text)}</td>`;
      });
      html += '</tr>';
    }
    return html + '</table>';
  };
})(TableCVExport);

if (typeof module !== 'undefined' && module.exports) { module.exports = TableCVExport; }
