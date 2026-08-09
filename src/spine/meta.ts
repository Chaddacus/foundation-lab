/**
 * Deployment metadata endpoint.
 *
 * Responsibility: report which environment and which revision is actually serving the
 * request.
 *
 * Place in the system: spine. This is deployment identity, not a business capability, so it
 * belongs to application-wide coordination and is attributed to the `spine` module on its
 * span.
 *
 * Why it exists: the UI shows an environment badge and a release reference. Hardcoding
 * either would make the interface lie the moment the same build runs in DEV or SANDBOX.
 * Release identity is also what joins a screenshot or a bug report to a revision (SPEC §8).
 *
 * Boundary: PUBLIC-within-deployment values only — environment, version, revision digest.
 * No configuration values, no paths, no secret references.
 */

import type { Config } from './config.ts';
import type { Route } from './http.ts';

export interface DeploymentMeta {
  readonly environment: string;
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly vcsRef: string;
  readonly artifactDigest: string;
}

export function metaRoutes(config: Config): readonly Route[] {
  return [
    {
      method: 'GET',
      pattern: '/api/meta',
      module: 'spine',
      operation: 'getDeploymentMeta',
      handler: (): DeploymentMeta => ({
        environment: config.environment,
        serviceName: config.serviceName,
        serviceVersion: config.serviceVersion,
        vcsRef: config.vcsRef,
        artifactDigest: config.artifactDigest,
      }),
    },
  ];
}
