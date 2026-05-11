(function () {
  'use strict';
  var chips = document.querySelectorAll('.blog-tag-chip');
  var cards = document.querySelectorAll('#blog-grid .blog-card');
  if (!chips.length || !cards.length) return;

  chips.forEach(function (chip) {
    chip.addEventListener('click', function () {
      var tag = chip.dataset.tag;
      chips.forEach(function (c) { c.setAttribute('aria-pressed', c === chip ? 'true' : 'false'); });
      cards.forEach(function (card) {
        if (tag === 'all') { card.style.display = ''; return; }
        var tags = card.querySelectorAll('.blog-card-tag') || [];
        var match = false;
        tags.forEach(function (t) {
          if (t.dataset && t.dataset.tag === tag) match = true;
        });
        // Fallback: match by visible label text if data-tag isn't present yet.
        if (!match) {
          tags.forEach(function (t) {
            if (t.textContent && t.textContent.trim().toLowerCase() === chip.textContent.trim().toLowerCase()) match = true;
          });
        }
        card.style.display = match ? '' : 'none';
      });
    });
  });
})();
