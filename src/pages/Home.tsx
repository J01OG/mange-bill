import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { InstallCard } from '../components/AppUpdates';
import { Card } from '../components/ui';
import { t } from '../lib/i18n';
import { ROLE_LABEL, type Role } from '../lib/types';

interface Tile {
  label: string;
  icon: string;
  to?: string; // no link yet = coming in a later phase
  roles: Role[];
}

const TILES: Tile[] = [
  { label: 'New bill', icon: '🧾', to: '/bill', roles: ['owner', 'cashier'] },
  { label: 'Bills', icon: '📋', to: '/bills', roles: ['owner', 'cashier'] },
  { label: 'Returns / refunds', icon: '↩️', to: '/returns', roles: ['owner', 'cashier'] },
  { label: 'Cash & cash out', icon: '💵', to: '/cash', roles: ['owner', 'cashier'] },
  { label: 'Products', icon: '📦', to: '/products', roles: ['owner'] },
  { label: 'Coupons', icon: '🏷️', to: '/coupons', roles: ['owner'] },
  { label: 'Workforce', icon: '👷', to: '/workers', roles: ['owner'] },
  { label: 'Attendance', icon: '✅', to: '/attendance', roles: ['owner'] },
  { label: 'Orders & calendar', icon: '📅', to: '/orders', roles: ['owner'] },
  { label: 'Today’s deliveries', icon: '🚚', to: '/orders', roles: ['cashier'] },
  { label: 'Reports', icon: '📊', to: '/reports', roles: ['owner'] },
  { label: 'Users', icon: '👥', to: '/users', roles: ['owner'] },
  { label: 'Farm settings', icon: '⚙️', to: '/settings', roles: ['owner'] },
  { label: 'My attendance & pay', icon: '📒', to: '/me', roles: ['worker', 'cashier'] },
  { label: 'My orders & bills', icon: '🛍️', roles: ['customer'] },
];

export function Home() {
  const { profile } = useAuth();
  if (!profile) return null;
  const tiles = TILES.filter((x) => x.roles.includes(profile.role));

  return (
    <div className="space-y-4">
      <div>
        <p className="text-gray-600">{t('hello')},</p>
        <h2 className="text-2xl font-bold">{profile.full_name}</h2>
        <span className="mt-1 inline-block rounded-full bg-brand-100 px-3 py-0.5 text-sm font-medium text-brand-900">
          {ROLE_LABEL[profile.role]}
        </span>
      </div>

      <InstallCard />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {tiles.map((x) => {
          const body = (
            <Card className={`flex h-full min-h-28 flex-col items-center justify-center gap-2 text-center ${x.to ? '' : 'opacity-60'}`}>
              <span className="text-3xl" aria-hidden>
                {x.icon}
              </span>
              <span className="font-semibold">{x.label}</span>
              {!x.to && <span className="text-xs text-gray-500">{t('comingSoon')}</span>}
            </Card>
          );
          return x.to ? (
            <Link key={x.label} to={x.to} className="active:scale-[0.98]">
              {body}
            </Link>
          ) : (
            <div key={x.label}>{body}</div>
          );
        })}
      </div>
    </div>
  );
}
