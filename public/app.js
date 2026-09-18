'use strict';

const $ = s => document.querySelector(s);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const launch = $('#launch');
const reader = $('#reader');
const scroller = $('#scroller');
const strip = $('#strip');
const scrub = $('#scrub');
const topbar = $('#topbar');
const dock = $('#dock');
const ticks = $('#ticks');
const filled = $('#filled');
const thumb = $('#thumb');
const widthInput = $('#width');
const widthVal = $('#widthval');

const END_H = 240;

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('strip:' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('strip:' + k, JSON.stringify(v)); } catch { /* private mode */ } }
};

// Scanlation groups tack their credits onto filenames; the chrome reads better without.
function trimCredits(s) {
  let out = s;
  while (/\s*\([^()]*\)\s*$/.test(out)) out = out.replace(/\s*\([^()]*\)\s*$/, '');
  return out.trim() || s;
}
function chapterLabel(name, folder) {
  let s = name;
  if (s.toLowerCase().startsWith(folder.toLowerCase())) s = s.slice(folder.length);
  s = trimCredits(s).replace(/^[\s\-_.]+/, '');
  return s || trimCredits(name);
}

// ---------- reader state ----------

const R = {
  ch: null,
  mode: 'strip',          // 'strip' = continuous webtoon, 'page' = one page at a time
  pct: 100,
  vw: 0, vh: 0,
  offsets: [], heights: [], pagesTotal: 0, total: 0, colW: 0, mounted: new Map(),
  at: 0
};
let endCard = null;
let nextPreloaded = null;

const pageUrl = (file, n) => '/api/page?path=' + encodeURIComponent(file) + '&n=' + n;
const isStrip = () => R.mode === 'strip';
const widthKey = () => 'w:' + R.mode + ':' + R.ch.folder;

async function openChapter(file) {
  const res = await fetch('/api/chapter?path=' + encodeURIComponent(file));
  const ch = await res.json();
  if (!ch || ch.error) return;

  clearPages();
  R.ch = ch;
  nextPreloaded = null;
  R.mode = store.get('mode:' + ch.folder) || 'strip';

  launch.hidden = true;
  reader.hidden = false;
  const label = chapterLabel(ch.name, ch.folder);
  $('#now').innerHTML = '<b></b> <span></span>';
  $('#now').children[0].textContent = trimCredits(ch.folder);
  // When the filename is just the number, saying it twice reads as a stutter.
  $('#now').children[1].textContent = label === String(ch.number)
    ? 'chapter ' + ch.number + ' of ' + ch.of
    : label + ', ' + ch.number + ' of ' + ch.of;
  $('#prevch').disabled = ch.prev === null;
  $('#nextch').disabled = ch.next === null;

  measure();
  enterMode(R.mode, store.get(ch.path));
  poke();
}

function measure() {
  R.vw = scroller.clientWidth;
  R.vh = scroller.clientHeight;
  // On a narrow screen the bars span the full width, so the scrubber has to stop where
  // they start. How tall they are depends on how the buttons wrapped, so measure them.
  const narrow = window.matchMedia('(max-width: 760px)').matches;
  scrub.style.top = narrow ? topbar.offsetHeight + 8 + 'px' : '';
  scrub.style.bottom = narrow ? dock.offsetHeight + 8 + 'px' : '';
  scrub.style.height = narrow ? 'auto' : '';
}

function clearPages() {
  for (const [, img] of R.mounted) img.remove();
  R.mounted.clear();
  strip.querySelectorAll('img').forEach(i => i.remove());
}

function enterMode(mode, saved) {
  R.mode = mode;
  store.set('mode:' + R.ch.folder, mode);
  strip.classList.toggle('paged', mode === 'page');
  $('#mode').textContent = mode === 'strip' ? 'Read as pages' : 'Read as strip';
  clearPages();
  buildEndCard();
  R.pct = mode === 'strip' ? (store.get(widthKey()) || defaultStripWidth()) : 100;

  if (mode === 'strip') {
    endCard.hidden = false;
    layout();
    scroller.scrollLeft = Math.max(0, (R.colW - R.vw) / 2);
    scroller.scrollTop = !saved ? 0
      : saved.usePage ? R.offsets[clamp(saved.page | 0, 0, R.offsets.length - 1)]
      : clamp(saved.at, 0, 1) * R.pagesTotal;
    render();
  } else {
    buildTicks(R.ch.pages.map((_, n) => n / (R.ch.pages.length + 1)));
    showPage(saved ? clamp(saved.page | 0, 0, R.ch.pages.length - 1) : 0);
  }
}

