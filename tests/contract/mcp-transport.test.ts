/**
 * MCP stdio transport — contract tests over a real client.
 *
 * What this defends: that the MCP server actually serves the module tools to a real client,
 * and that authorization survives the transport. Slice 2 shipped MCP adapters with
 * contract-level proof but no live client, so "MCP works" was untested by anything.
 *
 * These drive the SAME `@modelcontextprotocol/sdk` client an editor or agent would use, over
 * a real child process and a real stdio pipe.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildApp } from '../../src/spine/app.ts';
import { loadConfig } from '../../src/spine/config.ts';

const PASSWORD = 'mcp-test-password';
const SESSION_SECRET = 'mcp-test-secret';

let directory: string;
let databasePath: string;
let client: Client;
let acmeProjectId: string;
let globexProjectId: string;

/** Seed two customers so cross-tenant isolation is observable over the transport. */
function seed(): void {
  const app = buildApp(loadConfig({
    FL_DATABASE_PATH: databasePath,
    FL_OTLP_ENDPOINT: '',
    FL_SESSION_SECRET: SESSION_SECRET,
  }));

  for (const [customerName, email] of [['Acme', 'ana@acme.test'], ['Globex', 'gil@globex.test']]) {
    const customer = app.modules.customers.provisioning.provisionCustomer(customerName);
    app.modules.customers.provisioning.provisionUser(customer.id, email, PASSWORD);
    const actor = app.modules.customers.capability.login({ email, password: PASSWORD }).actor;
    const project = app.modules.projects.capability.createProject(actor, { name: `${customerName} Project` });
    if (customerName === 'Acme') acmeProjectId = project.id; else globexProjectId = project.id;
  }

  app.close();
}

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'foundation-lab-mcp-'));
  databasePath = join(directory, 'mcp.sqlite');
  seed();

  // The server runs as ana@acme.test for every call it will ever serve.
  client = new Client({ name: 'foundation-lab-test-client', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: 'node',
    args: ['src/spine/mcp-main.ts'],
    env: {
      ...process.env,
      FL_DATABASE_PATH: databasePath,
      FL_OTLP_ENDPOINT: '',
      FL_SESSION_SECRET: SESSION_SECRET,
      FL_MCP_EMAIL: 'ana@acme.test',
      FL_MCP_PASSWORD: PASSWORD,
    },
  }));
});

after(async () => {
  await client.close();
  rmSync(directory, { recursive: true, force: true });
});

/**
 * Tool results arrive as text; capability results are JSON.
 *
 * Typed loosely on purpose: the SDK's result type is a union that includes a legacy
 * `toolResult` shape, and narrowing it here would assert more about the SDK than the test
 * cares about.
 */
function parse(result: unknown): unknown {
  const [first] = (result as { content: { text: string }[] }).content;
  return JSON.parse(first.text);
}

/** The text of a tool result, for asserting on error messages. */
function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0].text;
}

describe('the server serves its tools to a real client', () => {
  test('lists every module tool with a schema', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    assert.deepEqual(names, [
      'create_project', 'create_release', 'get_customer', 'get_project', 'get_release',
      'list_projects', 'list_releases_for_project', 'list_users', 'set_release_status',
      'update_project',
    ]);

    for (const tool of tools) {
      assert.ok(tool.description, `${tool.name} has no description`);
      assert.equal((tool.inputSchema as { type: string }).type, 'object');
    }
  });

  test('exposes no login, provisioning, or admin tool over the transport', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      assert.ok(
        !/login|session|provision|password|admin|exec|shell|sql/i.test(tool.name),
        `${tool.name} should not be reachable over MCP`,
      );
    }
  });
});

describe('capabilities work over the transport', () => {
  test('a read returns the caller\'s real data', async () => {
    const projects = parse(await client.callTool({ name: 'list_projects', arguments: {} })) as { name: string }[];
    assert.deepEqual(projects.map((project) => project.name), ['Acme Project']);
  });

  test('a write persists and is visible to a subsequent read', async () => {
    const created = parse(await client.callTool({
      name: 'create_project',
      arguments: { name: 'Created Over MCP' },
    })) as { id: string; customerId: string };

    const fetched = parse(await client.callTool({
      name: 'get_project',
      arguments: { id: created.id },
    })) as { name: string };

    assert.equal(fetched.name, 'Created Over MCP');
  });

  test('a validation failure is reported as a tool error, not a crash', async () => {
    const result = await client.callTool({ name: 'create_project', arguments: { name: '' } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /could not be saved/i);
  });

  test('an unknown tool is refused', async () => {
    const result = await client.callTool({ name: 'drop_everything', arguments: {} });
    assert.equal(result.isError, true);
  });
});

describe('authorization survives the transport', () => {
  test('the server cannot read another tenant\'s project', async () => {
    // This is the property that would matter most if MCP bypassed the service layer.
    const result = await client.callTool({ name: 'get_project', arguments: { id: globexProjectId } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /No project exists/);
  });

  test('the server cannot see another tenant in a listing', async () => {
    const projects = parse(await client.callTool({ name: 'list_projects', arguments: {} })) as { name: string }[];
    assert.ok(!projects.some((project) => project.name === 'Globex Project'));
  });

  test('a client-supplied customerId cannot move ownership', async () => {
    const created = parse(await client.callTool({
      name: 'create_project',
      arguments: { name: 'Ownership Attempt', customerId: 'some-other-tenant' },
    })) as { customerId: string };

    const own = parse(await client.callTool({ name: 'get_project', arguments: { id: acmeProjectId } })) as { customerId: string };
    assert.equal(created.customerId, own.customerId);
  });

  test('the server cannot create a release against another tenant\'s project', async () => {
    const result = await client.callTool({
      name: 'create_release',
      arguments: {
        projectId: globexProjectId, version: '1.0.0', vcsRef: 'abc',
        artifactDigest: 'sha256:aa', environment: 'DEV',
      },
    });
    assert.equal(result.isError, true);
  });
});
