import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider';

const NAV = [
  { to: '/provider', label: 'Provider' },
  { to: '/agent-builder', label: 'Agent builder' },
  { to: '/admin', label: 'Admin' },
] as const;

export function AppShell({ title, children }: { title: string; children: ReactNode }) {
  const auth = useAuth();

  return (
    <div className="shell">
      <header className="shell__header">
        <div className="shell__brand">
          <Link to="/" className="shell__logo">
            VeriLink
          </Link>
          <span className="shell__title">{title}</span>
        </div>
        <nav className="shell__nav" aria-label="Primary">
          {NAV.map((item) => (
            <Link key={item.to} to={item.to} className="shell__nav-link">
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="shell__session">
          <label className="shell__tenant">
            Tenant
            <input
              type="text"
              value={auth.tenantId ?? ''}
              placeholder="X-Tenant-Id"
              onChange={(e) => auth.setTenantId(e.target.value.trim() || null)}
              aria-label="Active tenant id"
            />
          </label>
          <button type="button" className="shell__signout" onClick={() => auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="shell__main">{children}</main>
    </div>
  );
}