function toggleMode() {
  enterMode(isStrip() ? 'page' : 'strip', { page: currentPage(), usePage: true });
}

function currentPage() {
  if (!R.ch) return 0;
  return isStrip() ? indexAt(scroller.scrollTop + R.vh / 2) : Math.min(R.at, R.ch.pages.length - 1);
}

// ---------- strip mode ----------

// How far past its own resolution the art may be stretched, counted in real screen
// pixels rather than CSS ones. The old rule ignored the display, so on a 2x screen it
// asked for a 2.35x upscale and kept only 59% of the edge detail in the source.
const MAX_UPSCALE = 1.5;

function defaultStripWidth() {
  const widths = R.ch.pages.map(p => p.w).sort((a, b) => a - b);
  const median = widths[widths.length >> 1] || 800;
  const dpr = window.devicePixelRatio || 1;
  return Math.round(clamp(Math.min(R.vw, median * MAX_UPSCALE / dpr) / R.vw * 100, 30, 260));
}

function layout() {
  measure();
  R.colW = Math.max(160, Math.round(R.vw * R.pct / 100));

  let y = 0;
  R.offsets.length = 0;
  R.heights.length = 0;
  for (const p of R.ch.pages) {
    R.offsets.push(y);
    const h = Math.max(1, Math.round(p.h * (R.colW / p.w)));
    R.heights.push(h);
    y += h;               // the next page starts exactly where this one ends: no seam
  }
  R.pagesTotal = y;
  R.total = y + END_H;

  strip.style.width = R.colW + 'px';
  strip.style.height = R.total + 'px';
  for (const [i, img] of R.mounted) {
    img.style.top = R.offsets[i] + 'px';
    img.style.height = R.heights[i] + 'px';
  }
  endCard.style.top = R.pagesTotal + 'px';
  endCard.style.height = END_H + 'px';

  scroller.style.cursor = R.colW > R.vw ? 'grab' : '';
  setWidthReadout();
  buildTicks(R.offsets.map(o => o / R.total));
}

