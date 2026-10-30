import { NavLink, Outlet } from 'react-router-dom';
import { Header } from './Header';
import { Footer } from './Footer';
import { useAuth } from '../../auth/AuthContext';
import { Spinner } from '../ui';

export function PublicLayout() {
  return (
    <div className="app-root">
      <a className="skip-link" href="#main">Skip to content</a>
      <Header />
      <main id="main" className="app-main"><Outlet /></main>
      <Footer />
    </div>
  );
}

/** Shared shell for member + admin areas: top header, side nav (becomes a scrollable tab bar on small screens). */
export function DashboardLayout() {
  const { user } = useAuth();
  return (
    <div className="app-root">
      <a className="skip-link" href="#main">Skip to content</a>
      <Header />
      <div className="container dash">
        <nav className="sidenav" aria-label="Dashboard">
          <span className="sidenav-label">Member</span>
          <NavLink to="/dashboard" end>Overview</NavLink>
          <NavLink to="/signals">Signals</NavLink>
          <NavLink to="/saved">Saved</NavLink>
          <NavLink to="/profile">Profile</NavLink>
          <NavLink to="/settings">Settings</NavLink>
          <NavLink to="/billing">Billing</NavLink>
          {!user?.access.premium && <NavLink to="/pricing">Upgrade</NavLink>}
          {user?.role === 'admin' && (
            <>
              <span className="sidenav-label">Admin</span>
              <NavLink to="/admin" end>Admin dashboard</NavLink>
              <NavLink to="/admin/signals/new">Post signal</NavLink>
              <NavLink to="/admin/billing">Revenue &amp; billing</NavLink>
              <NavLink to="/admin/plans">Plans</NavLink>
            </>
          )}
        </nav>
        <main id="main" tabIndex={-1}><Outlet /></main>
      </div>
    </div>
  );
}

/** Signed-in members get the dashboard shell; visitors get the public shell. Same page either way. */
export function AdaptiveLayout() {
  const { user, loading } = useAuth();
  if (loading) return <Spinner label="Loading" />;
  return user ? <DashboardLayout /> : <PublicLayout />;
}
