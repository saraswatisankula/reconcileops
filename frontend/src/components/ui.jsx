import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { STATUS_LABEL } from '../format.js';

export function PageHead({ title, sub, children }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  );
}

export function Badge({ status, children }) {
  return <span className={`badge badge-${status}`}>{children || STATUS_LABEL[status] || status}</span>;
}

export function Lamp({ state, label }) {
  // state: ok | warn | bad | off
  return <span className={`lamp lamp-${state}`} role="img" aria-label={label} title={label} />;
}

export function Loading({ text = 'Loading' }) {
  return (
    <div className="state state-loading" role="status">
      <span className="spinner" aria-hidden="true" /> {text}…
    </div>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="state state-empty">
      <strong>{title}</strong>
      {children && <div>{children}</div>}
    </div>
  );
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="state state-error" role="alert">
      <strong>{error.message}</strong>
      {error.reasons?.length > 0 && (
        <ul>{error.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
      )}
      {error.details?.length > 0 && (
        <ul>{error.details.map((d) => <li key={d.path + d.message}>{d.path}: {d.message}</li>)}</ul>
      )}
      {onRetry && <button className="btn btn-quiet" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector('input, textarea, select, button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function IssueList({ issues }) {
  if (!issues?.length) return <p className="muted">No issues found.</p>;
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...issues].sort((a, b) => order[a.severity] - order[b.severity]);
  return (
    <ul className="issues">
      {sorted.map((i, n) => (
        <li key={n} className={`issue issue-${i.severity}`}>
          <div className="issue-top">
            <span className="issue-sev">{i.severity}</span>
            <span className="issue-rule">{i.rule}</span>
          </div>
          <p>{i.message}</p>
          {i.statement && <code className="issue-sql">{i.statement}</code>}
          {i.suggestion && <p className="issue-fix">{i.suggestion}</p>}
        </li>
      ))}
    </ul>
  );
}

const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((text, kind = 'ok') => {
    const id = Math.random().toString(36).slice(2);
    setItems((x) => [...x, { id, text, kind }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map((t) => <div key={t.id} className={`toast toast-${t.kind}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export function Field({ label, hint, error, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}