function indexAt(y) {
  let lo = 0, hi = R.offsets.length - 1;
  if (y <= 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (R.offsets[mid] <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

function mount(i) {
  if (i < 0 || i >= R.ch.pages.length || R.mounted.has(i)) return;
  const img = new Image();
  img.decoding = 'async';
  img.alt = 'Page ' + (i + 1);
  img.style.top = R.offsets[i] + 'px';
  img.style.height = R.heights[i] + 'px';
  img.src = pageUrl(R.ch.path, i);
  strip.appendChild(img);
  R.mounted.set(i, img);
}

function render() {
  if (!R.ch || !isStrip()) return;
  const top = scroller.scrollTop;
  const buffer = R.vh;
  const first = indexAt(top - buffer);
  const last = indexAt(top + R.vh + buffer);
  // Always keep one page mounted either side. A stitched page can be 15,000px tall, so a
  // buffer measured only in pixels would never reach the next one before you got there.
  for (let i = first - 1; i <= last + 1; i++) mount(i);
  for (const [i, img] of R.mounted) {
    if (i < first - 1 || i > last + 1) { img.remove(); R.mounted.delete(i); }
  }
  updateHud();
}

// ---------- page mode ----------

function showPage(n) {
  R.at = clamp(n, 0, R.ch.pages.length);
  clearPages();

  if (R.at < R.ch.pages.length) {
    // One image per turn. An image wider than it is tall is already a double-page
    // spread in the scan, so it simply fits to the screen like any other page.
    const img = new Image();
    img.decoding = 'async';
    img.alt = 'Page ' + (R.at + 1);
    img.src = pageUrl(R.ch.path, R.at);
    strip.appendChild(img);
    R.mounted.set(R.at, img);

    for (const i of [R.at + 1, R.at + 2]) {
      if (i < R.ch.pages.length) new Image().src = pageUrl(R.ch.path, i);
    }
  }

  fitPage();
  scroller.scrollTop = Math.max(0, (strip.offsetHeight - R.vh) / 2);
  scroller.scrollLeft = Math.max(0, (strip.offsetWidth - R.vw) / 2);
  setWidthReadout();
  updateHud();
}

// Resizes the page already on screen. Zooming must not rebuild the image: doing that
// threw away the decoded bitmap on every wheel notch, which is what made zoom stutter.
function fitPage() {
  measure();
  const past = R.at >= R.ch.pages.length;
  endCard.hidden = !past;

  if (past) {
    endCard.style.top = '0px';
    endCard.style.height = R.vh + 'px';
    strip.style.width = R.vw + 'px';
    strip.style.height = R.vh + 'px';
    return null;
  }

  const p = R.ch.pages[R.at];
  const scale = Math.min(R.vw / p.w, R.vh / p.h) * R.pct / 100;
  const w = Math.round(p.w * scale);
  const h = Math.round(p.h * scale);
  const cw = Math.max(R.vw, w);
  const chh = Math.max(R.vh, h);
  strip.style.width = cw + 'px';
  strip.style.height = chh + 'px';

  const left = Math.round((cw - w) / 2);
  const top = Math.round((chh - h) / 2);
  const img = R.mounted.get(R.at);
  if (img) {
    img.style.left = left + 'px';
    img.style.top = top + 'px';
    img.style.width = w + 'px';
    img.style.height = h + 'px';
  }
  scroller.style.cursor = (w > R.vw || h > R.vh) ? 'grab' : '';
  return { left, top, w, h };
}

// Zoom in page mode is for looking closer at one page, not a standing preference, so
// arriving at another page starts it fresh at fit-to-screen.
function goToPage(n) {
  R.pct = 100;
  showPage(n);
}

function turn(delta) {
  const want = R.at + delta;
  if (want > R.ch.pages.length) { if (R.ch.next) openChapter(R.ch.next); return; }
  if (want < 0) { if (R.ch.prev) openChapter(R.ch.prev); return; }
  goToPage(want);
}

// ---------- chrome ----------

function setWidthReadout() {
  widthInput.value = Math.round(R.pct);
  widthVal.value = Math.round(R.pct) + '%';
}

function updateHud() {
  const n = R.ch.pages.length;
  const page = currentPage();
  const f = isStrip()
    ? clamp(scroller.scrollTop / Math.max(1, R.total - R.vh), 0, 1)
    : clamp(R.at / Math.max(1, n), 0, 1);

  $('#pct').textContent = Math.round(f * 100) + '%';
  $('#pages').textContent = 'page ' + (page + 1) + ' of ' + n;

  const trackH = scrub.clientHeight;
  const visible = isStrip() ? R.vh / R.total : 1 / (n + 1);
  const thumbH = Math.max(4, Math.round(visible * trackH));
  const t = Math.round(f * (trackH - thumbH));
  thumb.style.top = t + 'px';
  thumb.style.height = thumbH + 'px';
  filled.style.height = (t + thumbH) + 'px';

  store.set(R.ch.path, {
    at: isStrip() ? scroller.scrollTop / Math.max(1, R.pagesTotal) : page / n,
    page,
    read: isStrip()
      ? clamp((scroller.scrollTop + R.vh) / Math.max(1, R.pagesTotal), 0, 1)
      : clamp((page + 1) / n, 0, 1)
  });

  if (f > 0.8) preloadNext();
}

function buildTicks(fractions) {
  ticks.innerHTML = '';
  if (fractions.length > 300) return;      // denser than this is a smear, not a scale
  const frag = document.createDocumentFragment();
  for (const f of fractions) {
    const i = document.createElement('i');
    i.style.top = (f * 100) + '%';
    frag.appendChild(i);
  }
  ticks.appendChild(frag);
}

function buildEndCard() {
  if (!endCard) {
    endCard = document.createElement('div');
    endCard.id = 'end';
    strip.appendChild(endCard);
  }
  endCard.innerHTML = '';
  const ch = R.ch;
  const label = document.createElement('strong');
  const b = document.createElement('button');
  b.type = 'button';
  if (ch.next) {
    label.textContent = 'End of ' + chapterLabel(ch.name, ch.folder);
    b.textContent = 'Read the next chapter';
    b.onclick = () => openChapter(ch.next);
  } else {
    label.textContent = 'That is the last chapter in this folder';
    b.textContent = 'Open another chapter';
    b.onclick = goBack;
  }
  endCard.append(label, b);
}

function preloadNext() {
  if (!R.ch.next || nextPreloaded === R.ch.next) return;
  nextPreloaded = R.ch.next;
  fetch('/api/chapter?path=' + encodeURIComponent(R.ch.next)).then(r => r.json()).then(ch => {
    if (!ch || ch.error) return;
    for (let i = 0; i < Math.min(2, ch.pages.length); i++) new Image().src = pageUrl(ch.path, i);
  }).catch(() => {});
}

// ---------- width / zoom ----------

function defaultWidth() { return isStrip() ? defaultStripWidth() : 100; }

function setWidth(pct, ax, ay) {
  // Kept as a fraction, not an integer. Rounding here swallowed the small deltas a
  // trackpad sends, so a slow pinch changed nothing at all.
  pct = clamp(pct, 25, 500);
  if (Math.abs(pct - R.pct) < 0.05) return;

  ax = ax == null ? R.vw / 2 : ax;
  ay = ay == null ? R.vh / 2 : ay;

  if (isStrip()) {
    const docY = scroller.scrollTop + ay;
    const i = indexAt(docY);
    const withinPage = (docY - R.offsets[i]) / Math.max(1, R.heights[i]);
    const centreX = (scroller.scrollLeft + R.vw / 2) / Math.max(1, R.colW);

    R.pct = pct;
    layout();
    store.set(widthKey(), Math.round(R.pct));   // a reading preference worth keeping

    scroller.scrollTop = R.offsets[i] + withinPage * R.heights[i] - ay;
    scroller.scrollLeft = centreX * R.colW - R.vw / 2;
    render();
  } else {
    // Hold whatever sits under the pointer still while the page grows around it.
    const img = R.mounted.get(R.at);
    const from = img && {
      fx: (scroller.scrollLeft + ax - parseFloat(img.style.left)) / parseFloat(img.style.width),
      fy: (scroller.scrollTop + ay - parseFloat(img.style.top)) / parseFloat(img.style.height)
    };

    R.pct = pct;
    const box = fitPage();
    if (from && box) {
      scroller.scrollLeft = box.left + from.fx * box.w - ax;
      scroller.scrollTop = box.top + from.fy * box.h - ay;
    }
    updateHud();
  }
  setWidthReadout();
}

// ---------- navigation ----------

function goBack() {
  if (R.ch) updateHud();
  reader.hidden = true;
  launch.hidden = false;
  clearPages();
  R.ch = null;
}

function scrollScreen(n) {
  // In page mode this only bites once the art is taller than the window; turning the
  // page is the arrows' job, not the scroll keys'.
  scroller.scrollBy({ top: n * R.vh * 0.85, behavior: 'smooth' });
}

// ---------- events ----------

scroller.addEventListener('scroll', () => { if (isStrip()) render(); }, { passive: true });

let resizeTimer;
function onViewportChange() {
  if (!R.ch) return;
  clearTimeout(resizeTimer);
  const here = currentPage();
  const f = isStrip() ? scroller.scrollTop / Math.max(1, R.pagesTotal) : 0;
  resizeTimer = setTimeout(() => {
    measure();
    if (isStrip()) { layout(); scroller.scrollTop = f * R.pagesTotal; render(); }
    else showPage(here);
  }, 140);
}
window.addEventListener('resize', onViewportChange);
// A collapsing browser toolbar changes the visible height without a window resize on iOS.
if (window.visualViewport) window.visualViewport.addEventListener('resize', onViewportChange);

scroller.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return;     // a trackpad pinch arrives as ctrl+wheel
  e.preventDefault();
  // A trackpad sends many small deltas, a mouse wheel one big one. Capping keeps a
  // single notch from slamming the width to its limit.
  setWidth(R.pct * Math.exp(-clamp(e.deltaY, -40, 40) * 0.0025), e.clientX, e.clientY);
}, { passive: false });

scroller.addEventListener('dblclick', () => setWidth(defaultWidth()));

let pan = null;
scroller.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'mouse' || e.target.closest('#end')) return;
  if (strip.offsetWidth <= R.vw + 1 && strip.offsetHeight <= R.vh + 1) return;
  pan = { x: e.clientX, y: e.clientY, left: scroller.scrollLeft, top: scroller.scrollTop, moved: false };
  scroller.style.cursor = 'grabbing';
});
window.addEventListener('pointermove', e => {
  if (!pan) return;
  pan.moved = true;
  scroller.scrollLeft = pan.left - (e.clientX - pan.x);
  scroller.scrollTop = pan.top - (e.clientY - pan.y);
});
window.addEventListener('pointerup', () => {
  if (!pan) return;
  const wasPanning = pan;
  pan = null;
  scroller.style.cursor = 'grab';
  setTimeout(() => { wasPanning.moved = false; }, 0);
});

