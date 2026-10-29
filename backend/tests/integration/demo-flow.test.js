import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { enabled, resetAll } from './helpers.js';

// Runs the full Product/Order demonstration against real PostgreSQL
// and checks the outcome of every step.
describe.skipIf(!enabled)('demo scenarios (integration)', () => {
  let app;
  let closePools;

  beforeAll(async () => {
    ({ createApp: app } = await import('../../src/app.js'));
    app = app();
    ({ closePools } = await import('../../src/db.js'));
    await resetAll();
    await request(app).post('/api/demo/reset').expect(200);
  });

  afterAll(async () => closePools());

  const step = async (key) => (await request(app).post(`/api/demo/steps/${key}`).expect(200)).body.results;

  it('promotes the baseline through all three environments', async () => {
    const r = await step('product-baseline');
    expect(r.every((x) => x.ok)).toBe(true);
  });

  it('refuses production without the promotion order', async () => {
    const { body: projects } = await request(app).get('/api/projects');
    const product = projects.find((p) => p.slug === 'product_service');
    const { body: scripts } = await request(app).get(`/api/projects/${product.id}/scripts`);
    const v2 = scripts.find((s) => s.version === 2);
    await request(app).post(`/api/projects/${product.id}/scripts/${v2.id}/validate`).send({}).expect(200);
    const res = await request(app)
      .post(`/api/projects/${product.id}/scripts/${v2.id}/execute`)
      .send({ environment: 'production', confirm: 'product_service' })
      .expect(422);
    expect(res.body.reasons.join(' ')).toMatch(/must succeed in staging first/);
  });

  it('runs expand, app v2 and migrate steps', async () => {
    expect((await step('product-expand')).every((x) => x.ok)).toBe(true);
    expect((await step('product-app-v2')).every((x) => x.ok)).toBe(true);
    expect((await step('product-migrate')).every((x) => x.ok)).toBe(true);
  });

  it('rejects the incompatible rename and the early contract', async () => {
    const rename = await step('product-incompatible');
    expect(rename[0].ok).toBe(false);
    expect(rename[0].issues.map((i) => i.rule)).toContain('rename-column');

    const early = await step('product-contract-early');
    expect(early[0].ok).toBe(false);
    expect(early[0].issues.map((i) => i.rule)).toContain('drop-column');
  });

  it('contracts after v1.0 is retired', async () => {
    const r = await step('product-contract');
    expect(r.every((x) => x.ok)).toBe(true);
  });

  it('records a real failure and leaves the schema unchanged', async () => {
    expect((await step('order-baseline')).every((x) => x.ok)).toBe(true);
    const r = await step('order-failed');
    expect(r[1].status).toBe('failed');
    expect(r[1].detail).toMatch(/violated by some row/);

    const { body: run } = await request(app).get(`/api/runs/${r[1].runId}`).expect(200);
    expect(run.error_code).toBe('23514');
    expect(run.health.find((h) => h.check_name === 'schema_consistency').passed).toBe(true);
  });

  it('recovers with a corrected version', async () => {
    expect((await step('order-recover')).every((x) => x.ok)).toBe(true);
  });

  it('rolls back automatically when the health probe fails', async () => {
    const r = await step('order-health-rollback');
    expect(r[1].status).toBe('rolled_back');
    const { body: run } = await request(app).get(`/api/runs/${r[1].runId}`);
    expect(run.rollback_ms).not.toBeNull();
    const failed = run.health.filter((h) => !h.passed).map((h) => h.check_name);
    expect(failed).toContain('compat_probe:v1.0:orders');
  });

  it('detects drift and clears it again', async () => {
    const { body: projects } = await request(app).get('/api/projects');
    const product = projects.find((p) => p.slug === 'product_service');

    await step('drift-create');
    let rec = (await request(app).get(`/api/projects/${product.id}/reconcile?environment=development`)).body;
    expect(rec.state).toBe('drift');
    expect(rec.findings.some((f) => f.message.includes('hotfix_note'))).toBe(true);

    await step('drift-revert');
    rec = (await request(app).get(`/api/projects/${product.id}/reconcile?environment=development`)).body;
    expect(rec.state).toBe('in_sync');
  });

  it('produces metrics from the recorded runs', async () => {
    const { body } = await request(app).get('/api/metrics').expect(200);
    expect(body.summary.failed).toBe(1);
    expect(body.summary.rolled_back).toBe(1);
    expect(body.summary.compatibility_issues).toBeGreaterThanOrEqual(2);

    const csv = await request(app).get('/api/reports/runs.csv').expect(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\n')[0]).toMatch(/^id,project_name,environment/);
  });
});
