import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { ErrorBox, Lamp, Loading, PageHead, useToast } from '../components/ui.jsx';
import ScriptsTab from '../components/project/ScriptsTab.jsx';
import AppsTab from '../components/project/AppsTab.jsx';
import CompareTab from '../components/project/CompareTab.jsx';
import HealthTab from '../components/project/HealthTab.jsx';
import { stamp, when } from '../format.js';

const TABS = [
  ['envs', 'Environments'],
  ['scripts', 'Migration scripts'],
  ['apps', 'App versions'],
  ['compare', 'Compare schemas'],
  ['health', 'Health history'],
];

function EnvColumn({ env, projectId, onChecked }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const state = !env.health ? 'off' : env.health.passed ? 'ok' : 'bad';

  const check = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/projects/${projectId}/health/run`, { environment: env.name });
      toast(r.passed ? `${env.name} is healthy` : `${env.name} has failing checks`, r.passed ? 'ok' : 'bad');
      onChecked();
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`env-col env-${state}`}>
      <header>
        <Lamp state={state} label={state === 'off' ? 'not checked' : state === 'ok' ? 'healthy' : 'unhealthy'} />
        <h3>{env.name}</h3>
        {env.protected && <span className="tag">protected</span>}
      </header>
      <div className="env-version">
        <span className="env-version-num">{env.currentVersion ? `V${env.currentVersion}` : 'empty'}</span>
        <code>{env.schema}</code>
      </div>

      <h4>Applied versions</h4>
      {env.history.length ? (
        <ol className="history">
          {env.history.map((h) => (
            <li key={h.version}>
              <b>V{h.version}</b> {h.description}
              <span className="muted"> {when(h.applied_at)}, {h.execution_ms} ms</span>
            </li>
          ))}
        </ol>
      ) : <p className="muted">Nothing applied yet.</p>}

      <h4>Last health check</h4>
      {env.health ? (
        <ul className="checks">
          {env.health.checks.map((c) => (
            <li key={c.check_name} className={c.passed ? 'pass' : 'fail'} title={c.details}>
              <span>{c.passed ? 'Pass' : 'Fail'}</span> {c.check_name}
            </li>
          ))}
          <li className="muted">{stamp(env.health.at)}</li>
        </ul>
      ) : <p className="muted">Not checked yet.</p>}

      <div className="env-actions">
        <button className="btn btn-quiet" onClick={check} disabled={busy}>{busy ? 'Checking…' : 'Run health check'}</button>
        <Link className="btn btn-quiet" to={`/reconcile?project=${projectId}&environment=${env.name}`}>Reconcile</Link>
      </div>
    </section>
  );
}

export default function ProjectDetail() {
  const { id } = useParams();
  const [tab, setTab] = useState('envs');
  const { data, error, loading, reload } = useApi(`/projects/${id}`);
  const nav = useNavigate();
  const toast = useToast();

  if (loading && !data) return <Loading text="Loading service" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  const remove = async () => {
    const typed = window.prompt(`Delete ${data.name}? Its run history goes too. Type "${data.slug}" to confirm.`);
    if (typed !== data.slug) return;
    try {
      await api.del(`/projects/${data.id}?confirm=${encodeURIComponent(typed)}`);
      toast(`Deleted ${data.name}`);
      nav('/projects');
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  return (
    <>
      <p className="crumbs"><Link to="/projects">Services</Link> / {data.name}</p>
      <PageHead title={data.name} sub={data.description}>
        <button className="btn btn-danger-quiet" onClick={remove}>Delete service</button>
      </PageHead>

      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'envs' && (
        <div className="env-grid">
          {data.environments.map((e) => <EnvColumn key={e.name} env={e} projectId={data.id} onChecked={reload} />)}
        </div>
      )}
      {tab === 'scripts' && <ScriptsTab project={data} onChange={reload} />}
      {tab === 'apps' && <AppsTab project={data} />}
      {tab === 'compare' && <CompareTab project={data} />}
      {tab === 'health' && <HealthTab project={data} />}
    </>
  );
}
