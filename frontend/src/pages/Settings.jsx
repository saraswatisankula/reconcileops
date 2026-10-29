import { useEffect, useState } from 'react';
import { api, auth, writeStore } from '../api.js';
import { useApi } from '../hooks.js';
import { ErrorBox, Field, Loading, PageHead, useToast } from '../components/ui.jsx';

const NUMBERS = [
  ['max_retries', 'Retries on transient errors', 'Lock timeouts, deadlocks and serialization failures only. 0 to 5.'],
  ['retry_backoff_ms', 'Retry backoff (ms)', 'Multiplied by the attempt number.'],
  ['lock_timeout_ms', 'Lock timeout (ms)', 'How long a migration may wait for a lock before giving up.'],
  ['statement_timeout_ms', 'Statement timeout (ms)', 'Upper limit for a whole script.'],
  ['probe_interval_ms', 'Probe interval (ms)', 'Pause between read probes during a run.'],
];

export default function Settings() {
  const settings = useApi('/settings');
  const system = useApi('/system');
  const envs = useApi('/environments');
  const [form, setForm] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [token, setToken] = useState(auth.token);
  const [actor, setActor] = useState(auth.actor);
  const toast = useToast();

  useEffect(() => { if (settings.data) setForm(settings.data); }, [settings.data]);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = { ...form };
      for (const [k] of NUMBERS) body[k] = Number(body[k]);
      setForm(await api.put('/settings', body));
      toast('Settings saved');
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const saveIdentity = (e) => {
    e.preventDefault();
    writeStore('rops.token', token.trim());
    writeStore('rops.actor', actor.trim());
    toast('Saved in this browser');
  };

  const toggleProtected = async (env) => {
    try {
      await api.patch(`/environments/${env.id}`, { protected: !env.protected });
      toast(`${env.name} is ${env.protected ? 'no longer' : 'now'} protected`);
      envs.reload();
    } catch (err) { toast(err.message, 'bad'); }
  };

  return (
    <>
      <PageHead title="Settings" sub="Execution safety rules, environments and how this browser identifies itself." />

      <div className="split">
        <section className="panel">
          <div className="panel-head"><h2>Execution rules</h2></div>
          {!form ? <Loading /> : (
            <form className="form" onSubmit={save}>
              <label className="check">
                <input type="checkbox" checked={form.auto_rollback} onChange={(e) => setForm({ ...form, auto_rollback: e.target.checked })} />
                Roll back automatically when post-deploy health checks fail (only for scripts with a down script)
              </label>
              <label className="check">
                <input type="checkbox" checked={form.enforce_promotion_order} onChange={(e) => setForm({ ...form, enforce_promotion_order: e.target.checked })} />
                Require each version to pass the previous environment first
              </label>
              <div className="form-grid">
                {NUMBERS.map(([k, label, hint]) => (
                  <Field key={k} label={label} hint={hint}>
                    <input type="number" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} required />
                  </Field>
                ))}
              </div>
              <ErrorBox error={error} />
              <div className="form-actions"><button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save rules'}</button></div>
            </form>
          )}
        </section>

        <div className="stack">
          <section className="panel">
            <div className="panel-head"><h2>This browser</h2></div>
            <form className="form" onSubmit={saveIdentity}>
              <Field label="Your name" hint="Shown in the audit log."><input value={actor} onChange={(e) => setActor(e.target.value)} maxLength={60} /></Field>
              <Field label="API token" hint={system.data?.authEnabled ? 'Required for changes on this server.' : 'The server has no token set, so this can stay empty.'}>
                <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
              </Field>
              <div className="form-actions"><button className="btn">Save</button></div>
            </form>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Environments</h2></div>
            {envs.data ? (
              <ul className="env-settings">
                {envs.data.map((e) => (
                  <li key={e.id}>
                    <div><b>{e.name}</b><span className="muted"> {e.description}</span></div>
                    <label className="check">
                      <input type="checkbox" checked={e.protected} onChange={() => toggleProtected(e)} /> Protected
                    </label>
                  </li>
                ))}
              </ul>
            ) : <Loading />}
            <p className="muted small">Each environment is its own PostgreSQL schema in the demo database, named service_environment.</p>
          </section>

          <section className="panel">
            <div className="panel-head"><h2>Connections</h2></div>
            {system.data ? (
              <dl className="facts facts-stack">
                <div><dt>Metadata database</dt><dd><code>{system.data.metaDatabase.url}</code> {system.data.metaDatabase.ok ? `PostgreSQL ${system.data.metaDatabase.version}` : system.data.metaDatabase.error}</dd></div>
                <div><dt>Demo database</dt><dd><code>{system.data.demoDatabase.url}</code> {system.data.demoDatabase.ok ? `PostgreSQL ${system.data.demoDatabase.version}` : system.data.demoDatabase.error}</dd></div>
                <div><dt>Write protection</dt><dd>{system.data.authEnabled ? 'API token required' : 'Open (set API_TOKEN in .env to lock it)'}</dd></div>
              </dl>
            ) : <Loading />}
            <p className="muted small">Passwords are masked by the server. Connection strings live only in the backend .env file.</p>
          </section>
        </div>
      </div>
    </>
  );
}
