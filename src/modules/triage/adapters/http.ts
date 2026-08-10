/**
 * Incident Triage — HTTP adapter.
 *
 * Responsibility: expose the triage capability over HTTP.
 *
 * The route is a POST because it spends real model capacity and is therefore not a safe,
 * cacheable read — a GET that costs money and can be prefetched would be a mistake. It
 * still mutates nothing.
 */

import type { Route } from '../../../spine/http.ts';
import type { TriageCapability } from '../contract.ts';

const MODULE = 'triage';

export function triageRoutes(triage: TriageCapability): readonly Route[] {
  return [
    {
      method: 'POST',
      pattern: '/api/incidents/:id/triage',
      module: MODULE,
      operation: 'assessIncident',
      handler: async ({ actor, params }) => await triage.assessIncident(actor, params.id),
    },
  ];
}
