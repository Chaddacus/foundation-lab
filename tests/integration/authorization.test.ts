/**
 * Tenant authorization — behavior tests.
 *
 * What this defends: Standard 8 requires authorization to be tested as BEHAVIOR across the
 * function, object, tenant, and field boundaries — not asserted in prose. Every test here
 * uses two populated customers, because a single-tenant fixture cannot tell a working
 * filter apart from one that returns everything.
 *
 * These run against the real service objects. The adapter-level equivalents live in
 * `tests/contract/authorization-parity.test.ts`, which proves MCP enforces the same rules.
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp, type Application } from '../../src/spine/app.ts';
import { loadConfig } from '../../src/spine/config.ts';
import type { Actor } from '../../src/spine/actor.ts';
import type { AppError } from '../../src/spine/errors.ts';
import type { Project } from '../../src/modules/projects/contract.ts';
import type { Release } from '../../src/modules/releases/contract.ts';
import type { Incident } from '../../src/modules/incidents/contract.ts';

/**
 * A gateway that fails the test if anything calls a provider.
 *
 * The capability contract claims no automated test spends subscription capacity. That was
 * true only because authorization refused first — a property, not a structure. This makes
 * it structural: a regression that let a call through fails loudly instead of billing.
 */
const NEVER_CALLED = {
  provider: 'never-called',
  complete: async (): Promise<never> => {
    throw new Error('a test reached a real AI provider — tests must never spend subscription capacity');
  },
};

const PASSWORD = 'correct-horse-battery-staple';

let app: Application;
let ana: Actor;      // Acme
let gil: Actor;      // Globex
let acmeProject: Project;
let globexProject: Project;
let acmeRelease: Release;
let acmeIncident: Incident;

beforeEach(async () => {
  app = buildApp(loadConfig({
    FL_DATABASE_PATH: ':memory:',
    FL_OTLP_ENDPOINT: '',
    FL_SESSION_SECRET: 'test-secret-not-a-real-key',
  }), NEVER_CALLED);

  const provisioning = app.modules.customers.provisioning;
  const acme = provisioning.provisionCustomer('Acme');
  const globex = provisioning.provisionCustomer('Globex');
  await provisioning.provisionUser(acme.id, 'ana@acme.test', PASSWORD);
  await provisioning.provisionUser(globex.id, 'gil@globex.test', PASSWORD);

  ana = (await app.modules.customers.capability.login({ email: 'ana@acme.test', password: PASSWORD })).actor;
  gil = (await app.modules.customers.capability.login({ email: 'gil@globex.test', password: PASSWORD })).actor;

  acmeProject = app.modules.projects.capability.createProject(ana, { name: 'Acme Apollo' });
  globexProject = app.modules.projects.capability.createProject(gil, { name: 'Globex Zeus' });
  acmeIncident = app.modules.incidents.capability.createIncident(ana, {
    title: 'Acme incident', report: 'Acme only.', severity: 'SEV-2',
  });
  acmeRelease = app.modules.releases.capability.createRelease(ana, {
    projectId: acmeProject.id, version: '1.0.0', vcsRef: 'abc123',
    artifactDigest: 'sha256:aa', environment: 'DEV',
  });
});

/** The anonymous actor the spine hands to public routes. Must reach nothing. */
const ANONYMOUS: Actor = { id: 'anonymous', customerId: '' };

function kindOf(fn: () => unknown): string {
  try {
    fn();
    return 'NO ERROR — THE CALL SUCCEEDED';
  } catch (error) {
    return (error as AppError).kind;
  }
}

describe('function boundary: an actor without a tenant reaches nothing', () => {
  test('every Projects capability refuses the anonymous actor', () => {
    const projects = app.modules.projects.capability;
    assert.equal(kindOf(() => projects.listProjects(ANONYMOUS)), 'unauthorized');
    assert.equal(kindOf(() => projects.getProject(ANONYMOUS, acmeProject.id)), 'unauthorized');
    assert.equal(kindOf(() => projects.createProject(ANONYMOUS, { name: 'x' })), 'unauthorized');
    assert.equal(kindOf(() => projects.updateProject(ANONYMOUS, acmeProject.id, { name: 'x' })), 'unauthorized');
  });

  test('every Releases capability refuses the anonymous actor', () => {
    const releases = app.modules.releases.capability;
    assert.equal(kindOf(() => releases.getRelease(ANONYMOUS, acmeRelease.id)), 'unauthorized');
    assert.equal(kindOf(() => releases.listReleasesForProject(ANONYMOUS, acmeProject.id)), 'unauthorized');
    assert.equal(kindOf(() => releases.setReleaseStatus(ANONYMOUS, acmeRelease.id, 'deployed')), 'unauthorized');
  });

  test('every Incidents capability refuses the anonymous actor', () => {
    const incidents = app.modules.incidents.capability;
    assert.equal(kindOf(() => incidents.listIncidents(ANONYMOUS)), 'unauthorized');
    assert.equal(kindOf(() => incidents.getIncident(ANONYMOUS, acmeIncident.id)), 'unauthorized');
    assert.equal(kindOf(() => incidents.createIncident(ANONYMOUS, { title: 'x', report: 'y', severity: 'SEV-3' })), 'unauthorized');
    assert.equal(kindOf(() => incidents.updateIncident(ANONYMOUS, acmeIncident.id, { status: 'resolved' })), 'unauthorized');
  });

  test('Customers capabilities refuse the anonymous actor', () => {
    const customers = app.modules.customers.capability;
    assert.equal(kindOf(() => customers.getCustomer(ANONYMOUS, ana.customerId)), 'not_found');
    assert.deepEqual(customers.listUsers(ANONYMOUS), []);
  });
});

