'use strict';

/**
 * Stateless, read-only HTTP transport for the repository's stdio MCP server.
 * Each JSON-RPC request runs in an isolated child process. Booking, payment,
 * account changes, and arbitrary MCP methods are denied at the gateway.
 *
 * Clients authenticate to this gateway with Authorization: Bearer <token>.
 * The upstream LetsFG credential is a separate server-side variable.
 */
const http = require('node:http');
const { spawn } = require('node:child_process');
const { timingSafeEqual } = require('node:crypto');
const path = require('node:path');

const SAFE_TOOLS = new Set([
  'search_flights', 'resolve_location', 'resolve_hotel_city',
  'search_hotels', 'authenticate', 'load_resources',
]);
const SAFE_METHODS = new Set([
  'initialize', 'ping', 'tools/list', 'tools/call',
  'resources/list', 'resources/read',
]);
const MAX_BODY = 128 * 1024;
const MAX_RESULT = 10 * 1024 * 1024;
const TIMEOUT_MS = 230000;

function isAuthorized(header, token) {
  if (!token || typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function json(res, status, value) {
  const data = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function invokeStdio(message, entry) {
  return new Promise((resolve, reject) => {
    let done = false;
    let buffer = '';
    const child = spawn(process.execPath, [entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const finish = (err, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!child.killed) child.kill('SIGTERM');
      if (err) reject(err);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('MCP request timed out')), TIMEOUT_MS);
    child.on('error', () => finish(new Error('MCP process could not start')));
    child.on('close', () => finish(new Error('MCP process exited before responding')));
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_RESULT) return finish(new Error('MCP response exceeded size limit'));
      const pos = buffer.indexOf('\n');
      if (pos < 0) return;
      try {
        const msg = JSON.parse(buffer.slice(0, pos));
        if (msg.id !== message.id) return finish(new Error('MCP response ID mismatch'));
        finish(null, msg);
      } catch {
        finish(new Error('Invalid MCP response'));
      }
    });
    // Never log stderr; upstream may include data from an authenticated request.
    child.stderr.resume();
    child.stdin.end(JSON.stringify(message) + '\n');
  });
}

function createServer({ token, entry = path.join(__dirname, 'mcp', 'index.js') }) {
  if (!token || token.length < 32) throw new Error('LETSFG_GATEWAY_TOKEN must be at least 32 characters');
  let active = 0;
  return http.createServer(async (req, res) => {
    const urlPath = (req.url || '').split('?')[0];
    if (req.method === 'GET' && urlPath === '/health') {
      return json(res, 200, { status: 'ok', service: 'letsfg-readonly-mcp' });
    }
    if (urlPath !== '/mcp') return json(res, 404, { error: 'not_found' });
    if (!isAuthorized(req.headers.authorization, token)) {
      return json(res, 401, { error: 'unauthorized' });
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return json(res, 405, { error: 'method_not_allowed' });
    }
    if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      return json(res, 415, { error: 'application_json_required' });
    }
    if (active >= 4) return json(res, 429, { error: 'concurrency_limit' });
    active++;
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk.toString('utf8');
        if (Buffer.byteLength(body) > MAX_BODY) {
          return json(res, 413, { error: 'request_too_large' });
        }
      }
      let msg;
      try { msg = JSON.parse(body); } catch {
        return json(res, 400, rpcError(null, -32700, 'Parse error'));
      }
      if (!msg || Array.isArray(msg) || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
        return json(res, 400, rpcError(null, -32600, 'Invalid request'));
      }
      if (msg.method === 'notifications/initialized') {
        res.writeHead(202, { 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (msg.id === undefined || !SAFE_METHODS.has(msg.method)) {
        return json(res, 400, rpcError(msg.id, -32601, 'Method not available'));
      }
      if (msg.method === 'tools/call' && !SAFE_TOOLS.has(msg.params?.name)) {
        return json(res, 200, rpcError(msg.id, -32601, 'Tool disabled: read-only deployment'));
      }
      const result = await invokeStdio(msg, entry);
      if (msg.method === 'tools/list' && Array.isArray(result.result?.tools)) {
        result.result.tools = result.result.tools.filter((tool) => SAFE_TOOLS.has(tool.name));
      }
      return json(res, 200, result);
    } catch {
      return json(res, 502, rpcError(null, -32603, 'MCP backend unavailable'));
    } finally {
      active--;
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const host = '0.0.0.0';
  const server = createServer({ token: process.env.LETSFG_GATEWAY_TOKEN });
  server.listen(port, host, () => {
    process.stdout.write('LetsFG read-only MCP HTTP gateway listening\n');
  });
}

module.exports = { createServer, isAuthorized, SAFE_TOOLS };
