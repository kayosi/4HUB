import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { durationLabel, formatMoney, perMonthMinor, savingsPercent, type Plan, type ProviderInfo } from '../lib/billing';
import { useAuth } from '../auth/AuthContext';
import { ButtonLink, Card, Spinner } from '../components/ui';
import { ErrorState } from '../components/ui/states';

export default function Pricing() {
  const { user } = useAuth();
  const s = useAsync(() => api<{ plans: Plan[]; providers: ProviderInfo[] }>('/billing/plans'));
  return (
    <div className="container page">
      <div className="page-head">
        <h1>Pricing</h1>
        <p className="muted">Start free. Upgrade for premium signals, charts and full analysis. Cancel any time.</p>
      </div>
      {s.status === 'loading' && <Spinner label="Loading plans" />}
      {s.status === 'error' && <ErrorState message={s.error.message} onRetry={s.reload} />}
      {s.status === 'ready' && (
        <>
          <div className="grid pricing-grid">
            {s.data.plans.map((p) => <PlanCard key={p.id} plan={p} all={s.data.plans} />)}
          </div>
          {s.data.providers.length > 0 && (
            <p className="muted small" style={{ marginTop: 16 }}>Pay with {s.data.providers.map((x) => x.name).join(' or ')}. Prices are shown in {s.data.plans.find((p) => p.priceMinor > 0)?.currency ?? 'KES'}.</p>
          )}
          {!user && <p className="muted small">Already a member? <a href="/login">Log in</a> to manage your plan.</p>}
        </>
      )}
    </div>
  );
}

function PlanCard({ plan, all }: { plan: Plan; all: Plan[] }) {
  const { user } = useAuth();
  const free = plan.tier === 'free';
  const saving = savingsPercent(plan, all);
  const month = perMonthMinor(plan);
  const popular = plan.code === 'premium_quarterly' || (saving > 0 && !all.some((p) => p.code === 'premium_quarterly') && plan.code.endsWith('yearly'));
  return (
    <Card>
      <div className={`plan${popular ? ' plan-featured' : ''}`}>
        <div className="plan-head"><h2 style={{ margin: 0, fontSize: '1.2rem' }}>{plan.name}</h2>{saving > 0 && <span className="badge badge-premium">Save {saving}%</span>}</div>
        <div className="price" data-testid={`price-${plan.code}`}>{free ? 'Free' : formatMoney(plan.priceMinor, plan.currency)}</div>
        <p className="muted small plan-unit">
          {free ? 'forever' : `per ${durationLabel(plan.durationDays)}`}
          {!free && month !== null && plan.durationDays !== 30 && <> · about {formatMoney(Math.round(month / 100) * 100, plan.currency)} / month</>}
        </p>
        {plan.description && <p className="muted">{plan.description}</p>}
        <ul className="checklist">{plan.features.map((f) => <li key={f}>{f}</li>)}</ul>
        {free ? (
          user ? <p className="muted small">{user.access.premium ? 'Included with every account' : 'Your current plan'}</p> : <ButtonLink to="/register" variant="secondary" block>Create free account</ButtonLink>
        ) : (
          <ButtonLink to={`/checkout/${plan.code}`} block variant={popular ? 'primary' : 'secondary'}>{user?.access.premium ? 'Extend with this plan' : 'Choose plan'}</ButtonLink>
        )}
      </div>
    </Card>
  );
}
