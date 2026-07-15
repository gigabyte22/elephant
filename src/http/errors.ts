import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

// Wire response envelope per EXPECTED.md §1: { ok: true, data } | { ok: false, error }.

export type Envelope<T> = { ok: true; data: T } | { ok: false; error: string };

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function notFound(what: string): HttpError {
  return new HttpError(404, `${what} not found`);
}

export function badRequest(message: string): HttpError {
  return new HttpError(400, message);
}

export function conflict(message: string): HttpError {
  return new HttpError(409, message);
}

export function payloadTooLarge(message: string): HttpError {
  return new HttpError(413, message);
}

export function errorHandler(err: FastifyError, _req: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof HttpError) {
    void reply.code(err.statusCode).send({ ok: false, error: err.message });
    return;
  }
  // Fastify's body-limit rejection surfaces as FST_ERR_CTP_BODY_TOO_LARGE;
  // give callers a clear hint rather than the generic code string.
  if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    void reply
      .code(413)
      .send({ ok: false, error: `request body exceeds the server limit: ${err.message}` });
    return;
  }
  // Zod validation errors from fastify-type-provider-zod come through with statusCode 400.
  if (err.statusCode && err.statusCode < 500) {
    void reply.code(err.statusCode).send({ ok: false, error: err.message });
    return;
  }
  reply.log.error(err);
  void reply.code(500).send({ ok: false, error: 'internal error' });
}
