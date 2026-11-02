/* deadjams app, version 2026.11.2 */
const APP_VERSION = '2026.11.5';
// Page scrolling goes through these, since iPhone browsers scroll an inner frame instead of the window
const innerScroll = () => document.documentElement.classList.contains('inner-scroll');
const getY = () => innerScroll() ? document.getElementById('page').scrollTop : window.scrollY;
function setY(y, smooth){ const o = { top: y, behavior: smooth ? 'smooth' : 'auto' }; if (innerScroll()) document.getElementById('page').scrollTo(o); else window.scrollTo(o); }
(() => {
'use strict';
const API = 'https://archive.org';
const FIRST = 1965, LAST = 1995;
const FIELDS = ['identifier','title','date','venue','coverage','avg_rating','num_reviews','source','downloads'];

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const one = v => Array.isArray(v) ? v[0] : v;
const store = {
  get(k, d){ try { const v = localStorage.getItem('taperoom:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v){ try { localStorage.setItem('taperoom:' + k, JSON.stringify(v)); } catch {} }
};

const state = {
  mode: 'year', year: store.get('year', 1977), label: '',
  shows: [], loading: false, error: null,
  verLen: {}, filter: '', sort: 'rating', sortAuto: false, song: null, recOpen: false, car: false,
  current: null, sourceId: null, meta: null, metaError: null, tab: 'setlist', allReviews: false,
  queue: null
};
const yearCache = new Map(), metaCache = new Map(), songCache = new Map();
const norm = x => String(x || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

/* ---------- helpers ---------- */
async function fetchJSON(url, ms = 20000){
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { signal: c.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
// Fallback: archive.org also answers JSONP, which works even where fetch() is blocked (e.g. a file opened from disk).
function jsonp(url, ms = 20000){
  return new Promise((res, rej) => {
    const cb = '__tr' + Math.random().toString(36).slice(2);
    const s = document.createElement('script');
    const t = setTimeout(() => { done(); rej(new Error('timeout')); }, ms);
    function done(){ clearTimeout(t); window[cb] = () => {}; s.remove(); }
    window[cb] = d => { done(); res(d); };
    s.onerror = () => { done(); rej(new Error('jsonp failed')); };
    s.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cb;
    document.head.appendChild(s);
  });
}
async function getJSON(url){
  try { return await fetchJSON(url); }
  catch (e) { console.warn('fetch failed, trying JSONP', e); return await jsonp(url); }
}
async function search(q, rows = 3000, sort = 'date asc'){
  const p = new URLSearchParams({ q, rows: String(rows), page: '1', output: 'json' });
  FIELDS.forEach(f => p.append('fl[]', f));
  p.append('sort[]', sort);
  const data = await getJSON(`${API}/advancedsearch.php?${p}`);
  return data.response?.docs || [];
}
function parts(d){ const [y, m, dd] = d.slice(0, 10).split('-').map(Number); return { y, m, d: dd }; }
function validDate(d){ const p = parts(d); return p.m >= 1 && p.m <= 12 && p.d >= 1; }
function toDate(d){ const p = parts(d); return new Date(Date.UTC(p.y, p.m - 1, p.d)); }
function fmt(d, opts){ return validDate(d) ? toDate(d).toLocaleDateString(undefined, { timeZone: 'UTC', ...opts }) : d.slice(0, 10); }
const fmtLong = d => fmt(d, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
const fmtShort = d => fmt(d, { month: 'short', day: 'numeric' });
const fmtDow = d => validDate(d) ? fmt(d, { weekday: 'short' }) : '';
function clock(s){ s = Math.max(0, Math.floor(s || 0)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2,'0')}:${x}` : `${m}:${x}`; }
function parseLen(v){ if (v == null) return 0; v = String(v); if (v.includes(':')) return v.split(':').map(Number).reduce((a, n) => a * 60 + n, 0); return parseFloat(v) || 0; }
function starHTML(r){ return `<span class="stars" role="img" aria-label="${r ? r.toFixed(1) + ' out of 5 stars' : 'No ratings'}"><span style="width:${(r / 5) * 100}%"></span></span>`; }
function htmlToText(h){
  if (!h) return '';
  if (Array.isArray(h)) h = h.join('\n');
  const prepped = String(h).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d|tr)>/gi, '\n');
  const doc = new DOMParser().parseFromString(prepped, 'text/html');
  return (doc.body.textContent || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
function kind(s){
  const t = `${one(s.source) || ''} ${s.identifier}`.toLowerCase();
  if (/matrix|\bmtx\b/.test(t)) return 'Matrix';
  if (/sbd|soundboard/.test(t)) return 'Soundboard';
  if (/\baud\b|audience|\bfob\b|\bmics?\b|schoeps|nakamichi|neumann|sennheiser|\bakg\b|beyer|sony ecm|\becm-?\d/.test(t)) return 'Audience';
  return 'Recording';
}
const score = s => s.rating * Math.min(1, Math.log10(s.reviews + 1) / 1.2) + Math.log10(s.dl + 1) * 0.05;

// Some nights had two shows. Uploads marked "early" or "late" (in the item name or title) are kept apart.
function slotOf(d){
  const t = `${d.identifier || ''} ${one(d.title) || ''}`.toLowerCase();
  if (/\bearly\b|[._-]early|early[ _-]?show/.test(t)) return 'early';
  if (/\blate\b|[._-]late|late[ _-]?show/.test(t)) return 'late';
  return '';
}
const keyOf = g => g.key || g.date;
const slotLabel = g => g.slot === 'early' ? 'Early show' : g.slot === 'late' ? 'Late show' : '';
function groupDocs(docs){
  const map = new Map();
  for (const d of docs){
    const date = String(one(d.date) || '').slice(0, 10);
    if (!date) continue;
    const slot = slotOf(d), key = slot ? `${date}|${slot}` : date;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(d);
  }
  return [...map].map(([key, srcs]) => {
    const [date, slot = ''] = key.split('|');
    srcs.forEach(s => {
      s.venue = one(s.venue); s.coverage = one(s.coverage); s.kind = kind(s);
      s.rating = +s.avg_rating || 0; s.reviews = +s.num_reviews || 0; s.dl = +s.downloads || 0;
    });
    const br = s => (s.rating * s.reviews + 3.5 * 3) / (s.reviews + 3); // highest rated, tempered by review count
    srcs.sort((a, b) => br(b) - br(a) || b.dl - a.dl);
    const n = srcs.reduce((a, s) => a + s.reviews, 0);
    const rating = n ? srcs.reduce((a, s) => a + s.rating * s.reviews, 0) / n : 0;
    return {
      date, key, slot, sources: srcs, rating, reviews: n,
      venue: fixText((srcs.find(s => s.venue) || {}).venue) || 'Venue not listed',
      coverage: fixText((srcs.find(s => s.coverage) || {}).coverage),
      hasSbd: srcs.some(s => s.kind === 'Soundboard'),
      downloads: srcs.reduce((a, s) => a + s.dl, 0)
    };
  });
}

// Saved on this device so revisits are instant (oldest entries are dropped when space runs out)
const LS = {
  get(k, maxAge){ try { const v = JSON.parse(localStorage.getItem('dj:' + k)); return v && Date.now() - v.t < maxAge ? v.d : null; } catch { return null; } },
  set(k, d){
    const put = () => localStorage.setItem('dj:' + k, JSON.stringify({ t: Date.now(), d }));
    try { put(); } catch { try { pruneLS(); put(); } catch {} }
  }
};
function pruneLS(){
  const items = [];
  for (let i = 0; i < localStorage.length; i++){
    const k = localStorage.key(i);
    if (k && k.startsWith('dj:')){ let t = 0; try { t = JSON.parse(localStorage.getItem(k)).t; } catch {} items.push([k, t]); }
  }
  items.sort((a, b) => a[1] - b[1]).slice(0, Math.ceil(items.length / 2)).forEach(([k]) => localStorage.removeItem(k));
}
const metaPending = new Map();
function fetchMeta(id){
  if (metaCache.has(id)) return Promise.resolve(metaCache.get(id));
  if (metaPending.has(id)) return metaPending.get(id);
  const saved = LS.get('m:' + id, 7 * 864e5);
  if (saved){ metaCache.set(id, saved); return Promise.resolve(saved); }
  const pr = getJSON(`${API}/metadata/${encodeURIComponent(id)}`)
    .then(d => { const m = parseMeta(id, d); metaCache.set(id, m); LS.set('m:' + id, m); return m; })
    .finally(() => metaPending.delete(id));
  metaPending.set(id, pr);
  return pr;
}
const warmHosts = new Set();
function preconnect(host){
  if (!host || warmHosts.has(host)) return; warmHosts.add(host);
  const l = document.createElement('link'); l.rel = 'preconnect'; l.href = 'https://' + host; l.crossOrigin = 'anonymous'; document.head.appendChild(l);
}
function prefetchTop(){
  visible().slice(0, 4).forEach((g, i) => setTimeout(() => fetchMeta(g.sources[0].identifier).then(m => preconnect(m.server)).catch(() => {}), 300 + i * 500));
}
// Tidy text from the archive: decode HTML entities, repair garbled accents, drop taper footnote symbols and file-number prefixes
const entityBox = document.createElement('textarea');
function fixText(x){
  let t = String(x || '');
  if (/&[#a-z0-9]+;/i.test(t)){ entityBox.innerHTML = t; t = entityBox.value; }
  if (/Ã.|â€/.test(t)){ try { t = decodeURIComponent(escape(t)); } catch {} }
  return t.replace(/[\u0000-\u001f\u007f\ufffd]/g, '').replace(/\s+/g, ' ').trim();
}
const NOT_SONG = /^(tuning|tune ?ups?|crowd( noise)?|audience|intro(duction)?s?|band intro(duction)?s?|banter|stage (banter|announcements?|chatter)|announcements?|applause|dead air|sound ?check|silence|encore break|set ?break|chatter|noodling|feedback|false start|technical difficulties)$/i;
function cleanTitle(raw){
  let t = fixText(raw)
    .replace(/^\s*(gd\d{2,4}-\d{2}-\d{2}\S*\s*)/i, '')                // file-name prefixes
    .replace(/^\s*(d\d+\s*)?t?\d{1,3}\s*[.):\-–]\s+/i, '')             // "d1t01 - ", "01. "
    .replace(/[*#%^@~†‡§¤]+/g, '')                                     // taper footnote marks
    .replace(/\s*\[[^\]]*\]\s*$/,'')                                    // trailing [notes]
    .trim();
  return t || fixText(raw) || null;   // tuning, crowd, banter and the like stay in the set list
}
function parseMeta(id, data){
  if (!data || !data.files) throw new Error('No files');
  const files = data.files;
  const byName = new Map(files.map(f => [f.name, f]));
  const prefs = ['VBR MP3', 'MP3', '64Kbps MP3', '128Kbps MP3', 'Ogg Vorbis'];
  const fmt = prefs.find(p => files.some(f => f.format === p));
  let tracks = fmt ? files.filter(f => f.format === fmt) : [];
  const num = f => { const t = parseInt(String(f.track || '').split('/')[0], 10); return isNaN(t) ? null : t; };
  tracks.sort((a, b) => {
    const ta = num(a), tb = num(b);
    if (ta != null && tb != null && ta !== tb) return ta - tb;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });
  const host = data.server || data.d1 || '', dir = data.dir || '';
  tracks = tracks.map(f => {
    const orig = f.original ? byName.get(f.original) : null;
    const clean = f.name.replace(/\.[^.]+$/, '').replace(/^.*\//, '').replace(/[_]+/g, ' ');
    return {
      title: cleanTitle(f.title || orig?.title || clean),
      len: parseLen(f.length || orig?.length),
      url: host && dir ? `https://${host}${dir.split('/').map(encodeURIComponent).join('/')}/${f.name.split('/').map(encodeURIComponent).join('/')}`
        : `${API}/download/${encodeURIComponent(id)}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
      alt: `${API}/download/${encodeURIComponent(id)}/${f.name.split('/').map(encodeURIComponent).join('/')}`
    };
  });
  const full = data.metadata || {};
  tracks = tracks.filter(t => t.title);
  const md = {}; ['date', 'source', 'lineage', 'taper', 'transferer', 'addeddate', 'notes'].forEach(k => { if (full[k]) md[k] = full[k]; });
  return {
    id, tracks, md, server: host,
    notes: htmlToText(full.description),
    reviews: (data.reviews || []).slice().sort((a, b) => String(b.reviewdate || '').localeCompare(String(a.reviewdate || '')))
  };
}

/* ---------- dial ---------- */
function buildDial(){
  const el = $('#dial');
  let html = '';
  for (let y = FIRST; y <= LAST; y++){
    html += `<button class="yr${y % 10 === 0 ? ' decade' : ''}" data-year="${y}" aria-pressed="false"><span class="lbl">${y}</span><span class="ticks" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span></button>`;
  }
  el.innerHTML = html;
  el.addEventListener('click', e => { const b = e.target.closest('.yr'); if (b){ haptic(); loadYear(+b.dataset.year); } });
  // A tick each time a new year passes the middle while you swipe, like a picker wheel.
  // Only for your own scrolling, not when the dial re-centers itself or plays its demo.
  let touching = false, userUntil = 0, lastYear = null, rafPending = false;
  const mine = () => touching || performance.now() < userUntil;
  el.addEventListener('pointerdown', () => { touching = true; }, { passive: true });
  el.addEventListener('touchstart', () => { touching = true; }, { passive: true });
  ['pointerup', 'pointercancel', 'touchend', 'touchcancel'].forEach(ev => el.addEventListener(ev, () => { touching = false; userUntil = performance.now() + 900; }, { passive: true }));
  el.addEventListener('wheel', () => { userUntil = performance.now() + 400; }, { passive: true });
  el.addEventListener('scroll', () => {
    if (rafPending) return; rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const mid = el.getBoundingClientRect().left + el.clientWidth / 2;
      let best = null, bd = 1e9;
      el.querySelectorAll('.yr').forEach(b => { const r = b.getBoundingClientRect(), d = Math.abs(r.left + r.width / 2 - mid); if (d < bd){ bd = d; best = b.dataset.year; } });
      if (best !== lastYear){ if (lastYear !== null && mine()) haptic(); lastYear = best; }
    });
  }, { passive: true });
  el.addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const y = Math.min(LAST, Math.max(FIRST, (state.year || 1977) + (e.key === 'ArrowRight' ? 1 : -1)));
    loadYear(y); el.querySelector(`[data-year="${y}"]`).focus();
  });
}
function markDial(){
  document.querySelectorAll('.yr').forEach(b => {
    const on = state.mode === 'year' && +b.dataset.year === state.year;
    b.setAttribute('aria-pressed', on);
    if (on) centerYear(b);
  });
}
function centerYear(b){
  const track = $('#dial');
  requestAnimationFrame(() => {
    track.scrollLeft = b.offsetLeft - track.clientWidth / 2 + b.offsetWidth / 2;
  });
}

/* ---------- list ---------- */
async function loadYear(y, keepDetail){
  state.mode = 'year'; state.year = y; store.set('year', y); leaveSong(); if ($('#sotdMobile')) $('#sotdMobile').innerHTML = '';
  state.label = String(y);
  markDial();
  const q = `collection:GratefulDead AND year:${y}`;
  if (yearCache.has(y)) return loadList(() => yearCache.get(y));
  const fetchFull = () => search(q).then(docs => { LS.set('y:' + y, docs); const g = groupDocs(docs); yearCache.set(y, g); return g; });
  const saved = LS.get('y:' + y, 3 * 864e5);
  if (saved){
    const g = groupDocs(saved); yearCache.set(y, g);
    await loadList(() => g);
    fetchFull().then(g2 => {
      if (state.mode !== 'year' || state.year !== y) return;
      if (state.current){ const same = g2.find(x => keyOf(x) === keyOf(state.current)); if (same) state.current = same; }
      state.shows = g2; renderList();
    }).catch(() => {});
    return;
  }
  await loadList(fetchFull, () => quickPage(q));
}
async function searchSong(q, year = null){
  if ($('#sotdMobile')) $('#sotdMobile').innerHTML = '';
  state.mode = 'song'; state.song = q; state.label = year ? `${q}, ${year}` : q; state.verLen = {}; state.noMatch = {}; $('#sort option[value="longest"]').hidden = false;
  state.sort = 'rating'; state.sortAuto = true; $('#sort').value = 'rating';
  state.filter = ''; $('#filter').value = '';
  markDial();
  if (document.body.classList.contains('viewing') && mq.matches) closeDetail();
  const phrase = q.replace(/["\\]/g, '');
  const key = norm(phrase) + (year ? '|' + year : '');
  const yq = year ? ` AND year:${year}` : '';
  const sq = `collection:GratefulDead AND ("${phrase}")${yq}`;
  const words = phrase.split(/\s+/).map(w => w.replace(/[^\w]/g, '')).filter(w => w.length > 1);
  const loose = words.length ? `collection:GratefulDead AND (${words.join(' AND ')})${yq}` : sq;
  await loadList(() => songCache.get(key) || search(sq).then(d => d.length ? d : search(loose))
    .then(groupDocs).then(g => year ? g.filter(x => +x.date.slice(0, 4) === year) : g).then(g => (songCache.set(key, g), g)), songCache.has(key) ? null : () => quickPage(sq));
}
async function loadOnThisDay(){
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0'), dd = String(now.getDate()).padStart(2, '0');
  state.mode = 'otd'; leaveSong();
  state.label = 'On this day, ' + now.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  fillSotd(); if (!sotd) loadSotd();
  markDial();
  await loadList(async () => {
    const docs = await search(`collection:GratefulDead AND identifier:gd*-${mm}-${dd}*`);
    return groupDocs(docs.filter(d => String(one(d.date) || '').slice(5, 10) === `${mm}-${dd}`));
  });
}
// A first page of the best-rated (or earliest) recordings comes back faster; the full list replaces it when it lands.
function quickPage(q){ return search(q, 120, state.sort === 'date' ? 'date asc' : 'avg_rating desc').then(groupDocs); }
async function loadList(getter, preview){
  const token = (state.listToken = (state.listToken || 0) + 1);
  state.loading = true; state.partial = false; state.error = null; state.retry = getter;
  renderList();
  const full = Promise.resolve().then(getter);
  if (preview){
    preview().then(g => {
      if (token !== state.listToken || !state.loading || !g.length) return;
      state.shows = g; state.loading = false; state.partial = true; renderList();
    }).catch(() => {});
  }
  try {
    const g = await full;
    if (token !== state.listToken) return;
    state.shows = g;
    if (state.current){ const same = g.find(x => keyOf(x) === keyOf(state.current)); if (same) state.current = same; }
  } catch (e) { if (token !== state.listToken) return; if (!state.partial){ state.error = e; state.shows = []; } }
  state.loading = false; state.partial = false;
  renderList();
  if (!state.error) prefetchTop();
}
function leaveSong(){
  state.song = null; $('#songq').value = '';
  $('#sort option[value="longest"]').hidden = true; if (state.sort === 'longest'){ state.sort = 'rating'; $('#sort').value = 'rating'; }
  $('#songStats').hidden = true;
  state.sortAuto = false;
}
function visible(){
  let list = state.shows;
  if (state.mode === 'library') return list;
  if (state.mode === 'song' && state.noMatch) list = list.filter(g => !state.noMatch[keyOf(g)]);
  const f = state.filter.trim().toLowerCase();
  if (f) list = list.filter(g => `${g.date} ${g.venue} ${g.coverage} ${fmtLong(g.date)}`.toLowerCase().includes(f));
  const bayes = g => (g.rating * g.reviews + 3.6 * 4) / (g.reviews + 4);
  const sorters = {
    date: (a, b) => a.date.localeCompare(b.date),
    rating: (a, b) => bayes(b) - bayes(a),
    reviews: (a, b) => b.reviews - a.reviews,
    popular: (a, b) => b.downloads - a.downloads,
    longest: (a, b) => (state.verLen[keyOf(b)] || -1) - (state.verLen[keyOf(a)] || -1)
  };
  return list.slice().sort(sorters[state.sort]);
}
function renderList(){
  $('#listTitle').textContent = state.label;
  const sub = $('#listSub');
  const hintPick = mq.matches && !state.current;
  sub.hidden = state.mode !== 'song' && !hintPick;
  renderStats();
  if (hintPick && state.mode !== 'song'){ sub.hidden = true; }
  sub.textContent = state.mode === 'song' ? 'Shows whose set list mentions this song. Sort by rating to find the best versions.' : 'Select a show to see its set list and play it.';
  const ul = $('#list');
  if (state.loading){ $('#count').textContent = ''; ul.innerHTML = '<li class="skel"></li>'.repeat(8); return; }
  if (state.error){
    $('#count').textContent = '';
    ul.innerHTML = `<li class="msg">Couldn't reach archive.org. If you're viewing this inside Claude's preview, open the file in your browser or host it instead. Otherwise, check your connection and try again.<br><button class="btn" id="retry">Try again</button></li>`;
    $('#retry').onclick = () => loadList(state.retry);
    return;
  }
  if (state.mode === 'library') return renderLibrary(ul);
  const list = visible();
  $('#count').textContent = state.partial ? 'loading the rest…' : list.length ? `${list.length} show${list.length === 1 ? '' : 's'}` : '';
  if (!list.length){
    ul.innerHTML = `<li class="empty-list">${state.shows.length ? 'No shows match that filter. Clear it to see the whole list.' : state.mode === 'song' ? 'No set lists mention that song. Check the spelling, or pick a title from the suggestions.' : state.mode === 'search' ? 'Nothing matched. Try a song, venue, city, state, year, or a date like 5/8/77.' : 'No recordings found here. Try another year.'}</li>`;
    return;
  }
  const showYear = state.mode !== 'year';
  if (state.mode === 'library') return renderLibrary(ul);
  ul.innerHTML = list.map(g => itemHTML(g, showYear)).join('');
  if (state.mode === 'song') queueVersionLengths(list);
}
function itemHTML(g, showYear){
  const vl = state.mode === 'song' ? state.verLen[keyOf(g)] : null;
  const btn = `<button class="show" data-date="${keyOf(g)}" aria-current="${!!state.current && keyOf(state.current) === keyOf(g)}">
      <span class="s-date"><b>${showYear ? g.date.slice(0, 4) : esc(fmtShort(g.date))}</b><small>${showYear ? esc(fmtShort(g.date)) : esc(fmtDow(g.date))}</small>${slotLabel(g) ? `<small class="slot">${slotLabel(g)}</small>` : ''}</span>
      <span><span class="s-venue">${esc(g.venue)}</span><span class="s-city">${esc(g.coverage)}</span></span>
      <span class="s-meta">
        ${g.reviews ? `<span class="rating">${starHTML(g.rating)}<span>${g.reviews}</span></span>` : '<span>No reviews</span>'}
        <span>${vl > 0 ? `<span class="vlen">${clock(vl)}</span> ` : ''}${g.sources.length} tape${g.sources.length === 1 ? '' : 's'}</span>
      </span>
    </button>`;
  return `<li>${btn}</li>`;
}
function renderLibrary(ul){
  const f = favs(), saved = Object.values(f.shows).sort((a, b) => b.at - a.at), hist = store.get('history', []);
  const sec = (t, body) => `<li class="sec-h">${t}</li>${body}`;
  let html = '';
  html += sec('Saved shows', saved.length ? saved.map(g => `<li>${itemHTML(g, true).replace(/^<li>|<\/li>$/g, '')}</li>`).join('') : '<li class="empty-list">Tap Save show on any show to keep it here.</li>');
  html += sec('Saved songs', f.songs.length ? f.songs.map((x, i) => `<li><button class="fsong" data-fs="${i}"><b>${esc(x.title)}</b><small>${esc(fmtShort(x.g.date))} ${x.g.date.slice(0, 4)}, ${esc(x.g.venue)}</small><span>Play</span></button></li>`).join('') : '<li class="empty-list">Tap the heart next to a song to save that version.</li>');
  html += sec('Recently played', hist.length ? hist.map(g => `<li>${itemHTML(g, true).replace(/^<li>|<\/li>$/g, '')}</li>`).join('') : '<li class="empty-list">Shows you play will show up here.</li>');
  ul.innerHTML = html;
  $('#count').textContent = '';
}
const warmShow = e => { const b = e.target.closest && e.target.closest('.show'); if (!b) return; const g = state.shows.find(x => keyOf(x) === b.dataset.date); if (g) fetchMeta(g.sources[0].identifier).then(m => preconnect(m.server)).catch(() => {}); };
$('#list').addEventListener('pointerover', warmShow);
$('#list').addEventListener('touchstart', warmShow, { passive: true });
$('#list').addEventListener('click', e => {
  const fs = e.target.closest('.fsong'); if (fs){ playSavedSong(favs().songs[+fs.dataset.fs]); return; }
  const b = e.target.closest('.show'); if (!b) return;
  const g = state.shows.find(x => keyOf(x) === b.dataset.date);
  if (!g) return;
  openShow(g);
  if (state.mode === 'song'){   // a song search plays that show's version of the song right away
    fetchMeta(g.sources[0].identifier).then(m => {
      if (state.current !== g) return;
      const i = matchIndex(m); state.queue = { id: m.id, tracks: m.tracks, show: g, index: Math.max(0, i) };   // then the rest of that show
      loadTrack(state.queue.index);
    }).catch(() => {});
  }
});

// Song stats from the list itself: how many shows mention it, first and last, and a bar per year
function renderStats(){
  const el = $('#songStats');
  if (state.mode !== 'song' || state.loading || !state.shows.length){ el.hidden = true; return; }
  const ds = state.shows.map(g => g.date).sort(), counts = {};
  ds.forEach(d => { const y = +d.slice(0, 4); counts[y] = (counts[y] || 0) + 1; });
  const ys = Object.keys(counts).map(Number), peak = ys.reduce((a, y) => counts[y] > counts[a] ? y : a, ys[0]);
  const max = Math.max(...Object.values(counts));
  let bars = ''; for (let y = FIRST; y <= LAST; y++) bars += `<i style="height:${((counts[y] || 0) / max) * 100}%" title="${y}: ${counts[y] || 0}"></i>`;
  el.innerHTML = `<p>${state.shows.length} shows mention it. First ${esc(fmtShort(ds[0]))} ${ds[0].slice(0, 4)}, last ${esc(fmtShort(ds[ds.length - 1]))} ${ds[ds.length - 1].slice(0, 4)}, most in ${peak}${state.partial ? ' (still counting)' : ''}.</p>
    <div class="bars">${bars}</div><div class="bars-x"><span>${FIRST}</span><span>1980</span><span>${LAST}</span></div>`;
  el.hidden = false;
}
// Version explorer: look up how long each show's version runs, a few at a time
let verQueue = [], verBusy = 0, verRender = 0;
function queueVersionLengths(list){
  const song = state.song;
  verQueue = list.slice(0, 120).filter(g => !(g.date in state.verLen)).map(g => ({ g, song }));
  for (let i = verBusy; i < 3; i++) pumpVersions();
}
function pumpVersions(){
  const job = verQueue.shift(); if (!job) return;
  verBusy++;
  fetchMeta(job.g.sources[0].identifier).then(m => {
    if (state.song !== job.song) return;
    const i = matchIndex(m); state.verLen[keyOf(job.g)] = i >= 0 ? m.tracks[i].len : 0;
    if (i < 0 && m.tracks.length){ state.noMatch = state.noMatch || {}; state.noMatch[keyOf(job.g)] = true; }   // not actually in this set list
    clearTimeout(verRender); verRender = setTimeout(() => { if (state.mode === 'song') { const y = getY(); renderList(); setY(y); } }, 600);
  }).catch(() => {}).finally(() => { verBusy--; pumpVersions(); });
}
let previewT = 0;
async function playSavedSong(f){
  if (!f) return;
  const g = f.g;
  openShow(g, f.id);
  try { const m = await fetchMeta(f.id); state.queue = { id: m.id, tracks: m.tracks, show: g, index: Math.min(f.index, m.tracks.length - 1) }; loadTrack(state.queue.index); }
  catch { toast("That show didn't load."); }
}
function openLibrary(){
  state.mode = 'library'; leaveSong(); state.label = 'Library';
  const f = favs(), all = [...Object.values(f.shows), ...store.get('history', [])];
  const seen = new Set(); state.shows = all.filter(g => !seen.has(keyOf(g)) && seen.add(keyOf(g)));
  state.loading = false; state.partial = false; state.error = null;
  markDial(); renderList();
  if (document.body.classList.contains('viewing') && mq.matches) closeDetail();
}
// Show of the day: the best-loved show played on today's date
let sotd = null;
async function loadSotd(){
  const now = new Date(), mm = String(now.getMonth() + 1).padStart(2, '0'), dd = String(now.getDate()).padStart(2, '0');
  let g = LS.get('sotd:' + mm + dd, 864e5);
  if (!g){
    try {
      const docs = (await search(`collection:GratefulDead AND identifier:gd*-${mm}-${dd}*`)).filter(d => String(one(d.date) || '').slice(5, 10) === `${mm}-${dd}`);
      const groups = groupDocs(docs), bayes = x => (x.rating * x.reviews + 3.6 * 4) / (x.reviews + 4);
      groups.sort((a, b) => bayes(b) - bayes(a));
      if (groups[0]){ g = gmin(groups[0]); LS.set('sotd:' + mm + dd, g); }
    } catch {}
  }
  if (!g) return;
  sotd = g; fillSotd();
}
function sotdHTML(){
  if (!sotd) return '';
  const ago = new Date().getFullYear() - +sotd.date.slice(0, 4);
  return `<div class="sotd"><p class="k">Show of the day</p><h3>${esc(fmt(sotd.date, { month: 'long', day: 'numeric', year: 'numeric' }))}</h3>
    <p>${ago} years ago today, ${esc(sotd.venue)}${sotd.coverage ? ', ' + esc(sotd.coverage) : ''}</p>
    <div class="row"><button class="btn primary" data-sotd="play">Play</button><button class="btn" data-sotd="open">Open</button></div></div>`;
}
function fillSotd(){
  const m = $('#sotdMobile'); if (m) m.innerHTML = state.mode === 'otd' ? sotdHTML() : '';
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-sotd]'); if (!b || !sotd) return;
  openShow(sotd, sotd.sources[0].identifier);
  if (b.dataset.sotd === 'play'){
    try { const m = await fetchMeta(sotd.sources[0].identifier); state.queue = { id: m.id, tracks: m.tracks, show: sotd, index: 0 }; loadTrack(0); } catch {}
  }
});

/* ---------- detail ---------- */
function openShow(g, sourceId, auto = false){
  state.current = g; state.tab = 'setlist'; state.allReviews = false; state.recOpen = false;
  if (auto){ document.querySelectorAll('.show').forEach(b => b.setAttribute('aria-current', b.dataset.date === keyOf(g))); loadSource(sourceId || g.sources[0].identifier); return; }
  if (mq.matches && !document.body.classList.contains('viewing')){ listScroll = getY(); history.pushState({ tr: 'show' }, ''); nav.show = true; }
  document.body.classList.add('viewing'); applyShrink(); window.relayoutWord && window.relayoutWord();
  document.querySelectorAll('.show').forEach(b => b.setAttribute('aria-current', b.dataset.date === keyOf(g)));
  if (matchMedia('(max-width: 900px)').matches) setY(0);
  loadSource(sourceId && g.sources.some(s => s.identifier === sourceId) ? sourceId : g.sources[0].identifier);
}
async function loadSource(id){
  state.sourceId = id; state.meta = null; state.metaError = null;
  renderDetail();
  try {
    let m = metaCache.get(id);
    if (!m) m = await fetchMeta(id);
    if (state.sourceId !== id) return;
    state.meta = m;
    preconnect(m.server);
    primeFirst(m);
    history.replaceState(null, '', '#' + id);
  } catch (e) {
    if (state.sourceId !== id) return;
    state.metaError = e;
  }
  renderDetail();
}
// Six random picks from the 50 best-loved shows on archive.org (rating weighted by how many people reviewed it)
let top50 = null, loved = [];
async function loadTop50(){
  top50 = LS.get('top50', 7 * 864e5);
  if (!top50){
    try {
      const docs = await search('collection:GratefulDead AND num_reviews:[12 TO 100000]', 600, 'avg_rating desc');
      const groups = groupDocs(docs).filter(g => validDate(g.date));
      const bayes = g => (g.rating * g.reviews + 4.2 * 25) / (g.reviews + 25);
      top50 = groups.sort((x, y) => bayes(y) - bayes(x)).slice(0, 50).map(gmin);
      if (top50.length) LS.set('top50', top50);
    } catch { top50 = []; }
  }
  pickLoved();
}
function pickLoved(){
  const pool = (top50 || []).slice();
  for (let i = pool.length - 1; i > 0; i--){ const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  loved = pool.slice(0, 6).map(g => ({ g, why: null }));
  if (!state.current) renderDetail();
  fillLovedMobile();
  // what listeners say about each one: a short line from its most helpful review
  loved.forEach(item => fetchMeta(item.g.sources[0].identifier).then(m => {
    const ranked = (m.reviews || []).slice().sort((a, b) => ((+b.stars || 0) * 2 + Math.min(String(b.reviewbody || '').length, 1500) / 300) - ((+a.stars || 0) * 2 + Math.min(String(a.reviewbody || '').length, 1500) / 300));
    for (const r of ranked){
      const sn = htmlToText(r.reviewbody).replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).find(x => x.length >= 30 && x.length <= 170);
      if (sn){ item.why = { text: sn, who: r.reviewer || 'A listener' }; break; }
    }
    document.querySelectorAll(`[data-loved="${keyOf(item.g)}"] .lv-w`).forEach(w => { if (item.why) w.innerHTML = `“${esc(item.why.text)}” <span class="lv-who">${esc(item.why.who)}</span>`; });
  }).catch(() => {}));
}
function fillLovedMobile(){
  const el = $('#lovedM'); if (!el) return;
  if (!loved.length){ el.hidden = true; return; }
  el.innerHTML = lovedHTML().replace('<div class="loved-top">', '<div class="loved-top">').replace(/id="lovedMore"/, 'id="lovedMoreM"');
  el.hidden = false;
}
function lovedHTML(){
  const head = `<div class="loved-top"><h2 class="loved-h">From the top 50</h2>${loved.length ? '<button class="btn" id="lovedMore">Show others</button>' : ''}</div>`;
  if (!top50) return head + '<div class="skel"></div>'.repeat(3);
  if (!loved.length) return head + '<p class="pick-hint">The top-rated shows didn’t load from archive.org.</p>';
  return head + `<div class="loved">${loved.map(({ g, why }) => `<button class="lv" data-loved="${keyOf(g)}">
      <span class="lv-d">${esc(fmt(g.date, { month: 'short', day: 'numeric', year: 'numeric' }))}</span>
      <span class="lv-v">${esc(g.venue)}${g.coverage ? ', ' + esc(g.coverage) : ''}</span>
      <span class="lv-r">${starHTML(g.rating)} ${g.rating.toFixed(1)} from ${g.reviews.toLocaleString()} reviews</span>
      <span class="lv-w">${why ? `“${esc(why.text)}” <span class="lv-who">${esc(why.who)}</span>` : ''}</span></button>`).join('')}</div>`;
}
document.addEventListener('click', async e => {
  if (e.target.closest('#lovedMore, #lovedMoreM')){ pickLoved(); haptic(); return; }
  const b = e.target.closest('[data-loved]'); if (!b) return;
  const item = loved.find(x => keyOf(x.g) === b.dataset.loved); if (!item) return;
  const g = item.g;
  openShow(g, g.sources[0].identifier);
  try { const m = await fetchMeta(g.sources[0].identifier); if (state.current === g){ state.queue = { id: m.id, tracks: m.tracks, show: g, index: 0 }; loadTrack(0); } } catch {}
});
function renderDetail(){
  const el = $('#detail');
  const g = state.current;
  if (!g){ el.innerHTML = lovedHTML(); return; }
  const m = state.meta;
  const src = g.sources.find(s => s.identifier === state.sourceId) || g.sources[0];
  const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
  const recs = g.sources.map((s, i) => {
    const lineage = htmlToText(one(s.source) || '').replace(/\s+/g, ' ');
    return `<button class="rec" role="radio" aria-checked="${s.identifier === state.sourceId}" data-id="${esc(s.identifier)}">
      <span class="rec-top"><b>${s.kind}</b>${i === 0 ? '<span class="tag">Highest rated</span>' : ''}</span>
      <span class="rec-meta">${s.reviews ? `${starHTML(s.rating)} ${s.rating.toFixed(1)} from ${plural(s.reviews, 'review')}` : 'No reviews yet'}${s.dl ? `, ${plural(s.dl, 'play')}` : ''}</span>
      <span class="rec-src" title="${esc(lineage || s.identifier)}">${esc(lineage || s.identifier)}</span>
    </button>`;
  }).join('');
  const matchI = m && state.song ? matchIndex(m) : -1;
  const playingThis = state.queue && m && state.queue.id === m.id;
  let body;
  if (state.metaError) body = `<p class="msg">This recording's details didn't load from archive.org.<br><button class="btn" id="mRetry">Try again</button></p>`;
  else if (!m) body = '<div class="skel"></div>'.repeat(6);
  else body = tabBody(m, playingThis);

  el.innerHTML = `
    <button class="back" id="back">‹ All shows</button>
    <p class="d-dow">${esc(fmtDow(g.date) ? fmt(g.date, { weekday: 'long' }) : '')}${slotLabel(g) ? ` · ${slotLabel(g)}` : ''}</p>
    <h2 class="d-date">${esc(fmt(g.date, { month: 'long', day: 'numeric', year: 'numeric' }))}</h2>
    <p class="d-venue">${esc(g.venue)}</p>
    <p class="d-city">${esc(g.coverage)}${src.kind !== 'Recording' ? ` <span class="badge kind">${({ Soundboard: 'SBD', Audience: 'AUD', Matrix: 'Matrix' })[src.kind]}</span>` : ''}</p>
    <div class="d-row">
      ${matchI >= 0 ? `<button class="btn primary" id="playMatch">Play ${esc(m.tracks[matchI].title.replace(/\s*-*>\s*$/, ''))}</button>` : ''}
      <button class="btn${matchI >= 0 ? '' : ' primary'}" id="playShow" ${m && m.tracks.length ? '' : 'disabled'}>${playingThis ? 'Restart show' : 'Play show'}</button>
      ${src.reviews ? `<span class="rating">${starHTML(src.rating)}<span class="rnum">${src.rating.toFixed(1)}</span><span class="muted">${src.reviews} review${src.reviews === 1 ? '' : 's'} of this tape</span></span>` : '<span class="muted">No reviews of this tape yet</span>'}
      <button class="btn heartbtn" id="shareShow" aria-label="Share this show"><svg viewBox="0 0 24 24" class="stroke"><path d="M12 15V4M8 8l4-4 4 4"/><path d="M6 12v6a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-6"/></svg><span>Share</span></button>
      <button class="btn heartbtn" id="favShow" aria-pressed="${isFavShow(keyOf(g))}"><svg viewBox="0 0 24 24" class="stroke"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg><span>${isFavShow(keyOf(g)) ? 'Saved' : 'Save show'}</span></button>
      <a class="link" href="https://archive.org/details/${encodeURIComponent(state.sourceId)}" target="_blank" rel="noopener">Open on archive.org</a>
    </div>
    <div class="tabs" role="tablist">
      ${['setlist', 'notes', 'reviews'].map(t => `<button class="tab" role="tab" data-tab="${t}" aria-selected="${state.tab === t}">${{ setlist: 'Set list', notes: 'Notes', reviews: `Reviews${m ? ` (${m.reviews.length})` : ''}` }[t]}</button>`).join('')}
    </div>
    <div role="tabpanel">${body}</div>
    <details class="recs" id="recs"${state.recOpen ? ' open' : ''}>
      <summary><span class="k">Recording</span><b>${src.kind}${src.reviews ? `, ${src.rating.toFixed(1)}★` : ''}</b><span class="chg">${g.sources.length > 1 ? `Choose from ${g.sources.length}` : 'Details'}</span></summary>
      <div class="rec-list" role="radiogroup" aria-label="Recordings of this show, highest rated first">${recs}</div>
    </details>`;

  $('#back').onclick = closeDetail;
  $('#recs').addEventListener('toggle', e => { state.recOpen = e.target.open; });
  el.querySelectorAll('.rec').forEach(b => b.onclick = () => { if (b.dataset.id !== state.sourceId){ state.recOpen = false; loadSource(b.dataset.id); } });
  const pm = $('#playMatch'); if (pm) pm.onclick = () => playFrom(matchI);
  const an = $('#autoNext'); if (an) an.onchange = () => store.set('autonext', an.checked);
  const pr = $('#mRetry'); if (pr) pr.onclick = () => { metaCache.delete(state.sourceId); loadSource(state.sourceId); };
  $('#playShow').onclick = () => playFrom(0);
  el.querySelectorAll('.tab').forEach(b => b.onclick = () => { state.tab = b.dataset.tab; renderDetail(); });
  el.querySelectorAll('.trk').forEach(b => b.onclick = () => {
    const i = +b.dataset.i;
    if (playingThis && state.queue.index === i) togglePlay(); else playFrom(i);
  });
  const more = $('#moreRev'); if (more) more.onclick = () => { state.allReviews = true; renderDetail(); };
  $('#favShow').onclick = () => { toggleFavShow(g); haptic(); renderDetail(); };
  $('#shareShow').onclick = () => shareShow(g);
  el.querySelectorAll('.heart[data-fi]').forEach(b => b.onclick = e => { e.stopPropagation(); if (m){ toggleFavSong(g, m, +b.dataset.fi); haptic(); b.setAttribute('aria-pressed', isFavSong(m.id, +b.dataset.fi)); } });
}
// Read set breaks and segues: "->" at the end of a title, and Set 1 / Set 2 / Encore headings in the notes
function prepTracks(m){
  if (m.prepped) return; m.prepped = true;
  m.tracks = m.tracks.map(t => { const c = cleanTitle(t.title); return c ? { ...t, title: c } : null; }).filter(Boolean);
  m.tracks.forEach(t => {
    if (/\s*(-+>|>|\u2192)\s*$/.test(t.title)){ t.segue = true; t.title = t.title.replace(/\s*(-+>|>|\u2192)\s*$/, ''); }
    t.set = null;
  });
  const text = m.notes || ''; if (!text) return;
  const nameOf = w => /enc/i.test(w) ? 'Encore' : /(3|three|iii)/i.test(w) ? 'Set 3' : /(2|two|ii)/i.test(w) ? 'Set 2' : 'Set 1';
  let label = null, ptr = 0, found = 0;
  const take = str => str.split(/,|->|>|\u2192|;|\//).map(x => norm(x.replace(/^\s*(d\d+)?t?\d+[.):\-\s]+/i, ''))).filter(x => x.length > 2).forEach(nm => {
    for (let k = ptr; k < m.tracks.length; k++){
      const tn = norm(m.tracks[k].title);
      if (tn && (tn.includes(nm) || nm.includes(tn))){ m.tracks[k].set = label; ptr = k + 1; found++; break; }
    }
  });
  for (const raw of text.split(/\n+/)){
    const line = raw.trim(); if (!line) continue;
    const h = line.match(/^(set\s*(?:one|two|three|[1-3]|i{1,3})\b|encore|e:)[:.\-\s]*/i);
    if (h){ label = nameOf(h[1]); const rest = line.slice(h[0].length); if (rest) take(rest); continue; }
    if (label) take(line);
  }
  if (!found) { m.tracks.forEach(t => t.set = null); return; }
  let cur = null; const first = (m.tracks.find(t => t.set) || {}).set;
  m.tracks.forEach(t => { if (t.set) cur = t.set; else t.set = cur || first; });
  if (new Set(m.tracks.map(t => t.set)).size < 2) m.tracks.forEach(t => t.set = null);
}
function matchIndex(m){
  const q = songKey(state.song); if (!q) return -1;
  return m.tracks.findIndex(t => songKey(t.title).includes(q) || norm(t.title).includes(norm(state.song)));
}
function tabBody(m, playingThis){
  if (state.tab === 'setlist'){
    if (!m.tracks.length) return '<p class="msg">This recording has no streamable audio. Choose another recording above.</p>';
    const total = m.tracks.reduce((a, t) => a + t.len, 0);
    const paused = audio.paused ? ' paused' : '';
    prepTracks(m);
    const mi = state.song ? matchIndex(m) : -1;
    return `<ol class="tracks">${m.tracks.map((t, i) => {
      const on = playingThis && state.queue.index === i;
      const head = t.set && (i === 0 || m.tracks[i - 1].set !== t.set) ? `<li class="set-h">${t.set}</li>` : '';
      const suite = i > 0 && m.tracks[i - 1].segue;
      return `${head}<li><button class="trk${on ? ' playing' + paused : ''}${i === mi ? ' match' : ''}${suite ? ' suite' : ''}" data-i="${i}" aria-label="Play ${esc(t.title)}">
        <span class="n">${on && state.started && !audio.paused ? '<span class="eqbars" aria-hidden="true"><i></i><i></i><i></i></span>' : i + 1}</span>
        <span class="t">${esc(t.title)}${t.segue ? '<span class="seg-arrow" aria-label="segues into the next song">→</span>' : ''}${i === mi ? '<span class="yours">Your song</span>' : ''}</span><span class="len">${t.len ? clock(t.len) : ''}</span></button><button class="heart" data-fi="${i}" aria-pressed="${isFavSong(m.id, i)}" aria-label="Save this version of ${esc(t.title)}"><svg viewBox="0 0 24 24" class="stroke"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg></button></li>`;
    }).join('')}</ol>${total ? `<p class="total">${m.tracks.length} tracks, ${clock(total)} total</p>` : ''}`;
  }
  if (state.tab === 'notes'){
    const md = m.md;
    const rows = [['Source', md.source], ['Lineage', md.lineage], ['Taped by', md.taper], ['Transferred by', md.transferer], ['Added', md.addeddate && String(md.addeddate).slice(0, 10)]]
      .filter(r => r[1]).map(([k, v]) => `<dt>${k}</dt><dd>${esc(htmlToText(v))}</dd>`).join('');
    const extra = htmlToText(md.notes);
    return `${m.notes ? `<p class="notes">${esc(m.notes)}</p>` : '<p style="color:var(--muted)">No show notes for this recording.</p>'}
      ${extra ? `<p class="notes" style="margin-top:16px">${esc(extra)}</p>` : ''}
      ${rows ? `<dl class="recinfo">${rows}</dl>` : ''}`;
  }
  if (!m.reviews.length) return '<p style="color:var(--muted)">No one has reviewed this recording yet.</p>';
  prepTracks(m);
  const useful = r => (+r.stars || 0) * 2 + Math.min(String(r.reviewbody || '').length, 1500) / 300;
  const ranked = m.reviews.slice().sort((a, b) => useful(b) - useful(a));
  const names = [...new Set(m.tracks.map(t => t.title))].filter(n => norm(n).length > 3);
  const hls = [];
  for (const r of ranked){
    const sents = htmlToText(r.reviewbody).replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);
    for (const sn of sents){
      if (sn.length < 25 || sn.length > 220) continue;
      const hit = names.find(n => norm(sn).includes(norm(n)));
      if (hit){ hls.push({ sn, hit, who: r.reviewer || 'A listener' }); break; }
    }
    if (hls.length >= 4) break;
  }
  const bold = (sn, hit) => { const i = sn.toLowerCase().indexOf(hit.toLowerCase()); return i < 0 ? esc(sn) : esc(sn.slice(0, i)) + '<b>' + esc(sn.slice(i, i + hit.length)) + '</b>' + esc(sn.slice(i + hit.length)); };
  const hlHTML = hls.length ? `<p class="rev-k">Highlights</p>${hls.map(h => `<div class="hl"><p>${bold(h.sn, h.hit)}</p><small>${esc(h.who)}</small></div>`).join('')}<p class="rev-k" style="margin-top:22px">Most helpful first</p>` : '';
  const list = state.allReviews ? ranked : ranked.slice(0, 5);
  return hlHTML + list.map(r => `<article class="review">
      ${starHTML(+r.stars || 0)}
      <h4>${esc(r.reviewtitle || 'Untitled review')}</h4>
      <p>${esc(htmlToText(r.reviewbody))}</p>
      <small>${esc(r.reviewer || 'Anonymous')}${r.reviewdate ? ', ' + esc(String(r.reviewdate).slice(0, 10)) : ''}</small>
    </article>`).join('') + (!state.allReviews && m.reviews.length > 5 ? `<p><button class="btn" id="moreRev">Show all ${m.reviews.length} reviews</button></p>` : '');
}

// Desktop: hand off to the preloaded next song a hair before this one ends, for gapless segues
function gaplessWatch(){
  requestAnimationFrame(gaplessWatch);
  const q = state.queue; if (!q || audio.paused || !spare || q.songRun || q.preview || state.remote) return;
  const n = q.tracks[q.index + 1]; if (!n || spare.url !== n.url) return;
  const left = audio.duration - audio.currentTime;
  if (isFinite(left) && left <= .045 && spare.el.readyState >= 3) loadTrack(q.index + 1);
}
setTimeout(() => { if (!IOS) requestAnimationFrame(gaplessWatch); }, 0);
async function restoreSession(){
  const r = store.get('resume', null); if (!r || !r.g || state.queue) return;
  try {
    const m = await fetchMeta(r.id); if (state.queue) return;
    const i = Math.min(r.index || 0, m.tracks.length - 1);
    state.queue = { id: m.id, tracks: m.tracks, show: r.g, index: i, histFor: keyOf(r.g) };
    audio.preload = 'metadata'; audio.src = m.tracks[i].url;
    if (r.t > 1) audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = r.t; } catch {} }, { once: true });
    ['#play', '#mplay', '#seek', '#shPlay', '#shSeek', '#back15', '#fwd15'].forEach(s => $(s).disabled = false);
    updateNowPlaying();
    $('#npSub').textContent = `Paused at ${clock(r.t)}. Press play to pick up where you left off.`;
  } catch {}
}
// Light tap feedback: vibration on Android; iPhone gets a tick from a hidden switch control
const hapticEl = (() => { const l = document.createElement('label'); l.style.display = 'none'; const i = document.createElement('input'); i.type = 'checkbox'; i.setAttribute('switch', ''); l.appendChild(i); document.body.appendChild(l); return l; })();
function haptic(){ try { if (navigator.vibrate) navigator.vibrate(8); else if (IOS) hapticEl.click(); } catch {} }

