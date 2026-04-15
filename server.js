// Local dev server — serves static files + proxies gamma API
const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = 3000;
const DIR  = __dirname;

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

const server = http.createServer((req, res) => {
  // ── Gamma proxy (/netlify/functions/gamma?slug=...) ──────────────────────
  if (req.url.startsWith('/.netlify/functions/gamma')) {
    const slug = new URL(req.url, 'http://localhost').searchParams.get('slug');
    if (!slug) { res.writeHead(400); res.end('missing slug'); return; }

    const options = {
      hostname: 'gamma-api.polymarket.com',
      path: `/events?slug=${encodeURIComponent(slug)}`,
      headers: { 'User-Agent': 'curl/7.88', 'Accept': 'application/json' },
    };

    https.get(options, (upstream) => {
      let body = '';
      upstream.on('data', d => body += d);
      upstream.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(body);
      });
    }).on('error', e => {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    });
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────────
  let filePath = path.join(DIR, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // fallback to index.html
      fs.readFile(path.join(DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}`);
});
