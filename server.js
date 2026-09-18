'use strict';
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const cbz = require('./lib/cbz');
const { size } = require('./lib/imgsize');

const PORT = Number(process.env.PORT) || 4173;
const START_DIR = path.resolve(process.argv[2] || path.join(__dirname, '..'));
let lastDir = START_DIR;      // the dialog reopens where you last opened something
const DROPPED = path.join(os.tmpdir(), 'strip-dropped');

// Scrolling a chapter fires one request per page; keeping a few archives open avoids
// re-reading the central directory every time.
const openZips = new Map();
function useZip(file) {
  let z = openZips.get(file);
  if (!z) {
    const zip = cbz.open(file);
    z = { zip, pages: cbz.pages(zip) };
    openZips.set(file, z);
    while (openZips.size > 4) {
      const [k, v] = openZips.entries().next().value;
      openZips.delete(k);
      cbz.close(v.zip);
    }
  }
  return z;
}

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function isChapter(p) {
  try {
    return typeof p === 'string' && p.toLowerCase().endsWith('.cbz') && fs.statSync(p).isFile();
  } catch { return false; }
}

function chapter(file) {
  const z = useZip(file);
  const pages = z.pages.map(e => size(cbz.read(z.zip, e, 32768)) || { w: 800, h: 1200 });

  // Chapters live as numbered files beside each other, so the folder is the reading order.
  const dir = path.dirname(file);
  const siblings = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.cbz')).sort(natural);
  const at = siblings.indexOf(path.basename(file));

  return {
    path: file,
    name: path.basename(file, path.extname(file)),
    folder: path.basename(dir),
    number: at + 1,
    of: siblings.length,
    prev: at > 0 ? path.join(dir, siblings[at - 1]) : null,
    next: at >= 0 && at < siblings.length - 1 ? path.join(dir, siblings[at + 1]) : null,
    pages
  };
}

function locate(name, size) {
  if (!name || !size) return null;
  const hits = [];
  (function walk(dir) {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (it.name.startsWith('.')) continue;
      const full = path.join(dir, it.name);
      if (it.isDirectory()) walk(full);
      else if (it.name === name) {
        try { if (fs.statSync(full).size === size) hits.push(full); } catch { /* gone */ }
      }
    }
  })(START_DIR);
  if (hits.length < 2) return hits[0] || null;
  // The same name at the same byte count in two places: prefer where we were last.
  return hits.find(h => path.dirname(h) === lastDir) || hits[0];
}

const MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

function json(res, body, code = 200) {
  const b = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length });
  res.end(b);
}

function body(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = url.searchParams.get('path');

  try {
    // The browser's picker hands back bytes with no location. Name plus exact byte count
    // identifies the file in the collection well enough to recover its folder, which is
    // what previous and next need. No match simply means it came from somewhere else.
    if (url.pathname === '/api/locate') {
      const found = locate(path.basename(url.searchParams.get('name') || ''),
                           Number(url.searchParams.get('size')));
      return found ? json(res, { path: found }) : json(res, { error: 'not in the library' }, 404);
    }

    if (url.pathname === '/api/chapter') {
      if (!isChapter(file)) return json(res, { error: 'not a .cbz file' }, 404);
      lastDir = path.dirname(file);
      return json(res, chapter(file));
    }

    if (url.pathname === '/api/page') {
      if (!isChapter(file)) return json(res, { error: 'not a .cbz file' }, 404);
      const z = useZip(file);
      const entry = z.pages[Number(url.searchParams.get('n'))];
      if (!entry) return json(res, { error: 'no such page' }, 404);
      const buf = cbz.read(z.zip, entry);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(entry.name).toLowerCase()] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'private, max-age=600'
      });
      return res.end(buf);
    }

    // A dropped file arrives as bytes with its name but no location, so it lands in temp.
    if (url.pathname === '/api/drop' && req.method === 'POST') {
      const name = path.basename(url.searchParams.get('name') || '');
      if (!name.toLowerCase().endsWith('.cbz')) return json(res, { error: 'not a .cbz file' }, 400);
      fs.mkdirSync(DROPPED, { recursive: true });
      const dest = path.join(DROPPED, name);
      fs.writeFileSync(dest, await body(req));
      openZips.delete(dest);
      return json(res, { path: dest });
    }

    const asset = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
    const local = path.join(__dirname, 'public', asset);
    if (fs.existsSync(local) && fs.statSync(local).isFile()) {
      const buf = fs.readFileSync(local);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(asset)] || 'text/plain', 'Content-Length': buf.length });
      return res.end(buf);
    }
    json(res, { error: 'not found' }, 404);
  } catch (err) {
    json(res, { error: String(err && err.message || err) }, 500);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Manga Reader is reading from ' + START_DIR);
  console.log('Open http://localhost:' + PORT);
});
