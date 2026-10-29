import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { Badge, ErrorBox, Field, Modal } from '../ui.jsx';
import { ENVS, ms } from '../../format.js';

export default function ExecuteDialog({ project, script, onClose, onDone }) {
  const [env, setEnv] = useState('development');
  const [pre, setPre] = useState(null);
  const [ack, setAck] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setPre(null);
    api.get(`/projects/${project.id}/scripts/${script.id}/preflight?environment=${env}`)
      .then((p) => live && setPre(p))
      .catch((e) => live && setError(e));
    return () => { live = false; };
  }, [env, project.id, script.id]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`/projects/${project.id}/scripts/${script.id}/execute`, {
        environment: env, acknowledgeWarnings: ack, confirm: confirm || undefined,
      });
      setResult(r);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const needsAck = pre?.warnings > 0;
  const canRun = pre?.ok && (!needsAck || ack) && (!pre?.needsConfirm || confirm === project.slug);

  return (
    <Modal title={`Run V${script.version} ${script.description}`} onClose={onClose} wide>
      {!result && (
        <>
          <Field label="Target environment">
            <select value={env} onChange={(e) => { setEnv(e.target.value); setConfirm(''); }}>
              {ENVS.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </Field>

          {!pre && !error && <p className="muted">Checking pre-flight rules…</p>}
          {pre && !pre.ok && (
            <div className="state state-error">
              <strong>This run would be blocked</strong>
              <ul>{pre.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            </div>
          )}
          {pre?.ok && (
            <div className="preflight-ok">
              <p>Pre-flight checks pass. The script runs {script.up_sql.match(/CONCURRENTLY/i) ? 'outside a transaction' : 'in a single transaction'} with
                lock and statement timeouts. Read probes for each live app version run alongside it.</p>
              {needsAck && (
                <label className="check">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  I have reviewed the {pre.warnings} validation warning(s)
                </label>
              )}
              {pre.needsConfirm && (
                <Field label={`Type ${project.slug} to run on ${env}`}>
                  <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
                </Field>
              )}
            </div>
          )}
          <ErrorBox error={error} />
          <div className="form-actions">
            <button className="btn btn-quiet" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" onClick={run} disabled={!canRun || busy}>{busy ? 'Running…' : `Run on ${env}`}</button>
          </div>
        </>
      )}

      {result && (
        <div className="run-result">
          <p className="verdict-line">
            <Badge status={result.run.status} />
            {result.run.needs_manual && <span className="tag tag-warn">needs manual review</span>}
            <span>{ms(result.run.duration_ms)}, {result.run.attempts} attempt(s), {result.run.probe_failed}/{result.run.probe_total} probe reads impacted</span>
          </p>
          {result.run.error_message && <p className="error-text">{result.run.error_message}</p>}
          <h4>Execution log</h4>
          <ol className="log">
            {result.run.log.map((l, i) => <li key={i}><time>{new Date(l.at).toLocaleTimeString()}</time> {l.msg}</li>)}
          </ol>
          <h4>Health after run</h4>
          <ul className="checks">
            {result.health.checks.map((c) => (
              <li key={c.check} className={c.passed ? 'pass' : 'fail'}><span>{c.passed ? 'Pass' : 'Fail'}</span> {c.check}: {c.details}</li>
            ))}
          </ul>
          <div className="form-actions">
            <Link className="btn btn-quiet" to={`/runs/${result.run.id}`}>Open run #{result.run.id}</Link>
            <button className="btn btn-primary" onClick={onClose}>Done</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
