/**
 * Make the same request as GET, then as HEAD
 */
export const getAndHead = async <Response>(request: (method: 'GET' | 'HEAD') => Promise<Response>) => {
  const get = await request('GET');
  const head = await request('HEAD');

  return { get, head };
};

/**
 * Headers to compare across GET and HEAD: `date` differs when the two straddle a second
 */
export const comparableHeaders = (headers: Record<string, unknown>) => {
  const { date: _date, ...rest } = headers;

  return rest;
};
