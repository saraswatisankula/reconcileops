import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { enabled, resetAll } from './helpers.js';

describe.skipIf(!enabled)('execution safety (integration)', () => {
  let app;
  let db;
  let project;

  const addScript = async (version, up, down = null) => {
    const { body } = await request(app).post(`/api/projects/${project.id}/scripts`)
      .send({ version, description: `step ${version}`, up_sql: up, down_sql: down }).expect(201);
    await request(app).post(`/api/projects/${project.id}/scripts/${body.id}/validate`).send({}).expect(200);
    return body;
  };
  const execute = (script, extra = {}) => request(app)
    .post(`/api/projects/${project.id}/scripts/${script.id}/execute`)
    .send({ environment: 'development', acknowledgeWarnings: true, ...extra });

  beforeAll(async () => {
    const mod = await import('../../src/app.js');
    app = mod.createApp();
    db = await import('../../src/db.js');
    await resetAll();
    project = (await request(app).post('/api/projects')
      .send({ name: 'Lock Test', slug: 'lock_test' }).expect(201)).body;
  });

  afterAll(async () => db.closePools());

  it('validates request bodies', async () => {
    const res = await request(app).post('/api/projects').send({ name: 'x', slug: 'Bad Slug' }).expect(400);
    expect(res.body.error).toBe('Validation failed');
  });

  it('will not run a draft or rejected script', async () => {
    const { body } = await request(app).post(`/api/projects/${project.id}/scripts`)
      .send({ version: 1, description: 'draft only', up_sql: 'CREATE TABLE items (id INT);' }).expect(201);
    const res = await execute(body).expect(422);
    expect(res.body.reasons[0]).toMatch(/Only validated scripts/);
    await request(app).delete(`/api/projects/${project.id}/scripts/${body.id}`).expect(204);
  });

  let v1;
  it('applies a script once and refuses a duplicate', async () => {
    v1 = await addScript(1, 'CREATE TABLE items (id SERIAL PRIMARY KEY, label TEXT); INSERT INTO items (label) VALUES (\'a\');', 'DROP TABLE items;');
    expect((await execute(v1).expect(200)).body.run.status).toBe('success');
    const again = await execute(v1).expect(422);
    expect(again.body.reasons.join(' ')).toMatch(/already applied/);
  });

  it('lets only one of two concurrent executions through', async () => {
    const v2 = await addScript(2, 'ALTER TABLE items ADD COLUMN note TEXT;', 'ALTER TABLE items DROP COLUMN note;');
    const [a, b] = await Promise.all([execute(v2), execute(v2)]);
    const codes = [a.status, b.status].sort();
    expect(codes[0]).toBe(200);
    expect([409, 422]).toContain(codes[1]);
  });

  it('retries after a lock timeout and measures blocked reads', async () => {
    await request(app).put('/api/settings').send({ lock_timeout_ms: 200, retry_backoff_ms: 300, max_retries: 3 }).expect(200);
    await request(app).post(`/api/projects/${project.id}/apps`)
      .send({ version: 'v1', requirements: [{ table: 'items', column: 'id' }, { table: 'items', column: 'label' }] }).expect(201);

    const v3 = await addScript(3, 'ALTER TABLE items ADD COLUMN qty INT;', 'ALTER TABLE items DROP COLUMN qty;');

    const holder = await db.demo.connect();
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE lock_test_development.items IN ACCESS EXCLUSIVE MODE');
    // .then() makes supertest send the request now, while the lock is held.
    const pending = execute(v3).then((res) => res);
    await new Promise((r) => setTimeout(r, 900));
    await holder.query('COMMIT');
    holder.release();

    const { status, body } = await pending;
    expect(status).toBe(200);
    expect(body.run.status).toBe('success');
    expect(body.run.attempts).toBeGreaterThan(1);
    expect(body.run.log.some((l) => /Transient error, retrying/.test(l.msg))).toBe(true);
    expect(body.run.probe_failed).toBeGreaterThan(0);
    expect(body.run.downtime_ms).toBeGreaterThan(0);
  });

  it('rolls back only the newest version, and only with a down script', async () => {
    const { body: runs } = await request(app).get(`/api/runs?projectId=${project.id}&status=success`);
    const first = runs.find((r) => r.version === 1);
    const newest = runs.find((r) => r.version === 3);

    const blocked = await request(app).post(`/api/runs/${first.id}/rollback`).send({}).expect(422);
    expect(blocked.body.reasons[0]).toMatch(/Roll back newer versions first/);

    const ok = await request(app).post(`/api/runs/${newest.id}/rollback`).send({}).expect(200);
    expect(ok.body.run.status).toBe('rolled_back');

    const v4 = await addScript(4, 'ALTER TABLE items ADD COLUMN tmp INT;');
    await request(app).post(`/api/projects/${project.id}/scripts/3/validate`).send({});
    const { body: scripts } = await request(app).get(`/api/projects/${project.id}/scripts`);
    const s3 = scripts.find((s) => s.version === 3);
    await execute(s3).expect(200);
    const r4 = (await execute(v4).expect(200)).body.run;
    const noDown = await request(app).post(`/api/runs/${r4.id}/rollback`).send({}).expect(422);
    expect(noDown.body.reasons[0]).toMatch(/no down script/);
  });

  it('keeps applied scripts immutable', async () => {
    const { body: scripts } = await request(app).get(`/api/projects/${project.id}/scripts`);
    const s1 = scripts.find((s) => s.version === 1);
    await request(app).put(`/api/projects/${project.id}/scripts/${s1.id}`)
      .send({ version: 1, description: 'changed', up_sql: 'SELECT 1;' }).expect(409);
  });

  it('writes an audit trail', async () => {
    const { body } = await request(app).get('/api/audit?action=migration').expect(200);
    expect(body.length).toBeGreaterThan(0);
  });
});
