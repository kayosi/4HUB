export const SUSPENDED_EVENT = '4hub:suspended';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string>,
  ) {
    super(message);
  }
}

export async function api<T = void>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: opts.method ?? 'GET',
      credentials: 'include',
      // FormData (image uploads) sets its own multipart boundary header.
      headers: opts.body !== undefined && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body === undefined ? undefined : opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Unable to reach the server. Check your connection and try again.');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error;
    // A suspended account is refused on every request. Tell the app once, so it can show the reason (a failed sign-in shows it inline).
    if (res.status === 403 && e?.code === 'ACCOUNT_SUSPENDED' && path !== '/auth/login') {
      window.dispatchEvent(new CustomEvent(SUSPENDED_EVENT, { detail: { message: e.message, ...(e.details ?? {}) } }));
    }
    throw new ApiError(res.status, e?.code ?? 'UNKNOWN', e?.message ?? 'Something went wrong', e?.details);
  }
  return data as T;
}
