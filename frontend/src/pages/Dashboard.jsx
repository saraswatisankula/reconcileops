import { Link } from 'react-router-dom';
import { useApi } from '../hooks.js';
import { Badge, Empty, ErrorBox, Loading, PageHead } from '../components/ui.jsx';
import SignalTrack from '../components/SignalTrack.jsx';
import MetricStrip from '../components/MetricStrip.jsx';
import { RunsByDay } from '../components/Charts.jsx';
import { ms, when } from '../format.js';

export default function Dashboard() {
  const { data, error, loading, reload } = useApi('/dashboard');

  if (loading && !data) return <Loading text="Loading overview" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;

  const { metrics, grid, activity } = data;
  const s = metrics.summary;

  return (
    <>
      <PageHead title="Overview" sub="Where every service's schema stands on its way to production.">
        <button className="btn btn-quiet" onClick={reload} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>
      </PageHead>

      {grid.length === 0 ? (
        <Empty title="No services yet">
          Add a service on the <Link to="/projects">Services</Link> page, or load the Product and Order
          services from <Link to="/demo">Demo scenarios</Link>.
        </Empty>
      ) : (
        <section className="panel panel-track" aria-label="Environment health">
          <div className="panel-head">
            <h2>Promotion track</h2>
            <p className="muted">Lamp colour is the latest health check. Green passed, red failed, hollow not checked yet.</p>
          </div>
          <SignalTrack rows={grid} />
        </section>
      )}

      {s.total > 0 && <MetricStrip s={s} />}

      <div className="split">
        <section className="panel">
          <div className="panel-head"><h2>Runs per day</h2></div>
          {metrics.daily.length ? <RunsByDay data={metrics.daily} /> : <Empty title="No runs yet">Execute a validated script to see it here.</Empty>}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>Latest activity</h2>
            <Link to="/audit" className="link-quiet">Full audit log</Link>
          </div>
          {activity.length ? (
            <ul className="feed">
              {activity.map((a) => (
                <li key={a.id}>
                  <span className="feed-action">{a.action}</span>
                  <span className="feed-who">{a.actor}</span>
                  <time className="feed-time">{when(a.created_at)}</time>
                </li>
              ))}
            </ul>
          ) : <Empty title="Nothing recorded yet" />}
        </section>
      </div>

      {metrics.recent.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2>Recent runs</h2>
            <Link to="/runs" className="link-quiet">All runs</Link>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Run</th><th>Service</th><th>Environment</th><th>Version</th><th>Status</th><th className="num">Duration</th><th className="num">Read impact</th></tr></thead>
              <tbody>
                {[...metrics.recent].reverse().slice(0, 8).map((r) => (
                  <tr key={r.id}>
                    <td><Link to={`/runs/${r.id}`}>#{r.id}</Link></td>
                    <td>{r.project}</td>
                    <td>{r.environment}</td>
                    <td>V{r.version}</td>
                    <td><Badge status={r.status} /></td>
                    <td className="num">{ms(r.duration_ms)}</td>
                    <td className="num">{ms(r.downtime_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
