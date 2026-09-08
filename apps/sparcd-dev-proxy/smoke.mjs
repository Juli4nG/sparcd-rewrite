import assert from 'node:assert/strict';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { createProxyConfig } from './vite.config.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const host = '127.0.0.1';

async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function startApp(relativeRoot) {
  const root = fileURLToPath(new URL(relativeRoot, import.meta.url));
  const port = await freePort();
  const server = await createServer({
    root,
    server: { host, port, strictPort: true },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert(address && typeof address !== 'string');
  return { server, origin: `http://${host}:${address.port}` };
}

// Sends a raw WebSocket upgrade request through the proxy and returns the HTTP
// status code from the first response line (101 = upgrade accepted).
// Using a raw TCP socket avoids Node.js HTTP-client quirks around the upgrade event.
function wsUpgradeStatus(origin, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    const socket = netConnect(Number(url.port), url.hostname);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`WS upgrade timeout: ${path}`));
    }, 5000);
    socket.once('connect', () => {
      socket.write(
        `GET ${url.pathname} HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        `Connection: Upgrade\r\n` +
        `Upgrade: websocket\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n` +
        `Sec-WebSocket-Protocol: vite-hmr\r\n` +
        `\r\n`,
      );
    });
    socket.once('data', (chunk) => {
      clearTimeout(timer);
      socket.destroy();
      const status = parseInt(chunk.toString().split(' ')[1], 10);
      resolve(status);
    });
    socket.once('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

let uploader;
let tagger;
let proxy;

try {
  uploader = await startApp('../sparcd-uploader/');
  tagger = await startApp('../sparcd-tagger/');
  const proxyPort = await freePort();
  const proxyConfig = createProxyConfig({
    targets: { uploader: uploader.origin, tagger: tagger.origin },
    port: proxyPort,
  });
  proxy = await createServer({
    ...proxyConfig,
    configFile: false,
    root: here,
    server: {
      ...proxyConfig.server,
      host,
    },
  });
  await proxy.listen();
  const address = proxy.httpServer?.address();
  assert(address && typeof address !== 'string');
  const origin = `http://${host}:${address.port}`;
  const uploaderUrl = new URL('/sparcd-exploration/uploader/', origin);
  const taggerUrl = new URL('/sparcd-exploration/tagger/', origin);

  assert.equal(uploaderUrl.origin, taggerUrl.origin);
  const [uploaderResponse, taggerResponse, uploaderClient, taggerClient] = await Promise.all([
    fetch(uploaderUrl),
    fetch(taggerUrl),
    fetch(new URL('/sparcd-exploration/uploader/@vite/client', origin)),
    fetch(new URL('/sparcd-exploration/tagger/@vite/client', origin)),
  ]);
  assert.equal(uploaderResponse.status, 200);
  assert.equal(taggerResponse.status, 200);
  assert.equal(uploaderClient.status, 200);
  assert.equal(taggerClient.status, 200);

  const [uploaderHtml, taggerHtml] = await Promise.all([
    uploaderResponse.text(),
    taggerResponse.text(),
  ]);
  assert.match(uploaderHtml, /\/sparcd-exploration\/uploader\/@vite\/client/);
  assert.match(taggerHtml, /\/sparcd-exploration\/tagger\/@vite\/client/);

  const [uploaderWs, taggerWs] = await Promise.all([
    wsUpgradeStatus(origin, '/sparcd-exploration/uploader/'),
    wsUpgradeStatus(origin, '/sparcd-exploration/tagger/'),
  ]);
  assert.equal(uploaderWs, 101, `uploader WS upgrade: expected 101, got ${uploaderWs}`);
  assert.equal(taggerWs, 101, `tagger WS upgrade: expected 101, got ${taggerWs}`);

  console.log(`same-origin proxy smoke passed at ${origin} (HTTP + WS)`);
} finally {
  await Promise.allSettled([
    proxy?.close(),
    uploader?.server.close(),
    tagger?.server.close(),
  ]);
}
