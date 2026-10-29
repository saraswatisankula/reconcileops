import { useState } from 'react';
import { Link } from 'react-router-dom';
import { qs } from '../api.js';
import { useApi } from '../hooks.js';
import { Badge, Empty, ErrorBox, Loading, PageHead } from '../components/ui.jsx';
import RunFilters, { EMPTY_FILTERS } from '../components/RunFilters.jsx';
import { ms, stamp } from '../format.js';

export default function Runs() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const { data, error, loading, reload } = useApi(`/runs${qs(filters)}`);

  return (
    <>
      <PageHead title="Runs" sub="Every execution attempt, including blocked and rolled back ones." />
      <div className="toolbar">
        <RunFilters value={filters} onChange={setFilters} />
        <button className="btn btn-quiet" onClick={reload}>Refresh</button>
      </div>
      {loading && !data && <Loading />}
      <ErrorBox error={error} onRetry={reload} />
      {data && data.length === 0 && <Empty title="No runs match these filters" />}
      {data && data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Run</th><th>Started</th><th>Service</th><th>Env</th><th>Script</th><th>Status</th><th className="num">Tries</th><th className="num">Duration</th><th className="num">Read impact</th><th>Note</th></tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td><Link to={`/runs/${r.id}`}>#{r.id}</Link></td>
                  <td className="nowrap">{stamp(r.started_at)}</td>
                  <td>{r.project_name}</td>
                  <td>{r.environment}</td>
                  <td>V{r.version} {r.description}</td>
                  <td><Badge status={r.status} />{r.needs_manual && <span className="tag tag-warn">manual</span>}</td>
                  <td className="num">{r.attempts}</td>
                  <td className="num">{ms(r.duration_ms)}</td>
                  <td className="num">{ms(r.downtime_ms)}</td>
                  <td className="wrap muted">{r.error_message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
