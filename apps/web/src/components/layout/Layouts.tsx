import { NavLink, Outlet } from 'react-router-dom';
import { Header } from './Header';
import { Footer } from './Footer';
import { useAuth } from '../../auth/AuthContext';

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
          <NavLink to="/profile">Profile</NavLink>
          <NavLink to="/pricing">Upgrade</NavLink>
          {user?.role === 'admin' && (
            <>
              <span className="sidenav-label">Admin</span>
              <NavLink to="/admin">Admin dashboard</NavLink>
            </>
          )}
        </nav>
        <main id="main" tabIndex={-1}><Outlet /></main>
      </div>
    </div>
  );
}