// Share: a link to the show, or to the exact song and moment when it's the show that's playing
async function shareShow(g){
  const id = state.sourceId || g.sources[0].identifier, q = state.queue;
  let hash = id, moment = '';
  if (q && q.id === id){ const t = Math.floor(playTime() || 0); hash += `@${q.index + 1}:${t}`; moment = ` — ${q.tracks[q.index].title} at ${clock(t)}`; }
  const url = location.origin + location.pathname + '#' + hash;
  const text = `Grateful Dead, ${fmtLong(g.date)}, ${g.venue}${moment}`;
  haptic();
  try { if (navigator.share){ await navigator.share({ title: 'deadjams', text, url }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(url); toast('Link copied'); } catch { prompt('Copy this link', url); }
  track('share', { ...showParams(g), with_moment: moment ? 1 : 0 });
}

/* ---------- favorites and history (kept on this device) ---------- */
const gmin = g => ({ date: g.date, key: keyOf(g), slot: g.slot || '', venue: g.venue, coverage: g.coverage, rating: g.rating, reviews: g.reviews, hasSbd: g.hasSbd, downloads: g.downloads,
  sources: g.sources.map(x => ({ identifier: x.identifier, kind: x.kind, rating: x.rating, reviews: x.reviews, dl: x.dl, source: one(x.source) })) });
const favs = () => store.get('favs', { shows: {}, songs: [] });
const isFavShow = d => !!favs().shows[d];
const isFavSong = (id, i) => favs().songs.some(f => f.id === id && f.index === i);
function toggleFavShow(g){ const f = favs(), k = keyOf(g); if (f.shows[k]) delete f.shows[k]; else f.shows[k] = { ...gmin(g), at: Date.now() }; store.set('favs', f); }
function toggleFavSong(g, m, i){
  const f = favs(), k = f.songs.findIndex(x => x.id === m.id && x.index === i);
  if (k >= 0) f.songs.splice(k, 1); else f.songs.unshift({ id: m.id, index: i, title: m.tracks[i].title, g: gmin(g), at: Date.now() });
  store.set('favs', f);
  if (k < 0) toast('Saved to your Library');
}
function addHistory(q){
  const h = store.get('history', []).filter(x => keyOf(x) !== keyOf(q.show));
  h.unshift({ ...gmin(q.show), id: q.id, at: Date.now() });
  store.set('history', h.slice(0, 40));
}

/* ---------- random ---------- */

/* ---------- audio + EQ ---------- */
const BANDS = [
  { f: 60, t: 'lowshelf', l: '60' }, { f: 170, t: 'peaking', l: '170' }, { f: 400, t: 'peaking', l: '400' },
  { f: 1000, t: 'peaking', l: '1k' }, { f: 2500, t: 'peaking', l: '2.5k' }, { f: 6000, t: 'peaking', l: '6k' }, { f: 12000, t: 'highshelf', l: '12k' }
];
const PRESETS = {
  'Flat': [0, 0, 0, 0, 0, 0, 0],
  'Warm': [3, 2, 0, -1, -1, -2, -3],
  'Bright': [-1, 0, 0, 1, 3, 4, 4],
  'Bass': [6, 4, 1, 0, 0, 0, 0],
  'Vocals': [-2, -1, 1, 3, 3, 1, 0],
  'Hiss cut': [0, 0, 0, 0, 0, -3, -7],
  'Audience tape': [-3, -1, -1, 1, 3, 1, -4]
};
const eq = store.get('eq', { on: true, gains: PRESETS.Flat.slice(), preset: 'Flat' });
let audio, ctx = null, graph = null, corsMode = true, eqAvailable = true, errCount = 0, dragging = null;
const SEEKS = [['#seek', '#cur', '#dur'], ['#shSeek', '#shCur', '#shDur']];
let volume = store.get('vol', 0.9), lastVol = volume || 0.9;

function createAudio(cors){
  const a = new Audio();
  if (cors) a.crossOrigin = 'anonymous';
  a.preload = 'auto';
  a.volume = volume;
  a.addEventListener('timeupdate', onTime);
  a.addEventListener('durationchange', onTime);
  a.addEventListener('play', syncPlay);
  a.addEventListener('pause', syncPlay);
  a.addEventListener('waiting', () => { if (a !== audio) return; setLoading(true); document.querySelectorAll('.trk.playing .n').forEach(n => { if (n.querySelector('.eqbars')) n.textContent = +n.closest('.trk').dataset.i + 1; }); });
  a.addEventListener('playing', () => { if (a !== audio) return; setLoading(false); errCount = 0; state.started = true; if (/^Paused at/.test($('#npSub').textContent)) updateNowPlaying(); markPlayingRow(); syncPlay(); onTime(); });
  a.addEventListener('pause', () => { if (a !== audio) return; setLoading(false); if (pendingUnroute && !wantRouted()){ pendingUnroute = false; setTimeout(() => { if (audio.paused && audio.routed) swapAudio(false); }, 50); } });
  a.addEventListener('ended', () => { if (a === audio) onEnded(); });
  a.addEventListener('error', onAudioError);
  if (window.WebKitPlaybackTargetAvailabilityEvent){
    a.addEventListener('webkitplaybacktargetavailabilitychanged', e => setCastAvail(e.availability === 'available'));
    a.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', () => setRemote(a.webkitCurrentPlaybackTargetIsWireless));
  } else if (a.remote && a.remote.watchAvailability){
    a.remote.watchAvailability(v => setCastAvail(v)).catch(() => setCastAvail(true));
    a.remote.addEventListener('connect', () => setRemote(true));
    a.remote.addEventListener('disconnect', () => setRemote(false));
  }
  return a;
}
audio = createAudio(true);

const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const eqActive = () => eq.on && eq.gains.some(g => Math.abs(g) > .01);
// iOS pauses processed audio when the screen locks, so on iPhone the music only goes through the EQ while it's in use
// iPhone: the EQ path breaks car, Bluetooth, and AirPlay playback (and can warp speed), so only Trip out uses it, and only while open
const wantRouted = () => corsMode && eqAvailable && !state.car && !state.remote && !state.casting && !IOS;   // iPhone never reroutes; it reads ahead instead
document.addEventListener('visibilitychange', () => { if (!document.hidden && ctx && ctx.state !== 'running') ctx.resume(); });
let pendingSwap = false, pendingUnroute = false;
function tripIsOpen(){ try { return trip.open; } catch { return false; } }
// Speakers and TVs: AirPlay in Safari, Cast in Chrome. The sound goes straight to the device, so the EQ and visuals rest meanwhile.
let castAvail = false;
function setCastAvail(v){ castAvail = castAvail || v; const b = $('#shCast'); if (b) b.hidden = false; }
function setRemote(on){
  if (!!state.remote === !!on) return;
  state.remote = on; setTimeout(syncTwin, 300);
  $('#castBtn').classList.toggle('on', !!on);
  toast(on ? (IOS ? 'Playing on your speaker. The EQ rests while connected.' : 'Playing on your speaker') : 'Back to this device');
  if (!on && state.queue) ensureGraph();
}
function speakerHelp(){
  toast(IOS ? 'Open Control Center, press and hold the music controls, and tap the AirPlay icon to pick a speaker.'
            : 'No speakers found here. You can also pick one in your computer’s sound or Bluetooth settings.');
}
function openSpeakers(){
  haptic();
  if (!state.queue){ toast('Start a show first, then pick a speaker.'); return; }
  if (audio.webkitShowPlaybackTargetPicker){ if (audio.routed) swapAudio(false); try { audio.webkitShowPlaybackTargetPicker(); } catch { speakerHelp(); } return; }   // AirPlay
  if (castReady){ cast.framework.CastContext.getInstance().requestSession().catch(() => {}); return; }   // Chrome: Cast
  if (audio.remote){ if (audio.routed) swapAudio(false); audio.remote.prompt().catch(err => { if (err && err.name !== 'NotAllowedError') speakerHelp(); }); return; }
  speakerHelp();
}
// Google Cast (Chrome on desktop and Android): the speaker streams the song itself; the app becomes the remote
let castReady = false, remotePlayer = null, remoteCtl = null;
function castSession(){ try { return cast.framework.CastContext.getInstance().getCurrentSession(); } catch { return null; } }
function castLoad(i, t = 0){
  const ses = castSession(), q = state.queue; if (!ses || !q) return;
  const tr = q.tracks[i], mi = new chrome.cast.media.MediaInfo(tr.url, 'audio/mpeg');
  const md = new chrome.cast.media.MusicTrackMediaMetadata(); md.title = tr.title; md.artist = 'Grateful Dead';
  md.albumName = `${fmtShort(q.show.date)} ${q.show.date.slice(0, 4)}, ${q.show.venue}`; mi.metadata = md;
  const rq = new chrome.cast.media.LoadRequest(mi); rq.currentTime = t; rq.autoplay = true;
  ses.loadMedia(rq).catch(() => toast('That song didn’t load on your speaker.'));
}
function castStart(){
  if (state.casting) return;
  state.casting = true; $('#castBtn').classList.add('on');
  const t = audio.currentTime; audio.pause();
  if (state.queue) castLoad(state.queue.index, t);
  toast('Playing on your speaker'); syncTwin();
}
function castStop(){
  if (!state.casting) return;
  const t = remotePlayer ? remotePlayer.currentTime : 0;
  state.casting = false; $('#castBtn').classList.remove('on');
  if (state.queue && t){ try { audio.currentTime = t; } catch {} }
  toast('Back to this device'); syncPlay(); syncTwin();
}
function castProgress(){
  if (!state.casting || !remotePlayer) return;
  const c = remotePlayer.currentTime, d = remotePlayer.duration || 0, pr = d ? c / d : 0;
  $('#miniProg').style.width = pr * 100 + '%';
  SEEKS.forEach(([sel, cur, dur]) => { const el = $(sel); $(dur).textContent = clock(d); if (dragging === el) return; $(cur).textContent = clock(c); el.value = pr * 1000; el.style.setProperty('--p', pr * 100 + '%'); });
}
if (window.chrome && !IOS && location.protocol === 'https:'){
  window.__onGCastApiAvailable = ok => {
    if (!ok) return;
    try {
      cast.framework.CastContext.getInstance().setOptions({ receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED });
      remotePlayer = new cast.framework.RemotePlayer(); remoteCtl = new cast.framework.RemotePlayerController(remotePlayer);
      const E = cast.framework.RemotePlayerEventType;
      remoteCtl.addEventListener(E.IS_CONNECTED_CHANGED, () => remotePlayer.isConnected ? castStart() : castStop());
      remoteCtl.addEventListener(E.IS_PAUSED_CHANGED, () => { syncPlay(); syncTwin(); });
      remoteCtl.addEventListener(E.CURRENT_TIME_CHANGED, castProgress);
      remoteCtl.addEventListener(E.PLAYER_STATE_CHANGED, () => {
        const ms = castSession() && castSession().getMediaSession();
        if (state.casting && remotePlayer.playerState === 'IDLE' && ms && ms.idleReason === 'FINISHED') onEnded();
      });
      castReady = true;
    } catch {}
  };
  const sc = document.createElement('script'); sc.async = true;
  sc.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1'; document.head.appendChild(sc);
}
// While a speaker plays the music, a silent copy plays in the page so the visuals, title, and bars can still follow it
const twin = { el: null, an: null };
function remoteTime(){ return state.casting && remotePlayer ? remotePlayer.currentTime : audio.currentTime; }
function remotePlaying(){ return state.casting && remotePlayer ? !remotePlayer.isPaused : !audio.paused; }
function syncTwin(){
  const need = !IOS && (state.remote || state.casting) && state.queue && corsMode;
  if (!need){ if (twin.el && !twin.el.paused) twin.el.pause(); return; }
  if (!ensureCtx()) return;
  if (!twin.el){
    twin.el = new Audio(); twin.el.crossOrigin = 'anonymous'; twin.el.preload = 'auto';
    const src = ctx.createMediaElementSource(twin.el); twin.an = ctx.createAnalyser(); twin.an.fftSize = 2048; twin.an.smoothingTimeConstant = .8;
    const mute = ctx.createGain(); mute.gain.value = 0; src.connect(twin.an); twin.an.connect(mute); mute.connect(ctx.destination);
    twin.beat = ctx.createAnalyser(); twin.beat.fftSize = 1024; twin.beat.smoothingTimeConstant = 0; src.connect(twin.beat);
  }
  const url = state.queue.tracks[state.queue.index].url;
  if (twin.el.src !== url) twin.el.src = url;
  if (Math.abs(twin.el.currentTime - remoteTime()) > .35){ try { twin.el.currentTime = remoteTime(); } catch {} }
  if (remotePlaying()){ if (twin.el.paused) twin.el.play().catch(() => {}); } else if (!twin.el.paused) twin.el.pause();
  if (ctx.state === 'suspended') ctx.resume();
}
setInterval(syncTwin, 1500);
// Which analyser is listening right now: the page's own sound, or the silent copy while a speaker plays
function getBeatAn(){
  if (graph && audio.routed && !audio.paused && !state.remote && !state.casting) return graph.beat;
  if (twin.el && twin.beat && !twin.el.paused) return twin.beat;
  return null;
}
function getAn(){
  if (graph && audio.routed && !audio.paused && !state.remote && !state.casting) return graph.an;
  if (twin.el && twin.an && !twin.el.paused) return twin.an;
  return null;
}
function ensureCtx(){
  if (graph) return true;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const filters = BANDS.map(b => { const f = ctx.createBiquadFilter(); f.type = b.t; f.frequency.value = b.f; f.Q.value = 1.1; return f; });
    const pre = ctx.createGain();
    const an = ctx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0.82;
    for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
    filters[filters.length - 1].connect(pre); pre.connect(an);
    an.connect(ctx.destination);
    const beat = ctx.createAnalyser(); beat.fftSize = 1024; beat.smoothingTimeConstant = 0; pre.connect(beat);   // no smoothing: kicks show up immediately
    graph = { filters, pre, an, beat, input: filters[0] };
    applyEq();
    return true;
  } catch (e) { console.warn('EQ unavailable', e); eqAvailable = false; renderEqNote(); return false; }
}
function routeElement(el){
  if (!graph || el.routed || el.crossOrigin !== 'anonymous') return false;
  try {
    ctx.createMediaElementSource(el).connect(graph.input); el.routed = true;
    const g = graph.pre.gain; g.cancelScheduledValues(ctx.currentTime); g.setValueAtTime(0, ctx.currentTime); applyEq();   // fade in, no click
    return true;
  } catch (e) { return false; }
}
// Swap the playing element (to add or drop the EQ path) without losing your place.
function swapAudio(routed){
  const url = audio.getAttribute('src') ? audio.src : '', t = audio.currentTime, playing = !audio.paused;
  const old = audio; audio = createAudio(routed || (IOS && corsMode));
  if (routed) routeElement(audio);
  old.pause(); old.removeAttribute('src'); old.load();
  if (url){
    audio.src = url;
    if (t > 0) audio.addEventListener('loadedmetadata', () => { audio.currentTime = t; }, { once: true });
    if (playing) audio.play().catch(() => syncPlay());
  }
}
function ensureGraph(){
  const canSwap = !IOS || !navigator.userActivation || navigator.userActivation.isActive;
  if (!wantRouted()){
    if (audio.routed){
      if (!audio.paused && !state.remote && !state.casting && !IOS) pendingUnroute = true;
      else if (canSwap) swapAudio(false); else pendingSwap = true;
    }
    if (ctx && ctx.state === 'suspended') ctx.resume();
    return;
  }
  pendingUnroute = false;
  if (!ensureCtx()) return;
  if (ctx.state === 'suspended') ctx.resume();
  if (!audio.routed){ if (audio.crossOrigin === 'anonymous') routeElement(audio); else if (canSwap) swapAudio(true); }
}
document.addEventListener('click', () => { if (pendingSwap){ pendingSwap = false; ensureGraph(); } }, true);
function applyEq(){
  if (!graph) return;
  const g = eq.on ? eq.gains : eq.gains.map(() => 0);
  const t = ctx.currentTime;
  graph.filters.forEach((f, i) => f.gain.setTargetAtTime(g[i], t, 0.03));
  const peak = Math.max(0, ...g);
  graph.pre.gain.setTargetAtTime(Math.pow(10, (-peak * 0.6) / 20), t, 0.03);
}
async function onAudioError(e){
  if (e.target !== audio || !state.queue || !audio.getAttribute('src')) return;
  const tr = state.queue.tracks[state.queue.index];
  if (tr && tr.alt && tr.url !== tr.alt){ tr.url = tr.alt; audio.src = tr.alt; audio.play().catch(() => syncPlay()); return; }
  const url = audio.src;
  if (corsMode){
    // Check whether this is a cross-origin block (then retry without the EQ) or a genuinely missing file.
    let corsOk = false;
    try { const r = await fetch(url, { method: 'HEAD', mode: 'cors' }); corsOk = r.ok; } catch {}
    if (!corsOk){
      corsMode = false; eqAvailable = false;
      const old = audio; audio = createAudio(false);
      old.removeAttribute('src'); old.load();
      audio.src = url; audio.play().catch(() => syncPlay());
      renderEqNote();
      toast('Playing without the equalizer: this browser blocked audio processing for archive.org streams.');
      return;
    }
  }
  errCount++;
  const q = state.queue;
  setLoading(false);
  if (errCount < 3 && q.index < q.tracks.length - 1){ toast("That track didn't load. Skipping ahead."); loadTrack(q.index + 1); }
  else { toast("Playback stopped: archive.org didn't return this track. Try another recording of the show."); syncPlay(); }
}

function playFrom(i, songRun = false){
  const m = state.meta; if (!m || !m.tracks.length) return;
  state.queue = { id: m.id, tracks: m.tracks, show: state.current, index: i, songRun: songRun && !!state.song };
  loadTrack(i);
}
// The next track loads quietly in a spare player, then takes over the moment the current one ends.
let spare = null;
function bufferNext(){
  const q = state.queue; if (!q || IOS || state.remote) return;
  const n = q.songRun ? null : q.tracks[q.index + 1];
  if (!n){ if (spare){ spare.el.removeAttribute('src'); spare = null; } return; }
  if (spare && spare.url === n.url) return;
  const el = createAudio(wantRouted());
  el.preload = 'auto'; el.muted = false; el.src = n.url; el.load();
  spare = { url: n.url, el };
}
// When a show opens and nothing is playing, start loading its first track so Play is instant
function primeFirst(m){
  if (state.queue || !m.tracks.length) return;
  const i = state.song ? Math.max(0, matchIndex(m)) : 0;
  audio.preload = 'auto';
  if (audio.src !== m.tracks[i].url){ audio.src = m.tracks[i].url; audio.load(); }
}
let loadingT = 0;
function setLoading(on){ clearTimeout(loadingT); if (on) loadingT = setTimeout(() => document.body.classList.add('loading'), 350); else document.body.classList.remove('loading'); }
// the playing bars appear next to a song only once its music is actually coming out
function markPlayingRow(){
  document.querySelectorAll('.trk.playing .n').forEach(n => { if (!n.querySelector('.eqbars')) n.innerHTML = '<span class="eqbars" aria-hidden="true"><i></i><i></i><i></i></span>'; });
}
function loadTrack(i){
  const q = state.queue; if (!q || i < 0 || i >= q.tracks.length) return;
  q.index = i;
  if (pendingUnroute){   // switch players between songs, where nobody hears it
    pendingUnroute = false;
    if (audio.routed && !wantRouted()){ const old = audio; audio = createAudio(IOS && corsMode); old.pause(); old.removeAttribute('src'); old.load(); }
  }
  if (state.casting){ castLoad(i, 0); q.buffered = true; updateNowPlaying(); syncTwin(); ['#play', '#mplay', '#seek', '#shPlay', '#shSeek', '#back15', '#fwd15'].forEach(s => $(s).disabled = false); if (state.meta && state.meta.id === q.id && state.tab === 'setlist') renderDetail(); return; }
  ensureGraph();
  const url = q.tracks[i].url;
  if (!IOS && !state.remote && spare && spare.url === url && (spare.el.crossOrigin === 'anonymous') === wantRouted()){
    const old = audio; audio = spare.el; spare = null;
    audio.volume = volume;
    if (wantRouted()) routeElement(audio);
    old.pause(); old.removeAttribute('src'); old.load();
    audio.currentTime = 0;
  } else if (audio.src !== url) audio.src = url;
  else { try { audio.currentTime = 0; } catch {} }
  audio.play().catch(() => syncPlay());
  q.buffered = false; state.started = false; setLoading(true);
  if (IOS) aheadReset('');
  if (!q.preview){ if (q.histFor !== keyOf(q.show)){ q.histFor = keyOf(q.show); addHistory(q); } }
  if (!q.preview) store.set('resume', { g: gmin(q.show), id: q.id, index: i, t: 0 });
  if (i > 0 && q.tracks[i - 1].segue && tripIsOpen()) segueShift();
  ['#play', '#mplay', '#seek', '#shPlay', '#shSeek', '#back15', '#fwd15'].forEach(s => $(s).disabled = false);
  updateNowPlaying();
  if (state.meta && state.meta.id === q.id && state.tab === 'setlist') renderDetail();
}
function togglePlay(){
  if (!state.queue){ if (state.meta) playFrom(0); return; }
  if (state.casting && remoteCtl){ remoteCtl.playOrPause(); return; }
  ensureGraph();
  if (audio.paused) audio.play().catch(() => syncPlay()); else audio.pause();
}
function skip(sec){ if (!state.queue) return;
  if (state.casting && remotePlayer){ remotePlayer.currentTime = Math.max(0, remotePlayer.currentTime + sec); remoteCtl.seek(); haptic(); return; } audio.currentTime = Math.max(0, Math.min((audio.duration || 0) - .5, audio.currentTime + sec)); haptic(); }
function next(){ const q = state.queue; if (q && q.index < q.tracks.length - 1) loadTrack(q.index + 1); }
function prev(){ const q = state.queue; if (!q) return;
  if (state.casting && remotePlayer){ if (remotePlayer.currentTime > 4 || q.index === 0){ remotePlayer.currentTime = 0; remoteCtl.seek(); } else loadTrack(q.index - 1); return; }
  if (audio.currentTime > 4 || q.index === 0) audio.currentTime = 0; else loadTrack(q.index - 1); }

function onEnded(){
  const q = state.queue; if (!q) return;
  if (q.songRun) return continueToNextShow(true);
  if (q.index < q.tracks.length - 1) loadTrack(q.index + 1); else continueToNextShow(false);
}
// Keep the music going: the next show in your list, or in a song search, the next show's version of that song.
async function continueToNextShow(songRun){
  const q = state.queue; if (!q) return;
  if (!store.get('autonext', true) && !state.car){ syncPlay(); return; }
  const list = state.shows.length ? visible() : [];
  const i = list.findIndex(g => keyOf(g) === keyOf(q.show));
  const g = i >= 0 ? list[i + 1] : list.find(x => x.date > q.show.date);
  if (!g){ toast('That was the last show in this list.'); return; }
  try {
    const id = g.sources[0].identifier;
    let m = metaCache.get(id);
    if (!m) m = await fetchMeta(id);
    if (!m.tracks.length) throw new Error('no audio');
    let start = 0;
    if (songRun){ start = matchIndex(m); if (start < 0){ state.queue = { ...q, show: g }; return continueToNextShow(true); } }
    state.queue = { id, tracks: m.tracks, show: g, index: start, songRun };
    toast(`Up next: ${fmtShort(g.date)} ${g.date.slice(0, 4)}, ${g.venue}`);
    loadTrack(start);
  } catch (e) { toast("The next show didn't load from archive.org."); }
}
const PLAY = '<path d="M8 5v14l11-7z"/>', PAUSE = '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>';
function syncPlay(){
  const p = state.casting && remotePlayer ? !remotePlayer.isPaused : !audio.paused;
  document.body.classList.toggle('playing', p);
  if (!p) document.querySelectorAll('.trk.playing .n').forEach(n => { if (n.querySelector('.eqbars')) n.textContent = +n.closest('.trk').dataset.i + 1; });
  else if (state.started || state.casting) markPlayingRow();
  $('#playIcon').innerHTML = $('#mplayIcon').innerHTML = $('#shPlayIcon').innerHTML = p ? PAUSE : PLAY;
  $('#shPlay').setAttribute('aria-label', p ? 'Pause' : 'Play');
  $('#play').setAttribute('aria-label', p ? 'Pause' : 'Play');
  $('#mplay').setAttribute('aria-label', p ? 'Pause' : 'Play');
  document.querySelectorAll('.trk.playing').forEach(b => b.classList.toggle('paused', !p));
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = p ? 'playing' : 'paused';
  if (p && !$('#eqFull').hidden) drawSpectrum();
}
// Cover art for the lock screen and CarPlay, drawn per show
const artCache = new Map();
function coverArt(g){
  if (artCache.has(g.date)) return artCache.get(g.date);
  const c = document.createElement('canvas'); c.width = c.height = 512; const x = c.getContext('2d');
  const gr = x.createLinearGradient(0, 0, 512, 512); gr.addColorStop(0, '#2148b8'); gr.addColorStop(.55, '#0b1a4a'); gr.addColorStop(1, '#040a1f');
  x.fillStyle = gr; x.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 10; i++){ x.strokeStyle = `rgba(150,195,255,${.04 + i * .014})`; x.lineWidth = 2; x.beginPath(); x.arc(420, 96, 30 + i * 34, 0, Math.PI * 2); x.stroke(); }
  const p = parts(g.date), label = validDate(g.date) ? `${p.m}.${p.d}.${String(p.y).slice(2)}` : String(p.y);
  let fs = 150; x.font = `850 ${fs}px "Schibsted Grotesk", system-ui, sans-serif`;
  while (x.measureText(label).width > 440 && fs > 60){ fs -= 6; x.font = `850 ${fs}px "Schibsted Grotesk", system-ui, sans-serif`; }
  x.fillStyle = '#eef4ff'; x.fillText(label, 36, 320);
  x.font = '650 30px "Schibsted Grotesk", system-ui, sans-serif'; x.fillStyle = '#d6e4ff';
  const words = g.venue.split(' '); let line = '', y = 372, lines = 0;
  for (const w of words){ const tl = line ? line + ' ' + w : w; if (x.measureText(tl).width > 440 && line){ x.fillText(line, 36, y); y += 36; line = w; if (++lines === 2) break; } else line = tl; }
  if (lines < 2) x.fillText(line, 36, y);
  x.font = '500 22px "Schibsted Grotesk", system-ui, sans-serif'; x.fillStyle = '#93a9d6'; x.fillText(g.coverage || '', 36, y + 34);
  x.font = '900 30px "Unbounded", "Schibsted Grotesk", sans-serif'; x.fillStyle = '#9fcfff'; x.fillText('deadjams', 36, 478);
  const url = c.toDataURL('image/png'); artCache.set(g.date, url); return url;
}
let posT = 0;
function onTime(){
  const q = state.queue;
  if (q && !q.buffered && audio.currentTime > 4){ q.buffered = true; bufferNext(); }
  if (q){
    if (performance.now() - (q.savedAt || 0) > 5000){ q.savedAt = performance.now(); store.set('resume', { g: gmin(q.show), id: q.id, index: q.index, t: audio.currentTime }); }
  }
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && isFinite(audio.duration) && audio.duration > 0 && performance.now() - posT > 1000){
    posT = performance.now();
    try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: 1, position: Math.min(audio.currentTime, audio.duration) }); } catch {}
  }
  const d = audio.duration, c = audio.currentTime;
  const total = isFinite(d) && d > 0 ? d : (state.queue ? state.queue.tracks[state.queue.index].len : 0);
  const p = total ? Math.min(1, c / total) : 0;
  $('#miniProg').style.width = p * 100 + '%';
  SEEKS.forEach(([sel, cur, dur]) => {
    const el = $(sel);
    $(dur).textContent = clock(total);
    if (dragging === el) return;
    $(cur).textContent = clock(c);
    el.value = p * 1000; el.style.setProperty('--p', p * 100 + '%');
  });
}
function updateNowPlaying(){
  const q = state.queue; if (!q) return;
  const t = q.tracks[q.index], g = q.show;
  $('#npTitle').textContent = t.title;
  $('#npSub').textContent = `${fmtLong(g.date)}, ${g.venue}`;
  $('#prev').disabled = false;
  $('#next').disabled = $('#mnext').disabled = $('#shNext').disabled = q.index >= q.tracks.length - 1;
  $('#shDate').textContent = fmtLong(g.date);
  $('#shVenue').textContent = [g.venue, g.coverage].filter(Boolean).join(', ');
  $('#shTrack').textContent = t.title;
  $('#shPos').textContent = `Track ${q.index + 1} of ${q.tracks.length}`;
  $('#sheetYear').textContent = g.date.slice(0, 4);
  syncTrip();
  document.title = `${t.title} — ${fmtShort(g.date)} ${g.date.slice(0, 4)} | deadjams`;
  if ('mediaSession' in navigator){
    const nx = q.tracks[q.index + 1];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `${q.index + 1}. ${t.title}`,
      artist: `Grateful Dead, ${fmtShort(g.date)} ${g.date.slice(0, 4)}`,
      album: nx ? `Next: ${q.index + 2}. ${nx.title}` : `Last song of ${g.venue}`,
      artwork: [{ src: coverArt(g), sizes: '512x512', type: 'image/png' }] });
  }
}
if ('mediaSession' in navigator){
  const ms = navigator.mediaSession;
  ms.setActionHandler('play', () => audio.play());
  ms.setActionHandler('pause', () => audio.pause());
  ms.setActionHandler('nexttrack', () => { const q = state.queue; if (q && q.index >= q.tracks.length - 1) continueToNextShow(false); else next(); });
  ms.setActionHandler('previoustrack', prev);
  try { ms.setActionHandler('seekto', d => { audio.currentTime = d.seekTime; }); } catch {}
}

