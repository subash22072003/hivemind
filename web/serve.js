/**
 * Tiny zero-dependency static server for the HiveMind dashboard.
 * Forwards --port / --host CLI args (and PORT env) so preview hosts work:
 *
 *   npm run dev                    → http://localhost:3000
 *   npm run dev -- --port 7100     → http://localhost:7100
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
function argValue(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}
const port = Number(argValue('--port') || process.env.PORT || 3000);
const host = argValue('--host') || 'localhost';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

http
  .createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const file = path.join(__dirname, path.normalize(urlPath));
    if (!file.startsWith(__dirname)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  })
  .listen(port, host, () => console.log(`HiveMind dashboard → http://${host}:${port}`));
