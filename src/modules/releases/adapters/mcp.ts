/**
 * Releases — MCP adapter.
 *
 * Responsibility: expose the Releases capability as bounded MCP tools.
 *
 * Place in the system: an adapter at the edge of the Releases module, peer to the HTTP
 * adapter, calling the same service instance.
 *
 * Boundary: `set_release_status` is a WRITE that records what is running in an environment.
 * It is bounded — it can only move a release along the lifecycle the domain permits, and it
 * cannot deploy anything, touch another tenant, or reach a protected environment. Standard 9
 * forbids exposing arbitrary admin capability through a tool, and this is deliberately the
 * narrow version.
 */

import type { Actor } from '../../../spine/actor.ts';
import { AppError } from '../../../spine/errors.ts';
import type { McpTool } from '../../projects/adapters/mcp.ts';
import type { CreateReleaseInput, ReleaseStatus, ReleasesCapability } from '../contract.ts';

export const releasesTools: readonly McpTool[] = [
  {
    name: 'list_releases_for_project',
    description: 'List the releases of one project the caller can see.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Project id.' } },
      required: ['projectId'],
      additionalProperties: false,
    },
    sideEffect: 'read',
  },
  {
    name: 'get_release',
    description: 'Fetch one release by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Release id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    sideEffect: 'read',
  },
  {
    name: 'create_release',
    description: 'Record a release candidate for a project, in pending status.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string' },
        version: { type: 'string', description: 'Release version, for example 1.4.0.' },
        vcsRef: { type: 'string', description: 'Source revision the candidate was built from.' },
        artifactDigest: { type: 'string', description: 'Immutable artifact digest.' },
        environment: { type: 'string', enum: ['DEV', 'SANDBOX'] },
      },
      required: ['projectId', 'version', 'vcsRef', 'artifactDigest', 'environment'],
      additionalProperties: false,
    },
    sideEffect: 'write',
  },
  {
    name: 'set_release_status',
    description: 'Advance a release along its lifecycle. Invalid transitions are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['pending', 'deployed', 'verified', 'rolled_back'] },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    },
    sideEffect: 'write',
  },
];

export function dispatchReleasesTool(
  releases: ReleasesCapability,
  actor: Actor,
  toolName: string,
  args: Record<string, unknown> = {},
): unknown {
  switch (toolName) {
    case 'list_releases_for_project':
      return releases.listReleasesForProject(actor, args.projectId as string);

    case 'get_release':
      return releases.getRelease(actor, args.id as string);

    case 'create_release':
      return releases.createRelease(actor, args as unknown as CreateReleaseInput);

    case 'set_release_status':
      return releases.setReleaseStatus(actor, args.id as string, args.status as ReleaseStatus);

    default:
      throw AppError.validation(`Unknown tool "${toolName}".`);
  }
}
