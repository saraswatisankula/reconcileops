import { useState } from 'react';
import { api } from '../../api.js';
import { useApi } from '../../hooks.js';
import { Badge, Empty, ErrorBox, Field, IssueList, Loading, Modal, useToast } from '../ui.jsx';
import ExecuteDialog from './ExecuteDialog.jsx';
import { ENVS, envShort, ms, when } from '../../format.js';

const PHASES = {
  standard: 'Standard',
  expand: 'Expand',
  migrate: 'Migrate',
  contract: 'Contract',
};

function ScriptEditor({ project, script, nextVersion, onClose, onSaved }) {
  const [form, setForm] = useState(script ? {
    version: script.version, description: script.description, phase: script.phase,
    up_sql: script.up_sql, down_sql: script.down_sql || '',
  } : { version: nextVersion, description: '', phase: 'standard', up_sql: '', down_sql: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { ...form, version: Number(form.version), down_sql: form.down_sql.trim() ? form.down_sql : null };
      const saved = script
        ? await api.put(`/projects/${project.id}/scripts/${script.id}`, body)
        : await api.post(`/projects/${project.id}/scripts`, body);
      onSaved(saved);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={script ? `Edit V${script.version}` : 'New migration script'} onClose={onClose} wide>
      <form className="form" onSubmit={submit}>
        <div className="form-row">
          <Field label="Version">
            <input type="number" min="1" value={form.version} onChange={set('version')} required />
          </Field>
          <Field label="Phase" hint="Expand adds, migrate moves data, contract removes.">
            <select value={form.phase} onChange={set('phase')}>
              {Object.entries(PHASES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Description">
          <input value={form.description} onChange={set('description')} required minLength={3} maxLength={160} placeholder="Add discount column" />
        </Field>
        <Field label="Up script" hint="Use unqualified table names. The executor targets the right environment schema.">
          <textarea className="sql" rows={10} value={form.up_sql} onChange={set('up_sql')} required spellCheck={false} />
        </Field>
        <Field label="Down script" hint="Leave empty if the change can't be reversed. Auto-rollback will then be skipped.">
          <textarea className="sql" rows={5} value={form.down_sql} onChange={set('down_sql')} spellCheck={false} />
        </Field>
        <ErrorBox error={error} />
        <div className="form-actions">
          <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save as draft'}</button>
        </div>
      </form>
    </Modal>
  );
}

function ValidateDialog({ project, script, onClose, onDone }) {
  const [env, setEnv] = useState('development');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post(`/projects/${project.id}/scripts/${script.id}/validate`, { dryRunEnvironment: env || null });
      setResult(r);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Validate V${script.version}`} onClose={onClose} wide>
      <p className="muted">Static checks look for breaking and unsafe SQL. A dry run executes the script on a real
        environment inside a transaction and rolls it back.</p>
      <div className="inline-form">
        <Field label="Dry run on">
          <select value={env} onChange={(e) => setEnv(e.target.value)}>
            <option value="">Skip dry run</option>
            {ENVS.map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
        </Field>
        <button className="btn btn-primary" onClick={run} disabled={busy}>{busy ? 'Validating…' : 'Validate'}</button>
      </div>
      <ErrorBox error={error} />
      {result && (
        <div className="validate-result">
          <p className={`verdict ${result.passed ? 'verdict-ok' : 'verdict-bad'}`}>
            {result.passed ? 'Passed' : 'Rejected'}: {result.errors} error(s), {result.warnings} warning(s) across {result.statementCount} statement(s)
            {result.nonTransactional && '. Runs outside a transaction.'}
          </p>
          {result.dryRun && (
            <p className="muted">
              Dry run on {result.dryRun.environment}:{' '}
              {result.dryRun.skipped ? `skipped (${result.dryRun.reason})` : (
                <>up {result.dryRun.up.ok ? `ok in ${ms(result.dryRun.up.ms)}` : 'failed'}
                  {result.dryRun.down && `, down ${result.dryRun.down.ok ? `ok in ${ms(result.dryRun.down.ms)}` : 'failed'}`}</>
              )}
            </p>
          )}
          <IssueList issues={result.issues} />
        </div>
      )}
    </Modal>
  );
}

function ViewScript({ script, onClose }) {
  const { data } = useApi(`/projects/${script.project_id}/scripts/${script.id}`);
  return (
    <Modal title={`V${script.version} ${script.description}`} onClose={onClose} wide>
      <p className="muted">Checksum <code>{script.checksum.slice(0, 16)}…</code></p>
      <h4>Up</h4>
      <pre className="sql-view">{script.up_sql}</pre>
      <h4>Down</h4>
      {script.down_sql ? <pre className="sql-view">{script.down_sql}</pre> : <p className="muted">No down script. This version cannot be rolled back automatically.</p>}
      {data?.validations?.length > 0 && (
        <>
          <h4>Last validation ({when(data.validations[0].created_at)})</h4>
          <IssueList issues={data.validations[0].issues} />
        </>
      )}
    </Modal>
  );
}

export default function ScriptsTab({ project, onChange }) {
  const { data, error, loading, reload } = useApi(`/projects/${project.id}/scripts`);
  const [dialog, setDialog] = useState(null);
  const toast = useToast();
  const refresh = () => { reload(); onChange(); };

  const reject = async (s) => {
    try {
      await api.patch(`/projects/${project.id}/scripts/${s.id}/status`, { status: 'rejected' });
      toast(`V${s.version} marked rejected`);
      refresh();
    } catch (err) { toast(err.message, 'bad'); }
  };
  const remove = async (s) => {
    if (!window.confirm(`Delete draft V${s.version}?`)) return;
    try {
      await api.del(`/projects/${project.id}/scripts/${s.id}`);
      toast(`Deleted V${s.version}`);
      refresh();
    } catch (err) { toast(err.message, 'bad'); }
  };

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  const next = data.length ? Math.max(...data.map((s) => s.version)) + 1 : 1;

  return (
    <>
      <div className="toolbar">
        <p className="muted">Scripts run in version order. Applied scripts are locked; change them by adding a new version.</p>
        <button className="btn btn-primary" onClick={() => setDialog({ type: 'edit' })}>New script</button>
      </div>

      {data.length === 0 ? (
        <Empty title="No migration scripts">Write the first version to create this service's tables.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table scripts">
            <thead>
              <tr><th>Version</th><th>Description</th><th>Phase</th><th>Status</th><th>Applied in</th><th>Checks</th><th /></tr>
            </thead>
            <tbody>
              {data.map((s) => {
                const applied = s.applied_in || [];
                return (
                  <tr key={s.id}>
                    <td><b>V{s.version}</b></td>
                    <td><button className="link-btn" onClick={() => setDialog({ type: 'view', s })}>{s.description}</button></td>
                    <td><span className={`phase phase-${s.phase}`}>{PHASES[s.phase]}</span></td>
                    <td><Badge status={s.status} /></td>
                    <td>
                      <span className="env-pills">
                        {ENVS.map((e) => <span key={e} className={`env-pill ${applied.includes(e) ? 'on' : ''}`}>{envShort(e)}</span>)}
                      </span>
                    </td>
                    <td className="muted">
                      {s.validated_at ? `${s.error_count} err, ${s.warning_count} warn` : 'not validated'}
                    </td>
                    <td className="row-actions">
                      <button className="btn btn-small" onClick={() => setDialog({ type: 'validate', s })}>Validate</button>
                      <button className="btn btn-small btn-primary" disabled={s.status !== 'validated'} onClick={() => setDialog({ type: 'execute', s })}>Run</button>
                      {applied.length === 0 && (
                        <>
                          <button className="btn btn-small btn-quiet" onClick={() => setDialog({ type: 'edit', s })}>Edit</button>
                          {s.status !== 'rejected' && <button className="btn btn-small btn-quiet" onClick={() => reject(s)}>Reject</button>}
                          <button className="btn btn-small btn-danger-quiet" onClick={() => remove(s)}>Delete</button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {dialog?.type === 'edit' && (
        <ScriptEditor project={project} script={dialog.s} nextVersion={next} onClose={() => setDialog(null)}
          onSaved={(s) => { toast(`Saved V${s.version} as draft`); setDialog(null); refresh(); }} />
      )}
      {dialog?.type === 'validate' && <ValidateDialog project={project} script={dialog.s} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.type === 'execute' && <ExecuteDialog project={project} script={dialog.s} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog?.type === 'view' && <ViewScript script={dialog.s} onClose={() => setDialog(null)} />}
    </>
  );
}