/* player controls */
$('#play').onclick = () => { togglePlay(); haptic(); };
$('#back15').onclick = () => skip(-15); $('#fwd15').onclick = () => skip(15);
$('#shBack15').onclick = () => skip(-15); $('#shFwd15').onclick = () => skip(15);
$('#mplay').onclick = togglePlay;
$('#next').onclick = next;
$('#prev').onclick = prev;
SEEKS.forEach(([sel, cur]) => {
  const el = $(sel);
  el.addEventListener('input', () => {
    dragging = el; el.style.setProperty('--p', el.value / 10 + '%');
    if (isFinite(audio.duration)) $(cur).textContent = clock(el.value / 1000 * audio.duration);
  });
  el.addEventListener('change', () => {
    if (state.casting && remotePlayer){ remotePlayer.currentTime = el.value / 1000 * (remotePlayer.duration || 0); remoteCtl.seek(); }
    else if (isFinite(audio.duration)) audio.currentTime = el.value / 1000 * audio.duration;
    dragging = null;
  });
});
const vol = $('#vol');
function setVol(v){ volume = v; audio.volume = v; vol.value = v * 100; vol.style.setProperty('--p', v * 100 + '%'); store.set('vol', v); }
vol.addEventListener('input', () => { setVol(vol.value / 100); if (volume > 0) lastVol = volume; });
$('#mute').onclick = () => setVol(volume > 0 ? 0 : lastVol || 0.9);
setVol(volume);
$('#castBtn').onclick = openSpeakers;
$('#shCast').onclick = openSpeakers;
$('#np').onclick = () => { if (!state.queue) return; if (mq.matches) openSheet(); else goToPlayingShow(); };
function goToPlayingShow(){
  const q = state.queue; if (!q) return;
  if (state.current === q.show && state.sourceId === q.id && document.body.classList.contains('viewing')) return;
  openShow(q.show, q.id);
}
$('#mnext').onclick = () => { next(); haptic(); };
(() => { // swipe up on the mini player opens the now-playing screen
  let y0 = null;
  $('#player').addEventListener('touchstart', e => { y0 = e.touches[0].clientY; }, { passive: true });
  $('#player').addEventListener('touchend', e => { if (y0 != null && y0 - e.changedTouches[0].clientY > 40 && state.queue && mq.matches){ openSheet(); haptic(); } y0 = null; }, { passive: true });
  // swipe sideways on the song title in the now-playing screen to change songs
  let x0 = null, sy = null;
  const t = $('#shTrack').parentElement;
  t.addEventListener('touchstart', e => { if (e.target.closest('input, button')) return; x0 = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  t.addEventListener('touchend', e => {
    if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - sy; x0 = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5){ dx < 0 ? next() : prev(); haptic(); }
  }, { passive: true });
})();

/* EQ UI */
function buildEq(){
  $('#presets').innerHTML = Object.keys(PRESETS).map(p => `<button class="chip" data-p="${p}" aria-pressed="${eq.preset === p}">${p}</button>`).join('');
  $('#bands').insertAdjacentHTML('beforeend', BANDS.map((b, i) => `
    <label class="band"><input type="range" min="-12" max="12" step="0.5" value="${eq.gains[i]}" data-i="${i}" aria-label="${b.l} hertz"><span>${b.l}</span></label>`).join(''));
  $('#eqOn').checked = eq.on;
  $('#eqHost2').classList.toggle('off', !eq.on);
  $('#presets').onclick = e => {
    const b = e.target.closest('.chip'); if (!b) return;
    eq.preset = b.dataset.p; eq.gains = PRESETS[eq.preset].slice();
    document.querySelectorAll('.band input').forEach((inp, i) => inp.value = eq.gains[i]);
    document.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', c === b));
    saveEq();
  };
  $('#bands').addEventListener('input', e => {
    const inp = e.target.closest('input'); if (!inp) return;
    eq.gains[+inp.dataset.i] = +inp.value; eq.preset = 'Custom';
    document.querySelectorAll('.chip').forEach(c => c.setAttribute('aria-pressed', 'false'));
    saveEq();
  });
  $('#eqOn').onchange = e => { eq.on = e.target.checked; $('#eqHost2').classList.toggle('off', !eq.on); saveEq(); };
  renderEqNote();
}
function saveEq(){ store.set('eq', eq); applyEq(); if (state.queue) ensureGraph(); const v = $('#setEqVal'); if (v) v.textContent = !eq.on ? 'Off' : eq.gains.every(g => !g) ? 'Flat' : eq.preset; }
function toggleEq(force){ if (force === false) closeEqFull(); else openEqFull(); }
function renderEqNote(){
  if (IOS){ const r = $('#setEq'); if (r) r.hidden = true; return; }
  if (typeof syncTrip === 'function') syncTrip();
  $('#eqNote').textContent = eqAvailable
    ? 'Drag a band to shape the sound. Settings are saved on this device.'
    : "This browser won't let the page process archive.org audio, so the equalizer is off. Playback still works.";
  document.querySelectorAll('.band input, #eqOn, .chip').forEach(i => i.disabled = !eqAvailable);
}
let rafId = 0;
function drawSpectrum(){
  cancelAnimationFrame(rafId);
  const cv = $('#specBig'); const c2 = cv.getContext('2d');
  const cs = getComputedStyle(document.documentElement);
  const cols = ['--c1', '--c2', '--c3'].map(v => cs.getPropertyValue(v).trim() || '#7a9dff');
  let data = null, peaks = null;
  const loop = () => {
    if ($('#eqFull').hidden){ c2.clearRect(0, 0, cv.width, cv.height); return; }
    rafId = requestAnimationFrame(loop);
    const w = cv.clientWidth * devicePixelRatio, h = cv.clientHeight * devicePixelRatio;
    if (cv.width !== w || cv.height !== h){ cv.width = w; cv.height = h; }
    c2.clearRect(0, 0, w, h);
    const an = getAn(); if (!an) return;
    if (!data || data.length !== an.frequencyBinCount){ data = new Uint8Array(an.frequencyBinCount); }
    an.getByteFrequencyData(data);
    const bars = 48, nyq = ctx.sampleRate / 2, gap = w / bars * .22, bw = w / bars - gap;
    if (!peaks) peaks = new Float32Array(bars);
    const gr = c2.createLinearGradient(0, h, 0, 0); cols.forEach((c, i) => gr.addColorStop(i / 2, c));
    c2.fillStyle = gr; c2.globalAlpha = .75;
    for (let i = 0; i < bars; i++){
      const f0 = 30 * Math.pow(16000 / 30, i / bars), f1 = 30 * Math.pow(16000 / 30, (i + 1) / bars);
      const a = Math.floor(f0 / nyq * data.length), b = Math.max(a + 1, Math.floor(f1 / nyq * data.length));
      let m = 0; for (let k = a; k < b; k++) m = Math.max(m, data[k]);
      const bh = Math.max(4 * devicePixelRatio, (m / 255) * h * (mq.matches ? .55 : .92));
      const x = i * (bw + gap) + gap / 2;
      c2.beginPath(); c2.roundRect ? c2.roundRect(x, h - bh, bw, bh, Math.min(bw / 2, 8 * devicePixelRatio)) : c2.rect(x, h - bh, bw, bh); c2.fill();
      peaks[i] = Math.max(peaks[i] - h * .006, h - bh);   // a falling peak marker on each bar
      peaks[i] = Math.min(peaks[i], h - bh);
    }
    c2.globalAlpha = .9; c2.fillStyle = cols[2];
    for (let i = 0; i < bars; i++){ const x = i * (bw + gap) + gap / 2; c2.fillRect(x, peaks[i] - 4 * devicePixelRatio, bw, 3 * devicePixelRatio); }
    c2.globalAlpha = 1;
  };
  loop();
}

/* ---------- misc UI ---------- */
let toastT;
function toast(msg){ const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 4200); }
$('#filter').addEventListener('input', e => { state.filter = e.target.value; renderList(); });
$('#sort').onchange = e => { state.sort = e.target.value; renderList(); };
$('#sort').addEventListener('change', () => { state.sortAuto = false; });
const SONGS = ["Alabama Getaway","Althea","Attics of My Life","Bertha","Big River","Bird Song","Black Peter","Black-Throated Wind","Box of Rain","Brokedown Palace","Brown-Eyed Women","Candyman","Casey Jones","Cassidy","China Cat Sunflower","China Doll","Cold Rain and Snow","Comes a Time","Cosmic Charlie","Crazy Fingers","Cumberland Blues","Dancing in the Street","Dark Star","Days Between","Deal","Dear Mr. Fantasy","Dire Wolf","Drums","Estimated Prophet","Eyes of the World","Fire on the Mountain","Foolish Heart","Franklin's Tower","Friend of the Devil","Good Lovin'","Greatest Story Ever Told","Hell in a Bucket","Help on the Way","He's Gone","Here Comes Sunshine","High Time","I Know You Rider","It Must Have Been the Roses","Jack Straw","Jack-A-Roe","Lazy Lightning","Let It Grow","Looks Like Rain","Loser","Lost Sailor","Me and My Uncle","Mississippi Half-Step Uptown Toodeloo","Morning Dew","New Speedway Boogie","Not Fade Away","One More Saturday Night","Playing in the Band","Ramble On Rose","Row Jimmy","Saint of Circumstance","Samson and Delilah","Scarlet Begonias","Shakedown Street","Ship of Fools","Slipknot!","Space","Stagger Lee","St. Stephen","Stella Blue","Sugar Magnolia","Sugaree","Sunshine Daydream","Supplication","Tennessee Jed","Terrapin Station","The Eleven","The Music Never Stopped","The Other One","The Wheel","They Love Each Other","Throwing Stones","Touch of Grey","Truckin'","Uncle John's Band","Viola Lee Blues","Wharf Rat","Weather Report Suite","West L.A. Fadeaway","Women Are Smarter"];
$('#songs').innerHTML = SONGS.map(t => `<option value="${esc(t)}">`).join('');
let lastSong = { q: '', t: 0 };
// One search box for everything: a year, a date, a song, or a venue or city
function parseShowDate(q){
  q = q.trim().toLowerCase();
  let m = q.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/); if (m) return ymd(+m[1], +m[2], +m[3]);
  m = q.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2}|\d{4})$/); if (m) return ymd(+m[3] < 100 ? 1900 + +m[3] : +m[3], +m[1], +m[2]);
  const MON = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
  m = q.match(/^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+'?(\d{2}|\d{4})$/); if (m && MON.includes(m[1])) return ymd(+m[3] < 100 ? 1900 + +m[3] : +m[3], MON.indexOf(m[1]) + 1, +m[2]);
  m = q.match(/^(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+'?(\d{2}|\d{4})$/); if (m && MON.includes(m[2])) return ymd(+m[3] < 100 ? 1900 + +m[3] : +m[3], MON.indexOf(m[2]) + 1, +m[1]);
  return null;
}
function ymd(y, mo, d){ if (y < FIRST || y > LAST || mo < 1 || mo > 12 || d < 1 || d > 31) return null; return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
// Search understands: a year, a date, a song, a venue or city or state, or a mix like "Chicago 1977"
const STATES = { alabama:'AL', alaska:'AK', arizona:'AZ', arkansas:'AR', california:'CA', colorado:'CO', connecticut:'CT', delaware:'DE', florida:'FL', georgia:'GA',
  hawaii:'HI', idaho:'ID', illinois:'IL', indiana:'IN', iowa:'IA', kansas:'KS', kentucky:'KY', louisiana:'LA', maine:'ME', maryland:'MD', massachusetts:'MA',
  michigan:'MI', minnesota:'MN', mississippi:'MS', missouri:'MO', montana:'MT', nebraska:'NE', nevada:'NV', 'new hampshire':'NH', 'new jersey':'NJ', 'new mexico':'NM',
  'new york state':'NY', 'north carolina':'NC', 'north dakota':'ND', ohio:'OH', oklahoma:'OK', oregon:'OR', pennsylvania:'PA', 'rhode island':'RI', 'south carolina':'SC',
  'south dakota':'SD', tennessee:'TN', texas:'TX', utah:'UT', vermont:'VT', virginia:'VA', washington:'WA', 'west virginia':'WV', wisconsin:'WI', wyoming:'WY', 'washington dc':'DC' };
const ABBRS = new Set(Object.values(STATES));
const songKey = x => norm(x).replace(/^saint /, 'st ');
function findSong(q){
  const k = songKey(q); if (!k) return null;
  return SONGS.find(t => songKey(t) === k) || (k.length > 3 && SONGS.find(t => songKey(t).startsWith(k))) || null;
}
async function runSearch(raw){
  let q = raw.trim(); if (!q) return;
  document.body.classList.remove('searching'); $('#songq').blur(); applyShrink();
  // a bare year
  let y = q.match(/^'?(\d{2}|\d{4})$/); if (y){ let n = +y[1]; if (n < 100) n += 1900; if (n >= FIRST && n <= LAST) return loadYear(n); }
  // a full date opens that show
  const d = parseShowDate(q);
  if (d){
    await loadYear(+d.slice(0, 4));
    const g = state.shows.find(x => x.date === d);
    if (g) openShow(g); else toast('No recording of a show on that date.');
    return;
  }
  // a year mixed with other words narrows the rest, e.g. "Chicago 1977" or "Dark Star 72"
  let year = null;
  const parts = q.split(/\s+/).filter(w => {
    const m = w.match(/^'?(\d{2}|\d{4})$/); if (!m || year) return true;
    let n = +m[1]; if (n < 100) n += 1900;
    if (n >= FIRST && n <= LAST){ year = n; return false; }
    return true;
  });
  q = parts.join(' ').trim(); if (!q && year) return loadYear(year);
  const song = findSong(q);
  if (song){ $('#songq').value = year ? `${song} ${year}` : song; return searchSong(song, year); }
  return searchPlace(q, year, raw.trim());
}
// Venues, cities, and states: ask the archive only about the venue and location fields, then double-check every result
async function searchPlace(q, year, shown){
  if ($('#sotdMobile')) $('#sotdMobile').innerHTML = '';
  leaveSong(); state.mode = 'search'; state.label = `“${shown}”`; markDial();
  if (document.body.classList.contains('viewing') && mq.matches) closeDetail();
  const ph = q.replace(/["\\]/g, ''), k = norm(ph);
  const abbr = STATES[k] || STATES[k.replace(/ state$/, '')] || (ph.length === 2 && ABBRS.has(ph.toUpperCase()) ? ph.toUpperCase() : null);
  const fields = abbr ? `coverage:"${abbr}"` : `venue:"${ph}" OR coverage:"${ph}"`;
  const yq = year ? ` AND year:${year}` : '';
  const words = k.split(' ').filter(Boolean);
  const matches = g => {
    const places = [g.venue, g.coverage, ...g.sources.flatMap(s => [s.venue, s.coverage])].filter(Boolean);
    if (year && +g.date.slice(0, 4) !== year) return false;
    if (abbr) return places.some(p => new RegExp(`(,|\\s)${abbr}\\b`).test(String(p)));
    return places.some(p => { const h = norm(p); return words.every(w => new RegExp(`\\b${w}`).test(h)); });
  };
  let found = [];
  await loadList(async () => {
    const docs = await search(`collection:GratefulDead AND (${fields})${yq}`);
    found = groupDocs(docs).filter(matches);
    return found;
  });
  // nothing at a place by that name: treat it as a song title the suggestions don't know
  if (!found.length && !state.error){ $('#songq').value = shown; return searchSong(q, year); }
}
function submitSong(){
  const q = $('#songq').value.trim();
  if (!q || (q === lastSong.q && Date.now() - lastSong.t < 800)) return;
  lastSong = { q, t: Date.now() }; document.body.classList.remove('searching');
  $('#songq').blur();
  runSearch(q);
}
$('#songForm').addEventListener('submit', e => { e.preventDefault(); submitSong(); });
$('#songBtn').onclick = () => { document.body.classList.add('searching'); applyShrink(); haptic(); setTimeout(() => $('#songq').focus(), 30); };
$('#songCancel').onclick = () => { document.body.classList.remove('searching'); $('#songq').blur(); applyShrink(); };
$('#songq').addEventListener('change', () => { if (SONGS.includes($('#songq').value.trim())) submitSong(); });
$('#otd').onclick = loadOnThisDay;
// Top 50: the best-loved shows as a list, sorted by rating
async function openTop50(){
  if (!top50) await loadTop50();
  if ($('#sotdMobile')) $('#sotdMobile').innerHTML = '';
  leaveSong(); state.mode = 'top50'; state.label = 'Top 50';
  state.shows = (top50 || []).map(g => ({ ...g })); state.loading = false; state.partial = false; state.error = null;
  state.sort = 'rating'; $('#sort').value = 'rating';
  markDial(); renderList(); haptic();
  if (document.body.classList.contains('viewing') && mq.matches) closeDetail();
  setY(0);
  track('top50_list');
}
$('#top50Btn').onclick = () => openTop50();
document.addEventListener('keydown', e => {
  if (e.target.closest('input, select, textarea') && e.target.type !== 'range') return;
  if (e.key === ' ' && !e.target.closest('button')){ e.preventDefault(); togglePlay(); }
  else if (e.key === 'Escape'){ if (!$('#eqFull').hidden) closeEqFull(); else if (!$('#settings').hidden) closeSettings(); else if (trip.open) requestCloseTrip(); else if (!$('#sheet').hidden) closeSheet(); }
  else if (e.target.closest('.dial, input[type=range]')) return;
  else if (e.key === 'ArrowRight' && state.queue && !e.shiftKey) audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 10);
  else if (e.key === 'ArrowLeft' && state.queue && !e.shiftKey) audio.currentTime = Math.max(0, audio.currentTime - 10);
  else if (e.key === 'ArrowRight' && e.shiftKey) next();
  else if (e.key === 'ArrowLeft' && e.shiftKey) prev();
});

/* ---------- phone navigation ---------- */
const mq = matchMedia('(max-width: 900px)');
const nav = { show: false, sheet: false, thenShow: false };
let listScroll = 0;
function hideDetail(){
  nav.show = false;
  document.body.classList.remove('viewing'); applyShrink(); window.relayoutWord && window.relayoutWord();
  requestAnimationFrame(() => { setY(listScroll); markDial(); });
}
function closeDetail(){ if (nav.show) history.back(); else hideDetail(); }
function openSheet(){
  if (!state.queue) return;
  $('#sheet').hidden = false; document.body.classList.add('sheet-open');
  history.pushState({ tr: 'sheet' }, ''); nav.sheet = true;
}
function hideSheet(){
  const sh = $('#sheet'); sh.hidden = true; sh.style.transform = '';
  document.body.classList.remove('sheet-open'); nav.sheet = false;
  if (nav.thenShow){ nav.thenShow = false; goToPlayingShow(); }
}
function closeSheet(){ if (nav.sheet) history.back(); else hideSheet(); }
window.addEventListener('popstate', () => {
  if (nav.skipPop){ nav.skipPop = false; return; }
  if (nav.eq){ nav.eq = false; hideEqFull(); return; }
  if (nav.settings){ nav.settings = false; hideSettings(); return; }
  if (nav.trip){ nav.trip = false; closeTrip(); return; }
  if (nav.sheet){ hideSheet(); return; }
  if (document.body.classList.contains('viewing')) hideDetail();
});
$('#sheetClose').onclick = closeSheet;
$('#shPlay').onclick = togglePlay;
$('#shNext').onclick = next;
$('#shPrev').onclick = prev;
$('#shShow').onclick = () => { nav.thenShow = true; closeSheet(); };
(() => { // swipe down to close the now-playing screen
  const sh = $('#sheet'); let y0 = null, dy = 0;
  sh.addEventListener('touchstart', e => { if (e.target.closest('input')) return; y0 = e.touches[0].clientY; dy = 0; sh.style.transition = 'none'; }, { passive: true });
  sh.addEventListener('touchmove', e => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); sh.style.transform = `translateY(${dy}px)`; }, { passive: true });
  sh.addEventListener('touchend', () => {
    if (y0 == null) return; y0 = null; sh.style.transition = 'transform .2s ease';
    if (dy > 110) closeSheet(); else sh.style.transform = '';
  });
})();


/* ---------- trip out: the Driftfield engine, driven by the music ---------- */
const trip = { open: false, raf: 0, last: 0, t: Math.random() * 100, wake: null, ok: false,
  L: { bass: 0, mid: 0, high: 0, beat: 0, avg: .2, lastBeat: -9 }, P: null, T: null, cur: {} };
const fbuf = new Uint8Array(1024), fprev = new Uint8Array(1024);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = a => a[Math.floor(Math.random() * a.length)];
const clamp01 = x => Math.min(1, Math.max(0, x));
function band(lo, hi){
  const hz = ctx.sampleRate / 2 / fbuf.length;
  const a = Math.max(1, Math.floor(lo / hz)), b = Math.min(fbuf.length - 1, Math.ceil(hi / hz));
  let sum = 0; for (let k = a; k <= b; k++) sum += fbuf[k];
  return sum / ((b - a + 1) * 255);
}
const hearing = () => !!getAn();
const canFollow = () => hearing() || aheadReady();
function readLevels(dt){
  const L = trip.L, t = performance.now() / 1000; let b, m, h;
  if (hearing()){
    getAn().getByteFrequencyData(fbuf);
    b = Math.min(1, band(25, 160) * 1.5); m = Math.min(1, band(300, 2000) * 1.8); h = Math.min(1, band(4000, 12000) * 2.6);
    // transients: how much the spectrum jumped since the last frame (snare hits, picked notes, cymbals)
    let fl = 0; const top = Math.floor(9000 / (ctx.sampleRate / 2 / fbuf.length));
    for (let k = 2; k < top; k++){ const d = fbuf[k] - fprev[k]; if (d > 0) fl += d; }
    fprev.set(fbuf); fl = fl / (top * 255) * 12;
    L.flux = L.flux * .5 + fl * .5;
    L.favg = (L.favg || .05) * .97 + fl * .03;
    if (fl > L.favg * 1.55 + .012 && t - (L.lastHit || 0) > .09){
      L.hit = 1; L.lastHit = t;
      if (Math.random() < .55) spawnShape();
      L.hx = rand(-.55, .55); L.hy = rand(-.38, .38); L.hh = Math.random();
    }
  } else if (aheadReady() && remotePlaying()){
    const pt = playTime(), v = aheadLevels(pt);
    b = v.bass * .95; m = v.mid * .9; h = v.high * .9;
    const nb = ahead.beats.find(x => x > ahead.lastBeatSent && x <= pt + .02 && x > pt - .12);
    if (nb !== undefined){ ahead.lastBeatSent = nb; L.beat = 1; L.lastBeat = t; trip.beatClock = performance.now() / 1000; }
    const nh = ahead.hits.find(x => x > ahead.lastHitSent && x <= pt + .02 && x > pt - .1);
    if (nh !== undefined){ ahead.lastHitSent = nh; L.hit = 1; L.lastHit = t; if (Math.random() < .55) spawnShape(); L.hx = rand(-.55, .55); L.hy = rand(-.38, .38); L.hh = Math.random(); }
  } else { b = .04; m = .04; h = .03; }
  L.bass += (b - L.bass) * .35; L.mid += (m - L.mid) * .22; L.high += (h - L.high) * .35;
  L.avg = L.avg * .96 + b * .04;
  if (!aheadReady() && b > L.avg * 1.22 + .03 && t - L.lastBeat > .25){ L.beat = 1; L.lastBeat = t; trip.beatClock = performance.now() / 1000; }
  L.beat *= Math.pow(.015, dt);
  L.hit = (L.hit || 0) * Math.pow(.004, dt);
  trip.hue = (trip.hue || 0) + L.beat * dt * 60 * (trip.T ? trip.T.hueJump : 0);
}

const spawnU = new Float32Array(16), spawnCol = new Float32Array(12); let spawnI = 0;
for (let i = 0; i < 4; i++) spawnU[i * 4 + 2] = 99;
function spawnShape(){
  if (!trip.T) return;
  const j = spawnI; spawnI = (spawnI + 1) % 4;
  spawnU.set([rand(-.6, .6), rand(-.4, .4), 0, Math.floor(Math.random() * 4)], j * 4);
  spawnCol.set(paletteAt((trip.P.palette + .2 + Math.random() * .6) % 1)[Math.floor(Math.random() * 4)], j * 3);
}
const DF_PALETTES = [
  ['#ff4fd8', '#8a5cff', '#3b6bff', '#ffa3e8'], ['#00e5ff', '#1a6bff', '#0fd1a0', '#8cf6ff'], ['#39ff9c', '#00c2ff', '#b066ff', '#d8ff6b'],
  ['#ffc857', '#ff7a59', '#e8506e', '#ffe3a3'], ['#ff3b30', '#ff9500', '#ffd60a', '#b0306a'], ['#ff5c9a', '#ffa54f', '#5cf2a0', '#8d7bff'],
  ['#3fae6a', '#a6d93b', '#e3c26a', '#5f9c8c'], ['#9ccfff', '#7fb6ff', '#5a8dff', '#a993ff'], ['#e07a2e', '#22b8ad', '#f4b06a', '#3f8fa0'],
  ['#c6ff00', '#00ff95', '#ff00c8', '#00b3ff'], ['#ffc65c', '#e0a83c', '#b0762c', '#ff9f4a'], ['#ff6b6b', '#feca57', '#7a4cff', '#ff9ff3'],
  ['#d9203a', '#ff6a3d', '#7a2a9c', '#ff9a6b'],
].map(p => p.map(h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255)));
const smooth3 = x => x * x * (3 - 2 * x);
function paletteAt(s){
  const n = DF_PALETTES.length - 1, x = clamp01(s) * n, i = Math.min(n - 1, Math.floor(x)), f = smooth3(x - i);
  return [0, 1, 2, 3].map(j => DF_PALETTES[i][j].map((v, k) => v + (DF_PALETTES[i + 1][j][k] - v) * f));
}
const KEYS = ['palette', 'terrain', 'backdrop', 'glow', 'gravity', 'dream', 'flow', 'turb', 'trails', 'ripples'];
// Each roll picks a character, like Driftfield's presets, then varies it, so rolls feel truly different
const TRIP_CHARACTERS = [
  { name: 'Nebula',   terrain: [.03, .22], dream: [.55, .9],  gravity: [.1, .35], trails: [.75, .97], ripples: [.4, .9],  glow: [.5, .9],  flow: [.25, .5], turb: [.2, .5] },
  { name: 'Marble',   terrain: [.42, .6],  dream: [.05, .35], gravity: [.15, .5], trails: [.5, .8],   ripples: [.1, .4],  glow: [.4, .7],  flow: [.3, .6], turb: [.3, .7] },
  { name: 'Coral',    terrain: [.82, .97], dream: [0, .25],   gravity: [0, .3],   trails: [.35, .65], ripples: [.05, .3], glow: [.35, .65], flow: [.35, .7], turb: [.5, 1] },
  { name: 'Vortex',   terrain: [.2, .7],   dream: [.2, .5],   gravity: [.72, .95], trails: [.82, .97], ripples: [.1, .4], glow: [.5, .85], flow: [.4, .7], turb: [.3, .6] },
  { name: 'Mist',     terrain: [.08, .4],  dream: [.6, .9],   gravity: [.05, .3], trails: [.85, .97], ripples: [.5, .95], glow: [.25, .45], flow: [.2, .4], turb: [.15, .4] },
  { name: 'Storm',    terrain: [.3, .85],  dream: [0, .3],    gravity: [.3, .6],  trails: [.25, .55], ripples: [.05, .25], glow: [.55, .95], flow: [.55, .85], turb: [.8, 1] },
  { name: 'Drift',    terrain: [.1, .9],   dream: [0, .9],    gravity: [0, .9],   trails: [.2, .97],  ripples: [.05, .95], glow: [.3, .95], flow: [.25, .9], turb: [.15, 1] }
];
function randomTrip(){
  const ch = pick(TRIP_CHARACTERS), r = k => rand(ch[k][0], ch[k][1]);
  return { character: ch.name, palette: Math.random(), terrain: r('terrain'), backdrop: rand(.2, 1), glow: r('glow'), gravity: r('gravity'),
    dream: r('dream'), flow: r('flow'), turb: r('turb'), trails: r('trails'), ripples: r('ripples'),
    // how each roll answers the music
    sym: Math.random() < .1 ? pick([3, 4, 5, 6, 8]) : 0, mirror: Math.random() < .05 ? 1 : 0,
    punch: rand(.035, .13), flash: rand(.18, .65), twist: rand(0, 1.5) * (Math.random() < .5 ? -1 : 1),
    shock: rand(0, .5), hueJump: pick([0, 0, 0, .0015, .003]), splash: rand(.4, 1.4), splashSize: rand(25, 140), ring: rand(0, .6),
    // what your finger or mouse does, as in Driftfield: stir most often, the swirl only now and then
    touchMode: (r => r < .4 ? 0 : r < .62 ? 2 : r < .8 ? 3 : r < .94 ? 4 : 1)(Math.random()), brush: rand(.15, .6) };
}
function derive(){
  const P = trip.P, c = trip.cur, t = P.terrain, gv = P.gravity, dd = P.dream, m = x => .4 + 1.2 * x;
  c.pal = paletteAt(P.palette);
  let d = c.pal[0], dl = 9;
  c.pal.forEach(cc => { const l = cc[0] * .3 + cc[1] * .59 + cc[2] * .11; if (l < dl){ dl = l; d = cc; } });
  c.back = d.map(v => Math.min(.22, v * (.022 + .09 * P.backdrop) / Math.max(.05, dl)));
  c.morph = t * .95; c.density = .2 + .65 * t; c.chaos = (.12 + .6 * t) * m(P.turb);
  c.trail = clamp01(.92 - .28 * t + gv * .1 + dd * .04 + (P.trails - .5) * .3);
  c.pull = gv * 1.25 - .3; c.spin = (gv - .3) * .8;
  c.glow = (.6 + .28 * dd) * (1 - .25 * t) * m(P.glow);
  c.ink = (.95 - .2 * Math.max(0, gv - .6)) * (.7 + .6 * P.glow);
  c.sat = 1.32 - .18 * dd;
  c.speed = (.85 + .25 * t) * (1 - .35 * dd) * m(P.flow);
  c.ripple = Math.min(1.6, Math.max(0, Math.max(0, (dd - .12) / .88) * m(P.ripples) + (P.ripples - .5) * .5));
}
// As in Driftfield: render a tiny copy of the picture, read the colors behind each button, and ease toward them
const TW = 32, TH = 18, tinyBuf = new Uint8Array(TW * TH * 4);
let tiny = null, sampT = 0;
const tintC = { x: null, d: null };
function vivid(c, fb){
  const mx = Math.max(c[0], c[1], c[2]), w = clamp01(mx * 5);
  const nrm = mx > .004 ? c.map(v => v / mx) : [1, 1, 1];
  const l = nrm[0] * .3 + nrm[1] * .59 + nrm[2] * .11;
  const sat = nrm.map(v => clamp01(l + (v - l) * 1.7));
  const mixd = sat.map((v, i) => w * v + (1 - w) * fb[i]);
  const top = Math.max(...mixd) || 1;
  return mixd.map(v => clamp01(v / top * .95));
}
const lighten = c => c.map(v => v + (1 - v) * .42);
const rgbStr = c => c.map(v => Math.round(v * 255)).join(',');
function paletteBright(){
  const pal = trip.cur.pal, top = pal.reduce((a, c) => (c[0] + c[1] + c[2] > a[0] + a[1] + a[2] ? c : a));
  const mx = Math.max(...top) || 1; return top.map(v => v / mx * .95);
}
function sampleBehind(now){
  if (now - sampT < 220) return;
  sampT = now;
  if (!tiny){
    const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]].forEach(([k, v]) => gl.texParameteri(gl.TEXTURE_2D, k, v));
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TW, TH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    tiny = { fb };
  }
  // the display program and its settings are still active from this frame, so draw it again, small
  gl.bindFramebuffer(gl.FRAMEBUFFER, tiny.fb); gl.viewport(0, 0, TW, TH);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.readPixels(0, 0, TW, TH, gl.RGBA, gl.UNSIGNED_BYTE, tinyBuf);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const box = $('#tripBox').getBoundingClientRect(), fb = paletteBright();
  const region = el => {
    const r = el.getBoundingClientRect();
    const x0 = Math.max(0, Math.floor((r.left - box.left) / box.width * TW)), x1 = Math.min(TW, Math.max(x0 + 1, Math.ceil((r.right - box.left) / box.width * TW)));
    const y0 = Math.max(0, Math.floor((r.top - box.top) / box.height * TH)), y1 = Math.min(TH, Math.max(y0 + 1, Math.ceil((r.bottom - box.top) / box.height * TH)));
    let cr = 0, cg = 0, cb = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++){
      const o = ((TH - 1 - y) * TW + x) * 4;   // the pixels come back bottom row first
      cr += tinyBuf[o]; cg += tinyBuf[o + 1]; cb += tinyBuf[o + 2]; n++;
    }
    return n ? [cr / n / 255, cg / n / 255, cb / n / 255] : null;
  };
  [['x', $('#tripX')], ['d', $('#bDice')]].forEach(([k, el]) => {
    const raw = region(el), target = raw ? vivid(raw, fb) : fb;
    tintC[k] = tintC[k] ? tintC[k].map((v, i) => v + (target[i] - v) * .14) : target;
    const pre = k === 'x' ? '--cx' : '--cd';
    el.style.setProperty(pre, rgbStr(tintC[k])); el.style.setProperty(pre + 'l', rgbStr(lighten(tintC[k])));
  });
}
function tintFromPalette(){
  const pal = trip.cur.pal, top = pal.reduce((a, c) => (c[0] + c[1] + c[2] > a[0] + a[1] + a[2] ? c : a));
  const mx = Math.max(...top) || 1, base = top.map(v => v / mx * .95), light = base.map(v => v + (1 - v) * .42);
  const tr = c => c.map(v => Math.round(v * 255)).join(',');
  $('#trip').style.setProperty('--cd', tr(base)); $('#trip').style.setProperty('--cdl', tr(light));
}