// In page mode an unzoomed click turns the page: right edge goes on, left edge goes back.
scroller.addEventListener('click', e => {
  if (isStrip() || e.target.closest('#end') || (pan && pan.moved)) return;
  if (strip.offsetWidth > R.vw + 1 || strip.offsetHeight > R.vh + 1) return;
  const third = R.vw / 3;
  if (e.clientX > R.vw - third) turn(1);
  else if (e.clientX < third) turn(-1);
});

let pinch = null;
const spread = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
scroller.addEventListener('touchstart', e => {
  if (e.touches.length === 2) pinch = { d: spread(e.touches), pct: R.pct };
}, { passive: true });
scroller.addEventListener('touchmove', e => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  setWidth(pinch.pct * (spread(e.touches) / pinch.d),
    (e.touches[0].clientX + e.touches[1].clientX) / 2,
    (e.touches[0].clientY + e.touches[1].clientY) / 2);
}, { passive: false });
scroller.addEventListener('touchend', () => { pinch = null; });

let scrubbing = false;
function scrubTo(clientY) {
  const r = scrub.getBoundingClientRect();
  const f = clamp((clientY - r.top) / r.height, 0, 1);
  if (isStrip()) scroller.scrollTop = f * Math.max(0, R.total - R.vh);
  else goToPage(Math.round(f * R.ch.pages.length));
}
scrub.addEventListener('pointerdown', e => {
  scrubbing = true;
  scrubTo(e.clientY);                                    // jump first; capture is a nicety
  try { scrub.setPointerCapture(e.pointerId); } catch { /* pointer already released */ }
});
scrub.addEventListener('pointermove', e => { if (scrubbing) scrubTo(e.clientY); });
scrub.addEventListener('pointerup', () => { scrubbing = false; });

