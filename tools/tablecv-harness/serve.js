// Tiny static server for the TableCV browser harness.
// Root is the repo; requests to /vendor/* are aliased to public/vendor/* so the
// modules' production-absolute asset paths resolve while /data/* photos are also
// served. .gz is served as octet-stream (no Content-Encoding) so tesseract
// gunzips the .traineddata itself.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || '.');
const PORT = parseInt(process.argv[3] || '8123', 10);

const TYPES = {
  '.html': 'text/html;charset=utf-8', '.js': 'text/javascript;charset=utf-8',
  '.json': 'application/json', '.wasm': 'application/wasm', '.gz': 'application/octet-stream',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.css': 'text/css',
};

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  // Alias the modules' absolute /vendor/* paths to public/vendor/*.
  if (p.startsWith('/vendor/')) p = '/public' + p;
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(f, (e, st) => {
    if (e || !st.isFile()) { res.writeHead(404); return res.end('not found: ' + p); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
}).listen(PORT, '127.0.0.1', () => console.log('serve ' + ROOT + ' :' + PORT));
