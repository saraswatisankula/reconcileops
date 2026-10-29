import { useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { Empty, ErrorBox, Field, Loading, Modal, useToast } from '../ui.jsx';

function parseRequirements(text) {
  const out = [];
  const bad = [];
  for (const raw of text.split(/[\n,]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)$/);
    if (m) out.push({ table: m[1], column: m[2] });
    else bad.push(line);
  }
  return { out, bad };
}

function NewApp({ project, onClose, onSaved }) {
  const [version, setVersion] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const parsed = parseRequirements(text);

  const submit = async (e) => {
    e.preventDefault();
    if (parsed.bad.length) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/projects/${project.id}/apps`, { version, requirements: parsed.out });
      onSaved(version);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Register an app version" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <Field label="Version"><input value={version} onChange={(e) => setVersion(e.target.value)} required pattern="[\w.\-]{1,20}" placeholder="v2.1" /></Field>
        <Field
          label="Columns this version reads"
          hint="One table.column per line. Used for compatibility checks and health probes."
          error={parsed.bad.length ? `Not in table.column form: ${parsed.bad.join(', ')}` : null}
        >
          <textarea className="sql" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'products.id\nproducts.sku\nproducts.price_cents'} required />
        </Field>
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || !parsed.out.length || parsed.bad.length > 0}>{busy ? 'Saving…' : 'Register version'}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function AppsTab({ project }) {
  const { data, error, loading, reload } = useApi(`/projects/${project.id}/apps`);
  const [adding, setAdding] = useState(false);
  const toast = useToast();

  const toggle = async (a) => {
    try {
      await api.patch(`/projects/${project.id}/apps/${a.id}`, { active: !a.active });
      toast(a.active ? `${a.version} retired` : `${a.version} is live again`);
      reload();
    } catch (err) { toast(err.message, 'bad'); }
  };
  const remove = async (a) => {
    if (!window.confirm(`Remove ${a.version} and its requirements?`)) return;
    try {
      await api.del(`/projects/${project.id}/apps/${a.id}`);
      toast(`Removed ${a.version}`);
      reload();
    } catch (err) { toast(err.message, 'bad'); }
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  return (
    <>
      <div className="toolbar">
        <p className="muted">A column can only be dropped or renamed once no live app version reads it. Retire old versions after they are fully replaced.</p>
        <button className="btn btn-primary" onClick={() => setAdding(true)}>Register version</button>
      </div>
      {data.length === 0 ? (
        <Empty title="No app versions registered">Without them, compatibility checks have nothing to protect.</Empty>
      ) : (
        <div className="apps">
          {data.map((a) => (
            <section key={a.id} className={`app ${a.active ? '' : 'app-retired'}`}>
              <header>
                <h3>{a.version}</h3>
                <span className={`tag ${a.active ? 'tag-ok' : ''}`}>{a.active ? 'live' : 'retired'}</span>
              </header>
              <ul className="req-list">
                {a.requirements.map((r) => <li key={r.table + r.column}><code>{r.table}.{r.column}</code></li>)}
              </ul>
              <div className="row-actions">
                <button className="btn btn-small" onClick={() => toggle(a)}>{a.active ? 'Retire' : 'Mark live'}</button>
                <button className="btn btn-small btn-danger-quiet" onClick={() => remove(a)}>Remove</button>
              </div>
            </section>
          ))}
        </div>
      )}
      {adding && <NewApp project={project} onClose={() => setAdding(false)} onSaved={(v) => { toast(`Registered ${v}`); setAdding(false); reload(); }} />}
    </>
  );
}
