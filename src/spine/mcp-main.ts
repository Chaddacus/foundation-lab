/**
 * MCP server bootstrap.
 *
 * Responsibility: serve the application's capability modules to an MCP client over stdio.
 *
 * Place in the system: spine, and a peer of `main.ts`. Both are process entry points over
 * the SAME module contracts — this file adds no capability and duplicates no business
 * logic (SPEC §3.3). If a rule is missing here, it is missing everywhere.
 *
 * AUTHORITY MODEL — the part that matters:
 * - The server authenticates ONCE at startup with a real credential and acts as exactly
 *   that user for every tool call. It cannot become another user and cannot escalate.
 * - Every tool call goes through the same service-layer authorization as HTTP, so tenant
 *   isolation is inherited rather than reimplemented. Authorization is enforced by the
 *   application at execution time, never by a tool description (Standard 9).
 * - No provisioning, login, or admin tool is exposed. The tool surface is exactly the
 *   bounded business capabilities the modules declare.
 *
 * It refuses to start without a credential rather than falling back to an anonymous or
 * privileged identity — an MCP server that starts without knowing who it is would be an
 * unauthenticated hole in an otherwise authenticated application.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.ts';
import { buildApp } from './app.ts';
import { isAppError, type AppError } from './errors.ts';
import type { Actor } from './actor.ts';

const config = loadConfig();
const app = buildApp(config);

const email = process.env.FL_MCP_EMAIL ?? '';
const password = process.env.FL_MCP_PASSWORD ?? '';

if (email === '' || password === '') {
  // stderr, not stdout: stdout is the JSON-RPC channel and any stray byte corrupts it.
  console.error(
    'Refusing to start: FL_MCP_EMAIL and FL_MCP_PASSWORD are required. ' +
    'The MCP server acts as one authenticated user and will not run anonymously.',
  );
  process.exit(1);
}

let actor: Actor;
try {
  actor = app.modules.customers.capability.login({ email, password }).actor;
} catch {
  // Deliberately does not echo the email or say which part failed — the same reticence the
  // HTTP login has, for the same reason.
  console.error('Refusing to start: the supplied Foundation Lab credential was not accepted.');
  process.exit(1);
}

/** Tool name to the module that owns it. Built once so dispatch cannot guess. */
const OWNERS = new Map<string, (toolName: string, args?: Record<string, unknown>) => unknown>();
for (const module_ of [app.modules.customers, app.modules.projects, app.modules.releases]) {
  for (const tool of module_.tools) {
    if (OWNERS.has(tool.name)) {
      console.error(`Refusing to start: duplicate tool name "${tool.name}".`);
      process.exit(1);
    }
    OWNERS.set(tool.name, (toolName, args) => module_.callTool(actor, toolName, args));
  }
}

const server = new Server(
  { name: config.serviceName, version: config.serviceVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [...app.modules.customers.tools, ...app.modules.projects.tools, ...app.modules.releases.tools]
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
}));

server.setRequestHandler(CallToolRequestSchema, (request) => {
  const dispatch = OWNERS.get(request.params.name);
  if (dispatch === undefined) {
    return { isError: true, content: [{ type: 'text' as const, text: `Unknown tool "${request.params.name}".` }] };
  }

  try {
    const result = dispatch(request.params.name, request.params.arguments as Record<string, unknown>);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    // An application error carries a user-safe message. Anything else is withheld, exactly
    // as the HTTP boundary withholds it — a tool result must not leak internal detail.
    const message = isAppError(error)
      ? (error as AppError).message
      : 'Something went wrong on our side.';
    return { isError: true, content: [{ type: 'text' as const, text: message }] };
  }
});

async function shutdown(): Promise<void> {
  app.close();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await server.connect(new StdioServerTransport());
console.error(`foundation-lab MCP server ready as ${email} (${OWNERS.size} tools).`);
