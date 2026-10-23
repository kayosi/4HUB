import { ButtonLink, Card } from '../components/ui';
import { useAuth } from '../auth/AuthContext';

export default function Pricing() {
  const { user } = useAuth();
  return (
    <div className="container page">
      <div className="page-head">
        <h1>Pricing</h1>
        <p className="muted">Placeholder. Plans and payments are coming in a later release.</p>
      </div>
      <div className="grid grid-2">
        <Card title="Free">
          <div className="price">$0</div>
          <ul className="checklist"><li>Member dashboard</li><li>Profile</li><li>Public community content</li></ul>
          {!user && <ButtonLink to="/register" variant="secondary" block>Create account</ButtonLink>}
        </Card>
        <Card title="Premium">
          <div className="price">Coming soon</div>
          <ul className="checklist"><li>Everything in Free</li><li>Premium trading content</li><li>Priority access to new features</li></ul>
          <button className="btn btn-secondary btn-block" disabled>Not yet available</button>
        </Card>
      </div>
    </div>
  );
}
