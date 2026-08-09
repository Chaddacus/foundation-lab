/**
 * Projects — MCP adapter.
 *
 * Responsibility: expose the Projects capability as bounded MCP tools — schemas plus a
 * dispatcher that maps a tool call onto the contract.
 *
 * Place in the system: an adapter at the edge of the Projects module, peer to the HTTP
 * adapter. It calls the SAME `ProjectsCapability` instance. If this file ever grows a rule
 * the HTTP path does not have, SPEC §3.3 has been violated and `tests/contract` fails.
 *
 * Boundary: bounded business capabilities only — no shell, no SQL, no admin surface
 * (Standard 9). Authorization is enforced by the application at execution time through the
 * actor argument, never by tool description text.
 *
 * SLICE 1 SCOPE: this file defines the tools and the dispatcher. The stdio transport that
 * serves them to an MCP client is not built yet, so these tools have contract-level proof
 * (`tests/contract/projects-parity.test.ts`) but no live-client proof. See SPEC §10.
 */

import type { Actor } from '../../../spine/actor.ts';
import { AppError } from '../../../spine/errors.ts';
import type {
  CreateProjectInput,
  ProjectsCapability,
  UpdateProjectInput,
} from '../contract.ts';

export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** Side-effect class, declared per Standard 9. `read` tools MUST NOT mutate state. */
  readonly sideEffect: 'read' | 'write';
}

export const projectsTools: readonly McpTool[] = [
  {
    name: 'list_projects',
    description: 'List the projects visible to the calling actor.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    sideEffect: 'read',
  },
  {
    name: 'get_project',
    description: 'Fetch one project by its id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Project id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    sideEffect: 'read',
  },
  {
    name: 'create_project',
    description: 'Create a project owned by a customer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name.' },
        description: { type: 'string', description: 'Optional project description.' },
        customerId: { type: 'string', description: 'Id of the owning customer.' },
      },
      required: ['name', 'customerId'],
      additionalProperties: false,
    },
    sideEffect: 'write',
  },
  {
    name: 'update_project',
    description: 'Change a project name or description. Omitted fields are left unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Project id.' },
        name: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    sideEffect: 'write',
  },
];

/**
 * Execute one tool call against the capability.
 *
 * An unknown tool name raises `validation` rather than returning a soft failure, so a
 * client typo is a visible error instead of a silent no-op.
 */
export function dispatchProjectsTool(
  projects: ProjectsCapability,
  actor: Actor,
  toolName: string,
  args: Record<string, unknown> = {},
): unknown {
  switch (toolName) {
    case 'list_projects':
      return projects.listProjects(actor);

    case 'get_project':
      return projects.getProject(actor, requireStringArg(args, 'id'));

    case 'create_project':
      return projects.createProject(actor, args as unknown as CreateProjectInput);

    case 'update_project': {
      const { id, ...changes } = args;
      return projects.updateProject(
        actor,
        requireStringArg(args, 'id'),
        changes as unknown as UpdateProjectInput,
      );
    }

    default:
      throw AppError.validation(`Unknown tool "${toolName}".`);
  }
}

/**
 * Read a required string argument.
 *
 * Schema validity is not semantic correctness (Standard 9): the tool schema is advisory
 * until a client honours it, so the dispatcher checks the argument itself.
 */
function requireStringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw AppError.validation(`Tool argument "${name}" is required and must be a non-empty string.`);
  }
  return value;
}
