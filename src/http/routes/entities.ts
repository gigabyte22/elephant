import { z } from 'zod';
import { read } from '../../config/neo4j.ts';
import type { Container } from '../../index.ts';
import { toWireEntity, toWireFact } from '../../models/wire.ts';
import { EntityRepository } from '../../repositories/EntityRepository.ts';
import { FactRepository } from '../../repositories/FactRepository.ts';
import { notFound } from '../errors.ts';
import type { App } from '../types.ts';
import { WireEntitySchema, WireFactSchema, okEnvelope, queryBool } from '../wire-schemas.ts';

export function registerEntitiesRoutes(app: App, _container: Container): void {
  app.route({
    method: 'GET',
    url: '/entities/:id',
    schema: {
      params: z.object({ id: z.string().uuid() }),
      querystring: z.object({
        includeSuperseded: queryBool,
      }),
      response: {
        200: okEnvelope(
          z.object({
            entity: WireEntitySchema,
            facts: z.array(WireFactSchema),
          }),
        ),
      },
    },
    handler: async (req) => {
      const result = await read(async (tx) => {
        const entity = await EntityRepository.get(tx, req.params.id);
        if (!entity) return null;
        const facts = await FactRepository.listForEntity(tx, {
          entityId: entity.id,
          includeSuperseded: req.query.includeSuperseded ?? false,
        });
        return { entity, facts };
      });
      if (!result) throw notFound(`entity ${req.params.id}`);
      return {
        ok: true as const,
        data: {
          entity: toWireEntity(result.entity),
          facts: result.facts.map(toWireFact),
        },
      };
    },
  });

  app.route({
    method: 'GET',
    url: '/entities',
    schema: {
      querystring: z.object({
        name: z.string().min(1),
        limit: z.coerce.number().int().positive().max(50).optional(),
      }),
      response: {
        200: okEnvelope(z.object({ entities: z.array(WireEntitySchema) })),
      },
    },
    handler: async (req) => {
      const entities = await read((tx) =>
        EntityRepository.fuzzyFindByName(tx, req.query.name, req.query.limit ?? 10),
      );
      return { ok: true as const, data: { entities: entities.map(toWireEntity) } };
    },
  });
}
