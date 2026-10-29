import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { Badge, Empty, ErrorBox, Field, Loading, PageHead, useToast } from '../components/ui.jsx';
import { ENVS } from '../format.js';

const STATE_TEXT = {
  in_sync: ['In sync', 'The environment matches the desired schema, history and app requirements.'],
  pending: ['Changes pending', 'Validated scripts are waiting to be applied. Review the plan below.'],
  drift: ['Drift detected', 'The real schema differs from what the history says it should be. Fix it before applying anything.'],
  blocked: ['Blocked', 'Some findings must be resolved before a plan can be produced.'],
};

export default function Reconcile() {
  const [params, setParams] = useSearchParams();
  const projects = useApi('/projects');
  const projectId = params.get('project') || projects.data?.[0]?.id || '';
  const environment = params.get('environment') || 'development';
  const report = useApi(projectId ? `/projects/${projectId}/reconcile?environment=${environment}` : null);
  const [ack, setAck] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState(null);
  const [applyError, setApplyError] = useState(null);
  const toast = useToast();

  const pick = (k, v) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    if (!next.get('project') && projectId) next.set('project', projectId);
    setParams(next);
    setApplyResult(null);
    setApplyError(null);
  };

  const apply = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      const r = await api.post(`/projects/${projectId}/reconcile/apply`, {
        environment, acknowledgeWarnings: ack, confirm: confirm || undefined,
      });
      setApplyResult(r);
      toast(r.blocked ? 'Plan is blocked' : `Applied ${r.results.filter((x) => x.status === 'success').length} script(s)`, r.blocked ? 'bad' : 'ok');
      report.reload();
    } catch (err) {
      setApplyError(err);
    } finally {
      setApplying(false);
    }
  };

  if (projects.loading && !projects.data) return <Loading />;
  if (projects.error) return <ErrorBox error={projects.error} onRetry={projects.reload} />;
  if (!projects.data.length) {
    return (
      <>
        <PageHead title="Reconcile" />
        <Empty title="No services to reconcile">Load the demo from <Link to="/demo">Demo scenarios</Link> first.</Empty>
      </>
    );
  }

  const r = report.data;
  const project = projects.data.find((p) => String(p.id) === String(projectId));

  return (
    <>
      <PageHead title="Reconcile" sub="Compares the desired schema, the real schema, the migration history and what live apps need, then plans the next steps." />

      <div className="toolbar">
        <div className="filters">
          <select value={projectId} onChange={(e) => pick('project', e.target.value)} aria-label="Service">
            {projects.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div className="seg" role="group" aria-label="Environment">
            {ENVS.map((e) => (
              <button key={e} className={environment === e ? 'on' : ''} onClick={() => pick('environment', e)}>{e}</button>
            ))}
          </div>
        </div>
        <button className="btn btn-quiet" onClick={report.reload} disabled={report.loading}>Re-run</button>
      </div>

      {report.loading && !r && <Loading text="Building desired schema and reading the environment" />}
      <ErrorBox error={report.error} onRetry={report.reload} />

      {r && (
        <>
          <section className={`state-banner banner-${r.state}`}>
            <h2>{STATE_TEXT[r.state][0]}</h2>
            <p>{STATE_TEXT[r.state][1]}</p>
            <p className="banner-versions">Current V{r.currentVersion}, target V{r.targetVersion}, schema <code>{r.schema}</code></p>
          </section>

          <div className="sources">
            <div><span>Desired schema</span><b>{r.sources.desiredTables}</b> table(s) from validated scripts</div>
            <div><span>Actual schema</span><b>{r.sources.actualTables}</b> table(s) in {r.environment}</div>
            <div><span>Migration history</span><b>{r.sources.historyEntries}</b> applied version(s)</div>
            <div><span>App requirements</span><b>{r.sources.activeRequirements}</b> column(s) read by live apps</div>
          </div>

          <div className="split">
            <section className="panel">
              <div className="panel-head"><h2>Findings</h2></div>
              {r.findings.length === 0 ? <p className="muted">Nothing to report.</p> : (
                <ul className="issues">
                  {r.findings.map((f, i) => (
                    <li key={i} className={`issue issue-${f.severity}`}>
                      <div className="issue-top"><span className="issue-sev">{f.severity}</span><span className="issue-rule">{f.type}</span></div>
                      <p>{f.message}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="panel">
              <div className="panel-head"><h2>Plan</h2></div>
              {r.plan.length === 0 ? (
                <p className="muted">{r.state === 'in_sync' ? 'Nothing to apply.' : 'No plan while there are blocking findings.'}</p>
              ) : (
                <>
                  <ol className="plan">
                    {r.plan.map((s) => (
                      <li key={s.scriptId}><b>V{s.version}</b> {s.description} <span className={`phase phase-${s.phase}`}>{s.phase}</span></li>
                    ))}
                  </ol>
                  {r.changes.length > 0 && (
                    <details className="changes">
                      <summary>{r.changes.length} structural change(s) this plan makes</summary>
                      <ul>{r.changes.map((c, i) => <li key={i}>{c.message}</li>)}</ul>
                    </details>
                  )}
                  <label className="check">
                    <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                    I have reviewed validation warnings for these scripts
                  </label>
                  {environment === 'production' && project && (
                    <Field label={`Type ${project.slug} to apply in production`}>
                      <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
                    </Field>
                  )}
                  <button className="btn btn-primary" onClick={apply} disabled={applying}>{applying ? 'Applying…' : `Apply plan to ${environment}`}</button>
                </>
              )}
              <ErrorBox error={applyError} />
              {applyResult?.results?.length > 0 && (
                <ul className="apply-results">
                  {applyResult.results.map((x) => (
                    <li key={x.version}>
                      V{x.version} <Badge status={x.status} />
                      {x.runId && <Link to={`/runs/${x.runId}`}> run #{x.runId}</Link>}
                      {x.reasons && <span className="muted"> {x.reasons.join(' ')}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}