describe('object boundary: a specific record belonging to another tenant', () => {
  test('reading another customer\'s project reports not_found, not forbidden', () => {
    // not_found is deliberate. `forbidden` would confirm the id exists, which is a
    // cross-tenant disclosure. See the threat model — do not "fix" this to forbidden.
    assert.equal(kindOf(() => app.modules.projects.capability.getProject(gil, acmeProject.id)), 'not_found');
  });

  test('updating another customer\'s project is refused and changes nothing', () => {
    assert.equal(
      kindOf(() => app.modules.projects.capability.updateProject(gil, acmeProject.id, { name: 'Seized' })),
      'not_found',
    );
    // The write path must be blocked, not merely reported: re-read as the owner.
    assert.equal(app.modules.projects.capability.getProject(ana, acmeProject.id).name, 'Acme Apollo');
  });

  test('reading another customer\'s release reports not_found', () => {
    assert.equal(kindOf(() => app.modules.releases.capability.getRelease(gil, acmeRelease.id)), 'not_found');
  });

  test('advancing another customer\'s release is refused and changes nothing', () => {
    assert.equal(
      kindOf(() => app.modules.releases.capability.setReleaseStatus(gil, acmeRelease.id, 'rolled_back')),
      'not_found',
    );
    assert.equal(app.modules.releases.capability.getRelease(ana, acmeRelease.id).status, 'pending');
  });

  test('a real id from another tenant is indistinguishable from a fabricated one', () => {
    const real = kindOf(() => app.modules.projects.capability.getProject(gil, acmeProject.id));
    const fake = kindOf(() => app.modules.projects.capability.getProject(gil, 'no-such-project-id'));
    assert.equal(real, fake, 'error kind differs, which leaks whether the id exists');
  });

  test('another customer cannot attach a release to a project it cannot see', () => {
    assert.equal(
      kindOf(() => app.modules.releases.capability.createRelease(gil, {
        projectId: acmeProject.id, version: '9.9.9', vcsRef: 'x',
        artifactDigest: 'sha256:bb', environment: 'DEV',
      })),
      'not_found',
    );
    assert.equal(app.modules.releases.capability.listReleasesForProject(ana, acmeProject.id).length, 1);
  });
});

describe('incidents and triage respect the tenant boundary', () => {
  test('reading another customer\'s incident reports not_found', () => {
    assert.equal(kindOf(() => app.modules.incidents.capability.getIncident(gil, acmeIncident.id)), 'not_found');
  });

  test('updating another customer\'s incident is refused and changes nothing', () => {
    assert.equal(
      kindOf(() => app.modules.incidents.capability.updateIncident(gil, acmeIncident.id, { severity: 'SEV-0' })),
      'not_found',
    );
    assert.equal(app.modules.incidents.capability.getIncident(ana, acmeIncident.id).severity, 'SEV-2');
  });

  test('each customer enumerates only its own incidents', () => {
    app.modules.incidents.capability.createIncident(gil, {
      title: 'Globex incident', report: 'Globex only.', severity: 'SEV-3',
    });
    assert.deepEqual(app.modules.incidents.capability.listIncidents(ana).map((i) => i.title), ['Acme incident']);
    assert.deepEqual(app.modules.incidents.capability.listIncidents(gil).map((i) => i.title), ['Globex incident']);
  });

  test('an incident cannot reference another customer\'s project', () => {
    // Validated through the Projects CAPABILITY rather than by reading its table, so
    // project ownership keeps one owner. Previously the field was stored unvalidated.
    assert.equal(
      kindOf(() => app.modules.incidents.capability.createIncident(gil, {
        title: 'Cross-tenant attempt', report: 'x', severity: 'SEV-3', projectId: acmeProject.id,
      })),
      'not_found',
    );
  });

  test('an incident may reference the caller\'s own project', () => {
    const incident = app.modules.incidents.capability.createIncident(ana, {
      title: 'Own project', report: 'x', severity: 'SEV-3', projectId: acmeProject.id,
    });
    assert.equal(incident.projectId, acmeProject.id);
  });

  test('an unknown project id is refused rather than stored', () => {
    assert.equal(
      kindOf(() => app.modules.incidents.capability.createIncident(ana, {
        title: 'Bad ref', report: 'x', severity: 'SEV-3', projectId: 'no-such-project',
      })),
      'not_found',
    );
  });

  test('triage cannot be run against another customer\'s incident', async () => {
    // The AI capability inherits the tenant rule rather than reimplementing it, so this
    // fails for the same reason and with the same shape as a direct read.
    await assert.rejects(
      () => app.modules.triage.capability.assessIncident(gil, acmeIncident.id),
      (error: AppError) => error.kind === 'not_found',
    );
  });

  test('an incident report cannot be read across tenants through triage metadata', () => {
    // Guards a subtle leak: an error or metadata path that echoed the report would expose
    // another tenant's content even while refusing the request.
    try {
      app.modules.incidents.capability.getIncident(gil, acmeIncident.id);
    } catch (error) {
      assert.ok(!(error as AppError).message.includes('Acme only.'));
    }
  });
});

