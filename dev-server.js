// Local dev server for testing ONLY. Serves the static site and mounts the
// Vercel API handler at /api/* WITHOUT calling the real LipaWin gateway.
//
//   npm run dev            -> http://localhost:3000
//
// TEST_MODE is enabled here locally so payments can be simulated.
// LIVE PRODUCTION IS UNAFFECTED: TEST_MODE is never set in the deployed API.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetch as apiHandler } from './api/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);

// Load .env.local / .env into process.env (simple key=value parser)
for (const file of ['.env.local', '.env']) {
  const p = path.join(__dirname, file);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// LOCAL ONLY: enable simulate mode so no real M-Pesa is needed.
if (!process.env.TEST_MODE) process.env.TEST_MODE = '1';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (url.pathname.startsWith('/api/')) {
      const body = (req.method === 'GET' || req.method === 'HEAD') ? undefined : await readBody(req);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) v.forEach(x => headers.append(k, x));
        else headers.set(k, String(v));
      }
      const webReq = new Request(url.href, { method: req.method, headers, body });
      const webRes = await apiHandler(webReq);
      const text = await webRes.text();
      const outHeaders = Object.fromEntries(webRes.headers.entries());
      res.writeHead(webRes.status, outHeaders);
      res.end(text);
      return;
    }

    // Static files
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    if (p === '/admin') p = '/admin.html';
    const file = path.normalize(path.join(PUBLIC_DIR, p));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) {
      return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
    }
    send(res, 200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }, fs.readFileSync(file));
  } catch (e) {
    console.error('Dev server error:', e);
    send(res, 500, { 'Content-Type': 'text/plain' }, 'Server error: ' + e.message);
  }
});

server.listen(PORT, () => {
  console.log(`\n  Madfun dev server running: http://localhost:${PORT}`);
  console.log(`  Admin: http://localhost:${PORT}/admin`);
  console.log('  TEST_MODE is ON locally - use the "Simulate Payment" button to test.\n');
});