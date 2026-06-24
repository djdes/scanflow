/* global cv */
const TableCVOverlay = {
  draw(canvasId, baseMat, cells, hoverIndex) {
    cv.imshow(canvasId, baseMat);
    const canvas = document.getElementById(canvasId);
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2;
    ctx.font = '14px sans-serif';
    cells.forEach((c, i) => {
      ctx.strokeStyle = (i === hoverIndex) ? '#e74c3c' : '#2ecc71';
      ctx.strokeRect(c.x, c.y, c.w, c.h);
      if (i === hoverIndex) {
        ctx.fillStyle = 'rgba(231,76,60,0.18)';
        ctx.fillRect(c.x, c.y, c.w, c.h);
      }
      ctx.fillStyle = '#2ecc71';
      ctx.fillText(String(i), c.x + 2, c.y + 14);
    });
  },
};