let gl = null, simP, dispP, copyP, simA, simB, texType, floorAmt;
const VS = `attribute vec2 p;varying vec2 v;void main(){v=p*.5+.5;gl_Position=vec4(p,0.,1.);}`;
const COMMON = `precision highp float;varying vec2 v;uniform float uAspect,uTime;uniform vec3 uP0,uP1,uP2,uP3;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1.,0.)),u.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),u.x),u.y);}
float fbm(vec2 p){float s=0.,a=.5;mat2 r=mat2(.8,.6,-.6,.8);for(int i=0;i<4;i++){s+=a*noise(p);p=r*p*2.03+3.1;a*=.5;}return s;}
uniform float uHue;
vec3 pal(float x){x=fract(x+uHue)*4.;float i=floor(x),f=smoothstep(0.,1.,fract(x));
  vec3 a=i<1.?uP0:i<2.?uP1:i<3.?uP2:uP3;vec3 c=i<1.?uP1:i<2.?uP2:i<3.?uP3:uP0;return mix(a,c,f);}
float luma(vec3 c){return dot(c,vec3(.299,.587,.114));}`;
const SIM_FS = `uniform sampler2D uPrev;uniform vec2 uTexel;
uniform vec4 uSpawn[4];uniform vec3 uSpawnCol[4];uniform vec4 uPtr[8];uniform float uBrush,uTM,uTouchK;
uniform float uMorph,uGlow,uDensity,uChaos,uDecay,uFloor,uStep,uInk,uPull,uSpin,uStars,uBeat,uBeatR,uRing,uHit,uSplash,uSplashSize,uHitHue;uniform vec2 uHitPos;
void main(){
  vec2 uv=v;vec2 as=vec2(uAspect,1.);vec2 p=(uv-.5)*as;float t=uTime;
  float fr=mix(1.,3.5,uDensity);
  vec2 q=vec2(fbm(p*1.3+vec2(0.,t*.04)),fbm(p*1.3+vec2(5.2,1.3)-t*.035));
  vec2 pp=p*fr+q*(1.+uChaos*3.)+t*.03;float e=.02;
  float n0=fbm(pp),nx=fbm(pp+vec2(e,0.)),ny=fbm(pp+vec2(0.,e));
  vec2 flow=vec2(ny-n0,n0-nx)/e*(.0005+uChaos*.0026);
  float bs=sqrt(28./uBrush);float paint=0.;
  for(int i=0;i<8;i++){vec4 pt=uPtr[i];vec2 d=p-pt.xy;float f=exp(-dot(d,d)*uBrush);float sp=length(pt.zw);float on=min(1.,sp*60.);
    if(uTM<.5) flow+=pt.zw*f*.5+vec2(-d.y,d.x)*f*sp*1.5/bs;
    else if(uTM<1.5) flow+=vec2(-d.y,d.x)*f*on*(.25+sp*2.)*uTouchK/bs;
    else if(uTM<2.5) flow+=pt.zw*f*.2;
    else if(uTM<3.5) flow-=d*f*on*.22*uTouchK;
    else {flow+=pt.zw*f*.25;paint+=f*on;}
  }
  flow*=uStep;
  float ang=uSpin*.004*uStep;float z=1.+uPull*.004*uStep;float ca=cos(ang),sa=sin(ang);
  vec2 suv=(mat2(ca,-sa,sa,ca)*p*z-flow)/as+.5;
  vec3 prev=texture2D(uPrev,suv).rgb*.6+(texture2D(uPrev,suv+vec2(uTexel.x,0.)).rgb+texture2D(uPrev,suv-vec2(uTexel.x,0.)).rgb+
    texture2D(uPrev,suv+vec2(0.,uTexel.y)).rgb+texture2D(uPrev,suv-vec2(0.,uTexel.y)).rgb)*.1;
  prev=max(prev*uDecay-uFloor,0.);
  float w0=1.-smoothstep(0.,.5,uMorph),w2=smoothstep(.5,1.,uMorph),w1=1.-w0-w2;
  float a0=fbm(p*fr*1.4+q*2.+t*.05);float r=length(p);
  vec2 wq=p*fr*1.1+vec2(fbm(p*fr*.8+q*3.+t*.03),fbm(p*fr*.8-q*3.-t*.025))*2.4;
  float a1=pow(1.-abs(sin(fbm(wq)*9.+t*.2)),3.);
  float rd=0.,amp=.55;vec2 rp=p*fr*1.6+q*1.5*(1.+uChaos)+t*.02;
  for(int i=0;i<4;i++){float n=1.-abs(noise(rp)*2.-1.);rd+=n*n*amp;rp=mat2(.8,.6,-.6,.8)*rp*2.1+1.7;amp*=.5;}
  float a2=smoothstep(.22,.72,rd);
  float val=smoothstep(.3,.72,a0)*w0+a1*w1*.9+a2*w2;
  float ink=smoothstep(.6-.1*uDensity,.88,val)*(.028+.045*uGlow)*uStep*uInk;
  vec3 col=prev+pal(val*1.1+r*.35+q.y*.6+t*.01)*ink;
  col+=pal(t*.03+q.x*.8)*min(paint,1.)*.007*uStep*min(uTouchK,1.);
  // each beat sends a ring of light outward from the middle
  col+=pal(t*.05+r*.8)*exp(-pow((r-uBeatR)*16.,2.))*uBeat*.07*uRing;
  // every transient splashes fresh color somewhere new
  vec2 hd=p-uHitPos;col+=pal(uHitHue)*exp(-dot(hd,hd)*uSplashSize)*uHit*.06*uSplash;
  // Driftfield's shapes: a bloom, a widening ring, a turning triangle, or a scatter of dots
  for(int i=0;i<4;i++){vec4 sp=uSpawn[i];float age=sp.z;
    if(age<3.){vec2 d=p-sp.xy;float fade=smoothstep(0.,.25,age)*(1.-smoothstep(1.,3.,age));float sh=0.;
      if(sp.w<.5) sh=exp(-dot(d,d)*70.);
      else if(sp.w<1.5){float rr=.03+age*.06;sh=exp(-pow((length(d)-rr)*110.,2.));}
      else if(sp.w<2.5){float a=atan(d.y,d.x)+age*.8;float k=.5/cos(mod(a,2.0944)-1.0472);sh=exp(-pow((length(d)/(.06*k)-1.)*12.,2.))*exp(-dot(d,d)*22.);}
      else {vec2 gg=d*45.;vec2 fr2=fract(gg)-.5;sh=step(.82,hash(floor(gg)+sp.xy*13.))*exp(-dot(fr2,fr2)*28.)*exp(-dot(d,d)*40.);}
      col+=uSpawnCol[i]*sh*fade*.03*uStep;}}
  vec2 cell=floor(uv/uTexel*.5);float h=fract(sin(dot(cell*.0173+floor(t*2.)*.731,vec2(12.9898,78.233)))*43758.5453);
  col+=step(1.-.0012*(.3+uDensity),h)*(.05+.06*uGlow)*uStep*uStars*vec3(.9,.95,1.);
  gl_FragColor=vec4(min(col,vec3(4.)),1.);
}`;
const DISPLAY_FS = `uniform vec4 uTouch[6];uniform float uTouchAmp;
uniform sampler2D uImg;uniform float uImgAmt,uImgAsp;
vec2 cover(vec2 uv,float ia){float s=uAspect/ia;vec2 c=uv-.5;if(s>1.)c.y/=s;else c.x*=s;return c+.5;}
uniform sampler2D uSim;uniform vec2 uTexel;uniform float uGlow,uRipple,uSat,uExpo,uKick,uPunch,uFlash,uSym,uMirror,uShock,uHit,uHitR;uniform vec3 uBack;uniform vec2 uHitPos;
void main(){
  vec2 uv=(v-.5)*(1.-uKick*uPunch)+.5;
  vec2 kp=(uv-.5)*vec2(uAspect,1.);
  if(uMirror>.5) kp.x=abs(kp.x);
  if(uSym>1.5){float a=atan(kp.y,kp.x)+uTime*.015;float rr=length(kp);float seg=6.28318/uSym;a=mod(a,seg);a=abs(a-seg*.5);kp=vec2(cos(a),sin(a))*rr;}
  // a shockwave rolls out from each transient
  vec2 sd=kp-uHitPos;float sl=length(sd)+1e-3;
  kp+=sd/sl*sin((sl-uHitR)*55.)*exp(-abs(sl-uHitR)*9.)*uHit*uShock*.018;
  uv=kp/vec2(uAspect,1.)+.5;
  vec2 pr=(uv-.5)*vec2(uAspect,1.);
  vec2 tdir=vec2(0.);
  for(int i=0;i<6;i++){vec4 tc=uTouch[i];vec2 d=pr-tc.xy;float dl=length(d)+1e-3;float ring=tc.z*.5;
    tdir+=d/dl*sin((dl-ring)*75.)*exp(-abs(dl-ring)*12.)*exp(-tc.z*1.5)*tc.w;}
  uv+=tdir*.007*uTouchAmp/vec2(uAspect,1.);
  vec2 rw=vec2(fbm(pr*2.6+vec2(uTime*.12,0.)),fbm(pr*2.6+vec2(5.,-uTime*.1)));
  vec2 rdir=vec2(sin(rw.x*16.+uTime*1.2),cos(rw.y*16.-uTime))*.7;
  uv+=rdir*uRipple*.007/vec2(uAspect,1.);
  vec3 base=texture2D(uSim,uv).rgb;vec3 b=vec3(0.);float R=2.+uGlow*7.;
  for(int i=0;i<12;i++){float a=float(i)*.5236+.26;float k=i<6?1.:2.3;b+=texture2D(uSim,uv+vec2(cos(a),sin(a))*uTexel*R*k).rgb;}
  b/=12.;
  vec3 col=base+b*uGlow*(1.1+uKick*1.2);
  // tone map on the brightest channel, so bright areas stay colorful instead of washing out to white
  float mx=max(max(col.r,col.g),col.b)+1e-4;col*=(1.-exp(-mx*uExpo))/mx;
  col=max(mix(vec3(luma(col)),col,uSat),0.);
  col*=1.+(rdir.x+rdir.y)*uRipple*.05;
  vec2 p=(uv-.5)*vec2(uAspect,1.);
  if(uImgAmt>.002){
    vec2 iw=vec2(fbm(p*1.1+vec2(uTime*.02,0.)),fbm(p*1.1+vec2(4.,-uTime*.02)))-.5;
    vec3 im=texture2D(uImg,cover(uv+iw*.035,uImgAsp)).rgb;float li=luma(im);
    vec3 tint=mix(im,pal(li*1.2+uTime*.01)*(.2+1.1*li),.62);
    float mk=smoothstep(.36,.68,fbm(p*1.5+iw*1.5+vec2(-uTime*.013,uTime*.009)));
    float ia=clamp(mk*uImgAmt*(.4+.75*li)*(1.+.6*uKick),0.,.8);
    col=mix(col,1.-(1.-col)*(1.-tint),ia);
  }
  col+=uBack*(.7+.6*fbm(p*.9+vec2(uTime*.008,-uTime*.006)))*(1.-clamp(luma(col)*2.2,0.,1.));
  vec2 vu=uv-.5;col*=1.-dot(vu,vu);
  col*=1.+uKick*uFlash+uHit*uFlash*.4;
  col+=(hash(uv*vec2(1013.,997.)+fract(uTime*7.)*31.)-.5)*.022;
  gl_FragColor=vec4(max(col,0.),1.);
}`;
const COPY_FS = `uniform sampler2D uT;void main(){gl_FragColor=texture2D(uT,v);}`;
function glInit(){
  const cv = $('#tripCv');
  gl = cv.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
  if (!gl) return false;
  const sh = (type, src) => { const x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x)); return x; };
  const prog = fs => {
    const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, COMMON + fs));
    gl.bindAttribLocation(pr, 0, 'p'); gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    const c = {}, L = n => (n in c) ? c[n] : (c[n] = gl.getUniformLocation(pr, n));
    return { pr, v4a: (n, a) => gl.uniform4fv(L(n), a), v3a: (n, a) => gl.uniform3fv(L(n), a), f: (n, x) => gl.uniform1f(L(n), x), v2: (n, x, y) => gl.uniform2f(L(n), x, y), v3: (n, a) => gl.uniform3f(L(n), a[0], a[1], a[2]), i: (n, x) => gl.uniform1i(L(n), x) };
  };
  try { simP = prog(SIM_FS); dispP = prog(DISPLAY_FS); copyP = prog(COPY_FS); } catch (e) { console.error(e); return false; }
  const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  texType = gl.UNSIGNED_BYTE; floorAmt = 1.2 / 255;
  const hf = gl.getExtension('OES_texture_half_float'), lin = gl.getExtension('OES_texture_half_float_linear');
  gl.getExtension('EXT_color_buffer_half_float');
  if (hf && lin){
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, hf.HALF_FLOAT_OES, null);
    const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE){ texType = hf.HALF_FLOAT_OES; floorAmt = .0004; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.deleteFramebuffer(fb); gl.deleteTexture(t);
  }
  return true;
}
function makeTarget(w, h){
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]].forEach(([k, v]) => gl.texParameteri(gl.TEXTURE_2D, k, v));
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, texType, null);
  const fb = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fb, w, h };
}
// Public-domain band photo (Herb Greene, 1970) from Wikimedia Commons, loaded once for the visuals
// Photos come from Wikimedia Commons, kept to public domain and Creative Commons licenses that allow changes
// (no NonCommercial or NoDerivatives), with album covers, posters and logos left out. Ranked, top 20 kept.
const PHOTO_FALLBACK = [{ url: 'https://commons.wikimedia.org/wiki/Special:FilePath/Grateful_Dead_(1970).png?width=1280', title: 'The Grateful Dead, 1970',
  artist: 'Herb Greene', license: 'Public domain', page: 'https://commons.wikimedia.org/wiki/File:Grateful_Dead_(1970).png' }];
