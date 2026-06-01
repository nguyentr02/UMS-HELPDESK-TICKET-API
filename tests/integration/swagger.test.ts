import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestApp } from '../helpers/app-factory';

const app = createTestApp();

interface OperationLike {
  summary?: string;
  description?: string;
  responses?: Record<string, ResponseOrRef>;
  requestBody?: { content?: Record<string, { example?: unknown }> };
}

type ResponseOrRef = { $ref: string } | { description?: string; content?: ContentMap };
type ContentMap = Record<string, { example?: unknown }>;
type PathItem = Record<string, OperationLike | unknown>;

const HTTP_METHODS = ['get', 'post', 'patch', 'delete', 'put'] as const;
type Method = (typeof HTTP_METHODS)[number];

function isOperation(value: unknown): value is OperationLike {
  return typeof value === 'object' && value !== null && !('$ref' in (value as object));
}

function isRef(value: unknown): value is { $ref: string } {
  return typeof value === 'object' && value !== null && typeof (value as { $ref?: unknown }).$ref === 'string';
}

function resolveRef(spec: Record<string, unknown>, ref: string): unknown {
  // Only relative refs like '#/components/responses/Foo' are supported.
  if (!ref.startsWith('#/')) return undefined;
  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>((acc, key) => {
      if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[key];
      return undefined;
    }, spec);
}

function resolveResponse(
  spec: Record<string, unknown>,
  r: ResponseOrRef,
): { description?: string; content?: ContentMap } | undefined {
  if (isRef(r)) {
    const resolved = resolveRef(spec, r.$ref);
    return resolved as { description?: string; content?: ContentMap } | undefined;
  }
  return r;
}

describe('Swagger / OpenAPI (ISO §8.3)', () => {
  it('GET /openapi.json returns a valid OpenAPI 3.x document covering every existing endpoint', async () => {
    const res = await request(app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.info?.title).toBeTruthy();
    expect(res.body.info?.version).toBeTruthy();

    const pathKeys = Object.keys(res.body.paths ?? {});
    expect(pathKeys).toEqual(
      expect.arrayContaining([
        '/healthz',
        '/categories',
        '/categories/{id}',
        '/routing-rules',
        '/routing-rules/{id}',
        '/tickets',
        '/tickets/{id}',
        '/tickets/{id}/history',
        '/attachments/{id}',
      ]),
    );
  });

  it('every operation has summary + description, every response code has a (resolved) description (ISO §8.3 items 1–4)', async () => {
    const res = await request(app).get('/openapi.json');
    const spec = res.body as Record<string, unknown>;
    const paths = spec.paths as Record<string, PathItem>;
    const violations: string[] = [];

    for (const [pathKey, pathItem] of Object.entries(paths)) {
      for (const method of HTTP_METHODS) {
        const op = pathItem[method as Method];
        if (!isOperation(op)) continue;

        if (!op.summary) violations.push(`${method.toUpperCase()} ${pathKey}: missing summary`);
        if (!op.description) violations.push(`${method.toUpperCase()} ${pathKey}: missing description`);

        const respMap = op.responses ?? {};
        if (Object.keys(respMap).length === 0) {
          violations.push(`${method.toUpperCase()} ${pathKey}: no responses declared`);
        }
        for (const [status, r] of Object.entries(respMap)) {
          const resolved = resolveResponse(spec, r);
          if (!resolved?.description) {
            violations.push(`${method.toUpperCase()} ${pathKey} → ${status}: missing description`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('every operation has ≥1 example for a 2xx response or request body (ISO §8.3 item 5; binary streams exempt)', async () => {
    const res = await request(app).get('/openapi.json');
    const spec = res.body as Record<string, unknown>;
    const paths = spec.paths as Record<string, PathItem>;
    const missing: string[] = [];

    for (const [pathKey, pathItem] of Object.entries(paths)) {
      for (const method of HTTP_METHODS) {
        const op = pathItem[method as Method];
        if (!isOperation(op)) continue;

        const respMap = op.responses ?? {};
        const has2xxExample = Object.entries(respMap).some(([status, r]) => {
          if (!status.startsWith('2')) return false;
          const resolved = resolveResponse(spec, r);
          const content = resolved?.content ?? {};
          const mediaTypes = Object.keys(content);
          // Binary streams have no textual example; exempt them.
          if (mediaTypes.length > 0 && mediaTypes.every((t) => t === 'application/octet-stream')) {
            return true;
          }
          return Object.values(content).some((c) => c.example !== undefined);
        });
        const hasReqExample = Object.values(op.requestBody?.content ?? {}).some(
          (c) => c.example !== undefined,
        );
        if (!has2xxExample && !hasReqExample) {
          missing.push(`${method.toUpperCase()} ${pathKey}: no example on success response or request body`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('all schema / response $refs resolve inside components (ISO §8.3 item 6)', async () => {
    const res = await request(app).get('/openapi.json');
    const spec = res.body as Record<string, unknown>;
    const components = (spec.components ?? {}) as {
      schemas?: Record<string, unknown>;
      responses?: Record<string, unknown>;
    };
    const schemaNames = new Set(Object.keys(components.schemas ?? {}));
    const responseNames = new Set(Object.keys(components.responses ?? {}));

    const broken: string[] = [];
    function walk(node: unknown, path: string): void {
      if (Array.isArray(node)) {
        node.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      if (typeof node === 'object' && node !== null) {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (k === '$ref' && typeof v === 'string') {
            if (v.startsWith('#/components/schemas/')) {
              const name = v.slice('#/components/schemas/'.length);
              if (!schemaNames.has(name)) broken.push(`${path}.$ref → ${v}`);
            } else if (v.startsWith('#/components/responses/')) {
              const name = v.slice('#/components/responses/'.length);
              if (!responseNames.has(name)) broken.push(`${path}.$ref → ${v}`);
            } else {
              broken.push(`${path}.$ref → ${v} (unsupported $ref root)`);
            }
          } else {
            walk(v, `${path}.${k}`);
          }
        }
      }
    }
    walk(spec, '$');

    expect(broken).toEqual([]);
  });

  it('GET /docs/ serves the Swagger UI HTML (ISO §8.3 item 7 — UI smoke test)', async () => {
    const res = await request(app).get('/docs/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Swagger UI');
  });
});
