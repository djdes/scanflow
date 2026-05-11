(function () {
  'use strict';

  // Reading progress bar.
  var bar = document.getElementById('read-progress');
  if (bar) {
    function update() {
      var docHeight = document.documentElement.scrollHeight - window.innerHeight;
      var pct = docHeight > 0 ? (window.scrollY / docHeight) * 100 : 0;
      bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
    }
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    update();
  }

  // ToC scroll-spy: highlight currently-visible H2.
  var tocLinks = document.querySelectorAll('.article-toc a');
  if (tocLinks.length) {
    var sectionIds = Array.from(tocLinks).map(function (a) { return a.getAttribute('href').slice(1); });
    var sections = sectionIds.map(function (id) { return document.getElementById(id); }).filter(Boolean);

    function refresh() {
      var y = window.scrollY + 130;
      var current = sections[0];
      for (var i = 0; i < sections.length; i++) {
        if (sections[i].offsetTop <= y) current = sections[i]; else break;
      }
      tocLinks.forEach(function (a) {
        a.classList.toggle('current', a.getAttribute('href') === '#' + current.id);
      });
    }
    window.addEventListener('scroll', refresh, { passive: true });
    refresh();
  }
})();
