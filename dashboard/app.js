// Launch Radar's page: a sortable, filterable board, a detail view per protocol
// and a live-token view, all rendered from window.RADAR in data.js. No fetch,
// no network, no links out: the page only ever reads its own dataset.
//
// Views are hash-routed so a screenshot can open one directly:
//   (empty)                  the board
//   #/protocol/<slug>        one protocol's detail view
//   #/live                   the live-token view
//   #/?category=Dexs         the board, filtered on load
//   #/?chain=Solana&q=stak   the board, filtered on load

(function () {
  'use strict';

  var app = document.getElementById('app');
  var DATA = window.RADAR;

  if (!DATA || !Array.isArray(DATA.rows)) {
    app.setAttribute('aria-busy', 'false');
    app.innerHTML = '<div class="wrap"><p>Launch Radar could not load its data.</p></div>';
    return;
  }

  var state = {
    sortKey: 'rank',
    sortDir: 1,
    q: '',
    category: '',
    chain: '',
    minTvl: 0,
    watchlistOnly: false,
  };

  /** HTML-escape a string from the data. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** $1.24B, $45.3M, $820K, $512. */
  function money(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }

  /** +12.4%, -8.2%, or an em dash when unreported. */
  function pct(v) {
    if (v == null || !isFinite(v)) return '—';
    var sign = v > 0 ? '+' : '';
    return sign + v.toFixed(1) + '%';
  }

  function pctClass(v) {
    if (v == null) return '';
    return v > 0 ? 'up' : v < 0 ? 'down' : '';
  }

  /** 412d, or an em dash when the listing date is unknown. */
  function ageText(days) {
    if (days == null) return '—';
    if (days < 365) return days + 'd';
    var y = Math.floor(days / 365);
    var rest = days % 365;
    return y + 'y ' + rest + 'd';
  }

  /** Whether a row is on the snapshot's watchlist (flagged by the builder). */
  function isWatchlist(row) {
    return row.on_watchlist === true;
  }

  /** Parse location.hash into a view and its filters. */
  function parseHash() {
    var raw = (location.hash || '').replace(/^#\/?/, '');
    var parts = raw.split('?');
    var path = parts[0] || '';
    var query = {};
    if (parts[1]) {
      parts[1].split('&').forEach(function (pair) {
        var kv = pair.split('=');
        if (kv[0]) query[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
      });
    }
    if (path.indexOf('protocol/') === 0) return { view: 'detail', slug: path.slice('protocol/'.length), query: query };
    if (path === 'live') return { view: 'live', slug: null, query: query };
    return { view: 'board', slug: null, query: query };
  }

  function applyQuery(query) {
    if (query.category) state.category = query.category;
    if (query.chain) state.chain = query.chain;
    if (query.q) state.q = query.q;
    if (query.minTvl) state.minTvl = Number(query.minTvl) || 0;
    if (query.watchlist) state.watchlistOnly = query.watchlist === '1';
  }

  function filteredRows() {
    var q = state.q.trim().toLowerCase();
    return DATA.rows.filter(function (r) {
      if (state.watchlistOnly && !isWatchlist(r)) return false;
      if (state.category && r.category !== state.category) return false;
      if (state.chain && r.chains.indexOf(state.chain) === -1) return false;
      if (state.minTvl && r.tvl_usd < state.minTvl) return false;
      if (q && r.name.toLowerCase().indexOf(q) === -1 && r.slug.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }

  function sortRows(rows) {
    var key = state.sortKey;
    var dir = state.sortDir;
    var val = {
      rank: function (r) { return r.rank; },
      tvl: function (r) { return r.tvl_usd; },
      change: function (r) { return r.change_7d == null ? -Infinity : r.change_7d; },
      age: function (r) { return r.age_days == null ? -1 : r.age_days; },
      value: function (r) { return r.implied_value_usd; },
    }[key];
    return rows.slice().sort(function (a, b) {
      var d = (val(a) - val(b)) * dir;
      if (d !== 0) return d;
      return a.rank - b.rank;
    });
  }

  function categories() {
    var seen = {};
    DATA.rows.forEach(function (r) { if (r.category) seen[r.category] = true; });
    return Object.keys(seen).sort();
  }

  function chains() {
    var seen = {};
    DATA.rows.forEach(function (r) { r.chains.forEach(function (c) { seen[c] = true; }); });
    return Object.keys(seen).sort();
  }

  function options(list, current, allLabel) {
    var html = '<option value="">' + esc(allLabel) + '</option>';
    list.forEach(function (v) {
      html += '<option value="' + esc(v) + '"' + (v === current ? ' selected' : '') + '>' + esc(v) + '</option>';
    });
    return html;
  }

  function masthead(active) {
    return '<header class="masthead">' +
      '<div><div class="kicker">Token launch radar</div>' +
      '<h1>Launch Radar</h1>' +
      '<p class="sub">Pre-token protocols ranked by what a launch would be worth, worked out from the snapshot\u2019s own figures: TVL, seven-day growth, and time running with no token.</p></div>' +
      '<div class="asof">Snapshot <b>' + esc(DATA.as_of) + '</b><br>' + esc(DATA.source) + '</div>' +
      '</header>' +
      '<section class="stats">' +
      '<div class="stat"><div class="label">Board rows</div><div class="value num">' + DATA.board_size + '</div><div class="note">ranked pre-token protocols</div></div>' +
      '<div class="stat"><div class="label">Watchlist</div><div class="value num">' + DATA.watchlist_size + '</div><div class="note">covered in full, the floor</div></div>' +
      '<div class="stat"><div class="label">Early finds</div><div class="value num">' + DATA.early_size + '</div><div class="note">below the $50M floor, by value</div></div>' +
      '<div class="stat"><div class="label">Live tokens</div><div class="value num">' + DATA.live_size + '</div><div class="note">already trading, set aside</div></div>' +
      '</section>' +
      '<nav class="tabs">' +
      '<a class="tab" href="#/"' + (active === 'board' ? ' aria-current="page"' : '') + '>Board</a>' +
      '<a class="tab" href="#/live"' + (active === 'live' ? ' aria-current="page"' : '') + '>Live tokens</a>' +
      '</nav>';
  }

  function modelNote() {
    var m = DATA.model;
    var bands = m.size_bands.map(function (b) {
      var ceiling = isFinite(b.below_usd) ? money(b.below_usd) : 'above';
      return 'under ' + ceiling + ' \u00d7 ' + b.multiple;
    }).join(', ');
    return '<section class="modelnote"><h2>How the value is worked out</h2>' +
      '<p>Implied value = TVL \u00d7 size multiple \u00d7 growth factor \u00d7 age factor. ' +
      'Size multiple by TVL band: ' + esc(bands) + '. ' +
      'Growth factor = 1 + clamp(7-day change, ' + m.growth_floor_pct + '%, ' + m.growth_cap_pct + '%) \u00d7 ' + m.growth_weight + '. ' +
      'Age factor = ' + m.age_floor + ' + ' + m.age_range + ' \u00d7 min(age, ' + m.age_cap_days + ' days) / ' + m.age_cap_days + ' days' +
      (m.unknown_age_days ? ' (unknown age counts as ' + m.unknown_age_days + ' days)' : '') + '. ' +
      'Model <code>' + esc(DATA.model_label) + '</code>. A board\u2019s implied value is this entry\u2019s own claim, never a prediction that a token will launch.</p></section>';
  }

  function footer() {
    return '<p class="foot">Snapshot ' + esc(DATA.as_of) + ' \u00b7 watchlist floor ' + money(DATA.floor_usd) +
      ' \u00b7 ' + DATA.board_size + ' rows \u00b7 pre-token means the snapshot records no token: no market cap, no CoinGecko id, no symbol.</p>';
  }

  function sortArrow(key) {
    if (state.sortKey !== key) return '';
    return state.sortDir === 1 ? ' \u25b2' : ' \u25bc';
  }

  function renderBoard() {
    var rows = sortRows(filteredRows());
    var shown = rows.slice(0, 100);
    var html = '<div class="wrap">' + masthead('board') +
      '<div class="filters">' +
      '<input type="search" id="f-q" placeholder="Search name or slug" value="' + esc(state.q) + '" aria-label="Search">' +
      '<select id="f-cat" aria-label="Category">' + options(categories(), state.category, 'All categories') + '</select>' +
      '<select id="f-chain" aria-label="Chain">' + options(chains(), state.chain, 'All chains') + '</select>' +
      '<select id="f-tvl" aria-label="Minimum TVL">' +
      '<option value="0"' + (state.minTvl === 0 ? ' selected' : '') + '>Any TVL</option>' +
      '<option value="100000000"' + (state.minTvl === 100000000 ? ' selected' : '') + '>\u2265 $100M TVL</option>' +
      '<option value="500000000"' + (state.minTvl === 500000000 ? ' selected' : '') + '>\u2265 $500M TVL</option>' +
      '<option value="1000000000"' + (state.minTvl === 1000000000 ? ' selected' : '') + '>\u2265 $1B TVL</option>' +
      '</select>' +
      '<label><input type="checkbox" id="f-wl"' + (state.watchlistOnly ? ' checked' : '') + '> Watchlist only</label>' +
      '<span class="count">' + rows.length + ' of ' + DATA.board_size + ' rows</span>' +
      '</div>';
    if (shown.length === 0) {
      html += '<div class="empty">Nothing matches these filters. Clear one and try again.</div>';
    } else {
      html += '<table class="board"><thead><tr>' +
        '<th class="sortable" data-sort="rank">Rank' + sortArrow('rank') + '</th>' +
        '<th>Protocol</th><th>Category</th><th>Chains</th>' +
        '<th class="sortable value" data-sort="tvl">TVL' + sortArrow('tvl') + '</th>' +
        '<th class="sortable value" data-sort="change">7d' + sortArrow('change') + '</th>' +
        '<th class="sortable value age" data-sort="age">Age' + sortArrow('age') + '</th>' +
        '<th class="sortable value" data-sort="value">Implied value' + sortArrow('value') + '</th>' +
        '</tr></thead><tbody>';
      shown.forEach(function (r) {
        html += '<tr data-slug="' + esc(r.slug) + '">' +
          '<td class="rank"><b>#' + r.rank + '</b>' + (isWatchlist(r) ? ' <span class="watch">WATCHLIST</span>' : '') + '</td>' +
          '<td><div class="name">' + esc(r.name) + '</div><div class="slug">' + esc(r.slug) + '</div></td>' +
          '<td><span class="pill">' + esc(r.category || '—') + '</span></td>' +
          '<td>' + esc(r.chains.slice(0, 2).join(', ') || '—') + (r.chains.length > 2 ? ' +' + (r.chains.length - 2) : '') + '</td>' +
          '<td class="tvl num">' + money(r.tvl_usd) + '</td>' +
          '<td class="growth num ' + pctClass(r.change_7d) + '">' + pct(r.change_7d) + '</td>' +
          '<td class="age num">' + ageText(r.age_days) + '</td>' +
          '<td class="value">' + money(r.implied_value_usd) + '</td>' +
          '</tr>';
      });
      html += '</tbody></table>';
      if (rows.length > shown.length) {
        html += '<p class="foot">Showing the first ' + shown.length + ' of ' + rows.length + ' matching rows — narrow the filters to see the rest.</p>';
      }
    }
    html += modelNote() + footer() + '</div>';
    app.innerHTML = html;
    app.setAttribute('aria-busy', 'false');
    bindBoard();
  }

  function bindBoard() {
    var q = document.getElementById('f-q');
    if (q) q.addEventListener('input', function () { state.q = q.value; renderBoardKeepFocus(); });
    var cat = document.getElementById('f-cat');
    if (cat) cat.addEventListener('change', function () { state.category = cat.value; renderBoard(); });
    var chain = document.getElementById('f-chain');
    if (chain) chain.addEventListener('change', function () { state.chain = chain.value; renderBoard(); });
    var tvl = document.getElementById('f-tvl');
    if (tvl) tvl.addEventListener('change', function () { state.minTvl = Number(tvl.value) || 0; renderBoard(); });
    var wl = document.getElementById('f-wl');
    if (wl) wl.addEventListener('change', function () { state.watchlistOnly = wl.checked; renderBoard(); });
    Array.prototype.forEach.call(document.querySelectorAll('th.sortable'), function (th) {
      th.addEventListener('click', function () {
        var key = th.getAttribute('data-sort');
        if (state.sortKey === key) {
          state.sortDir = -state.sortDir;
        } else {
          state.sortKey = key;
          state.sortDir = key === 'rank' ? 1 : -1;
        }
        renderBoard();
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('tr[data-slug]'), function (tr) {
      tr.addEventListener('click', function () {
        location.hash = '#/protocol/' + tr.getAttribute('data-slug');
      });
    });
  }

  /** Re-render the board without dropping the search box's focus. */
  function renderBoardKeepFocus() {
    var pos = null;
    var q = document.getElementById('f-q');
    if (q) pos = q.selectionStart;
    renderBoard();
    var q2 = document.getElementById('f-q');
    if (q2) {
      q2.focus();
      if (pos != null) q2.setSelectionRange(pos, pos);
    }
  }

  /** Split one farm step "action Cost: ... Time: ..." into its three parts. */
  function splitStep(s) {
    var costAt = s.indexOf(' Cost: ');
    var timeAt = s.indexOf(' Time: ');
    if (costAt === -1 || timeAt === -1 || timeAt < costAt) return { action: s, cost: '', time: '' };
    return {
      action: s.slice(0, costAt),
      cost: s.slice(costAt + 7, timeAt),
      time: s.slice(timeAt + 7).replace(/\.$/, ''),
    };
  }

  function renderDetail(slug) {
    var row = null;
    DATA.rows.forEach(function (r) { if (r.slug === slug) row = r; });
    if (!row) {
      app.innerHTML = '<div class="wrap"><p>No protocol <b>' + esc(slug) + '</b> on this board.</p><p><a href="#/">Back to the board</a></p></div>';
      app.setAttribute('aria-busy', 'false');
      return;
    }
    var base = row.tvl_usd * row.size_multiple;
    var steps = row.farm_steps.map(function (s) {
      var p = splitStep(s);
      return '<li><div>' + esc(p.action) + '</div>' +
        (p.cost || p.time ? '<div class="cost">Cost: ' + esc(p.cost) + (p.time ? ' \u00b7 Time: ' + esc(p.time) : '') + '</div>' : '') +
        '</li>';
    }).join('');
    var html = '<div class="wrap">' + masthead('board') +
      '<section class="detail"><a class="back" href="#/">&larr; Back to the board</a>' +
      '<div class="head"><div>' +
      '<h2>' + esc(row.name) + ' <span class="pill">#' + row.rank + '</span>' +
      (isWatchlist(row) ? ' <span class="watch">ON THE WATCHLIST</span>' : '') + '</h2>' +
      '<p class="meta">' + esc(row.slug) + ' \u00b7 ' + esc(row.category || 'no category') + ' \u00b7 ' +
      esc(row.chains.join(', ') || 'no chain listed') + ' \u00b7 listed ' + esc(row.listed_at || 'unknown') + '</p>' +
      '</div><div><div class="big num">' + money(row.implied_value_usd) + '</div><div class="meta">implied launch value</div></div></div>' +
      '<div class="grid"><div class="card"><h3>The value, step by step</h3><div class="math">' +
      '<div class="row"><span>TVL</span><span>' + money(row.tvl_usd) + '</span></div>' +
      '<div class="row"><span>Size multiple</span><span>\u00d7 ' + row.size_multiple + '</span></div>' +
      '<div class="row"><span>Base (TVL \u00d7 multiple)</span><span>' + money(base) + '</span></div>' +
      '<div class="row"><span>7-day change</span><span class="' + pctClass(row.change_7d) + '">' + pct(row.change_7d) + '</span></div>' +
      '<div class="row"><span>Growth factor</span><span>\u00d7 ' + row.growth_factor + '</span></div>' +
      '<div class="row"><span>Age</span><span>' + ageText(row.age_days) + '</span></div>' +
      '<div class="row"><span>Age factor</span><span>\u00d7 ' + row.age_factor + '</span></div>' +
      '<div class="row total"><span>Implied value</span><span>' + money(row.implied_value_usd) + '</span></div>' +
      '</div></div>' +
      '<div class="card"><h3>Why it ranks here</h3>' +
      '<p class="meta">Rank #' + row.rank + ' of ' + DATA.board_size + '. ' +
      (isWatchlist(row) ? 'It is on the snapshot\u2019s watchlist: at or above the ' + money(DATA.floor_usd) + ' floor, recording no token.' :
        'It sits below the watchlist floor and earned its place on implied value alone.') +
      ' The snapshot records no token for it — no market cap, no CoinGecko id, no symbol — so the board treats it as pre-token.</p></div></div>' +
      '<h3 style="margin-top:20px">How to farm it</h3><ol class="steps">' + steps + '</ol>' +
      '<p class="foot">A farm plan is a plan, not a promise: a token may never launch, and a launch may be worth nothing. Never pay to claim.</p>' +
      '</section>' + modelNote() + footer() + '</div>';
    app.innerHTML = html;
    app.setAttribute('aria-busy', 'false');
  }

  function renderLive() {
    var html = '<div class="wrap">' + masthead('live') +
      '<p class="sub" style="color:var(--muted);margin-bottom:14px">These protocols already trade. The board keeps them apart and shows the market\u2019s own value — a market cap — instead of a model\u2019s guess.</p>' +
      '<table class="board"><thead><tr><th>#</th><th>Protocol</th><th>Category</th><th>Chains</th>' +
      '<th class="value">TVL</th><th class="value">Market cap</th><th class="value">7d</th></tr></thead><tbody>';
    DATA.live.forEach(function (r, i) {
      html += '<tr><td class="rank"><b>#' + (i + 1) + '</b></td>' +
        '<td><div class="name">' + esc(r.name) + '</div><div class="slug">' + esc(r.slug) + '</div></td>' +
        '<td><span class="pill">' + esc(r.category || '—') + '</span></td>' +
        '<td>' + esc(r.chains.slice(0, 2).join(', ') || '—') + '</td>' +
        '<td class="tvl num">' + money(r.tvl_usd) + '</td>' +
        '<td class="value">' + money(r.mcap_usd) + '</td>' +
        '<td class="growth num ' + pctClass(r.change_7d) + '">' + pct(r.change_7d) + '</td></tr>';
    });
    html += '</tbody></table>' + modelNote() + footer() + '</div>';
    app.innerHTML = html;
    app.setAttribute('aria-busy', 'false');
  }

  function route() {
    var parsed = parseHash();
    applyQuery(parsed.query);
    if (parsed.view === 'detail') renderDetail(parsed.slug);
    else if (parsed.view === 'live') renderLive();
    else renderBoard();
  }

  window.addEventListener('hashchange', route);
  route();
})();