const stripTags = h => { const d = document.createElement('div'); d.innerHTML = String(h || ''); return (d.textContent || '').replace(/\s+/g, ' ').trim(); };
async function photoPool(){
  const saved = LS.get('photos3', 30 * 864e5); if (saved && saved.length) return saved;
  const queries = ['Grateful Dead', 'Grateful Dead concert', 'Jerry Garcia Grateful Dead', 'Grateful Dead 1970s', 'Grateful Dead live'];
  const found = new Map();
  for (const q of queries){
    const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=6&gsrlimit=50'
      + '&gsrsearch=' + encodeURIComponent(q + ' filetype:bitmap') + '&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1280';
    try {
      const d = await fetchJSON(u, 15000);
      for (const pg of Object.values(d.query?.pages || {})){
        const ii = pg.imageinfo && pg.imageinfo[0]; if (!ii || found.has(pg.title)) continue;
        const md = ii.extmetadata || {}, lic = (md.LicenseShortName?.value || '').trim();
        const text = `${pg.title} ${stripTags(md.ImageDescription?.value)} ${stripTags(md.ObjectName?.value)}`;
        if (!/^image\/(jpeg|png)$/.test(ii.mime)) continue;
        if (!/public domain|^pd|cc0|cc[ -]by/i.test(lic) || /nc|nd|fair/i.test(lic)) continue;
        if (!/grateful dead|garcia|weir|lesh|kreutzmann|mickey hart|pigpen|mckernan|mydland|godchaux|constanten|welnick/i.test(text)) continue;
        if (/cover|album|logo|poster|flyer|ticket|stamp|sticker|shirt|skull|bear|signature|autograph|grave|plaque|mural|graffiti|tattoo|map\b|book|magazine|vinyl|record|\blp\b|\bcd\b|dead ?(&|and) ?company|furthur|ratdog|the dead 20|tribute|bus\b|van\b|car\b|house|building|street|sign\b|trade ad/i.test(text)) continue;
        if ((ii.width || 0) < 700) continue;
        let score = 0;
        if (/concert|live|stage|perform|playing|on stage|show/i.test(text)) score += 3;
        if (/grateful dead/i.test(text)) score += 2;
        const yr = (String(md.DateTimeOriginal?.value || '') + ' ' + pg.title).match(/19([6-9]\d)/);
        if (yr && +yr[1] >= 65 && +yr[1] <= 95) score += 2;
        if ((ii.width || 0) >= 1400) score += 1;
        found.set(pg.title, { url: ii.thumburl || ii.url, title: pg.title.replace(/^File:/, '').replace(/\.[a-z]+$/i, ''),
          artist: stripTags(md.Artist?.value) || 'Unknown photographer', license: lic, page: ii.descriptionurl, score });
      }
    } catch {}
  }
  const list = [...found.values()].sort((a, b) => b.score - a.score).slice(0, 20);
  if (list.length) LS.set('photos3', list);
  return list;
}
let photoList = null, photoI = -1;
async function nextPhoto(){
  if (trip.imgLoading) return; trip.imgLoading = true;
  if (!photoList){
    // Herb Greene's 1970 photo always comes first, then the rest of the pool rotates in
    const def = { ...PHOTO_FALLBACK[0] };
    try {
      const d = await fetchJSON('https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&titles=' + encodeURIComponent('File:Grateful_Dead_(1970).png') + '&prop=imageinfo&iiprop=url&iiurlwidth=1280', 12000);
      const ii = Object.values(d.query?.pages || {})[0]?.imageinfo?.[0];
      if (ii) def.url = ii.thumburl || ii.url;   // direct image link, which loads reliably into the visuals
    } catch {}
    let pool = [];
    try { pool = await photoPool(); } catch {}
    photoList = [def, ...pool.filter(x => !/Grateful_Dead_\(1970\)/.test(x.page || '') && x.title !== 'Grateful Dead (1970)')];
    photoI = -1;
  }
  trip.photoCount = (trip.photoCount || 0) + 1;
  photoI = trip.photoCount % 2 === 1 ? 0 : 1 + ((photoI + 1) % Math.max(1, photoList.length - 1));   // the 1970 photo every other time
  if (photoI >= photoList.length) photoI = 0;
  const ph = photoList[photoI], im = new Image(); im.crossOrigin = 'anonymous';
  im.onload = () => {
    try {
      const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]].forEach(([k, v]) => gl.texParameteri(gl.TEXTURE_2D, k, v));
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      if (trip.img) gl.deleteTexture(trip.img.tex);
      trip.img = { tex, asp: im.naturalWidth / im.naturalHeight };
    } catch {}
    trip.imgLoading = false;
  };
  im.onerror = () => { trip.imgLoading = false; };
  im.src = ph.url;
}
function renderPhotoCredits(){
  const el = $('#photoCredits'); if (!el) return;
  const list = photoList || LS.get('photos3', 1e13) || PHOTO_FALLBACK;
  el.innerHTML = list.map(p => `<li><a class="link" href="${esc(p.page)}" target="_blank" rel="noopener">${esc(p.title)}</a> by ${esc(p.artist)}, ${esc(p.license)}</li>`).join('');
}
function tripResize(){
  const cv = $('#tripCv'), r = $('#tripBox').getBoundingClientRect();
  tripSize = { w: r.width, h: r.height };
  const dpr = Math.min(devicePixelRatio || 1, 2) * (mq.matches ? .8 : 1);
  cv.width = Math.max(2, Math.round(r.width * dpr)); cv.height = Math.max(2, Math.round(r.height * dpr));
  const sw = Math.max(2, Math.min(1000, Math.floor(cv.width * .55))), sh = Math.max(2, Math.round(sw * cv.height / cv.width));
  if (simA && simA.w === sw && simA.h === sh) return;
  const a = makeTarget(sw, sh), b = makeTarget(sw, sh);
  if (simA){
    gl.bindFramebuffer(gl.FRAMEBUFFER, a.fb); gl.viewport(0, 0, sw, sh); gl.useProgram(copyP.pr);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, simA.tex); copyP.i('uT', 0); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    [simA, simB].forEach(t => { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); });
  }
  simA = a; simB = b;
}
function setPal(P){ P.v3('uP0', trip.cur.pal[0]); P.v3('uP1', trip.cur.pal[1]); P.v3('uP2', trip.cur.pal[2]); P.v3('uP3', trip.cur.pal[3]); }
function tripLoop(now){
  if (!trip.open && !$('#trip').classList.contains('closing')) return;
  trip.raf = requestAnimationFrame(tripLoop);
  const dt = Math.min(.05, trip.last ? (now - trip.last) / 1000 : .016); trip.last = now;
  // a new roll eases in over a couple of seconds
  const k = 1 - Math.exp(-dt * 1.6);
  KEYS.forEach(key => { trip.P[key] += (trip.T[key] - trip.P[key]) * k; });
  ['punch', 'flash', 'twist', 'shock', 'splash', 'splashSize', 'ring', 'hueJump', 'brush'].forEach(key => { trip.P[key] = (trip.P[key] ?? trip.T[key] ?? 0) + ((trip.T[key] ?? 0) - (trip.P[key] ?? 0)) * k; });
  derive();
  readLevels(dt);
  const L = trip.L, c = trip.cur, cv = $('#tripCv');
  const T = trip.P;
  const drive = (.1 + L.bass * 5 + L.beat * 4.5 + L.hit * 2.4) * .25;   // slow and spacious; the music still sets the pace
  trip.t += dt * c.speed * (.1 + L.bass * 3 + L.beat * 2.2) * .25;
  const step = Math.min(2.5, Math.max(.25, dt * 60)) * c.speed * drive;
  // simulate
  gl.bindFramebuffer(gl.FRAMEBUFFER, simB.fb); gl.viewport(0, 0, simB.w, simB.h);
  let P = simP; gl.useProgram(P.pr);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, simA.tex); P.i('uPrev', 0);
  P.f('uAspect', cv.width / cv.height); P.f('uTime', trip.t); setPal(P);
  P.v2('uTexel', 1 / simB.w, 1 / simB.h);
  P.f('uMorph', c.morph); P.f('uDensity', c.density); P.f('uChaos', c.chaos * (1 + L.mid * 1.4));
  P.f('uGlow', c.glow); P.f('uDecay', Math.pow(.86 + (.993 - .86) * c.trail, step)); P.f('uFloor', floorAmt * step);
  P.f('uStep', step); P.f('uInk', c.ink * (.8 + L.bass * 4.2 + L.beat * 3.6));
  P.f('uPull', c.pull * .6 + L.beat * 6.5 + L.bass * 1.8); P.f('uSpin', c.spin * (1 + L.mid * 2) + L.mid * .4 + L.beat * T.twist);
  const calmSim = store.get('calm', false);
  P.f('uHue', trip.hue || 0); P.f('uRing', T.ring * (calmSim ? .3 : 1)); P.f('uHit', L.hit || 0); P.f('uSplash', T.splash); P.f('uSplashSize', T.splashSize);
  P.f('uHitHue', L.hh || 0); P.v2('uHitPos', L.hx || 0, L.hy || 0);
  for (let i = 0; i < 4; i++) spawnU[i * 4 + 2] += dt * (.7 + L.bass * 1.2);
  P.v4a('uSpawn[0]', spawnU); P.v3a('uSpawnCol[0]', spawnCol);
  updatePointer(dt);
  const tm = trip.T.touchMode || 0, gv = trip.P.gravity, dd = trip.P.dream;
  const tk = [1, .6 + gv, .5 + dd, .5 + gv, .4 + .3 * trip.P.glow][tm] * 1.05;   // about Driftfield's strength
  trip.touchK = tk;
  P.v4a('uPtr[0]', ptrU); P.f('uBrush', Math.max(18, 230 - 200 * (trip.P.brush || .3))); P.f('uTM', tm); P.f('uTouchK', tk);
  P.f('uStars', Math.min(1.5, L.high * 2)); P.f('uBeat', L.beat); P.f('uBeatR', Math.min(1.2, (now / 1000 - trip.beatClock) * .9));
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  const t2 = simA; simA = simB; simB = t2;
  // show
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, cv.width, cv.height);
  P = dispP; gl.useProgram(P.pr);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, simA.tex); P.i('uSim', 0);
  P.f('uAspect', cv.width / cv.height); P.f('uTime', trip.t); setPal(P);
  P.v2('uTexel', 1 / simA.w, 1 / simA.h);
  P.f('uGlow', c.glow * .8 * (1 + L.high * .9)); P.f('uRipple', c.ripple * .6 + L.mid * 1.5); P.f('uSat', c.sat); P.f('uExpo', .85 + L.bass * .4);
  P.f('uKick', L.beat); P.v3('uBack', c.back); P.f('uHue', trip.hue || 0);
  P.v4a('uTouch[0]', touchU); P.f('uTouchAmp', (trip.T.touchMode === 2 ? 1.6 * (trip.touchK || 1) : .5) * .7);
  // photo envelope: every 40 to 80 seconds, fades in over 4s, lingers 8s, fades out over 4s
  let imgAmt = 0;
  if (trip.img && store.get('photos', true)){
    if (!trip.imgNext) trip.imgNext = now / 1000 + rand(5, 10);
    const e = now / 1000 - trip.imgNext;
    if (e > 9){ trip.imgNext = now / 1000 + rand(14, 26); nextPhoto(); }   // a different photo next time
    else if (e > 0) imgAmt = Math.min(1, e / 1.4, (9 - e) / 1.4) * .9;   // quick morph in and out
  }
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, trip.img ? trip.img.tex : simB.tex);
  P.i('uImg', 1); P.f('uImgAmt', imgAmt); P.f('uImgAsp', trip.img ? trip.img.asp : 1);
  gl.activeTexture(gl.TEXTURE0);
  const calm = store.get('calm', false) ? 1 : 0;   // calmer visuals: far gentler flashes, punches, rings, and shockwaves
  P.f('uPunch', T.punch * (calm ? .3 : 1)); P.f('uFlash', T.flash * (calm ? .18 : 1)); P.f('uSym', trip.T.sym); P.f('uMirror', trip.T.mirror); P.f('uShock', T.shock * (calm ? .2 : 1));
  P.f('uHit', L.hit || 0); P.f('uHitR', Math.min(1.5, (now / 1000 - (L.lastHit || 0)) * 1.1)); P.v2('uHitPos', L.hx || 0, L.hy || 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  captureGif(now);
  sampleBehind(now);
  if (Math.floor(now / 500) !== trip.needTick){ trip.needTick = Math.floor(now / 500); syncTrip(); }
}
function syncTrip(){
  const el = $('#tripNeed'); if (!el) return;
  let msg = '';
  if (!state.queue || !remotePlaying()) msg = 'Play some music and the visuals will move with it';
  else if (!canFollow() && !(IOS && trip.open && state.queue)) msg = state.car ? 'Visuals can’t hear the music in car mode' : (state.remote && IOS) ? 'Visuals can’t hear AirPlay music on iPhone' : 'This browser won’t let the visuals hear the music';
  el.textContent = msg; el.hidden = !msg;
}
function applyTrip(target){
  trip.T = target; if (!trip.P || !('punch' in trip.P)) trip.P = { ...target };
  derive(); tintFromPalette();
  store.set('trip2', target);
}
async function openTrip(){
  if (trip.open) return;
  if (!gl && !glInit()){ toast('Trip out needs WebGL. Turn on hardware acceleration in your browser settings.'); return; }
  const el = $('#trip'); el.classList.remove('closing'); el.hidden = false; trip.open = true;   // open first, so the music gets routed to the visuals
  if (audio.webkitCurrentPlaybackTargetIsWireless) state.remote = true;   // AirPlay picked in Control Center
  if (state.queue){
    ensureGraph(); syncTwin();
    // iPhone (and Home Screen apps): start a fresh player wired to the visuals, picking up where the song is
    if (ctx) ctx.resume();
  }
  document.body.classList.add('trip-open');
  history.pushState({ tr: 'trip' }, ''); nav.trip = true;
  tripResize();
  if (store.get('photos', true) && !trip.img) nextPhoto();
  if (!store.get('tripWarned', false)){ store.set('tripWarned', true); setTimeout(() => toast('Trip out has pulsing light. For softer visuals, turn on Calmer visuals in Settings.'), 600); }
  const saved = store.get('trip2', null);
  applyTrip(saved && 'touchMode' in saved ? saved : randomTrip());
  trip.beatClock = performance.now() / 1000;
  syncTrip();
  trip.last = 0; trip.raf = requestAnimationFrame(tripLoop);
  try { trip.wake = await navigator.wakeLock?.request('screen'); } catch {}
}
function closeTrip(){
  if (!trip.open) return;
  if (IOS && graph && audio.routed){ try { const g = graph.pre.gain; g.cancelScheduledValues(ctx.currentTime); g.setTargetAtTime(0, ctx.currentTime, .025); } catch {} }
  trip.open = false;
  setTimeout(() => { if (!trip.open) cancelAnimationFrame(trip.raf); }, 320);   // keep drawing while it fades
  if (state.queue){ if (IOS && audio.routed) setTimeout(() => { if (!trip.open) ensureGraph(); }, 90); else ensureGraph(); }
  const el = $('#trip'); el.classList.add('closing');
  setTimeout(() => { if (!trip.open){ el.hidden = true; el.classList.remove('closing'); } }, 320);
  document.body.classList.remove('trip-open');
  trip.wake?.release?.(); trip.wake = null;
}
function requestCloseTrip(){ closeTrip(); if (nav.trip){ nav.trip = false; nav.skipPop = true; history.back(); } }
let diceX = 0, diceY = 0;
function segueShift(){
  if (!trip.T) return;
  const r = randomTrip();
  trip.T = { ...trip.T, palette: r.palette, sym: r.sym, mirror: r.mirror, hueJump: r.hueJump, twist: r.twist };
  derive(); spawnShape(); spawnShape(); store.set('trip2', trip.T);
}
// Screensaver: open Trip out after 3 quiet minutes of music
let lastInput = Date.now();
['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach(ev => addEventListener(ev, () => {
  lastInput = Date.now();
  if (trip.auto && trip.open){ trip.auto = false; requestCloseTrip(); }
}, { passive: true, capture: true }));
setInterval(() => {
  if (!store.get('saver', false) || trip.open || audio.paused || document.hidden || !state.queue) return;
  if (!$('#settings').hidden) return;
  if (Date.now() - lastInput > 180000){ openTrip().then(() => { trip.auto = true; }); }
}, 10000);
// Hold the dice to record a looping GIF (Driftfield's boomerang encoder)
class ByteW {
  constructor(n = 4096){ this.a = new Uint8Array(n); this.n = 0; }
  u8(v){ if (this.n >= this.a.length){ const b = new Uint8Array(this.a.length * 2); b.set(this.a); this.a = b; } this.a[this.n++] = v & 255; }
  u16(v){ this.u8(v); this.u8(v >> 8); }
  str(s){ for (const ch of s) this.u8(ch.charCodeAt(0)); }
  bytes(){ return this.a.subarray(0, this.n); }
}
function buildPalette(frames){
  const per = frames[0].length / 4, stride = Math.max(1, Math.floor(per * frames.length / 24000));
  const px = []; let k = 0;
  for (const f of frames) for (let i = (k++ % stride); i < per; i += stride) px.push(f[i * 4], f[i * 4 + 1], f[i * 4 + 2]);
  const n = px.length / 3, idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const info = b => {
    const mn = [255, 255, 255], mx = [0, 0, 0];
    for (let i = b.s; i < b.e; i++){ const o = idx[i] * 3; for (let c = 0; c < 3; c++){ const v = px[o + c]; if (v < mn[c]) mn[c] = v; if (v > mx[c]) mx[c] = v; } }
    const r = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    b.ch = r[0] >= r[1] && r[0] >= r[2] ? 0 : r[1] >= r[2] ? 1 : 2;
    b.score = r[b.ch] * Math.sqrt(b.e - b.s);
    return b;
  };
  const boxes = [info({ s: 0, e: n })];
  while (boxes.length < 256){
    let bi = -1, best = 0;
    boxes.forEach((b, i) => { if (b.e - b.s > 1 && b.score > best){ best = b.score; bi = i; } });
    if (bi < 0) break;
    const b = boxes[bi];
    const sub = Array.from(idx.subarray(b.s, b.e)).sort((x, y) => px[x * 3 + b.ch] - px[y * 3 + b.ch]);
    idx.set(sub, b.s);
    const mid = b.s + ((b.e - b.s) >> 1);
    boxes.splice(bi, 1, info({ s: b.s, e: mid }), info({ s: mid, e: b.e }));
  }
  return boxes.map(b => {
    let r = 0, g = 0, bl = 0;
    for (let i = b.s; i < b.e; i++){ const o = idx[i] * 3; r += px[o]; g += px[o + 1]; bl += px[o + 2]; }
    const c = b.e - b.s; return [Math.round(r / c), Math.round(g / c), Math.round(bl / c)];
  });
}
function makeMapper(pal){
  const cache = new Int16Array(32768).fill(-1);
  return (r, g, b) => {
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let v = cache[key]; if (v >= 0) return v;
    let best = 1e9;
    for (let i = 0; i < pal.length; i++){ const p = pal[i], dr = p[0] - r, dg = p[1] - g, db = p[2] - b; const d = dr * dr * 2 + dg * dg * 4 + db * db * 3; if (d < best){ best = d; v = i; } }
    cache[key] = v; return v;
  };
}
function lzw(ind, minCode){
  const out = new ByteW(ind.length >> 1); out.u8(minCode);
  const clearCode = 1 << minCode, eoi = clearCode + 1;
  let nBits = minCode + 1, maxCode = (1 << nBits) - 1, free = clearCode + 2, clearFlag = false;
  const dict = new Map(); const block = new Uint8Array(255); let bl = 0, acc = 0, accBits = 0;
  const byte = b => { block[bl++] = b; if (bl === 255){ out.u8(255); for (let i = 0; i < 255; i++) out.u8(block[i]); bl = 0; } };
  const emit = code => {
    acc |= code << accBits; accBits += nBits;
    while (accBits >= 8){ byte(acc & 255); acc >>>= 8; accBits -= 8; }
    if (free > maxCode || clearFlag){
      if (clearFlag){ nBits = minCode + 1; maxCode = (1 << nBits) - 1; clearFlag = false; }
      else { nBits++; maxCode = nBits === 12 ? 4096 : (1 << nBits) - 1; }
    }
  };
  emit(clearCode);
  let ent = ind[0];
  for (let i = 1; i < ind.length; i++){
    const c = ind[i], key = (c << 12) | ent, hit = dict.get(key);
    if (hit !== undefined){ ent = hit; continue; }
    emit(ent); ent = c;
    if (free < 4096) dict.set(key, free++);
    else { dict.clear(); free = clearCode + 2; clearFlag = true; emit(clearCode); }
  }
  emit(ent); emit(eoi);
  if (accBits > 0) byte(acc & 255);
  if (bl > 0){ out.u8(bl); for (let i = 0; i < bl; i++) out.u8(block[i]); }
  out.u8(0); return out.bytes();
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const c8 = v => v < 0 ? 0 : v > 255 ? 255 : v | 0;
function encodeFrame(data, w, h, map){
  const ind = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++){
    const i = y * w + x, o = i * 4, d = (BAYER[(y & 3) * 4 + (x & 3)] - 7.5) * 1.6;
    ind[i] = map(c8(data[o] + d), c8(data[o + 1] + d), c8(data[o + 2] + d));
  }
  return lzw(ind, 8);
}
async function encodeBoomerang(frames, w, h, delayCs){
  const pal = buildPalette(frames), map = makeMapper(pal), enc = [];
  for (const f of frames){ enc.push(encodeFrame(f, w, h, map)); await new Promise(r => setTimeout(r, 0)); }
  const order = [...frames.keys()]; for (let i = frames.length - 2; i > 0; i--) order.push(i);
  const head = new ByteW();
  head.str('GIF89a'); head.u16(w); head.u16(h); head.u8(0xF7); head.u8(0); head.u8(0);
  for (let i = 0; i < 256; i++){ const c = pal[i] || [0, 0, 0]; head.u8(c[0]); head.u8(c[1]); head.u8(c[2]); }
  head.u8(0x21); head.u8(0xFF); head.u8(11); head.str('NETSCAPE2.0'); head.u8(3); head.u8(1); head.u16(0); head.u8(0);
  const parts = [head.bytes()];
  for (const i of order){
    const fh = new ByteW(32);
    fh.u8(0x21); fh.u8(0xF9); fh.u8(4); fh.u8(0); fh.u16(delayCs); fh.u8(0); fh.u8(0);
    fh.u8(0x2C); fh.u16(0); fh.u16(0); fh.u16(w); fh.u16(h); fh.u8(0);
    parts.push(fh.bytes(), enc[i]);
  }
  parts.push(new Uint8Array([0x3B]));
  return new Blob(parts, { type: 'image/gif' });
}
const GIF = { cap: null, busy: false };
function startGif(){
  if (GIF.cap || GIF.busy) return;
  const cv = $('#tripCv'), w = Math.min(mq.matches ? 360 : 440, cv.width), h = Math.max(2, Math.round(w * cv.height / cv.width));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  GIF.cap = { cx: c.getContext('2d', { willReadFrequently: true }), w, h, frames: [], need: 22, last: 0 };
  toast('Recording a loop…'); haptic();
}
function captureGif(now){
  const g = GIF.cap; if (!g || now - g.last < 85) return;
  g.last = now;
  g.cx.drawImage($('#tripCv'), 0, 0, g.w, g.h);
  g.frames.push(g.cx.getImageData(0, 0, g.w, g.h).data);
  if (g.frames.length < g.need) return;
  GIF.cap = null; GIF.busy = true; toast('Making your GIF…');
  encodeBoomerang(g.frames, g.w, g.h, 8).then(blob => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `deadjams-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.gif`;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('GIF saved');
  }).catch(() => toast('The GIF couldn’t be made. Try again.')).finally(() => { GIF.busy = false; });
}
let holdT = 0, held = false;
$('#bDice').addEventListener('pointerdown', () => { held = false; clearTimeout(holdT); holdT = setTimeout(() => { held = true; startGif(); }, 550); });
['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => $('#bDice').addEventListener(ev, () => clearTimeout(holdT)));
function rollDice(){
  if (held){ held = false; return; }
  haptic();
  const spinX = 360 * (2 + Math.floor(Math.random() * 2)), spinY = 360 * (2 + Math.floor(Math.random() * 2));
  diceX = Math.ceil(diceX / 360) * 360 + spinX;   // whole turns only, so it lands face-on
  diceY = Math.ceil(diceY / 360) * 360 + spinY;
  $('#cube').style.transform = `rotateX(${diceX}deg) rotateY(${diceY}deg)`;
  const d = $('#bDice'); d.classList.remove('pop'); void d.offsetWidth; d.classList.add('pop');
  applyTrip(randomTrip());
}
$('#bDice').addEventListener('click', rollDice);
// Pointer effects from Driftfield: moving across the visuals stirs, ripples, pulls, paints, or (rarely) swirls them
const ptrBase = new Float32Array(32), ptrU = new Float32Array(32), ptrAge = new Float32Array(8).fill(99), touchU = new Float32Array(24);
for (let i = 0; i < 6; i++) touchU[i * 4 + 2] = 99;
let ptrI = 0, touchI = 0, lastPtr = null, lastPushT = 0, lastTouchT = 0;
function updatePointer(dt){
  for (let i = 0; i < 8; i++){
    ptrAge[i] += dt; const f = Math.max(0, 1 - ptrAge[i] / 1.2), j = i * 4;
    ptrU[j] = ptrBase[j]; ptrU[j + 1] = ptrBase[j + 1]; ptrU[j + 2] = ptrBase[j + 2] * f; ptrU[j + 3] = ptrBase[j + 3] * f;
  }
  for (let i = 0; i < 6; i++) touchU[i * 4 + 2] += dt;
}
function boxPoint(e){
  const r = $('#tripBox').getBoundingClientRect();
  return [((e.clientX - r.left) / r.width - .5) * (r.width / r.height), .5 - (e.clientY - r.top) / r.height];
}
const tripCv = $('#tripCv');
tripCv.addEventListener('pointerdown', e => { lastPtr = boxPoint(e); const j = touchI * 4; touchU.set([lastPtr[0], lastPtr[1], 0, .8], j); touchI = (touchI + 1) % 6; lastTouchT = performance.now(); });
tripCv.addEventListener('pointermove', e => {
  const p = boxPoint(e), now = performance.now();
  if (!lastPtr){ lastPtr = p; return; }
  if (now - lastPushT < 16) return;
  let vx = (p[0] - lastPtr[0]) * .9, vy = (p[1] - lastPtr[1]) * .9;
  const l = Math.hypot(vx, vy); if (l > .04){ vx *= .04 / l; vy *= .04 / l; }
  if (l > .0005){
    const i = ptrI; ptrI = (ptrI + 1) % 8; ptrBase.set([p[0], p[1], vx, vy], i * 4); ptrAge[i] = 0;
    if (now - lastTouchT > (trip.T && trip.T.touchMode === 2 ? 60 : 160)){ const j = touchI * 4; touchU.set([p[0], p[1], 0, Math.min(.8, .3 + l * 20)], j); touchI = (touchI + 1) % 6; lastTouchT = now; }
  }
  lastPushT = now; lastPtr = p;
});
['pointerleave', 'pointercancel', 'pointerup'].forEach(ev => tripCv.addEventListener(ev, e => { if (e.pointerType !== 'mouse' || ev === 'pointerleave') lastPtr = null; }));
tripCv.style.touchAction = 'none';
$('#tripX').addEventListener('click', requestCloseTrip);
$('#tripScrim').addEventListener('click', requestCloseTrip);
$('#trip').addEventListener('click', e => { if (e.target === e.currentTarget) requestCloseTrip(); });
$('#tripBtn').onclick = openTrip;
$('#shTrip').onclick = openTrip;
let tripSize = { w: 0, h: 0 }, tripResizeT = 0;
addEventListener('resize', () => {
  if (!trip.open) return;
  clearTimeout(tripResizeT);
  tripResizeT = setTimeout(() => {
    const r = $('#tripBox').getBoundingClientRect();
    if (Math.abs(r.width - tripSize.w) < 2 && Math.abs(r.height - tripSize.h) < 140) return;
    tripResize();
  }, 150);
});
// iPhone ignores the viewport setting for pinch and double-tap zoom, so stop those from rescaling the app
['gesturestart', 'gesturechange', 'gestureend'].forEach(ev => document.addEventListener(ev, e => e.preventDefault(), { passive: false }));
let lastTouchEnd = 0;
document.addEventListener('touchend', e => {
  const now = Date.now();
  if (now - lastTouchEnd < 320 && !e.target.closest('input, textarea, select')) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });



/* ---------- settings ---------- */
function applyTheme(){
  let t = store.get('theme', 'dark'); if (t === 'time') t = 'dark';
  const pal = window.djRename(store.get('palette', 'Dark Star'));
  window.djApply(t, pal);
  document.querySelectorAll('#themeSeg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.v === t));
  $('#palSel').value = window.djPalettes.includes(pal) ? pal : 'Dark Star';
}
$('#palSel').innerHTML = window.djPalettes.map(n => `<option value="${n}">${n}</option>`).join('');
$('#palSel').onchange = e => { store.set('palette', e.target.value); applyTheme(); haptic(); };
// time of day: check every minute, and whenever the app comes back to the front
document.addEventListener('visibilitychange', () => { if (!document.hidden) applyTheme(); });
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);
function openSettings(){
  renderPhotoCredits();
  $('#setAuto').checked = store.get('autonext', true);
  $('#setPhotos').checked = store.get('photos', true);
  $('#setSaver').checked = store.get('saver', false);
  $('#settings').hidden = false; document.body.classList.add('trip-open');
  history.pushState({ tr: 'settings' }, ''); nav.settings = true;
  $('#setClose').focus({ preventScroll: true });
}
function hideSettings(){ $('#settings').hidden = true; document.body.classList.remove('trip-open'); }
function closeSettings(){ hideSettings(); if (nav.settings){ nav.settings = false; nav.skipPop = true; history.back(); } }
$('#setBtn').onclick = openSettings;
$('#setBtn').addEventListener('click', () => haptic());
$('#setClose').onclick = closeSettings;
$('#setScrim').onclick = closeSettings;
$('#themeSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; store.set('theme', b.dataset.v); applyTheme(); };
$('#setAuto').onchange = e => store.set('autonext', e.target.checked);
$('#setPhotos').onchange = e => store.set('photos', e.target.checked);
$('#setSaver').onchange = e => store.set('saver', e.target.checked);
$('#libBtn').onclick = openLibrary;
// The equalizer opens full screen, with a bold frequency analyzer behind the controls
function openEqFull(){
  if (!$('#settings').hidden) hideSettings();
  if (nav.settings){ nav.settings = false; history.replaceState({ tr: 'eq' }, ''); } else history.pushState({ tr: 'eq' }, '');
  nav.eq = true;
  $('#eqFull').hidden = false; document.body.classList.add('trip-open');
  if (state.queue) ensureGraph();
  drawSpectrum();
}
function hideEqFull(){ $('#eqFull').hidden = true; document.body.classList.remove('trip-open'); }
function closeEqFull(){ hideEqFull(); if (nav.eq){ nav.eq = false; nav.skipPop = true; history.back(); } }
$('#setEq').onclick = openEqFull;
$('#eqfClose').onclick = closeEqFull;
$('#sheetSet').onclick = openSettings;
// Remote and keyboard media keys, anywhere in the app
document.addEventListener('keydown', e => {
  const k = e.key, c = e.keyCode;
  const media = { MediaPlayPause: 'pp', MediaPlay: 'play', MediaPause: 'pause', MediaTrackNext: 'next', MediaTrackPrevious: 'prev', MediaFastForward: 'ff', MediaRewind: 'rw' }[k]
    || { 10252: 'pp', 415: 'play', 19: 'pause', 417: 'ff', 412: 'rw', 10233: 'next', 10232: 'prev' }[c];
  if (media){
    e.preventDefault();
    if (media === 'pp') togglePlay(); else if (media === 'play'){ if (audio.paused) togglePlay(); } else if (media === 'pause'){ if (!audio.paused) togglePlay(); }
    else if (media === 'next') next(); else if (media === 'prev') prev(); else if (media === 'ff') skip(15); else if (media === 'rw') skip(-15);
    return;
  }
  return;
}, true);
$('#setClear').onclick = () => {
  Object.keys(localStorage).filter(k => k.startsWith('dj:')).forEach(k => localStorage.removeItem(k));
  metaCache.clear(); yearCache.clear(); songCache.clear(); toast('Saved shows cleared');
};
applyTheme();

/* ---------- title: the Stomp wordmark ---------- */
// The word is drawn three times in the same spot: the base with the j cut out, the j above the ankle, and the j's foot.
// Script measures the j and positions the cuts and pivots. (From the deadjams Stomp design.)
const wordHost = $('#wordmark'), wordLayers = [], wordLayouts = [];
function buildStomp(wordHost){
  const layers = [];
  const text = wordHost.textContent.trim(); wordHost.textContent = '';
  const mk = (tag, cls) => { const e = document.createElement(tag); e.className = cls; e.setAttribute('aria-hidden', 'true'); return e; };
  const base = mk('span', 't'); base.textContent = text;
  const probe = mk('i', 'probe'); base.appendChild(probe);
  wordHost.appendChild(base);
  for (let i = 0; i < text.length; i++){
    if (text.charAt(i) !== 'j') continue;
    const body = mk('span', 't jbody'); body.textContent = text;
    const fw = mk('span', 'fw'), foot = mk('span', 't foot'); foot.textContent = text; fw.appendChild(foot);
    wordHost.appendChild(body); wordHost.appendChild(fw);
    const L = { i, body, fw, foot }; layers.push(L); wordLayers.push(L);
  }
  const cvs = document.createElement('canvas'); cvs.width = 500; cvs.height = 600;
  const cx = cvs.getContext('2d', { willReadFrequently: true });
  function measure(){
    const fs = 200, ox = 150, oy = 300, cs = getComputedStyle(wordHost);
    cx.clearRect(0, 0, 500, 600); cx.font = cs.fontWeight + ' ' + fs + 'px Fraunces'; cx.fillText('j', ox, oy);
    const tm = cx.measureText('j');
    const m = { depth: Math.max(.06, (tm.actualBoundingBoxDescent || .22 * fs) / fs), inkL: -(tm.actualBoundingBoxLeft || 0) / fs, inkR: (tm.actualBoundingBoxRight || .3 * fs) / fs };
    m.stem = (m.inkL + m.inkR) / 2;
    const d = cx.getImageData(0, oy - Math.round(.18 * fs), 500, 1).data, runs = []; let st = -1;
    for (let x = 0; x < 500; x++){ const on = d[x * 4 + 3] > 128; if (on && st < 0) st = x; if (!on && st >= 0){ runs.push([st, x - 1]); st = -1; } }
    if (runs.length){ const r = runs[runs.length - 1]; m.stem = ((r[0] + r[1]) / 2 - ox) / fs; }
    return m;
  }
  const px = v => v.toFixed(2) + 'px';
  function layout(){
    const M = measure(), b = base.getBoundingClientRect(); if (!b.width) return;
    const sc = b.width / (base.offsetWidth || b.width) || 1;   // the header may be scaled down
    const fs = parseFloat(getComputedStyle(base).fontSize);
    const len = parseFloat(getComputedStyle(wordHost).getPropertyValue('--foot-length')) || .55;
    const baseline = (probe.getBoundingClientRect().bottom - b.top) / sc, W = b.width / sc, H = b.height / sc; let holes = '';
    layers.forEach(L => {
      const r = document.createRange(); r.setStart(base.firstChild, L.i); r.setEnd(base.firstChild, L.i + 1);
      const gx = (r.getBoundingClientRect().left - b.left) / sc;
      const cutY = baseline + (1 - len) * M.depth * fs, groundY = baseline + M.depth * fs;
      const xl = gx + M.inkL * fs - .04 * fs, xr = gx + M.inkR * fs + .04 * fs, pivX = gx + M.stem * fs, ov = .05 * fs;
      L.foot.style.clipPath = 'inset(' + px(cutY - ov) + ' ' + px(W - xr) + ' ' + px(-.5 * fs) + ' ' + px(xl) + ')';
      L.fw.style.transformOrigin = px(pivX) + ' ' + px(cutY);
      L.foot.style.transformOrigin = px((xl + xr) / 2) + ' ' + px(groundY);
      L.body.style.clipPath = 'inset(' + px(-.5 * fs) + ' ' + px(W - xr) + ' ' + px(H - (cutY + ov / 2)) + ' ' + px(xl) + ')';
      L.body.style.transformOrigin = px(pivX) + ' ' + px(cutY);
      holes += 'M' + xl.toFixed(2) + ' -100H' + xr.toFixed(2) + 'V' + (H + 100).toFixed(2) + 'H' + xl.toFixed(2) + 'Z';
    });
    base.style.clipPath = layers.length ? 'path(evenodd,"M-200 -200H' + (W + 200).toFixed(2) + 'V' + (H + 200).toFixed(2) + 'H-200Z' + holes + '")' : 'none';
  }
  layout();
  if (document.fonts){ document.fonts.load('800 200px Fraunces', 'j').then(layout, layout); document.fonts.ready.then(layout); }
  addEventListener('resize', layout);
  wordLayouts.push(layout);
}
buildStomp(wordHost);
window.relayoutWord = () => requestAnimationFrame(() => wordLayouts.forEach(f => f()));
const setWordLive = on => document.querySelectorAll('.word').forEach(w => w.classList.toggle('live', on));
// With music playing, each kick lands a full stomp; between songs it falls back to the subtle loop.
const STOMP_OFF = [0, .12, .42, .56, .70, .78, .88, 1];   // the slap lands at 70%
const STOMP_EASE = ['ease-out', 'ease-in-out', 'ease-out', 'ease-in', 'ease-out', 'ease-out', 'ease-in-out', 'linear'];
const S_ROT = [0, -2.7, 18, 16.2, 0, -2.16, .54, 0];
const S_SQ = [[1, 1], [1.03, .96], [.96, 1.05], [.97, 1.04], [1.1, .86], [.97, 1.03], [1.01, .99], [1, 1]];
const S_BS = [[1, 1], [1, .98], [1, 1.015], [1, 1.012], [1.02, .96], [1, 1.01], [1, 1], [1, 1]];
const S_BR = [0, 0, -.8, -.7, .2, 0, 0, 0];
const titleBeat = { avg: .15, last: 0, gaps: [], liveUntil: 0, anims: [] };
const tbuf = new Uint8Array(1024), bbuf = new Uint8Array(512);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
function stomp(slapIn){
  const shrunkBoost = mq.matches && topEl.classList.contains('shrunk') ? 1.35 : 1;
  const D = Math.max(.25, Math.min(1.1, slapIn / .7)) * 1000, a = (mq.matches ? 3.2 : 2.1) * shrunkBoost;   // timed so the slap lands on the next beat; bigger on phones
  const sc = v => 1 + (v - 1) * a;
  titleBeat.anims.forEach(x => x.cancel()); titleBeat.anims = [];
  // on phones the whole word dips a touch as the foot lands, so the beat reads at a glance
  if (mq.matches) document.querySelectorAll('.word').forEach(w => titleBeat.anims.push(w.animate([
    { transform: 'none', offset: 0 }, { transform: 'translateY(-1px)', offset: .55 }, { transform: 'translateY(3.5px) scaleY(.92)', offset: .72, easing: 'ease-out' }, { transform: 'none', offset: 1 }
  ], { duration: D })));
  wordLayers.forEach(L => {
    titleBeat.anims.push(
      L.fw.animate(S_ROT.map((r, i) => ({ offset: STOMP_OFF[i], rotate: (r * a) + 'deg', easing: STOMP_EASE[i] })), { duration: D }),
      L.foot.animate(S_SQ.map((v, i) => ({ offset: STOMP_OFF[i], scale: `${sc(v[0])} ${sc(v[1])}`, easing: STOMP_EASE[i] })), { duration: D }),
      L.body.animate(S_BS.map((v, i) => ({ offset: STOMP_OFF[i], scale: `${sc(v[0])} ${sc(v[1])}`, rotate: (S_BR[i] * a) + 'deg', easing: STOMP_EASE[i] })), { duration: D })
    );
  });
}
function titleLoop(now){
  requestAnimationFrame(titleLoop);
  const an = !document.hidden ? getAn() : null;
  if (!an){
    if (!document.hidden && aheadReady() && remotePlaying()){
      const pt = playTime(), v = aheadLevels(pt);
      document.querySelectorAll('.trk.playing .eqbars').forEach(el => { el.classList.add('vol'); [...el.children].forEach((bar, k) => { bar.style.height = (2 + Math.min(1, [v.bass, v.mid, v.high][k] * 1.1) * 11).toFixed(1) + 'px'; }); });
      if (!reduceMotion){
        // aim at the next known beat; between beats, keep the tempo going
        const next = ahead.beats.find(x => x > pt + .22 && x > ahead.lastStompBeat);
        const recent = ahead.beats.filter(x => x > pt - 4 && x < pt + 4);
        const gaps = recent.slice(1).map((x, i) => x - recent[i]).filter(g => g > .3 && g < 1.4).sort((x, y) => x - y);
        const ibi = gaps.length ? gaps[gaps.length >> 1] : .536;
        if (next !== undefined && next - pt < 1.05){ stomp(next - pt); ahead.lastStompBeat = next; setWordLive(true); titleBeat.liveUntil = now + 2500; }
        else if (ahead.lastStompBeat > 0 && pt > ahead.lastStompBeat && pt - ahead.lastStompBeat > ibi * .7 && pt - ahead.lastStompBeat < 2.5){ ahead.lastStompBeat += ibi; stomp(Math.max(.25, ahead.lastStompBeat - pt)); }
      }
      return;
    }
    if (now > titleBeat.liveUntil) setWordLive(false); return;
  }
  an.getByteFrequencyData(tbuf);
  // the playing bars beside the song follow its low, middle, and high frequencies
  const barsEl = document.querySelectorAll('.trk.playing .eqbars');
  if (barsEl.length){
    const hz0 = ctx.sampleRate / 2 / tbuf.length;
    const lvl = [[40, 250], [250, 2000], [2000, 8000]].map(([f0, f1]) => { const a0 = Math.max(1, Math.floor(f0 / hz0)), a1 = Math.ceil(f1 / hz0); let m = 0; for (let k = a0; k <= a1; k++) m += tbuf[k]; return m / ((a1 - a0 + 1) * 255); });
    barsEl.forEach(el => { el.classList.add('vol'); [...el.children].forEach((bar, k) => { bar.style.height = (2 + Math.min(1, lvl[k] * [1.4, 1.9, 2.8][k]) * 11).toFixed(1) + 'px'; }); });
  }
  if (reduceMotion) return;
  // kick detection runs on the unsmoothed analyser, then each tap is aimed so the foot lands on the predicted beat
  const ba = getBeatAn(); if (!ba) return;
  ba.getByteFrequencyData(bbuf);
  const hz = ctx.sampleRate / 2 / bbuf.length, lo = Math.max(1, Math.floor(35 / hz)), hi = Math.ceil(140 / hz);
  let sum = 0; for (let k = lo; k <= hi; k++) sum += bbuf[k];
  const LAT = .03;                                   // analysis delay, seconds
  const b = sum / ((hi - lo + 1) * 255), t = now / 1000 - LAT;
  const tb = titleBeat;
  tb.avg = tb.avg * .94 + b * .06;
  if (b > tb.avg * 1.32 + .04 && b > .2 && t - tb.last > .27){
    const gap = t - tb.last;
    if (gap < 1.6){ tb.gaps.push(gap); if (tb.gaps.length > 8) tb.gaps.shift(); }
    tb.last = t;
    const sorted = tb.gaps.slice().sort((x, y) => x - y);
    let ibi = sorted.length >= 2 ? sorted[sorted.length >> 1] : (tb.ibi || .536);   // tempo locks after two kicks
    while (ibi > .75) ibi /= 2;      // kicks often land on 1 and 3: tap the quarter notes in between too
    while (ibi < .33) ibi *= 2;
    tb.ibi = ibi;
    setWordLive(true); tb.liveUntil = now + 2500;
    tb.next = t + ibi;               // the next beat, predicted
    if (t - (tb.lastStomp || 0) > ibi * .5){ stomp(tb.next - now / 1000); tb.lastStomp = t; }
  } else if (tb.ibi && t < tb.last + 2.5 && t >= (tb.next || Infinity) - .02){
    tb.next += tb.ibi; stomp(tb.next - now / 1000); tb.lastStomp = t;   // keep tapping on the beat between kicks
  } else if (now > tb.liveUntil) setWordLive(false);
}
requestAnimationFrame(titleLoop);

// The title takes you back to the start: close any overlay and the open show, and return to the year list
function goHome(){
  if (trip.open) closeTrip();
  if (!$('#settings').hidden) hideSettings();
  if (!$('#sheet').hidden) hideSheet();
  nav.trip = nav.settings = nav.sheet = nav.show = false;
  state.current = null; state.sourceId = null; state.meta = null;
  document.body.classList.remove('viewing'); window.relayoutWord && window.relayoutWord();
  history.replaceState(null, '', location.pathname);
  if (state.mode !== 'year') loadYear(state.year); else { renderList(); markDial(); }
  renderDetail(); fillSotd();
  setY(0, true);
}
$('#homeLink').addEventListener('click', e => { e.preventDefault(); goHome(); haptic(); });

// First visits: a finger presses the dial, drags it one way and back (the dial follows), then taps a year
function dialDemo(){
  const track = $('#dial'), f = $('#finger');
  if (reduceMotion) return;
  let stop = false;
  const cancel = () => { stop = true; f.hidden = true; };
  track.addEventListener('pointerdown', cancel, { once: true });
  const start = track.scrollLeft;
  // [time ms, finger x offset px, opacity, pressed]
  const K = [[0, 0, 0, 0], [350, 0, 1, 0], [550, 0, 1, 1], [1350, -120, 1, 1], [1550, -120, 1, 0], [1750, -120, 1, 0], [1950, -120, 1, 1], [2900, 0, 1, 1], [3100, 0, 1, 0], [3500, 0, 1, 0], [3650, 0, 1, 1], [3800, 0, 1, 0], [4300, 0, 0, 0]];
  const ease = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  let t0 = 0, wasDown = 0;
  f.hidden = false;
  const frame = now => {
    if (stop) return;
    if (!t0) t0 = now;
    const t = now - t0;
    let i = 0; while (i < K.length - 2 && t > K[i + 1][0]) i++;
    const [ta, xa, oa, pa] = K[i], [tb, xb, ob] = K[i + 1];
    const u = ease(Math.min(1, Math.max(0, (t - ta) / (tb - ta))));
    const x = xa + (xb - xa) * u, o = oa + (ob - oa) * u, down = pa;
    if (down && !wasDown){ f.classList.remove('press'); void f.offsetWidth; f.classList.add('press'); }
    wasDown = down;
    f.style.opacity = o;
    f.style.transform = `translateX(${x}px) scale(${down ? .9 : 1})`;
    if (down) track.scrollLeft = start - x;   // the dial moves with the finger
    if (t < K[K.length - 1][0]) requestAnimationFrame(frame);
    else { f.hidden = true; track.scrollTo({ left: start, behavior: 'smooth' }); }
  };
  requestAnimationFrame(frame);
}

if (IOS && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches) document.documentElement.classList.add('ios-browser');

const topEl = $('.top');
function applyShrink(){
  const p = Math.min(1, Math.max(0, getY() / (mq.matches ? 90 : 140)));
  topEl.style.setProperty('--shrink', p.toFixed(3));
  topEl.classList.toggle('shrunk', p > .6 || document.body.classList.contains('viewing'));
}
function measureHeader(){
  const r = document.documentElement.style;
  topEl.style.setProperty('--shrink', '0'); r.setProperty('--hdrFull', topEl.offsetHeight + 'px');
  topEl.style.setProperty('--shrink', '1'); r.setProperty('--hdrMin', topEl.offsetHeight + 'px');
  applyShrink();
}
// keep the last song row clear of the player bar
function measurePlayer(){ document.documentElement.style.setProperty('--pbar', ($('#player').offsetHeight + 18) + 'px'); }
addEventListener('scroll', applyShrink, { passive: true });
$('#page').addEventListener('scroll', applyShrink, { passive: true });
addEventListener('resize', () => { measureHeader(); measurePlayer(); });
if (document.fonts) document.fonts.ready.then(() => { measureHeader(); measurePlayer(); });
setTimeout(() => { measureHeader(); measurePlayer(); }, 0);
$('#hdrSearch').onclick = () => { setY(0); document.body.classList.add('searching'); haptic(); setTimeout(() => $('#songq').focus(), 60); };

setInterval(() => { if (!state.casting && state.queue && document.body.classList.contains('playing') === audio.paused) syncPlay(); }, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden){ syncPlay(); onTime(); } });

