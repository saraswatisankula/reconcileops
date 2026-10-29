import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Empty, ErrorBox, Field, Loading, Modal, PageHead, useToast } from '../components/ui.jsx';
import { when } from '../format.js';

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 's$1').slice(0, 39);
}

function NewProject({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', slug: '', description: '', primary_table: '' });
  const [touchedSlug, setTouchedSlug] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => {
    const v = e.target.value;
    setForm((f) => ({ ...f, [k]: v, ...(k === 'name' && !touchedSlug ? { slug: slugify(v) } : {}) }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api.post('/projects', { ...form, primary_table: form.primary_table || null });
      onCreated(p);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add a service" onClose={onClose}>
      <form onSubmit={submit} className="form">
        <Field label="Service name">
          <input value={form.name} onChange={set('name')} required minLength={2} maxLength={80} placeholder="Inventory Service" />
        </Field>
        <Field label="Slug" hint="Used for schema names, e.g. inventory_service_staging. Cannot change later.">
          <input value={form.slug} onChange={(e) => { setTouchedSlug(true); set('slug')(e); }} required pattern="[a-z][a-z0-9_]{1,38}" />
        </Field>
        <Field label="Main table" hint="Optional, for reference only.">
          <input value={form.primary_table} onChange={set('primary_table')} pattern="[a-z_][a-z0-9_]*" placeholder="items" />
        </Field>
        <Field label="Description">
          <textarea rows={3} value={form.description} onChange={set('description')} maxLength={500} />
        </Field>
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add service'}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function Projects() {
  const { data, error, loading, reload } = useApi('/projects');
  const [creating, setCreating] = useState(false);
  const toast = useToast();
  const nav = useNavigate();

  return (
    <>
      <PageHead title="Services" sub="Each service owns its schema, its migration scripts and the app versions that read it.">
        <button className="btn btn-primary" onClick={() => setCreating(true)}>Add service</button>
      </PageHead>

      {loading && !data && <Loading />}
      <ErrorBox error={error} onRetry={reload} />

      {data && data.length === 0 && (
        <Empty title="No services yet">
          Add one, or load the demo services from <Link to="/demo">Demo scenarios</Link>.
        </Empty>
      )}

      {data && data.length > 0 && (
        <div className="service-list">
          {data.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} className="service">
              <div className="service-main">
                <h2>{p.name}</h2>
                <code>{p.slug}</code>
                <p>{p.description || 'No description'}</p>
              </div>
              <dl className="service-facts">
                <div><dt>Scripts</dt><dd>{p.script_count}</dd></div>
                <div><dt>Latest</dt><dd>{p.latest_version ? `V${p.latest_version}` : '–'}</dd></div>
                <div><dt>Live app versions</dt><dd>{p.active_apps}</dd></div>
                <div><dt>Last run</dt><dd>{when(p.last_run_at)}</dd></div>
              </dl>
            </Link>
          ))}
        </div>
      )}

      {creating && (
        <NewProject
          onClose={() => setCreating(false)}
          onCreated={(p) => { toast(`Added ${p.name}`); setCreating(false); nav(`/projects/${p.id}`); }}
        />
      )}
    </>
  );
}
