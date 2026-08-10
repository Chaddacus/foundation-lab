/**
 * Incidents — MCP adapter.
 *
 * Responsibility: expose the Incidents capability as bounded MCP tools, calling the same
 * service as HTTP.
 *
 * Boundary: `update_incident` is a write, but a narrow one — it can only set severity,
 * status, or the Case reference on an incident the caller already owns. It cannot delete,
 * cannot reassign tenancy, and cannot reopen a resolved incident (the domain refuses).
 */

import type { Actor } from '../../../spine/actor.ts';
import { AppError } from '../../../spine/errors.ts';
import type { McpTool } from '../../projects/adapters/mcp.ts';
import type { CreateIncidentInput, IncidentsCapability, UpdateIncidentInput } from '../contract.ts';

export const incidentsTools: readonly McpTool[] = [
  {
    name: 'list_incidents',
    description: "List the operational incidents belonging to the caller's customer.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    sideEffect: 'read',
  },
  {
    name: 'get_incident',
    description: 'Fetch one incident by id, including its report and Elastic Case reference.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Incident id.' } },
      required: ['id'], additionalProperties: false,
    },
    sideEffect: 'read',
  },
  {
    name: 'create_incident',
    description: 'Record a new operational incident.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        report: { type: 'string', description: 'What is happening, in free text.' },
        severity: { type: 'string', enum: ['SEV-0', 'SEV-1', 'SEV-2', 'SEV-3'] },
        caseRef: { type: 'string', description: 'Elastic Case id, if one exists.' },
        projectId: { type: 'string', description: 'Project this incident concerns, if any.' },
      },
      required: ['title', 'report', 'severity'], additionalProperties: false,
    },
    sideEffect: 'write',
  },
  {
    name: 'update_incident',
    description: 'Change an incident severity, status, or Case reference.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        severity: { type: 'string', enum: ['SEV-0', 'SEV-1', 'SEV-2', 'SEV-3'] },
        status: { type: 'string', enum: ['open', 'mitigated', 'resolved'] },
        caseRef: { type: 'string' },
      },
      required: ['id'], additionalProperties: false,
    },
    sideEffect: 'write',
  },
];

export function dispatchIncidentsTool(
  incidents: IncidentsCapability,
  actor: Actor,
  toolName: string,
  args: Record<string, unknown> = {},
): unknown {
  switch (toolName) {
    case 'list_incidents':
      return incidents.listIncidents(actor);
    case 'get_incident':
      return incidents.getIncident(actor, args.id as string);
    case 'create_incident':
      return incidents.createIncident(actor, args as unknown as CreateIncidentInput);
    case 'update_incident': {
      const { id, ...changes } = args;
      return incidents.updateIncident(actor, id as string, changes as unknown as UpdateIncidentInput);
    }
    default:
      throw AppError.validation(`Unknown tool "${toolName}".`);
  }
}