/* ---------- analytics ---------- */
function track(name, params = {}){
  try { if (window.gtag && !store.get('noStats', false)) window.gtag('event', name, params); } catch {}
}
const showParams = g => g ? { show_date: g.date, show_year: +g.date.slice(0, 4), venue: g.venue, city: g.coverage } : {};
const wrap = (fn, before) => function(...a){ try { before.apply(this, a); } catch {} return fn.apply(this, a); };
loadYear = wrap(loadYear, y => { if (window.djReady) track('select_year', { year: y }); });   // not the year the app opens on
loadOnThisDay = wrap(loadOnThisDay, () => track('on_this_day'));
openLibrary = wrap(openLibrary, () => track('open_library'));
openShow = wrap(openShow, (g, id, auto) => { if (!auto) track('open_show', { ...showParams(g), from: state.mode }); });
loadTrack = wrap(loadTrack, i => { const q = state.queue; if (q && q.tracks[i]) track('play_song', { song: q.tracks[i].title, track_number: i + 1, ...showParams(q.show), recording: q.id, from: state.mode, output: state.casting ? 'cast' : state.remote ? 'airplay' : 'device' }); });
onEnded = wrap(onEnded, () => { const q = state.queue; if (q) track('song_complete', { song: q.tracks[q.index].title, ...showParams(q.show) }); });
runSearch = wrap(runSearch, raw => track('search', { search_term: String(raw).trim().slice(0, 100) }));
openTrip = wrap(openTrip, () => { trip.openedAt = Date.now(); track('trip_out_open'); });
closeTrip = wrap(closeTrip, () => { if (trip.open) track('trip_out_close', { seconds: Math.round((Date.now() - (trip.openedAt || Date.now())) / 1000) }); });
const rollDiceOriginal = rollDice;
rollDice = wrap(rollDice, () => track('trip_out_roll'));
openEqFull = wrap(openEqFull, () => track('open_equalizer'));
openSpeakers = wrap(openSpeakers, () => track('open_speakers', { browser: window.WebKitPlaybackTargetAvailabilityEvent ? 'airplay' : castReady ? 'cast' : 'other' }));
setRemote = wrap(setRemote, on => { if (!!on !== !!state.remote) track(on ? 'airplay_connect' : 'airplay_disconnect'); });
castStart = wrap(castStart, () => { if (!state.casting) track('cast_connect'); });
toggleFavShow = wrap(toggleFavShow, g => track(isFavShow(keyOf(g)) ? 'unsave_show' : 'save_show', showParams(g)));
toggleFavSong = wrap(toggleFavSong, (g, m, i) => track(isFavSong(m.id, i) ? 'unsave_song' : 'save_song', { song: m.tracks[i].title, ...showParams(g) }));
onAudioError = wrap(onAudioError, () => { const q = state.queue; if (q) track('song_error', { song: q.tracks[q.index].title, recording: q.id }); });
// buttons wired before the wrapping above still point at the originals, so point them at the tracked versions
$('#tripBtn').onclick = () => openTrip(); $('#shTrip').onclick = () => openTrip();
$('#bDice').removeEventListener('click', rollDiceOriginal); $('#bDice').addEventListener('click', () => rollDice());
$('#setEq').onclick = () => openEqFull(); $('#castBtn').onclick = () => openSpeakers(); $('#shCast').onclick = () => openSpeakers();
$('#otd').onclick = () => loadOnThisDay(); $('#libBtn').onclick = () => openLibrary();
// taps that aren't functions of their own
document.addEventListener('click', e => {
  const t = e.target;
  const tab = t.closest('.tab'); if (tab) track('view_tab', { tab: tab.dataset.tab });
  const rec = t.closest('.rec'); if (rec) track('change_recording', { recording: rec.dataset.id });
  const lv = t.closest('[data-loved]'); if (lv) track('top50_pick', { show_date: lv.dataset.loved });
  if (t.closest('#lovedMore')) track('top50_shuffle');
  const so = t.closest('[data-sotd]'); if (so) track('show_of_the_day', { action: so.dataset.sotd });
  const chip = t.closest('#presets .chip'); if (chip) track('eq_preset', { preset: chip.dataset.p });
  if (t.closest('#themeSeg button')) track('appearance', { mode: t.closest('button').dataset.v });
  if (t.closest('#setBtn')) track('open_settings');
  if (t.closest('#homeLink')) track('go_home');
}, true);
$('#palSel').addEventListener('change', e => track('palette', { palette: e.target.value }));
// minutes of actual listening, one event per minute played
let listenSec = 0;
setInterval(() => {
  const playing = state.casting ? remotePlaying() : (state.queue && !audio.paused);
  if (!playing) return;
  if (++listenSec % 60 === 0){ const q = state.queue; track('listen_minute', { song: q.tracks[q.index].title, ...showParams(q.show), trip_out: trip.open ? 1 : 0 }); }
}, 1000);

