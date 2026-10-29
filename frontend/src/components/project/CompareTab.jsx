import { useState } from 'react';
import { useApi } from '../../hooks.js';
import { Empty, ErrorBox, Loading } from '../ui.jsx';

const SIDES = ['desired', 'development', 'staging', 'production'];

function TableCard({ name, def, highlight }) {
  return (
    <div className="schema-table">
      <h4>{name}</h4>
      <table>
        <tbody>
          {Object.entries(def.columns).map(([c, info]) => (
            <tr key={c} className={highlight.has(`${name}.${c}`) ? 'diff-row' : ''}>
              <td><code>{c}</code></td>
              <td className="muted">{info.type}{info.nullable ? '' : ', not null'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {def.indexes.length > 0 && <p className="muted small">{def.indexes.length} index(es), {def.constraints.length} constraint(s)</p>}
    </div>
  );
}

function SchemaSide({ side, highlight }) {
  const tables = Object.entries(side.schema?.tables || {});
  return (
    <div className="compare-side">
      <h3>{side.label}</h3>
      {side.error && <p className="error-text">{side.error}</p>}
      {tables.length === 0 ? <p className="muted">No tables.</p> :
        tables.map(([t, def]) => <TableCard key={t} name={t} def={def} highlight={highlight} />)}
    </div>
  );
}

export default function CompareTab({ project }) {
  const [left, setLeft] = useState('desired');
  const [right, setRight] = useState('development');
  const { data, error, loading, reload } = useApi(`/projects/${project.id}/compare?left=${left}&right=${right}`);

  const highlight = new Set((data?.differences || []).filter((d) => d.column).map((d) => `${d.table}.${d.column}`));

  return (
    <>
      <div className="toolbar compare-bar">
        <label>Compare
          <select value={left} onChange={(e) => setLeft(e.target.value)}>{SIDES.map((s) => <option key={s}>{s}</option>)}</select>
        </label>
        <label>with
          <select value={right} onChange={(e) => setRight(e.target.value)}>{SIDES.map((s) => <option key={s}>{s}</option>)}</select>
        </label>
        <button className="btn btn-quiet" onClick={reload}>Refresh</button>
      </div>
      {loading && !data && <Loading text="Reading both schemas" />}
      <ErrorBox error={error} />
      {data && (
        <>
          <section className="panel">
            <div className="panel-head"><h2>{data.differences.length ? `${data.differences.length} difference(s)` : 'Schemas match'}</h2></div>
            {data.differences.length ? (
              <ul className="diff-list">
                {data.differences.map((d, i) => (
                  <li key={i}><span className={`diff-kind kind-${d.kind.split('_')[1]}`}>{d.kind.replace('_', ' ')}</span> {d.message}</li>
                ))}
              </ul>
            ) : <Empty title={`${left} and ${right} have the same structure`} />}
          </section>
          <div className="compare-grid">
            <SchemaSide side={data.left} highlight={highlight} />
            <SchemaSide side={data.right} highlight={highlight} />
          </div>
        </>
      )}
    </>
  );
}
