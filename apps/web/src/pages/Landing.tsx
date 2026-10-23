import { ButtonLink, Card } from '../components/ui';

export default function Landing() {
  return (
    <div className="container">
      <section className="hero">
        <p className="eyebrow">Trading community</p>
        <h1>A calm, professional home for serious traders.</h1>
        <p>
          4HUB brings trading education, community and premium content together in one clear, trustworthy place. No hype,
          just well-organised tools for learning and improving.
        </p>
        <div className="hero-actions">
          <ButtonLink to="/register">Create free account</ButtonLink>
          <ButtonLink to="/pricing" variant="secondary">View pricing</ButtonLink>
        </div>
      </section>
      <section className="grid grid-3" aria-label="Highlights">
        <Card title="Learn"><p className="muted">Structured trading content, organised so you can find what matters.</p></Card>
        <Card title="Connect"><p className="muted">A respectful community with moderation you can rely on.</p></Card>
        <Card title="Go further"><p className="muted">Premium membership unlocks deeper content as the platform grows.</p></Card>
      </section>
    </div>
  );
}
