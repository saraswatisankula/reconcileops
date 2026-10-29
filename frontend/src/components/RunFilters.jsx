import { useApi } from '../hooks.js';
import { ENVS, STATUS_LABEL } from '../format.js';

export const EMPTY_FILTERS = { projectId: '', environment: '', status: '', from: '', to: '' };

export default function RunFilters({ value, onChange }) {
  const { data: projects } = useApi('/projects');
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  const dirty = Object.values(value).some(Boolean);

  return (
    <div className="filters" role="group" aria-label="Filters">
      <select value={value.projectId} onChange={set('projectId')} aria-label="Service">
        <option value="">All services</option>
        {(projects || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <select value={value.environment} onChange={set('environment')} aria-label="Environment">
        <option value="">All environments</option>
        {ENVS.map((e) => <option key={e}>{e}</option>)}
      </select>
      <select value={value.status} onChange={set('status')} aria-label="Status">
        <option value="">Any status</option>
        {['success', 'failed', 'rolled_back', 'blocked', 'running'].map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
      </select>
      <label className="date">From <input type="date" value={value.from} onChange={set('from')} /></label>
      <label className="date">To <input type="date" value={value.to} onChange={set('to')} /></label>
      {dirty && <button className="btn btn-small btn-quiet" onClick={() => onChange(EMPTY_FILTERS)}>Clear</button>}
    </div>
  );
}
