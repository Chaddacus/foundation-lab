/**
 * Projects — HTTP/REST adapter.
 *
 * Responsibility: expose the Projects capability over HTTP by declaring routes and
 * translating between request shape and contract arguments.
 *
 * Place in the system: an adapter at the edge of the Projects module. It holds NO business
 * logic — every route delegates to `ProjectsCapability`. The MCP adapter delegates to the
 * same object, which is how API and MCP stay behaviourally identical (SPEC §3.3).
 *
 * Boundary: no validation, no persistence, no error mapping. The domain validates, the
 * spine's error boundary maps.
 */

import type { Route } from '../../../spine/http.ts';
import type {
  CreateProjectInput,
  ProjectsCapability,
  UpdateProjectInput,
} from '../contract.ts';

const MODULE = 'projects';

/** Declare the module's routes. The spine composes them into the application route table. */
export function projectsRoutes(projects: ProjectsCapability): readonly Route[] {
  return [
    {
      method: 'GET',
      pattern: '/api/projects',
      module: MODULE,
      operation: 'listProjects',
      handler: ({ actor }) => projects.listProjects(actor),
    },
    {
      method: 'POST',
      pattern: '/api/projects',
      module: MODULE,
      operation: 'createProject',
      successStatus: 201,
      handler: ({ actor, body }) => projects.createProject(actor, body as CreateProjectInput),
    },
    {
      method: 'GET',
      pattern: '/api/projects/:id',
      module: MODULE,
      operation: 'getProject',
      handler: ({ actor, params }) => projects.getProject(actor, params.id),
    },
    {
      method: 'PATCH',
      pattern: '/api/projects/:id',
      module: MODULE,
      operation: 'updateProject',
      handler: ({ actor, params, body }) =>
        projects.updateProject(actor, params.id, body as UpdateProjectInput),
    },
    {
      // POST, not DELETE: archiving is a state transition, not a deletion, and the record
      // survives. A DELETE would tell every client the wrong thing about what happened.
      method: 'POST',
      pattern: '/api/projects/:id/archive',
      module: MODULE,
      operation: 'archiveProject',
      handler: ({ actor, params }) => projects.archiveProject(actor, params.id),
    },
  ];
}
