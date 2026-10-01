import { z } from 'zod';
import type { Container } from '../../index.ts';
import { SettingsValidationError } from '../../settings/knowledge-media.ts';
import { badRequest } from '../errors.ts';
import type { App } from '../types.ts';
import { okEnvelope } from '../wire-schemas.ts';

// Admin settings. Auth is the global bearer preHandler, like every other route.
// Secrets are write-only: the wire says whether one is set, never what it is.

const SettingStatusSchema = z.object({
  name: z.string(),
  secret: z.boolean(),
  isSet: z.boolean(),
  value: z.string().optional(),
  source: z.enum(['stored', 'env', 'default']),
});
const SettingsResponse = okEnvelope(z.object({ settings: z.array(SettingStatusSchema) }));

export function registerAdminSettingsRoutes(app: App, container: Container): void {
  const settings = container.mediaSettings;

  app.route({
    method: 'GET',
    url: '/admin/settings/knowledge-media',
    schema: { response: { 200: SettingsResponse } },
    handler: async () => ({ ok: true as const, data: { settings: settings.list() } }),
  });

  app.route({
    method: 'PUT',
    url: '/admin/settings/knowledge-media',
    schema: {
      body: z.object({
        set: z.record(z.string()).optional(),
        unset: z.array(z.string()).optional(),
      }),
      response: { 200: SettingsResponse },
    },
    handler: async (req) => {
      try {
        return { ok: true as const, data: { settings: settings.update(req.body) } };
      } catch (err) {
        if (err instanceof SettingsValidationError) throw badRequest(err.message);
        throw err;
      }
    },
  });
}
