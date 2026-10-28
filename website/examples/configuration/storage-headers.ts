import arocapi, { type Options } from 'arocapi';
import Fastify from 'fastify';

// Your arocapi options
declare const options: Options;

const fastify = Fastify();

// In its own scope with arocapi, so the hook sees only arocapi's routes
await fastify.register(async (scope) => {
  // Let deposited HTML run scripts, still in an opaque origin
  scope.addHook('onSend', async (_request, reply, payload) => {
    if (reply.hasHeader('content-security-policy')) {
      reply.header('Content-Security-Policy', 'sandbox allow-scripts');
    }

    return payload;
  });

  await scope.register(arocapi, options);
});
