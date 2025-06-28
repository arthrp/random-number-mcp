import express from "express";
import { randomUUID } from "node:crypto";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
/**
 * Build a fresh MCP server instance exposing a single `random-number` tool.
 * The tool returns a random number (0–N) each time it is called.
 */
function createRandomNumberServer() {
    const server = new McpServer({
        name: "random-server",
        version: "1.0.0",
    });
    server.registerTool("random-number", {
        title: "Random Number",
        description: "Return a random floating-point number between 0 and a given maximum.",
        inputSchema: {
            max: z.number().int().describe("The upper bound for the random number."),
        },
    }, async ({ max }) => ({
        content: [
            {
                type: "text",
                text: String(Math.random() * max),
            },
        ],
    }));
    return server;
}
const app = express();
app.use(express.json());
// Store active transports keyed by session ID so we can route follow-up
// HTTP requests from the same client to the correct transport.
const transports = new Map();
app.post("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    let transport;
    if (sessionId && transports.has(sessionId)) {
        // Existing session – reuse its transport
        transport = transports.get(sessionId);
    }
    else if (!sessionId && isInitializeRequest(req.body)) {
        // New session starting
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => transports.set(id, transport),
            // For local development you may want to enable DNS-rebinding protection.
            // enableDnsRebindingProtection: true,
            // allowedHosts: ["127.0.0.1"],
        });
        // Build a dedicated MCP server for this client and connect it.
        const server = createRandomNumberServer();
        await server.connect(transport);
        // Clean up when the transport closes (client terminated session)
        transport.onclose = () => {
            if (transport.sessionId) {
                transports.delete(transport.sessionId);
            }
            server.close?.();
        };
    }
    else {
        // The request didn't include a valid session identifier nor did it start
        // with an initialization payload – reject it.
        res.status(400).json({
            jsonrpc: "2.0",
            error: {
                code: -32000,
                message: "Bad Request: No valid session ID provided",
            },
            id: null,
        });
        return;
    }
    // Delegate handling of the JSON-RPC payload to the transport.
    await transport.handleRequest(req, res, req.body);
});
// Handle GET requests (server-sent notifications) and DELETE (end session)
const handleSessionRequest = async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    if (!sessionId || !transports.has(sessionId)) {
        res.status(400).send("Invalid or missing session ID");
        return;
    }
    const transport = transports.get(sessionId);
    await transport.handleRequest(req, res);
};
app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MCP Random Number server listening on http://localhost:${PORT}/mcp`);
});
