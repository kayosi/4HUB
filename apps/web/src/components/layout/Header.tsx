import { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Button, ButtonLink } from '../ui';

export function Header() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const close = () => setOpen(false);

  return (
    <header className="site-header">
      <div className="container">
        <Link to="/" className="brand" onClick={close}>
          <span className="brand-mark" aria-hidden="true">4</span>
          <span>4HUB</span>
        </Link>
        <button className="btn btn-ghost btn-sm menu-toggle" aria-expanded={open} aria-controls="main-nav" onClick={() => setOpen((o) => !o)}>
          {open ? 'Close' : 'Menu'}
        </button>
        <nav id="main-nav" className="nav" data-open={open} aria-label="Main" onClick={close}>
          <NavLink to="/pricing">Pricing</NavLink>
          {user ? (
            <>
              <NavLink to="/dashboard">Dashboard</NavLink>
              {user.role === 'admin' && <NavLink to="/admin">Admin</NavLink>}
              <NavLink to="/profile">Profile</NavLink>
              <Button variant="secondary" small onClick={async () => { await logout(); navigate('/'); }}>
                Log out
              </Button>
            </>
          ) : (
            <>
              <NavLink to="/login">Log in</NavLink>
              <ButtonLink to="/register" small>Create account</ButtonLink>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
