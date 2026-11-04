import type { AccessFunction } from 'arocapi';
import type { FastifyRequest } from 'fastify';

// Your app's session lookup
declare function currentUser(request: FastifyRequest): { isStaff: boolean } | undefined;

export const access: AccessFunction = (_entity, { request }, row) => {
  const user = currentUser(request);
  // Decided by your indexer and stored in the row; anything but an explicit 'Public' is restricted
  const meta = row.meta;
  const isPublic = typeof meta === 'object' && meta !== null && !Array.isArray(meta) && meta.accessControl === 'Public';

  return {
    metadata: isPublic || Boolean(user?.isStaff),
    content: Boolean(user?.isStaff),
    contentAuthorizationUrl: user ? undefined : 'https://auth.example.com/login',
  };
};
