import type { FastifyReply, FastifyRequest } from 'fastify';
import { decideAccess, type EntityRow } from '../transformers/default.js';
import type { AccessFunction } from '../types/access.js';
import type { IsAuthenticated, RequestContext } from '../types/context.js';
import { sendRefusal } from './errors.js';
import { isAnonymous } from './visibility.js';

/**
 * All Public Access - every request may read every visible entity's Metadata and Content
 *
 * WARNING: Only use this for fully public repositories with no access control.
 */
export const AllPublicAccess: AccessFunction = () => ({ metadata: true, content: true });

export type LicenceAccessOptions = {
  hasLicence: (licenceId: string, context: RequestContext) => Promise<boolean> | boolean;
  authorisationUrl?: (licenceId: string) => string;
};

/**
 * Licence Access - Metadata access needs the entity's metadata licence, Content access its content licence
 *
 * Each licence is checked at most once per request, so a listing sharing a few licences costs a few checks.
 */
export const LicenceAccess = ({ hasLicence, authorisationUrl }: LicenceAccessOptions): AccessFunction => {
  const checksByRequest = new WeakMap<FastifyRequest, Map<string, Promise<boolean>>>();

  const check = (licenceId: string, context: RequestContext) => {
    let checks = checksByRequest.get(context.request);
    if (!checks) {
      checks = new Map();
      checksByRequest.set(context.request, checks);
    }

    let held = checks.get(licenceId);
    if (!held) {
      held = Promise.resolve(hasLicence(licenceId, context));
      checks.set(licenceId, held);
    }

    return held;
  };

  return async ({ metadataLicenseId, contentLicenseId }, context) => {
    const [metadata, content] = await Promise.all([
      check(metadataLicenseId, context),
      check(contentLicenseId, context),
    ]);

    return {
      metadata,
      content,
      ...(!metadata && authorisationUrl && { metadataAuthorizationUrl: authorisationUrl(metadataLicenseId) }),
      ...(!content && authorisationUrl && { contentAuthorizationUrl: authorisationUrl(contentLicenseId) }),
    };
  };
};

type AccessGuardOptions = {
  access: AccessFunction;
  isAuthenticated?: IsAuthenticated;
  level: 'metadata' | 'content';
};

/**
 * Build a check that refuses a request when a visible entity's Metadata or Content isn't accessible to it
 * Returns whether the request was denied (not the reply: replies are thenable, so awaiting one loses it)
 */
export const createAccessGuard =
  ({ access, isAuthenticated, level }: AccessGuardOptions) =>
  async (reply: FastifyReply, entity: EntityRow, context: RequestContext) => {
    const [entityAccess] = await decideAccess([entity], access, context);
    if (entityAccess[level]) {
      return false;
    }

    sendRefusal(reply, await isAnonymous(isAuthenticated, context), entity.id);

    return true;
  };