/* ---------- read-ahead analysis (iPhone) ----------
   Instead of tapping the playing sound, quietly download the song a little ahead of where it's playing,
   decode it in small pieces, and keep only a timeline of bass, mids, highs, beats, and hits.
   Runs while Trip out is open, or on Wi-Fi where the browser can tell. */
const ahead = { id: 0, url: '', chunks: [], beats: [], hits: [], until: 0, busy: false, ctl: null, lastBeatSent: -1, lastHitSent: -1, lastStompBeat: -1 };
const onWifi = () => !!(navigator.connection && navigator.connection.type === 'wifi');
const aheadWanted = () => IOS && state.queue && !state.casting && (tripIsOpen() || onWifi());
const playTime = () => state.casting && remotePlayer ? remotePlayer.currentTime : audio.currentTime;
const BR1 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320], BR2 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
const SR1 = [44100,48000,32000], SR2 = [22050,24000,16000], SR25 = [11025,12000,8000];
function mp3Frame(b, i){
  if (i + 4 > b.length || b[i] !== 0xFF || (b[i + 1] & 0xE0) !== 0xE0) return null;
  const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3, bri = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3, pad = (b[i + 2] >> 1) & 1;
  if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) return null;
  const v1 = ver === 3, br = (v1 ? BR1 : BR2)[bri] * 1000, sr = (v1 ? SR1 : ver === 2 ? SR2 : SR25)[sri];
  return { len: Math.floor((v1 ? 144 : 72) * br / sr) + pad, samples: v1 ? 1152 : 576, sr };
}
function aheadStop(){ ahead.id++; try { ahead.ctl && ahead.ctl.abort(); } catch {} ahead.ctl = null; ahead.busy = false; }
function aheadReset(url){ aheadStop(); Object.assign(ahead, { url, chunks: [], beats: [], hits: [], until: 0, lastBeatSent: -1, lastHitSent: -1, lastStompBeat: -1, f: { lp1: 0, lp2: 0, lp3: 0, prevB: 0, prevMH: 0, fluxAvg: .01, mhAvg: .01, mx: [1e-4, 1e-4, 1e-4] } }); }
async function aheadRun(){
  if (ahead.busy || !aheadWanted()) return;
  const q = state.queue, url = q.tracks[q.index].url;
  if (ahead.url !== url) aheadReset(url);
  ahead.busy = true; const my = ahead.id;
  const ctlr = new AbortController(); ahead.ctl = ctlr;
  try {
    const res = await fetch(url, { signal: ctlr.signal, mode: 'cors' });
    if (!res.ok || !res.body) throw new Error('no body');
    const reader = res.body.getReader();
    let buf = new Uint8Array(0), pos = 0, chunkStart = 0, frames = 0, samples = 0, sampleBase = 0, rate = 44100, idSkipped = false;
    const oc = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 2, 44100);
    const flush = async () => {
      if (pos <= chunkStart) return;
      const bytes = buf.slice(chunkStart, pos).buffer, t0 = sampleBase / rate;
      sampleBase += samples; samples = 0; frames = 0;
      try { const ab = await oc.decodeAudioData(bytes); if (my === ahead.id) aheadAnalyze(ab, t0); } catch {}
      buf = buf.slice(pos); pos = 0; chunkStart = 0;
    };
    while (my === ahead.id){
      // stay about 75 seconds ahead of the music, then pause reading (the download pauses with it)
      while (my === ahead.id && ahead.until > playTime() + 75){ await new Promise(r => setTimeout(r, 1500)); if (!aheadWanted()){ aheadStop(); return; } }
      const { value, done } = await reader.read();
      if (value){ const nb = new Uint8Array(buf.length + value.length); nb.set(buf); nb.set(value, buf.length); buf = nb; }
      if (!idSkipped && buf.length >= 10){
        idSkipped = true;
        if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33){ const sz = ((buf[6] & 127) << 21) | ((buf[7] & 127) << 14) | ((buf[8] & 127) << 7) | (buf[9] & 127); pos = chunkStart = 10 + sz + ((buf[5] & 16) ? 10 : 0); }
      }
      while (pos + 4 <= buf.length){
        const f = mp3Frame(buf, pos);
        if (!f){ pos++; if (frames === 0) chunkStart = pos; continue; }
        if (pos + f.len > buf.length) break;
        rate = f.sr; pos += f.len; frames++; samples += f.samples;
        if (frames >= 1200){ await flush(); }      // about 30 seconds per piece, cut exactly on frame boundaries
      }
      if (done){ await flush(); break; }
    }
  } catch {}
  if (my === ahead.id){ ahead.busy = false; ahead.ctl = null; }
}
function aheadAnalyze(ab, t0){
  const sr = ab.sampleRate, n = ab.length, c0 = ab.getChannelData(0), c1 = ab.numberOfChannels > 1 ? ab.getChannelData(1) : c0;
  const hop = 1024, H = Math.floor(n / hop), F = ahead.f;
  const a1 = Math.exp(-2 * Math.PI * 150 / sr), a2 = Math.exp(-2 * Math.PI * 2000 / sr), a3 = Math.exp(-2 * Math.PI * 4500 / sr);
  const bass = new Float32Array(H), mid = new Float32Array(H), high = new Float32Array(H);
  for (let h = 0; h < H; h++){
    let sb = 0, sm = 0, sh = 0;
    for (let i = h * hop, e = i + hop; i < e; i++){
      const x = (c0[i] + c1[i]) * .5;
      F.lp1 = a1 * F.lp1 + (1 - a1) * x; F.lp2 = a2 * F.lp2 + (1 - a2) * x; F.lp3 = a3 * F.lp3 + (1 - a3) * x;
      const b = F.lp1, m = F.lp2 - F.lp1, hi = x - F.lp3; sb += b * b; sm += m * m; sh += hi * hi;
    }
    const rb = Math.sqrt(sb / hop), rm = Math.sqrt(sm / hop), rh = Math.sqrt(sh / hop);
    bass[h] = rb; mid[h] = rm; high[h] = rh;
    const t = t0 + (h * hop) / sr;
    // kicks: sudden jumps in bass; hits: sudden jumps in the mids and highs
    const flux = Math.max(0, rb - F.prevB); F.prevB = rb; F.fluxAvg = F.fluxAvg * .97 + flux * .03;
    if (flux > F.fluxAvg * 2.4 + .004 && t - (ahead.beats[ahead.beats.length - 1] ?? -9) > .28) ahead.beats.push(t);
    const mh = rm + rh, fl2 = Math.max(0, mh - F.prevMH); F.prevMH = mh; F.mhAvg = F.mhAvg * .96 + fl2 * .04;
    if (fl2 > F.mhAvg * 2.6 + .003 && t - (ahead.hits[ahead.hits.length - 1] ?? -9) > .09) ahead.hits.push(t);
  }
  ahead.chunks.push({ t0, sr, hop, bass, mid, high });
  ahead.until = t0 + n / sr;
}
function aheadLevels(t){
  const c = ahead.chunks.find(k => t >= k.t0 && t < k.t0 + k.bass.length * k.hop / k.sr); if (!c) return null;
  const i = Math.min(c.bass.length - 1, Math.floor((t - c.t0) * c.sr / c.hop)), mx = ahead.f.mx;
  const v = [c.bass[i], c.mid[i], c.high[i]];
  v.forEach((x, k) => { mx[k] = Math.max(x, mx[k] * .9995); });
  return { bass: Math.min(1, v[0] / mx[0]), mid: Math.min(1, v[1] / mx[1]), high: Math.min(1, v[2] / mx[2]) };
}
const aheadReady = () => !!(ahead.chunks.length && aheadLevels(playTime()));
// keep it running when wanted, stop it when not, and start over on each new song
setInterval(() => { if (aheadWanted()){ if (state.queue && ahead.url !== state.queue.tracks[state.queue.index].url) aheadReset(''); aheadRun(); } else if (ahead.busy) aheadStop(); }, 1000);

