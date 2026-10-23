import type { ReactNode } from 'react';
import { Button, ButtonLink } from './index';

function State({ icon, title, children, action }: { icon: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <div className="state-icon" aria-hidden="true">{icon}</div>
      <h2>{title}</h2>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

export const EmptyState = ({ title, message, action }: { title: string; message?: string; action?: ReactNode }) => (
  <State icon="◌" title={title} action={action}>{message}</State>
);

export const ErrorState = ({ message = 'We could not load this. Please try again.', onRetry }: { message?: string; onRetry?: () => void }) => (
  <State icon="!" title="Something went wrong" action={onRetry && <Button variant="secondary" onClick={onRetry}>Try again</Button>}>
    {message}
  </State>
);

export const AccessDenied = ({ message = 'Your account does not have permission to view this page.' }: { message?: string }) => (
  <State icon="⛔" title="Access denied" action={<ButtonLink to="/dashboard" variant="secondary">Back to dashboard</ButtonLink>}>
    {message}
  </State>
);

export const NotFoundState = () => (
  <State icon="?" title="Page not found" action={<ButtonLink to="/" variant="secondary">Go home</ButtonLink>}>
    The page you are looking for does not exist.
  </State>
);
