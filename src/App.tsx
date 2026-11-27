import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth/AuthProvider';
import { UpdateBanner } from './components/AppUpdates';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import type { Role } from './lib/types';
// The counter's everyday screens load with the app…
import { BillView } from './pages/BillView';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { NewBill } from './pages/NewBill';

// …everything else downloads only when first opened (faster start on slow phones).
function page<K extends string>(load: () => Promise<Record<K, ComponentType<any>>>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}
const Attendance = page(() => import('./pages/Attendance'), 'Attendance');
const Bills = page(() => import('./pages/Bills'), 'Bills');
const Cash = page(() => import('./pages/Cash'), 'Cash');
const Coupons = page(() => import('./pages/Coupons'), 'Coupons');
const OrderEdit = page(() => import('./pages/OrderEdit'), 'OrderEdit');
const Orders = page(() => import('./pages/Orders'), 'Orders');
const OrderView = page(() => import('./pages/OrderView'), 'OrderView');
const Products = page(() => import('./pages/Products'), 'Products');
const ProfilePage = page(() => import('./pages/Profile'), 'ProfilePage');
const PublicBill = page(() => import('./pages/PublicBill'), 'PublicBill');
const Reports = page(() => import('./pages/Reports'), 'Reports');
const Returns = page(() => import('./pages/Returns'), 'Returns');
const SettingsPage = page(() => import('./pages/SettingsPage'), 'SettingsPage');
const Users = page(() => import('./pages/Users'), 'Users');
const WorkerDetail = page(() => import('./pages/WorkerDetail'), 'WorkerDetail');
const Workers = page(() => import('./pages/Workers'), 'Workers');

const OWNER: Role[] = ['owner'];
const STAFF: Role[] = ['owner', 'cashier'];

/** Hides a screen from roles that should not see it. (The database enforces this too.) */
function RequireRole({ roles, children }: { roles: Role[]; children: ReactNode }) {
  const { profile } = useAuth();
  if (!profile || !roles.includes(profile.role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
const only = (roles: Role[], el: ReactNode) => <RequireRole roles={roles}>{el}</RequireRole>;

function Gate() {
  const { loading, profile } = useAuth();
  if (loading) return <Spinner />;
  if (!profile) return <Login />;

  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Home />} />
          <Route path="bill" element={only(STAFF, <NewBill />)} />
          <Route path="bills" element={only(STAFF, <Bills />)} />
          <Route path="bills/:id" element={only(STAFF, <BillView />)} />
          <Route path="returns" element={only(STAFF, <Returns />)} />
          <Route path="cash" element={only(STAFF, <Cash />)} />
          <Route path="coupons" element={only(OWNER, <Coupons />)} />
          <Route path="workers" element={only(OWNER, <Workers />)} />
          <Route path="workers/:id" element={only(OWNER, <WorkerDetail />)} />
          <Route path="attendance" element={only(OWNER, <Attendance />)} />
          <Route path="me" element={only(['worker', 'cashier'], <WorkerDetail self />)} />
          <Route path="orders" element={only(STAFF, <Orders />)} />
          <Route path="orders/new" element={only(STAFF, <OrderEdit />)} />
          <Route path="orders/:id" element={only(STAFF, <OrderView />)} />
          <Route path="orders/:id/edit" element={only(STAFF, <OrderEdit />)} />
          <Route path="reports" element={only(OWNER, <Reports />)} />
          <Route path="products" element={only(OWNER, <Products />)} />
          <Route path="settings" element={only(OWNER, <SettingsPage />)} />
          <Route path="users" element={only(OWNER, <Users />)} />
          <Route path="profile" element={<ProfilePage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <UpdateBanner />
      <AuthProvider>
        <Routes>
          {/* Customer's bill link from WhatsApp: works without logging in. */}
          <Route
            path="/b/:token"
            element={
              <Suspense fallback={<Spinner />}>
                <PublicBill />
              </Suspense>
            }
          />
          <Route path="*" element={<Gate />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
