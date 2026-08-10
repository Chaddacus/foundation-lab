/**
 * Customers — HTTP/REST adapter.
 *
 * Responsibility: expose login, logout, and customer/user reads over HTTP, and translate a
 * `SessionGrant` into a `Set-Cookie` header.
 *
 * Place in the system: an adapter at the edge of the Customers module. It holds no
 * business logic and makes no authorization decision — the service does both.
 *
 * Boundary: the session id is written to a cookie and NEVER into a response body. A body
 * is reachable from scripts and ends up in logs, proxies, and screenshots; an HttpOnly
 * cookie is not.
 */

import type { Route } from '../../../spine/http.ts';
import { buildClearedSessionCookie, buildSessionCookie, signSessionId } from '../../../spine/session.ts';
import type { Config } from '../../../spine/config.ts';
import type { CustomersCapability, LoginInput } from '../contract.ts';

const MODULE = 'customers';

export function customersRoutes(customers: CustomersCapability, config: Config): readonly Route[] {
  return [
    {
      method: 'POST',
      pattern: '/api/session',
      module: MODULE,
      operation: 'login',
      // One of three public routes (login, sign-out, session probe). It is the only one
      // that accepts a credential, which is the property that actually matters.
      public: true,
      audit: true,
      successStatus: 201,
      handler: async ({ body, setCookie }) => {
        const grant = await customers.login(body as LoginInput);
        setCookie(buildSessionCookie(
          signSessionId(grant.sessionId, config.sessionSecret),
          grant.expiresAt,
          config,
        ));
        // Returns the actor, not the session id.
        return {
          userId: grant.actor.id,
          customerId: grant.actor.customerId,
          email: grant.email,
          expiresAt: grant.expiresAt,
        };
      },
    },
    {
      method: 'DELETE',
      pattern: '/api/session',
      module: MODULE,
      operation: 'logout',
      // Public so signing out with an already-expired session still clears the cookie
      // rather than returning 401 and leaving a dead cookie in the browser.
      public: true,
      audit: true,
      handler: ({ sessionId, setCookie }) => {
        if (sessionId !== null) customers.logout(sessionId);
        setCookie(buildClearedSessionCookie(config));
        return { signedOut: true };
      },
    },
    {
      method: 'GET',
      pattern: '/api/session',
      module: MODULE,
      operation: 'getCurrentSession',
      /**
       * Public, and answers honestly for an anonymous caller.
       *
       * "Am I signed in?" is a question a signed-out page legitimately asks, so answering
       * 401 would make the application generate an error for its own normal startup. It
       * discloses nothing: the caller already knows whether it holds a session.
       */
      public: true,
      handler: ({ actor }) => {
        if (actor.customerId === '') return { authenticated: false };
        // The caller's own record only — resolved through the capability, which is scoped.
        const self = customers.listUsers(actor).find((user) => user.id === actor.id);
        return {
          authenticated: true,
          userId: actor.id,
          customerId: actor.customerId,
          email: self?.email ?? '',
        };
      },
    },
    {
      method: 'GET',
      pattern: '/api/customers/:id',
      module: MODULE,
      operation: 'getCustomer',
      handler: ({ actor, params }) => customers.getCustomer(actor, params.id),
    },
    {
      method: 'GET',
      pattern: '/api/users',
      module: MODULE,
      operation: 'listUsers',
      handler: ({ actor }) => customers.listUsers(actor),
    },
  ];
}
