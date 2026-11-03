const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { Writable } = require('node:stream');
const zlib = require('node:zlib');
const bodyParser = require('body-parser');

// Library-only loopback fixture; the shipped UniDeX MCP server is not this HTTP server.
async function main() {
  const trailer = Buffer.alloc(4096, 0x5a);
  const first = Buffer.concat([zlib.gzipSync('{"kind":"dummy"}'), Buffer.from([0])]);
  const parse = bodyParser.json();
  let pending;
  const server = http.createServer((req, res) => {
    let rawBytes = 0;
    const raw = new Writable({ write(chunk, encoding, done) { rawBytes += chunk.length; done(); } });
    req.pipe(raw);
    parse(req, res, (err) => {
      if (err) {
        res.statusCode = err.status || 500;
        res.end(JSON.stringify({ rejected: true }));
        return;
      }
      if (req.url === '/trailing') {
        raw.once('finish', () => res.end(JSON.stringify({ body: req.body, rawBytes })));
        // Event-gated: the decoder has finished before the remaining HTTP bytes arrive.
        pending.end(trailer);
      } else {
        res.end(JSON.stringify({ body: req.body }));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  function post(data, encoding, delayed = false) {
    return new Promise((resolve, reject) => {
      const headers = { 'content-type': 'application/json', 'content-length': data.length + (delayed ? trailer.length : 0) };
      if (encoding) headers['content-encoding'] = encoding;
      const request = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: delayed ? '/trailing' : '/', method: 'POST', agent: false, headers }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('error', reject);
        response.on('end', () => {
          try { resolve({ status: response.statusCode, body: JSON.parse(text) }); }
          catch (err) { reject(err); }
        });
      });
      request.on('error', reject);
      request.setTimeout(2000, () => request.destroy(new Error('bounded parser fixture timed out')));
      if (delayed) { pending = request; request.write(data); }
      else request.end(data);
    });
  }
  try {
    const decoded = await post(first, 'gzip', true);
    assert.equal(decoded.status, 200);
    assert.deepEqual(decoded.body.body, { kind: 'dummy' });
    assert.equal(decoded.body.rawBytes, first.length + trailer.length);
    const invalid = await post(Buffer.from([0, 1, 2]), 'deflate');
    assert.equal(invalid.status, 400);
    const after = await post(Buffer.from('{"after":"alive"}'));
    assert.equal(after.status, 200);
    assert.deepEqual(after.body.body, { after: 'alive' });
    process.stdout.write(JSON.stringify({ decoded: decoded.body.body, rejectedStatus: invalid.status,
      after: after.body.body, rawConsumerComplete: true }) + '\n');
  } finally {
    pending?.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