addEventListener('hashchange', () => { if (/@\d+:\d+$/.test(location.hash)) location.reload(); });

// Tap the version number five times to stop (or resume) counting this device in analytics
let verTaps = 0, verT = 0;
$('#appVersion').onclick = () => {
  clearTimeout(verT); verT = setTimeout(() => verTaps = 0, 1500);
  if (++verTaps < 5) return; verTaps = 0;
  const off = !store.get('noStats', false); store.set('noStats', off);
  try { if (window.gtag) window.gtag('consent', 'update', { analytics_storage: off ? 'denied' : 'granted' }); } catch {}
  toast(off ? 'This device is no longer counted in analytics' : 'This device is counted in analytics again'); haptic();
};
$('#setCalm').checked = store.get('calm', false);
$('#setCalm').onchange = e => store.set('calm', e.target.checked);

/* ---------- boot ---------- */
async function boot(){
  buildDial(); buildEq(); saveEq(); renderDetail();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  const [id, at] = decodeURIComponent(location.hash.slice(1)).split('@');
  if (id){
    try {
      const m = await fetchMeta(id);
      const date = String(one(m.md && m.md.date) || '').slice(0, 10);
      if (date){
        await loadYear(+date.slice(0, 4));
        const g = state.shows.find(x => x.sources.some(s => s.identifier === id)) || state.shows.find(x => x.date === date);
        if (g){
          openShow(g, id); window.djReady = true;
          // a shared moment: line up that song at that spot, ready to play
          const mm = (at || '').match(/^(\d+):(\d+)$/);
          if (mm){
            const i = Math.max(0, Math.min(+mm[1] - 1, m.tracks.length - 1)), t = +mm[2];
            state.queue = { id: m.id, tracks: m.tracks, show: g, index: i };
            audio.preload = 'metadata'; audio.src = m.tracks[i].url;
            audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = t; } catch {} }, { once: true });
            ['#play', '#mplay', '#seek', '#shPlay', '#shSeek', '#back15', '#fwd15'].forEach(s => $(s).disabled = false);
            updateNowPlaying(); $('#npSub').textContent = `Shared moment at ${clock(t)}. Press play.`;
          } else restoreSession();
          loadTop50(); return;
        }
      }
    } catch {}
  }
  await loadYear(state.year);
  window.djReady = true;
  restoreSession();
  setTimeout(dialDemo, 400);
  loadTop50();
}
boot();
})();
