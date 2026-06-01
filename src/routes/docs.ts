import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { openApiSpec } from '../openapi/spec';

export const docsRouter = Router();

// Raw spec — handy for tooling, codegen, and the §8.3 conformance test.
docsRouter.get('/openapi.json', (_req, res) => {
  res.json(openApiSpec);
});

// Swagger UI at /docs (mounted as middleware; the UI assets live under /docs/*).
docsRouter.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(openApiSpec, {
    customSiteTitle: 'M31 Helpdesk API — Swagger UI',
  }),
);