$('#back').onclick = goBack;
$('#mode').onclick = toggleMode;
$('#reset').onclick = () => setWidth(defaultWidth());
$('#zoomin').onclick = () => setWidth(R.pct + 10);
$('#zoomout').onclick = () => setWidth(R.pct - 10);
widthInput.oninput = () => setWidth(Number(widthInput.value));
$('#full').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();

function showFullscreenState() {
  const on = !!document.fullscreenElement;
  $('#full').textContent = on ? 'Leave fullscreen' : 'Fullscreen';
  $('#full').setAttribute('aria-pressed', String(on));
}
document.addEventListener('fullscreenchange', showFullscreenState);
showFullscreenState();
$('#prevch').onclick = () => R.ch.prev && openChapter(R.ch.prev);
$('#nextch').onclick = () => R.ch.next && openChapter(R.ch.next);

window.addEventListener('keydown', e => {
  if (reader.hidden || e.target.tagName === 'INPUT') return;
  const k = e.key;
  const hit = () => e.preventDefault();                   // getting around: chrome stays put
  const show = () => { e.preventDefault(); poke(); };      // changing a setting: show it

  const step = e.shiftKey ? -1 : 1;
  if (k === ' ') { hit(); isStrip() ? scrollScreen(step) : turn(step); }
  else if (k === 'ArrowDown' || k === 'j' || k === 'PageDown') { hit(); scrollScreen(1); }
  else if (k === 'ArrowUp' || k === 'k' || k === 'PageUp') { hit(); scrollScreen(-1); }
  else if (k === 'ArrowRight') { hit(); if (!isStrip()) turn(1); }
  else if (k === 'ArrowLeft') { hit(); if (!isStrip()) turn(-1); }
  else if (k === 'Home') { hit(); isStrip() ? scroller.scrollTo({ top: 0, behavior: 'smooth' }) : goToPage(0); }
  else if (k === 'End') { hit(); isStrip() ? scroller.scrollTo({ top: R.total, behavior: 'smooth' }) : goToPage(R.ch.pages.length); }
  else if (k === 'f') { show(); $('#full').click(); }
  else if (k === 'm') { show(); toggleMode(); }
  else if (k === 'Escape' && !document.fullscreenElement) { hit(); goBack(); }
  else if (k === '+' || k === '=') { show(); setWidth(R.pct + 10); }
  else if (k === '-') { show(); setWidth(R.pct - 10); }
  else if (k === '0') { show(); setWidth(defaultWidth()); }
  else if (k === '[') { show(); if (R.ch.prev) openChapter(R.ch.prev); }
  else if (k === ']') { show(); if (R.ch.next) openChapter(R.ch.next); }
});

