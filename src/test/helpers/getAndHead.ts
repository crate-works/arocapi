/**
 * Make the same request as GET, then as HEAD
 */
export const getAndHead = async <Response>(request: (method: 'GET' | 'HEAD') => Promise<Response>) => {
  const get = await request('GET');
  const head = await request('HEAD');

  return { get, head };
};
