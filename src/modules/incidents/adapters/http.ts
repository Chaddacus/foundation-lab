/**
 * Incidents — HTTP/REST adapter.
 *
 * Responsibility: expose the Incidents capability over HTTP. No business logic, no
 * authorization decision — both live in the service, which the MCP adapter also calls.
 */

import type { Route } from '../../../spine/http.ts';
import type { CreateIncidentInput, IncidentsCapability, UpdateIncidentInput } from '../contract.ts';

const MODULE = 'incidents';

export function incidentsRoutes(incidents: IncidentsCapability): readonly Route[] {
  return [
    {
      method: 'GET', pattern: '/api/incidents', module: MODULE, operation: 'listIncidents',
      handler: ({ actor }) => incidents.listIncidents(actor),
    },
    {
      method: 'POST', pattern: '/api/incidents', module: MODULE, operation: 'createIncident',
      successStatus: 201,
      handler: ({ actor, body }) => incidents.createIncident(actor, body as CreateIncidentInput),
    },
    {
      method: 'GET', pattern: '/api/incidents/:id', module: MODULE, operation: 'getIncident',
      handler: ({ actor, params }) => incidents.getIncident(actor, params.id),
    },
    {
      method: 'PATCH', pattern: '/api/incidents/:id', module: MODULE, operation: 'updateIncident',
      handler: ({ actor, params, body }) => incidents.updateIncident(actor, params.id, body as UpdateIncidentInput),
    },
  ];
}
