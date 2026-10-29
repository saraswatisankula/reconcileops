import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApi } from '../hooks.js';
import { ErrorBox, Loading, PageHead, useToast } from '../components/ui.jsx';

const EXPECT = {
  success: 'should succeed',
  rejected: 'should be rejected',
  failed: 'should fail safely',
  rolled_back: 'should roll back',
  drift: 'should create drift',
};

export default function Demo() {
  const { data: steps, error, loading } = useApi('/demo/steps');
  const [results, setResults] = useState({});
  const [busy, setBusy] = useState(null);
  const toast = useToast();

  const reset = async () => {
    if (!window.confirm('This drops the demo schemas and recreates both demo services. Continue?')) return;
    setBusy('reset');
    try {
      await api.post('/demo/reset');
      setResults({});
      toast('Demo services recreated');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setBusy(null);
    }
  };

  const run = async (key) => {
    setBusy(key);
    try {
      const r = await api.post(`/demo/steps/${key}`);
      setResults((x) => ({ ...x, [key]: r }));
    } catch (err) {
      setResults((x) => ({ ...x, [key]: { error: err.message } }));
    } finally {
      setBusy(null);
    }
  };

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;

  const groups = [...new Set(steps.map((s) => s.group))];
  let n = 0;

  return (
    <>
      <PageHead title="Demo scenarios" sub="A walkthrough with two services. Every step runs real SQL on the isolated demo database through the same code paths as the rest of the app.">
        <button className="btn" onClick={reset} disabled={busy !== null}>{busy === 'reset' ? 'Resetting…' : 'Reset demo data'}</button>
      </PageHead>
      <p className="muted">Start with Reset, then run the steps in order. Results are whatever the database actually returns.</p>

      {groups.map((g) => (
        <section key={g} className="demo-group">
          <h2>{g}</h2>
          <ol className="steps">
            {steps.filter((s) => s.group === g).map((s) => {
              n += 1;
              const r = results[s.key];
              return (
                <li key={s.key} className="step">
                  <span className="step-num">{n}</span>
                  <div className="step-body">
                    <h3>{s.title}</h3>
                    <p>{s.explain} <span className="muted">This {EXPECT[s.expect]}.</span></p>
                    {r?.error && <p className="error-text">{r.error}</p>}
                    {r?.results && (
                      <ul className="step-results">
                        {r.results.map((x, i) => (
                          <li key={i} className={x.ok ? 'pass' : 'fail'}>
                            <span>{x.ok ? 'OK' : x.status === 'rolled_back' ? 'Rolled back' : x.status === 'failed' ? 'Failed' : 'Refused'}</span>
                            {x.label}: {x.detail}
                            {x.runId && <> <Link to={`/runs/${x.runId}`}>run #{x.runId}</Link></>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <button className="btn btn-small btn-primary" onClick={() => run(s.key)} disabled={busy !== null}>
                    {busy === s.key ? 'Running…' : r ? 'Run again' : 'Run step'}
                  </button>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </>
  );
}
