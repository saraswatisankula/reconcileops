export const ENVS = ['development', 'staging', 'production'];

export const STATUS_COLORS = {
  success: '#2A9D6A',
  rolled_back: '#B67C00',
  failed: '#A3243F',
  blocked: '#5B6FB0',
};

export const STATUS_LABEL = {
  success: 'Succeeded',
  failed: 'Failed',
  rolled_back: 'Rolled back',
  blocked: 'Blocked',
  running: 'Running',
  draft: 'Draft',
  validated: 'Validated',
  rejected: 'Rejected',
};

export function ms(v) {
  if (v === null || v === undefined) return '–';
  if (v < 1000) return `${v} ms`;
  return `${(v / 1000).toFixed(v < 10000 ? 2 : 1)} s`;
}

export function when(ts) {
  if (!ts) return '–';
  const d = new Date(ts);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function stamp(ts) {
  return ts ? new Date(ts).toLocaleString() : '–';
}

export function envShort(name) {
  return { development: 'Dev', staging: 'Staging', production: 'Prod' }[name] || name;
}
