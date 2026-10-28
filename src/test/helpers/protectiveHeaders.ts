import type { LightMyRequestResponse } from 'fastify';

/**
 * The protective headers a response carries, for comparing with `sandboxed`, `mediaOnly` or `unprotected`
 */
export const protectiveHeaders = (response: LightMyRequestResponse) => ({
  csp: response.headers['content-security-policy'],
  nosniff: response.headers['x-content-type-options'],
});

export const sandboxed = { csp: "default-src 'none'; style-src 'unsafe-inline'; sandbox", nosniff: 'nosniff' };
export const mediaOnly = { csp: undefined, nosniff: 'nosniff' };
export const unprotected = { csp: undefined, nosniff: undefined };
