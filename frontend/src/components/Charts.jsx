import {
  Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { STATUS_COLORS, STATUS_LABEL } from '../format.js';

const axis = { stroke: '#8A95A3', fontSize: 12, tickLine: false, axisLine: { stroke: '#CDD4DC' } };
const ORDER = ['success', 'rolled_back', 'failed', 'blocked'];

function Tip({ active, payload, label, unit = '' }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <div className="chart-tip-head">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="chart-tip-row">
          <span className="swatch" style={{ background: p.color }} />
          <span>{p.name}</span>
          <b>{p.value}{unit}</b>
        </div>
      ))}
    </div>
  );
}

export function RunsByDay({ data }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barCategoryGap="30%" maxBarSize={56}>
        <CartesianGrid vertical={false} stroke="#E3E8ED" />
        <XAxis dataKey="day" {...axis} />
        <YAxis allowDecimals={false} {...axis} />
        <Tooltip content={<Tip />} cursor={{ fill: 'rgba(24,33,45,.05)' }} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span style={{ color: '#455163' }}>{v}</span>} />
        {ORDER.map((k, i) => (
          <Bar key={k} dataKey={k} name={STATUS_LABEL[k]} stackId="s" fill={STATUS_COLORS[k]}
            stroke="#fff" strokeWidth={2} radius={i === ORDER.length - 1 ? [4, 4, 0, 0] : 0} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export function PerRun({ data, dataKey, name, unit = ' ms', color = '#2D4DB0' }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -10, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="#E3E8ED" />
        <XAxis dataKey="label" {...axis} interval="preserveStartEnd" />
        <YAxis allowDecimals={false} {...axis} />
        <Tooltip content={<Tip unit={unit} />} cursor={{ fill: 'rgba(24,33,45,.05)' }} />
        <Bar dataKey={dataKey} name={name} fill={color} radius={[4, 4, 0, 0]} maxBarSize={28} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function IssuesByRule({ data }) {
  const rows = data.map((d) => ({ ...d, label: d.rule }));
  return (
    <ResponsiveContainer width="100%" height={Math.max(140, rows.length * 34 + 30)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, left: 10, bottom: 0 }}>
        <CartesianGrid horizontal={false} stroke="#E3E8ED" />
        <XAxis type="number" allowDecimals={false} {...axis} />
        <YAxis type="category" dataKey="label" width={150} {...axis} />
        <Tooltip content={<Tip />} cursor={{ fill: 'rgba(24,33,45,.05)' }} />
        <Bar dataKey="count" name="Findings" fill="#2D4DB0" radius={[0, 4, 4, 0]} maxBarSize={18} />
      </BarChart>
    </ResponsiveContainer>
  );
}