const IDLE_MS = 1250;

let idleTimer;
function poke() {
  reader.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => !scrubbing && !pan && reader.classList.add('idle'), IDLE_MS);
}
// Controls answer the mouse. Scrolling is not a request to see them, so the wheel and a
// touch drag leave them alone; on touch a tap brings them back.
// Measured from where the pointer last asked for them, not from the previous event, so
// a slow drift still adds up while a jittery mouse sitting still never counts.
const MOUSE_SLOP = 4;
let mouseFrom = null;
reader.addEventListener('mousemove', e => {
  if (mouseFrom && Math.hypot(e.clientX - mouseFrom.x, e.clientY - mouseFrom.y) < MOUSE_SLOP) return;
  mouseFrom = { x: e.clientX, y: e.clientY };   // only moved far enough resets the mark
  poke();
}, { passive: true });

let tapFrom = null;
reader.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'mouse') tapFrom = { x: e.clientX, y: e.clientY };
}, { passive: true });
reader.addEventListener('pointerup', e => {
  if (e.pointerType === 'mouse' || !tapFrom) return;
  const moved = Math.hypot(e.clientX - tapFrom.x, e.clientY - tapFrom.y) >= 10;
  tapFrom = null;
  if (moved) return;                                       // that was a scroll
  if (!isStrip() && (e.clientX < R.vw / 3 || e.clientX > R.vw - R.vw / 3)) return;
  poke();
}, { passive: true });

// ---------- opening a chapter ----------

$('#pick').onclick = () => $('#file').click();
$('#file').onchange = e => { openFile(e.target.files[0]); e.target.value = ''; };

// The picker gives us bytes, not a location, so ask the server whether it recognises the
// file. Recognising it is what keeps previous and next working; if it does not, the
// chapter still opens, just without neighbours.
async function openFile(file) {
  if (!file || !file.name.toLowerCase().endsWith('.cbz')) return;
  const query = '?name=' + encodeURIComponent(file.name) + '&size=' + file.size;

  const found = await fetch('/api/locate' + query)
    .then(r => r.ok ? r.json() : null)
    .catch(() => null);
  if (found && found.path) return openChapter(found.path);

  const out = await fetch('/api/drop?name=' + encodeURIComponent(file.name),
                          { method: 'POST', body: file }).then(r => r.json());
  if (out.path) openChapter(out.path);
}

let dragDepth = 0;
window.addEventListener('dragenter', e => { e.preventDefault(); if (++dragDepth === 1) document.body.classList.add('dragging'); });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  openFile(e.dataTransfer.files[0]);
});
