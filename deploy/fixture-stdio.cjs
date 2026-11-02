'use strict';
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  const methods = {
    initialize: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } },
    'tools/list': { tools: [
      { name: 'search_flights', inputSchema: { type: 'object' } },
      { name: 'book_flight', inputSchema: { type: 'object' } },
    ] },
    'tools/call': { content: [{ type: 'text', text: 'fixture-result' }] },
    ping: {},
  };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: methods[msg.method] || {} }) + '\n');
});
