import { Suspense, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { ErrorBoundary } from './ErrorBoundary';
import { Spinner } from './ui';
import { t } from '../lib/i18n';
import type { Role } from '../lib/types';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  roles: Role[];
}

// Bottom navigation (owner/cashier reach everything else from Home).
const NAV: NavItem[] = [
  { to: '/', label: t('home'), icon: '🏠', roles: ['owner', 'cashier', 'worker', 'customer'] },
  { to: '/bill', label: 'New bill', icon: '🧾', roles: ['owner', 'cashier'] },
  { to: '/bills', label: 'Bills', icon: '📋', roles: ['owner', 'cashier'] },
  { to: '/cash', label: 'Cash', icon: '💵', roles: ['owner', 'cashier'] },
  { to: '/me', label: 'My pay', icon: '📒', roles: ['worker'] },
  { to: '/profile', label: t('profile'), icon: '👤', roles: ['owner', 'cashier', 'worker', 'customer'] },
];

/**
 * Netlify's free plan adds a "Powered by Netlify" badge fixed to the bottom-right corner.
 * While it is visible, lift the bottom menu (and bars above it) so the badge never
 * covers a button. If the badge is gone (turned off, or dismissed with "Hide this badge"),
 * everything moves back down.
 */
function useBadgeGap() {
  useEffect(() => {
    const check = () => {
      const badge = document.getElementById('nl-badge-frame');
      const r = badge?.getBoundingClientRect();
      const visible = !!r && r.height > 0 && r.bottom > window.innerHeight - 4 && getComputedStyle(badge!).display !== 'none';
      document.documentElement.style.setProperty('--badge-gap', visible ? `${Math.ceil(window.innerHeight - r!.top)}px` : '0px');
    };
    check();
    const timer = setInterval(check, 1500);
    window.addEventListener('resize', check);
    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', check);
    };
  }, []);
}

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function Layout() {
  const { profile } = useAuth();
  const { pathname } = useLocation();
  const online = useOnline();
  useBadgeGap();
  const items = NAV.filter((n) => profile && n.roles.includes(profile.role));

  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col">
      <header className="sticky top-0 z-20 bg-brand-800 px-4 py-3 text-white shadow">
        <h1 className="text-lg font-bold">🍄 {t('appName')}</h1>
      </header>
      {!online && (
        <div role="alert" className="bg-amber-100 px-4 py-2 text-sm font-medium text-amber-900">
          No internet. You can look around, but bills cannot be saved until you are back online.
        </div>
      )}

      <main className="flex-1 px-4 pt-4" style={{ paddingBottom: 'calc(7rem + var(--badge-gap))' }}>
        <ErrorBoundary resetKey={pathname}>
          <Suspense fallback={<Spinner />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>

      <nav className="above-badge fixed inset-x-0 z-30 border-t border-gray-200 bg-white pb-[env(safe-area-inset-bottom)]">
        <ul className="mx-auto flex max-w-3xl">
          {items.map((n) => (
            <li key={n.to} className="flex-1">
              <NavLink
                to={n.to}
                end={n.to === '/'}
                className={({ isActive }) =>
                  `flex min-h-16 flex-col items-center justify-center text-xs font-medium ${
                    isActive ? 'text-brand-800' : 'text-gray-500'
                  }`
                }
              >
                <span className="text-xl" aria-hidden>
                  {n.icon}
                </span>
                {n.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
