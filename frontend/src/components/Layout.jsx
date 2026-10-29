import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/projects', label: 'Services' },
  { to: '/reconcile', label: 'Reconcile' },
  { to: '/runs', label: 'Runs' },
  { to: '/reports', label: 'Reports' },
  { to: '/audit', label: 'Audit log' },
  { to: '/demo', label: 'Demo scenarios' },
  { to: '/settings', label: 'Settings' },
];

export default function Layout() {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);

  return (
    <div className="shell">
      <aside className={`rail ${open ? 'rail-open' : ''}`}>
        <div className="brand">
          <svg viewBox="0 0 40 16" width="40" height="16" aria-hidden="true">
            <line x1="4" y1="8" x2="36" y2="8" stroke="currentColor" strokeWidth="1.5" opacity=".45" />
            <circle cx="6" cy="8" r="4" fill="#2A9D6A" />
            <circle cx="20" cy="8" r="4" fill="#2A9D6A" />
            <circle cx="34" cy="8" r="4" fill="#B67C00" />
          </svg>
          <span>ReconcileOps</span>
        </div>
        <nav aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <p className="rail-foot">Zero-downtime schema migrations for microservices</p>
      </aside>
      <div className="main">
        <div className="topbar">
          <button className="menu-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label="Toggle menu">
            <span /><span /><span />
          </button>
          <span className="topbar-title">ReconcileOps</span>
        </div>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
