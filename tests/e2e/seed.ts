/**
 * Browser-proof seed entry point.
 *
 * Runs as the first half of the Playwright `webServer` command, so the database is reset and
 * seeded before the server that will serve it starts. See `fixture.ts` for why the ordering
 * is explicit rather than left to Playwright's setup hooks.
 */

import { seedFixture } from './fixture.ts';

seedFixture();
console.log('e2e fixture seeded');
