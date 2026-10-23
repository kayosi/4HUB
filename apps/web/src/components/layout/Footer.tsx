import { Link } from 'react-router-dom';

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <span>© {new Date().getFullYear()} 4HUB</span>
        <nav className="footer-links" aria-label="Footer">
          <Link to="/pricing">Pricing</Link>
          <Link to="/login">Log in</Link>
          <Link to="/register">Register</Link>
        </nav>
        <p className="risk-note">
          Trading involves risk. Content on 4HUB is for education and information only and is not financial advice.
        </p>
      </div>
    </footer>
  );
}
