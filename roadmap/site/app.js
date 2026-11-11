'use strict';
// The roadmap page's behaviour (spec 2026-11-11-roadmap-design D6). The page works without it: cards are links to
// #UDX-…, and CSS's :target shows that item's panel. This adds the filters, the theme toggle, Esc to close, focus that
// follows the panel, and closing without a jump to the top.
(function () {
  var root = document.documentElement;
  var body = document.body;
  root.classList.add('js'); // from here the panel follows body.panel-open, not CSS :target (style.css)

  // ---- theme: Auto (the system) → Light → Dark, remembered per visitor ----
  var THEMES = ['auto', 'light', 'dark'];
  var LABELS = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' };
  var KEY = 'udx-roadmap-theme';
  var toggle = document.querySelector('[data-theme-toggle]');
  function current() { return root.dataset.theme || 'auto'; }
  function showTheme() {
    if (!toggle) return;
    toggle.textContent = LABELS[current()];
    toggle.setAttribute('aria-label', 'Colour theme: ' + current() + '. Change it.');
  }
  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = THEMES[(THEMES.indexOf(current()) + 1) % THEMES.length];
      if (next === 'auto') delete root.dataset.theme; else root.dataset.theme = next;
      try { if (next === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, next); } catch (e) { /* private mode */ }
      showTheme();
    });
    showTheme();
  }

  // ---- filters: type AND area ----
  var state = { type: 'all', area: 'all' };
  var items = Array.prototype.slice.call(document.querySelectorAll('.card, .row'));
  function applyFilters() {
    items.forEach(function (el) {
      var show = (state.type === 'all' || el.dataset.type === state.type) && (state.area === 'all' || el.dataset.area === state.area);
      var target = el.classList.contains('row') ? el.parentElement : el;
      target.hidden = !show;
    });
    document.querySelectorAll('.lane').forEach(function (lane) {
      var cards = lane.querySelectorAll('.card');
      var visible = lane.querySelectorAll('.card:not([hidden])').length;
      var count = lane.querySelector('.count');
      if (count) count.textContent = String(visible);
      lane.dataset.filteredEmpty = String(cards.length > 0 && visible === 0);
    });
    document.querySelectorAll('.release').forEach(function (group) {
      group.hidden = group.querySelectorAll('li:not([hidden])').length === 0;
    });
  }
  document.querySelectorAll('[data-filter-type], [data-filter-area]').forEach(function (button) {
    button.addEventListener('click', function () {
      var kind = button.hasAttribute('data-filter-type') ? 'type' : 'area';
      state[kind] = button.getAttribute('data-filter-' + kind);
      button.parentElement.querySelectorAll('button').forEach(function (b) { b.setAttribute('aria-pressed', String(b === button)); });
      applyFilters();
    });
  });

  // ---- the panel: open from the address (#UDX-001), close with ✕ or Esc ----
  var opener = null;
  function article(hash) {
    if (!/^#UDX-\d{3,}$/.test(hash)) return null;
    var el = document.getElementById(hash.slice(1));
    return el && el.classList.contains('detail') ? el : null;
  }
  function sync(focus) {
    var open = article(location.hash);
    document.querySelectorAll('.detail.open').forEach(function (el) { if (el !== open) el.classList.remove('open'); });
    items.forEach(function (el) { el.removeAttribute('aria-current'); });
    body.classList.toggle('panel-open', !!open);
    if (!open) return;
    open.classList.add('open');
    var card = document.querySelector('.card[href="' + location.hash + '"], .row[href="' + location.hash + '"]');
    if (card) card.setAttribute('aria-current', 'true');
    if (focus) open.focus({ preventScroll: window.matchMedia('(min-width: 721px)').matches });
  }
  function close() {
    var id = location.hash;
    history.replaceState(null, '', location.pathname + location.search);
    sync(false);
    var back = opener || document.querySelector('[href="' + id + '"].card, [href="' + id + '"].row');
    if (back) back.focus({ preventScroll: true });
    opener = null;
  }
  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('a');
    if (!link) return;
    if (link.classList.contains('close')) { e.preventDefault(); close(); return; }
    if (link.matches('.card, .row')) opener = link;
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && body.classList.contains('panel-open')) close();
  });
  window.addEventListener('hashchange', function () { sync(true); });
  sync(true);
})();
