import { useAuth } from '../auth/AuthContext';
import { untilText } from '../lib/moderation';
import { Button } from '../components/ui';

/** Shown instead of the app when the account is suspended, so the person is told what happened, why, and for how long. */
export default function Suspended() {
  const { suspension, logout } = useAuth();
  return (
    <main className="container">
      <div className="state" role="alert">
        <div className="state-icon" aria-hidden="true">⛔</div>
        <h1>Your account is suspended</h1>
        <p className="muted">Your access is suspended {untilText(suspension?.expiresAt)}.</p>
        {suspension?.reason && <p><strong>Reason:</strong> {suspension.reason}</p>}
        <p className="muted small">If you think this is a mistake, please contact the 4HUB team.</p>
        <Button variant="secondary" onClick={() => void logout()}>Log out</Button>
      </div>
    </main>
  );
}
