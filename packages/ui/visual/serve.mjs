// Minimal static server for the Storybook build (dist/storybook) (no dependencies, so it runs inside the Playwright image).
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../dist/storybook/', import.meta.url));
const port = Number(process.argv[2] ?? 6007);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

createServer((req, res) => {
  let path;
  try {
    path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = join(root, path);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (statSync(file).isDirectory()) file = join(file, 'index.html');
    statSync(file);
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1');
