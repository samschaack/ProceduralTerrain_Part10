/**
 * Development server with Cross-Origin-Isolation headers
 * Required for SharedArrayBuffer support
 *
 * Usage: node server.js [port]
 * Default port: 8080
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || 8000;

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

const server = http.createServer((req, res) => {
  // Parse URL and get pathname
  let pathname = req.url.split('?')[0];

  // Default to index.html
  if (pathname === '/') {
    pathname = '/index.html';
  }

  const filePath = path.join(__dirname, pathname);
  const ext = path.extname(filePath).toLowerCase();

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('500 Internal Server Error');
      }
      return;
    }

    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Set Cross-Origin Isolation headers for SharedArrayBuffer support
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      // Allow loading resources from CDNs
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });

    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  Cross-Origin Isolated Development Server                       ║
╠══════════════════════════════════════════════════════════════════╣
║  Server running at: http://localhost:${PORT}                       ║
║                                                                  ║
║  SharedArrayBuffer: ENABLED                                      ║
║  crossOriginIsolated: true                                       ║
║                                                                  ║
║  Headers:                                                        ║
║    Cross-Origin-Opener-Policy: same-origin                       ║
║    Cross-Origin-Embedder-Policy: require-corp                    ║
╚══════════════════════════════════════════════════════════════════╝
  `);
});
