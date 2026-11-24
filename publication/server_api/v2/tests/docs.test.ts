import { describe, test, expect } from 'bun:test';
import {
  handleDocs,
  handleSwaggerUI,
  handleScalarUI,
  handleSwaggerAssets,
  handleScalarAssets,
  handleOpenApiSpec,
} from '../src/routes/docs';
import { config } from '../src/config';

const BASE = `http://localhost:3100${config.BASE_PATH}`;

describe('Docs routes', () => {
  test('docs landing page is HTML', async () => {
    const res = await handleDocs(new Request(`${BASE}/docs`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(await res.text()).toContain('swagger');
  });

  test('Swagger UI page references local assets', async () => {
    const res = await handleSwaggerUI(new Request(`${BASE}/docs/swagger`));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('/docs/swagger/swagger-ui.css');
    expect(body).toContain('/openapi.yaml');
  });

  test('Scalar page references local assets', async () => {
    const res = await handleScalarUI(new Request(`${BASE}/docs/scalar`));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/docs/scalar/standalone.js');
  });

  test('OpenAPI spec is served as YAML', async () => {
    const res = await handleOpenApiSpec(new Request(`${BASE}/openapi.yaml`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('yaml');
    const body = await res.text();
    expect(body).toContain('openapi: 3.1.0');
    expect(body).toContain('/{db}/tables/{table}/records');
  });

  test('OpenAPI search operation documents the lang parameter the route accepts', async () => {
    const body = await (await handleOpenApiSpec(new Request(`${BASE}/openapi.yaml`))).text();
    const start = body.indexOf('  /{db}/tables/{table}/search:');
    expect(start).toBeGreaterThan(-1);
    const searchOperation = body.slice(start, body.indexOf('\n  /', start + 1));
    expect(searchOperation).toContain("$ref: '#/components/parameters/Lang'");
  });

  test('Swagger assets are served from node_modules', async () => {
    const res = await handleSwaggerAssets(new Request(`${BASE}/docs/swagger/swagger-ui.css`));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/css');
  });

  test('missing assets return 404', async () => {
    const res = await handleSwaggerAssets(new Request(`${BASE}/docs/swagger/nope.js`));
    expect(res.status).toBe(404);
  });

  test('path traversal is rejected', async () => {
    const res = await handleSwaggerAssets(new Request(`${BASE}/docs/swagger/..%2Fpackage.json`));
    expect([400, 404]).toContain(res.status);
  });

  test('Scalar assets resolve style.css and standalone.js', async () => {
    const css = await handleScalarAssets(new Request(`${BASE}/docs/scalar/style.css`));
    expect(css.status).toBe(200);

    const js = await handleScalarAssets(new Request(`${BASE}/docs/scalar/standalone.js`));
    expect(js.status).toBe(200);
    expect(js.headers.get('Content-Type')).toBe('application/javascript');
  });
});
