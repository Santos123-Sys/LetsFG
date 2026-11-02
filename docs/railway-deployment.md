# Railway deployment: LetsFG read-only MCP gateway

This deployment exposes the repository's **local stdio MCP client** as a private-token-protected, stateless HTTP endpoint. It is **not** a self-host of LetsFG's search and booking backend; searches still run at letsfg.co.

## Security model

- A unique, high-entropy \`LETSFG_GATEWAY_TOKEN\` is **required** at startup. Requests to \`POST /mcp\` must supply \`Authorization: Bearer <gateway-token>\`.
- \`GET /health\` is public and only confirms that the HTTP gateway is running; it does not verify authorization to letsfg.co or working search inventory.
- Only these tools are exposed: \`search_flights\`, \`resolve_location\`, \`resolve_hotel_city\`, \`search_hotels\`, \`authenticate\`, \`load_resources\`.
- All booking, cancellation, payment, account/profile access, and other MCP methods are blocked **before** the stdio child process is invoked. No live transaction or paid action is supported.
- Four concurrent requests maximum, 128 KiB request bodies, 10 MiB response limit, 230-second upstream timeout.
- The full LetsFG infrastructure is a third-party dependency. A successful healthcheck does not establish upstream health or live-search accuracy.

## Railway

1. Create a **new Railway project** dedicated to the connector, separate from other apps.
2. Create an empty service called \`letsfg-readonly-mcp\`.
3. Set Dockerfile path to \`Dockerfile.railway\`, the healthcheck path to \`/health\`, and \`PORT=3000\`.
4. Set \`LETSFG_GATEWAY_TOKEN\` to a generated 32+ character random string.
5. Connect the GitHub repo to the tested deployment branch or a reviewed commit SHA.
6. Once the build and healthcheck pass, create a Railway service domain (no need for a custom DNS name).
7. For actual searches, supply **one** upstream credential: \`LETSFG_BEARER_TOKEN\` (obtained after you approve the LetsFG hosted consent flow) or \`LETSFG_API_KEY\` (a separate paid developer product). Do not provision a paid account automatically.
8. Revalidate authentication regularly: the upstream bearer token may expire; this server does not implement OAuth token refresh.

## HTTP smoke tests

\`\`\`bash
curl -i https://YOUR-SERVICE.up.railway.app/health

curl -i https://YOUR-SERVICE.up.railway.app/mcp \
  -H "Authorization: Bearer $LETSFG_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
\`\`\`

Validate that \`book_flight\`, \`book_hotel\`, and \`cancel_hotel_booking\` do not appear in \`tools/list\`, and that direct \`tools/call\` attempts to invoke them return the read-only rejection. Verify successful live search only after the upstream credential has been supplied.

## Limitations

This is a **stateless HTTP JSON-RPC adapter**; it supports one request per call, JSON responses, and an initialization notification, not SSE streaming or resumable MCP sessions. OAuth client auto-enrollment is **not** implemented. Clients that require an OAuth 2.1-capable remote MCP endpoint should connect directly to the official \`https://letsfg.co/mcp\` instead.

Do not expose booking or traveler data through this bridge without a separate, reviewed authorization design, human transaction approval workflow, and security assessment.
