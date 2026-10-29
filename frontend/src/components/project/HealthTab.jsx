import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../hooks.js';
import { Empty, ErrorBox, Loading } from '../ui.jsx';
import { ENVS, stamp } from '../../format.js';

export default function HealthTab({ project }) {
  const { data, error, loading, reload } = useApi(`/projects/${project.id}/health`);
  const [env, setEnv] = useState('');
  const [onlyFailed, setOnlyFailed] = useState(false);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  const rows = data.filter((h) => (!env || h.environment === env) && (!onlyFailed || !h.passed));

  return (
    <>
      <div className="toolbar">
        <div className="filters">
          <select value={env} onChange={(e) => setEnv(e.target.value)} aria-label="Environment">
            <option value="">All environments</option>
            {ENVS.map((e) => <option key={e}>{e}</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} /> Failed only</label>
        </div>
        <button className="btn btn-quiet" onClick={reload}>Refresh</button>
      </div>
      {rows.length === 0 ? <Empty title="No health checks match" /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Environment</th><th>Check</th><th>Result</th><th>Details</th><th>Run</th></tr></thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.id}>
                  <td className="nowrap">{stamp(h.created_at)}</td>
                  <td>{h.environment}</td>
                  <td><code>{h.check_name}</code></td>
                  <td><span className={h.passed ? 'pass-text' : 'fail-text'}>{h.passed ? 'Pass' : 'Fail'}</span></td>
                  <td className="wrap">{h.details}</td>
                  <td>{h.run_id ? <Link to={`/runs/${h.run_id}`}>#{h.run_id}</Link> : 'manual'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
