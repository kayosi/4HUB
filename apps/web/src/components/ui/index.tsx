import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { Link } from 'react-router-dom';

type Variant = 'primary' | 'secondary' | 'ghost';
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  block?: boolean;
  small?: boolean;
  loading?: boolean;
}
const cls = (v: Variant, block?: boolean, small?: boolean) =>
  `btn btn-${v}${block ? ' btn-block' : ''}${small ? ' btn-sm' : ''}`;

export function Button({ variant = 'primary', block, small, loading, children, disabled, className, ...rest }: BtnProps) {
  return (
    <button {...rest} className={`${cls(variant, block, small)}${className ? ` ${className}` : ''}`} disabled={disabled || loading} aria-busy={loading || undefined}>
      {loading ? 'Please wait…' : children}
    </button>
  );
}

export function ButtonLink({ to, variant = 'primary', block, small, children }: { to: string; variant?: Variant; block?: boolean; small?: boolean; children: ReactNode }) {
  return (
    <Link className={cls(variant, block, small)} to={to}>
      {children}
    </Link>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="card">
      {title && <h3 className="card-title">{title}</h3>}
      {children}
    </section>
  );
}

export const Badge = ({ children, accent }: { children: ReactNode; accent?: boolean }) => (
  <span className={`badge${accent ? ' badge-accent' : ''}`}>{children}</span>
);

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
}
export function Field({ label, error, hint, id, ...rest }: FieldProps) {
  const fid = id ?? `f-${rest.name ?? label.replace(/\s+/g, '-').toLowerCase()}`;
  const desc = error ? `${fid}-err` : hint ? `${fid}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={fid}>{label}</label>
      <input id={fid} className="input" aria-invalid={error ? true : undefined} aria-describedby={desc} {...rest} />
      {error ? (
        <span id={`${fid}-err`} className="field-error" role="alert">{error}</span>
      ) : hint ? (
        <span id={`${fid}-hint`} className="field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

export const Alert = ({ kind = 'error', children }: { kind?: 'error' | 'success' | 'info'; children: ReactNode }) => (
  <div className={`alert${kind === 'error' ? ' alert-error' : kind === 'success' ? ' alert-success' : ''}`} role={kind === 'error' ? 'alert' : 'status'}>
    {children}
  </div>
);

export const Spinner = ({ label = 'Loading' }: { label?: string }) => (
  <div className="page-loading" role="status" aria-live="polite">
    <div className="spinner" aria-hidden="true" />
    <span className="sr-only">{label}</span>
  </div>
);
