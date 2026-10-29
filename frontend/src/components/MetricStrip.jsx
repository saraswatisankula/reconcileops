import { ms } from '../format.js';

// Every number here comes from migration_runs / validation_results rows.
export default function MetricStrip({ s }) {
  const items = [
    { label: 'Success rate', value: s.success_rate === null ? '–' : `${s.success_rate}%`, note: `${s.success} of ${s.success + s.failed + s.rolled_back} finished runs` },
    { label: 'Measured read impact', value: ms(s.total_downtime_ms), note: `${s.probe_failed} of ${s.probe_total} probe reads failed or slow` },
    { label: 'Average rollback', value: s.rollbacks ? ms(s.avg_rollback_ms) : '–', note: `${s.rollbacks} rollback(s)` },
    { label: 'Breaking changes caught', value: s.compatibility_issues, note: `${s.validations_rejected} script(s) rejected` },
    { label: 'Manual follow-ups', value: s.manual, note: 'runs flagged for a human' },
  ];
  return (
    <dl className="metric-strip">
      {items.map((i) => (
        <div key={i.label} className="metric">
          <dt>{i.label}</dt>
          <dd>{i.value}</dd>
          <span className="metric-note">{i.note}</span>
        </div>
      ))}
    </dl>
  );
}
