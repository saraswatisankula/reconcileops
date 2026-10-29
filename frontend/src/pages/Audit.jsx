import { useState } from 'react';
import { qs } from '../api.js';
import { useApi } from '../hooks.js';
import { Empty, ErrorBox, Loading, PageHead } from '../components/ui.jsx';
import { stamp } from '../format.js';

const PREFIXES = ['migration', 'rollback', 'script', 'app', 'reconcile', 'health', 'settings', 'project', 'demo'];

export default function Audit() {
  const [action, setAction] = useState('');
  const { data, error, loading, reload } = useApi(`/audit${qs({ action, limit: 300 })}`);
  const [open, setOpen] = useState(null);

  return (
    <>
      <PageHead title="Audit log" sub="An append-only record of who changed what. Nothing here can be edited from the UI." />
      <div className="toolbar">
        <div className="filters">
          <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action type">
            <option value="">All actions</option>
            {PREFIXES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <button className="btn btn-quiet" onClick={reload}>Refresh</button>
      </div>
      {loading && !data && <Loading />}
      <ErrorBox error={error} onRetry={reload} />
      {data && data.length === 0 && <Empty title="No entries" />}
      {data && data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td className="nowrap">{stamp(a.created_at)}</td>
                  <td>{a.actor}</td>
                  <td><code>{a.action}</code></td>
                  <td>{a.entity}{a.entity_id ? ` #${a.entity_id}` : ''}</td>
                  <td className="wrap">
                    <button className="link-btn" onClick={() => setOpen(open === a.id ? null : a.id)}>{open === a.id ? 'Hide' : 'Show'}</button>
                    {open === a.id && <pre className="json">{JSON.stringify(a.details, null, 2)}</pre>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
