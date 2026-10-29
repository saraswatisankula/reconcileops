import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Badge, ErrorBox, Loading, PageHead, useToast } from '../components/ui.jsx';
import { ms, stamp } from '../format.js';

export default function RunDetail() {
  const { id } = useParams();
  const { data: run, error, loading, reload } = useApi(`/runs/${id}`);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);
  const toast = useToast();
  const nav = useNavigate();

  if (loading && !run) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  const confirmIfProd = () => {
    if (run.environment !== 'production') return undefined;
    return window.prompt(`Type ${run.project_slug} to confirm in production`) || '';
  };

  const rollback = async () => {
    const confirm = confirmIfProd();
    if (confirm === '') return;
    setBusy(true);
    setActionError(null);
    try {
      await api.post(`/runs/${run.id}/rollback`, { confirm });
      toast(`Rolled back V${run.version} on ${run.environment}`);
      reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    const confirm = confirmIfProd();
    if (confirm === '') return;
    setBusy(true);
    setActionError(null);
    try {
      const r = await api.post(`/runs/${run.id}/retry`, { acknowledgeWarnings: true, confirm });
      toast(`Retry finished: ${r.run.status}`, r.run.status === 'success' ? 'ok' : 'bad');
      nav(`/runs/${r.run.id}`);
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  };

  const facts = [
    ['Started', stamp(run.started_at)],
    ['Finished', stamp(run.finished_at)],
    ['Duration', ms(run.duration_ms)],
    ['Attempts', run.attempts],
    ['Probe reads', `${run.probe_failed} failed or slow of ${run.probe_total}`],
    ['Read impact', ms(run.downtime_ms)],
    ['Rollback time', ms(run.rollback_ms)],
    ['Triggered by', run.triggered_by],
  ];

  return (
    <>
      <p className="crumbs"><Link to="/runs">Runs</Link> / #{run.id}</p>
      <PageHead title={`Run #${run.id}: V${run.version} on ${run.environment}`} sub={`${run.project_name}, ${run.description}`}>
        {run.status === 'success' && <button className="btn" onClick={rollback} disabled={busy}>Roll back</button>}
        {['failed', 'blocked', 'rolled_back'].includes(run.status) && <button className="btn btn-primary" onClick={retry} disabled={busy}>Retry</button>}
      </PageHead>
      <ErrorBox error={actionError} />

      <p className="verdict-line">
        <Badge status={run.status} />
        {run.needs_manual && <span className="tag tag-warn">needs manual review</span>}
        {run.error_code && <code>SQLSTATE {run.error_code}</code>}
      </p>
      {run.error_message && <p className="error-text">{run.error_message}</p>}

      <dl className="facts">
        {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>

      <div className="split">
        <section className="panel">
          <div className="panel-head"><h2>Execution log</h2></div>
          <ol className="log">
            {(run.log || []).map((l, i) => <li key={i}><time>{new Date(l.at).toLocaleTimeString()}</time> {l.msg}</li>)}
          </ol>
        </section>
        <section className="panel">
          <div className="panel-head"><h2>Health checks for this run</h2></div>
          {run.health.length === 0 ? <p className="muted">None recorded.</p> : (
            <ul className="checks">
              {run.health.map((c) => (
                <li key={c.id} className={c.passed ? 'pass' : 'fail'}><span>{c.passed ? 'Pass' : 'Fail'}</span> {c.check_name}: {c.details}</li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