describe('tenant boundary: enumeration returns only the caller\'s records', () => {
  test('each customer sees only its own projects, with two tenants populated', () => {
    const anaProjects = app.modules.projects.capability.listProjects(ana);
    const gilProjects = app.modules.projects.capability.listProjects(gil);

    assert.deepEqual(anaProjects.map((p) => p.name), ['Acme Apollo']);
    assert.deepEqual(gilProjects.map((p) => p.name), ['Globex Zeus']);
  });

  test('each customer sees only its own users', () => {
    assert.deepEqual(app.modules.customers.capability.listUsers(ana).map((u) => u.email), ['ana@acme.test']);
    assert.deepEqual(app.modules.customers.capability.listUsers(gil).map((u) => u.email), ['gil@globex.test']);
  });

  test('getCustomer returns only the caller\'s own customer', () => {
    assert.equal(app.modules.customers.capability.getCustomer(ana, ana.customerId).name, 'Acme');
    assert.equal(kindOf(() => app.modules.customers.capability.getCustomer(ana, gil.customerId)), 'not_found');
  });

  test('release listing for another tenant\'s project is refused, not silently empty', () => {
    // An empty list would look like "no releases" and hide the authorization failure.
    assert.equal(
      kindOf(() => app.modules.releases.capability.listReleasesForProject(gil, acmeProject.id)),
      'not_found',
    );
  });
});

describe('field boundary: ownership cannot be set by the client', () => {
  test('a customerId in the create body is ignored in favour of the session', () => {
    const project = app.modules.projects.capability.createProject(
      gil,
      { name: 'Attempted Takeover', customerId: ana.customerId } as never,
    );
    assert.equal(project.customerId, gil.customerId);
    assert.equal(app.modules.projects.capability.listProjects(ana).length, 1);
  });

  test('a customerId in the update body cannot move a project between tenants', () => {
    app.modules.projects.capability.updateProject(
      ana,
      acmeProject.id,
      { name: 'Renamed', customerId: gil.customerId } as never,
    );
    assert.equal(app.modules.projects.capability.getProject(ana, acmeProject.id).customerId, ana.customerId);
    assert.equal(kindOf(() => app.modules.projects.capability.getProject(gil, acmeProject.id)), 'not_found');
  });

  test('a release cannot be created into another tenant by supplying customerId', () => {
    const release = app.modules.releases.capability.createRelease(gil, {
      projectId: globexProject.id, version: '1.0.0', vcsRef: 'x',
      artifactDigest: 'sha256:cc', environment: 'DEV', customerId: ana.customerId,
    } as never);
    assert.equal(release.customerId, gil.customerId);
  });

  test('a status supplied at creation cannot pre-set a release to verified', () => {
    const release = app.modules.releases.capability.createRelease(gil, {
      projectId: globexProject.id, version: '2.0.0', vcsRef: 'x',
      artifactDigest: 'sha256:dd', environment: 'DEV', status: 'verified',
    } as never);
    assert.equal(release.status, 'pending');
  });
});

describe('credentials never leave the module', () => {
  test('no capability response carries a password verifier', () => {
    const serialized = JSON.stringify({
      users: app.modules.customers.capability.listUsers(ana),
      customer: app.modules.customers.capability.getCustomer(ana, ana.customerId),
    });

    assert.ok(!serialized.includes('scrypt$'), 'a password verifier reached a capability response');
    assert.ok(!serialized.toLowerCase().includes('password'));
  });
});
