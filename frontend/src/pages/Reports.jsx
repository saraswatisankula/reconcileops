import { useState } from 'react';
import { downloadCsv, qs } from '../api.js';
import { useApi } from '../hooks.js';
import { Empty, ErrorBox, Loading, PageHead, useToast } from '../components/ui.jsx';
import RunFilters, { EMPTY_FILTERS } from '../components/RunFilters.jsx';
import MetricStrip from '../components/MetricStrip.jsx';
import { IssuesByRule, PerRun, RunsByDay } from '../components/Charts.jsx';
import { ms } from '../format.js';

export default function Reports() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const { data, error, loading, reload } = useApi(`/metrics${qs(filters)}`);
  const [exporting, setExporting] = useState(false);
  const toast = useToast();

  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadCsv(filters);
      toast('CSV downloaded');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      setExporting(false);
    }
  };

  const perRun = (data?.recent || []).map((r) => ({ ...r, label: `#${r.id}` }));

  return (
    <>
      <PageHead title="Reports" sub="Migration success, measured read impact, rollbacks and caught breaking changes, from recorded runs only.">
        <button className="btn btn-primary" onClick={exportCsv} disabled={exporting}>{exporting ? 'Exporting…' : 'Export runs as CSV'}</button>
      </PageHead>
      <div className="toolbar"><RunFilters value={filters} onChange={setFilters} /></div>

      {loading && !data && <Loading />}
      <ErrorBox error={error} onRetry={reload} />

      {data && data.summary.total === 0 && <Empty title="No runs match these filters">Run a migration or load the demo scenarios.</Empty>}

      {data && data.summary.total > 0 && (
        <>
          <MetricStrip s={data.summary} />

          <p className="method-note">
            Read impact is measured, not estimated: while a migration runs, ReconcileOps repeatedly runs the SELECT that each live app
            version depends on. A probe that errors or takes over 250 ms counts toward the total. Fast migrations on small demo tables
            can finish before any probe is slowed down, so a zero means no impact was observed, not that none is possible.
          </p>

          <section className="panel">
            <div className="panel-head"><h2>Runs per day by outcome</h2></div>
            <RunsByDay data={data.daily} />
          </section>

          <div className="split">
            <section className="panel">
              <div className="panel-head"><h2>Duration per run</h2><span className="muted">last {perRun.length}</span></div>
              <PerRun data={perRun} dataKey="duration_ms" name="Duration" />
            </section>
            <section className="panel">
              <div className="panel-head"><h2>Read impact per run</h2><span className="muted">last {perRun.length}</span></div>
              <PerRun data={perRun} dataKey="downtime_ms" name="Read impact" color="#B67C00" />
            </section>
          </div>

          <div className="split">
            <section className="panel">
              <div className="panel-head"><h2>Validation findings by rule</h2></div>
              {data.issues.length ? <IssuesByRule data={data.issues} /> : <p className="muted">No findings recorded.</p>}
            </section>
            <section className="panel">
              <div className="panel-head"><h2>By environment</h2></div>
              <table className="table">
                <thead><tr><th>Environment</th><th className="num">Runs</th><th className="num">Succeeded</th></tr></thead>
                <tbody>
                  {data.byEnv.map((e) => (
                    <tr key={e.environment}><td>{e.environment}</td><td className="num">{e.runs}</td><td className="num">{e.success}</td></tr>
                  ))}
                </tbody>
              </table>
              <p className="muted small">Average duration {ms(data.summary.avg_duration_ms)}, longest single read impact {ms(data.summary.max_downtime_ms)}.</p>
            </section>
          </div>
        </>
      )}
    </>
  );
}
