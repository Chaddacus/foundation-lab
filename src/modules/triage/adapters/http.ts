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
      handler: async ({ actor, params }) => {
        const outcome = await triage.assessIncident(actor, params.id);
        if (outcome.status === 'assessed') return outcome;

        // `detail` names the schema rule that rejected the answer. It is a diagnostic for
        // logs and evals, and it was previously serialized to every API client — which made
        // the "internal only" claim on it false. Stripped here so the claim is true.
        const { detail, ...clientSafe } = outcome;
        return clientSafe;
      },
    },
  ];
}
