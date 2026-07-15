import type { FastifyReply, FastifyRequest } from 'fastify';

// Bearer-token preHandler. Even on loopback, share-secret auth blocks
// drive-by access from other local processes/users.
//
// Exemptions:
//   - `/health`            so monitoring can poll without the token.
//   - `/dashboard` static  so the browser can load the SPA shell before the
//                          user enters their token. The /dashboard/api/*
//                          routes still require auth.

export function bearerAuth(token: string) {
  const expected = `Bearer ${token}`;
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (req.routeOptions.url === '/health') return;
    if (req.url.startsWith('/dashboard') && !req.url.startsWith('/dashboard/api/')) {
      return;
    }
    const auth = req.headers.authorization;
    if (auth !== expected) {
      void reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
  };
}
