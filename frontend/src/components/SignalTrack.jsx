import { Link } from 'react-router-dom';
import { Lamp } from './ui.jsx';
import { envShort } from '../format.js';

function lampState(env) {
  if (!env.checked) return 'off';
  if (env.passed) return 'ok';
  return 'bad';
}

// One row per service, a lamp per environment, joined by a track line.
// It mirrors the promotion path: development -> staging -> production.
export default function SignalTrack({ rows }) {
  return (
    <div className="track-board">
      {rows.map((p) => (
        <div className="track-row" key={p.id}>
          <Link to={`/projects/${p.id}`} className="track-name">{p.name}</Link>
          <ol className="track-line">
            {p.environments.map((e) => {
              const state = lampState(e);
              const label = state === 'off'
                ? `${e.name}: not checked yet`
                : state === 'ok' ? `${e.name}: healthy` : `${e.name}: ${e.failing.join(', ')}`;
              return (
                <li key={e.name} className={`track-stop stop-${state}`}>
                  <Lamp state={state} label={label} />
                  <span className="track-env">
                    {envShort(e.name)}
                    <span className="track-ver">{e.version ? `at V${e.version}` : 'empty'}</span>
                  </span>
                  {state === 'bad' && <span className="track-why">{e.failing[0]}</span>}
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </div>
  );
}
