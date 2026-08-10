/**
 * Releases — HTTP/REST adapter.
 *
 * Responsibility: expose the Releases capability over HTTP.
 *
 * Place in the system: an adapter at the edge of the Releases module. No business logic and
 * no authorization decision — both live in the service, which the MCP adapter also calls.
 */

import type { Route } from '../../../spine/http.ts';
import type { CreateReleaseInput, ReleaseStatus, ReleasesCapability } from '../contract.ts';

const MODULE = 'releases';

export function releasesRoutes(releases: ReleasesCapability): readonly Route[] {
  return [
    {
      method: 'GET',
      pattern: '/api/projects/:projectId/releases',
      module: MODULE,
      operation: 'listReleasesForProject',
      handler: ({ actor, params }) => releases.listReleasesForProject(actor, params.projectId),
    },
    {
      method: 'POST',
      pattern: '/api/releases',
      module: MODULE,
      operation: 'createRelease',
      successStatus: 201,
      handler: ({ actor, body }) => releases.createRelease(actor, body as CreateReleaseInput),
    },
    {
      method: 'GET',
      pattern: '/api/releases/:id',
      module: MODULE,
      operation: 'getRelease',
      handler: ({ actor, params }) => releases.getRelease(actor, params.id),
    },
    {
      method: 'PATCH',
      pattern: '/api/releases/:id',
      module: MODULE,
      operation: 'setReleaseStatus',
      handler: ({ actor, params, body }) =>
        releases.setReleaseStatus(actor, params.id, (body as { status: ReleaseStatus })?.status),
    },
  ];
}
