/**
 * Projects — domain rules.
 *
 * Responsibility: validate and normalize project input, independently of storage and
 * transport.
 *
 * Place in the system: internal to the Projects module. Kept pure so the rules can be
 * proven at the cheapest layer — plain function calls, no database, no server.
 *
 * Boundary: no I/O, no clock, no id generation. Those are the service's concern, which
 * keeps this file deterministic.
 */

import { AppError } from '../../spine/errors.ts';
import type { CreateProjectInput, UpdateProjectInput } from './contract.ts';

export const NAME_MAX_LENGTH = 120;
export const DESCRIPTION_MAX_LENGTH = 2000;

/**
 * A create input that has passed validation: trimmed, defaulted, and safe to persist.
 *
 * No `customerId`: ownership is supplied by the service from the authenticated session, so
 * it is never a validated client input.
 */
export interface NormalizedCreate {
  readonly name: string;
  readonly description: string;
}

/**
 * Validate and normalize a create request.
 *
 * Collects every field error before raising, so a form can show all problems at once
 * instead of making the user resubmit to discover the next one.
 */
export function normalizeCreate(input: CreateProjectInput): NormalizedCreate {
  const details: Record<string, string> = {};

  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (name === '') {
    details.name = 'Enter a project name.';
  } else if (name.length > NAME_MAX_LENGTH) {
    details.name = `Use ${NAME_MAX_LENGTH} characters or fewer.`;
  }

  const description = typeof input?.description === 'string' ? input.description.trim() : '';
  if (description.length > DESCRIPTION_MAX_LENGTH) {
    details.description = `Use ${DESCRIPTION_MAX_LENGTH} characters or fewer.`;
  }

  if (Object.keys(details).length > 0) {
    throw AppError.validation('That project could not be saved. Correct the fields below and try again.', details);
  }

  return { name, description };
}

/**
 * Validate and normalize an update request.
 *
 * Returns only the fields the caller actually supplied, so an absent field means
 * "unchanged" rather than "set to empty". An update naming no recognised field is
 * rejected instead of silently succeeding as a no-op.
 */
export function normalizeUpdate(input: UpdateProjectInput): Partial<NormalizedCreate> {
  const details: Record<string, string> = {};
  const changes: { name?: string; description?: string } = {};

  if (input?.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '') {
      details.name = 'Enter a project name.';
    } else if (name.length > NAME_MAX_LENGTH) {
      details.name = `Use ${NAME_MAX_LENGTH} characters or fewer.`;
    } else {
      changes.name = name;
    }
  }

  if (input?.description !== undefined) {
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (description.length > DESCRIPTION_MAX_LENGTH) {
      details.description = `Use ${DESCRIPTION_MAX_LENGTH} characters or fewer.`;
    } else {
      changes.description = description;
    }
  }

  if (Object.keys(details).length > 0) {
    throw AppError.validation('That project could not be updated. Correct the fields below and try again.', details);
  }

  if (Object.keys(changes).length === 0) {
    throw AppError.validation('Nothing to update. Change the name or the description first.');
  }

  return changes;
}
