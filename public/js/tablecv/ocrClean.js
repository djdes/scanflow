// public/js/tablecv/ocrClean.js
var TableCVOcrClean = (typeof window !== 'undefined' ? (window.TableCVOcrClean = {}) : {});
(function (g) {
  const hasAlnum = (s) => /[\p{L}\p{N}]/u.test(s);
  const numericish = (s) => {
    const t = s.replace(/\s/g, '');
    if (!t) return false;
    const digits = (t.match(/[0-9.,\-]/g) || []).length;
    return digits / t.length >= 0.6;
  };

  g.cleanCellText = function (text, confidence, opts) {
    const minConf = (opts && opts.minConf != null) ? opts.minConf : 45;
    if (typeof confidence === 'number' && confidence < minConf) return '';
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!hasAlnum(t)) return '';
    return t;
  };

  // Intended for NUMERIC columns only (caller gates via isLikelyNumericColumn).
  // The O->0 / l->1 substitutions WILL mangle mixed alphanumeric codes (SKUs),
  // so do not apply this to text/article columns.
  g.normalizeNumeric = function (text) {
    const t = String(text || '');
    if (!numericish(t)) return t;
    let s = t
      .replace(/[OoОо]/g, '0')
      .replace(/[lI]/g, '1')
      .replace(/(?<=\d)\.(?=\d)/g, ',') // dot decimal separator -> comma (RU format)
      .replace(/^[^\d\-]+/, '')   // strip leading junk before first digit/minus
      .replace(/[^\d\-]+$/, '')   // strip trailing junk
      .replace(/\s+/g, ' ')
      .trim();
    return s;
  };

  g.isLikelyNumericColumn = function (texts) {
    const nonEmpty = (texts || []).filter((t) => t && t.trim());
    if (nonEmpty.length === 0) return false;
    const num = nonEmpty.filter(numericish).length;
    return num / nonEmpty.length >= 0.6;
  };
})(TableCVOcrClean);
if (typeof module !== 'undefined' && module.exports) { module.exports = TableCVOcrClean; }
