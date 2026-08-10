/**
 * Incident Triage — module registration. The spine imports THIS file only.
 *
 * Deliberately exposes NO MCP tool. An MCP client that could invoke triage could spend the
 * subscription budget this capability is metered against, and the tool surface is supposed
 * to be bounded business capability rather than a way to run up a bill. If it is ever
 * exposed, it needs its own budget authority — recorded here so the omission reads as a
 * decision rather than an oversight.
 */

import type { Route } from '../../spine/http.ts';
import type { AiGateway } from '../../spine/ai-gateway.ts';
import type { IncidentsCapability } from '../incidents/contract.ts';
import type { TriageCapability } from './contract.ts';
import { TriageService, type ModuleNameSource } from './service.ts';
import { triageRoutes } from './adapters/http.ts';

export interface TriageModule {
  readonly name: 'triage';
  readonly capability: TriageCapability;
  readonly routes: readonly Route[];
}

export function createTriageModule(
  incidents: IncidentsCapability,
  gateway: AiGateway,
  moduleNames: ModuleNameSource,
): TriageModule {
  const capability = new TriageService(incidents, gateway, moduleNames);
  return { name: 'triage', capability, routes: triageRoutes(capability) };
}

export type { TriageOutcome, TriageAssessment, TriageCapability } from './contract.ts';
