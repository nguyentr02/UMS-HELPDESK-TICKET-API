import { Router } from 'express';
import { openApiSpec } from '../openapi/spec.js';

export const docsRouter = Router();

// Raw spec — handy for tooling, codegen, and the §8.3 conformance test.
docsRouter.get('/openapi.json', (_req, res) => {
  res.json(openApiSpec);
});

/**
 * Swagger UI HTML page. We DON'T use `swagger-ui-express` here because that
 * middleware serves UI assets (CSS / JS bundles) from `node_modules/swagger-
 * ui-dist` via `express.static`, and `@vercel/node` doesn't reliably ship
 * those static files inside the function bundle on Vercel — the browser then
 * hits a 404 envelope (text/html) when fetching `/docs/swagger-ui-bundle.js`
 * and refuses to execute it.
 *
 * Loading the UI from a public CDN sidesteps the bundling issue entirely
 * and still works offline-on-localhost during dev (CDN cached by the browser).
 */
const SWAGGER_UI_VERSION = '5.17.14';

const swaggerUiHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>M31 Helpdesk API — Swagger UI</title>
    <link
      rel="stylesheet"
      href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css"
    />
    <style>body { margin: 0; }</style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js" crossorigin></script>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-standalone-preset.js" crossorigin></script>
    <script>
      window.onload = function () {
        window.ui = SwaggerUIBundle({
          url: '/openapi.json',
          dom_id: '#swagger-ui',
          presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
          layout: 'StandaloneLayout',
          deepLinking: true,
        });
      };
    </script>
  </body>
</html>
`;

docsRouter.get(['/docs', '/docs/'], (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(swaggerUiHtml);
});
