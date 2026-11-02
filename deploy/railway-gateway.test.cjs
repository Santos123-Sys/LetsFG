'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createServer, isAuthorized } = require('./railway-gateway.cjs');

const TOKEN = 's'.repeat(40);
let server, base;

before(async () => {
  server = createServer({ token: TOKEN, entry: path.join(__dirname, 'fixture-stdio.cjs') });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

function post(payload, auth = TOKEN, headers = {}) {
  return fetch(base + '/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: 'Bearer ' + auth } : {}), ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

test('constant-time token comparison validates exact bearer only', () => {
  assert.equal(isAuthorized('Bearer ' + TOKEN, TOKEN), true);
  assert.equal(isAuthorized('Bearer ' + TOKEN + 'x', TOKEN), false);
  assert.equal(isAuthorized('Basic ' + TOKEN, TOKEN), false);
  assert.equal(isAuthorized(undefined, TOKEN), false);
  assert.throws(() => createServer({ token: 'short' }));
});

test('public health returns no secrets', async () => {
  const r = await fetch(base + '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: 'ok', service: 'letsfg-readonly-mcp' });
});

test('MCP denies missing or wrong auth', async () => {
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, null)).status, 401);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'invalid')).status, 401);
});

test('initialized notification accepted without producing a JSON-RPC response', async () => {
  const r = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(r.status, 202);
});

test('initialize works over HTTP transport', async () => {
  const r = await post({ jsonrpc: '2.0', id: 'a', method: 'initialize', params: {} });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.id, 'a');
  assert.equal(data.result.serverInfo.name, 'fixture');
});

test('tools/list removes book_flight', async () => {
  const r = await post({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
  assert.equal(r.status, 200);
  assert.deepEqual((await r.json()).result.tools.map(t => t.name), ['search_flights']);
});

test('book_flight is refused before any child process receives it', async () => {
  const r = await post({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'book_flight' } });
  const payload = await r.json();
  assert.equal(payload.error.code, -32601);
  assert.match(payload.error.message, /read-only/);
});

test('search_flights is permitted', async () => {
  const r = await post({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'search_flights', arguments: {} } });
  assert.equal((await r.json()).result.content[0].text, 'fixture-result');
});

test('malformed JSON, disallowed method and content type are rejected', async () => {
  assert.equal((await post('{broken json')).status, 400);
  const r = await post({ jsonrpc: '2.0', id: 10, method: 'payments/charge' });
  assert.equal((await r.json()).error.code, -32601);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, TOKEN, { 'Content-Type': 'text/plain' })).status, 415);
});
