# 4HUB

Responsive **web application** (desktop, tablet, mobile browsers) for a trading community and premium
trading-content platform. One codebase; no native apps, no PWA.

## Stack
- **Web:** React 19 + TypeScript + Vite, React Router, plain CSS design system (`apps/web/src/styles`)
- **API:** Fastify + TypeScript, Zod validation, Argon2id password hashing, pino logging
- **Database:** PostgreSQL, plain-SQL migrations (`apps/api/migrations`)
- **Tests:** Vitest (API integration tests on in-memory Postgres; web tests with Testing Library)

## Quick start
```bash
cp .env.example .env            # edit values; never commit .env
docker compose up -d            # local PostgreSQL
npm install
npm run migrate
npm run seed:admin              # optional: needs ADMIN_EMAIL / ADMIN_PASSWORD in .env
npm run dev                     # web http://localhost:5173, API http://localhost:4000
```
Quality gate (also run in CI): `npm run check` (lint, typecheck, tests, build).

## Architecture
```
apps/api/src
  app.ts            app factory (helmet, CORS, cookies, rate limit, CSRF origin check, error handler)
  config.ts         env validation (fail fast)
  db/               pool, transactions, migration runner, repositories
  auth/             roles, argon2 password hashing, token hashing
  plugins/auth.ts   session resolution + requireAuth / requireRole(...)
  routes/           auth, me, areas (member / moderation / admin), rooms (member + staff)
  lib/mailer.ts     notification seam (log-only for now)
apps/web/src
  styles/           design tokens + components CSS
  components/ui     Button, Field, Card, Badge, Alert, Spinner, empty/error/access-denied states
  components/layout Header, Footer, public + dashboard layouts
  auth/             AuthContext, RequireAuth / RequireRole guards
  pages/            Landing, Login, Register, Forgot/Reset password, Pricing, Dashboards, Profile
```
**Adding a module later** (payments, bots, copy trading, community): add a route plugin under
`apps/api/src/routes`, register it in `app.ts`, add a SQL migration, and add pages under `apps/web/src/pages`.

## Signals (core product)
- **Domain:** asset, direction, timeframe, entry, SL, TP1-3, risk, analysis, teaser, free/premium visibility,
  active/closed status, result (TP hit / SL hit / breakeven / cancelled), pips, timestamps, chart screenshots, and an
  append-only update history (`signal_updates`) written in the same transaction as every change.
- **Posting:** admin only. `/admin/signals/new` is a single screen (paste or drop charts, tab through levels, publish).
  Edits, "move SL to breakeven", notes, closing and result recording live on `/admin/signals/:id/edit`.
- **Engagement:** reactions (one per member), comments (moderators/admins can remove), bookmarks, de-duplicated view counter.
- **Promoting members:** until payments exist, admins change roles in the admin dashboard (`PATCH /api/admin/users/:id/role`).

### Premium content protection
- All signal output goes through `serializeSignal` (`apps/api/src/signals/serialize.ts`), a whitelist: a locked response
  never contains entry, stop, targets, analysis, pips, images, stats or update history. Nothing is hidden with CSS/JS.
- Chart files are stored outside any web root under random 192-bit keys (`UPLOAD_DIR`, default `.data/uploads`) and are
  only served by `GET /api/signals/:id/images/:imageId`, which checks the viewer's role on **every** request
  (`Cache-Control: private, no-store`). File type is verified from the file's bytes, not the client's header.
- Premium comments, reactions and bookmarks require premium access server-side too.
- The API and web app must share an origin in production (reverse proxy) so image requests carry the session cookie.

## Billing & subscriptions
**Plans** (`plans` table, admin-editable at `/admin/plans`): name, price (integer minor units), currency, duration, features,
active flag. A plan's `tier` maps to capabilities in `apps/api/src/billing/tiers.ts`; adding VIP or Copy Trading means a new
registry entry plus plans, with no change to checkout, webhooks or subscription logic.

**One authorization rule.** *Premium is not a role.* `can(user, capability)` in `auth/access.ts` is the only place that decides
who may see paid content; signal serialization, images, comments, reactions, bookmarks and route guards all use it. Access is
*derived* from subscription dates at request time (`billing/subscriptions.ts`), so it lapses exactly on schedule with no cron job.
A test fails the build if premium logic is duplicated elsewhere.

**Subscription states** (derived): `active` -> `grace` (renewal overdue, access kept for `SUBSCRIPTION_GRACE_DAYS`) -> `expired`;
`cancelled` = access ended by a refund or an admin. Members who cancel keep access to the period end with no grace.
Purchases stack: renewing early adds time to the end of the current period. A full refund takes back the period it bought.

**Payment flow.** Checkout (server prices from the DB, ignores/rejects any client price) -> provider initiation -> *pending*
payment -> signed webhook -> **server-to-server verification with the provider** -> amount/currency must match the checkout
snapshot -> one transaction marks the payment paid, adds subscription time, issues the invoice. The browser only ever *reads*
status; nothing the frontend says can grant access.

**Webhook safety.** Signature/secret checked against the raw body; `(provider, event_id)` is unique (redelivery is a no-op);
`payment_id` is unique on the period ledger (a payment can grant time once even if confirmed by different events); status
changes are guarded transitions; failures never undo successes; every money/access change is written to `audit_log`.

**Providers** implement one interface (`billing/providers/types.ts`): `mpesa` (Daraja STK push), `card` (Paystack hosted
checkout; card data never touches 4HUB), `mock` (sandbox, dev/test only). See `.env.example`.

### Before going live
1. Exercise the M-Pesa and Paystack adapters against their **sandboxes** with real credentials; they are covered by contract tests
   against recorded request/response shapes, not yet by live calls.
2. Use https `API_PUBLIC_URL` so providers can reach `/api/webhooks/payments/<provider>`; set `PAYMENT_PROVIDERS` without `mock`.
3. Keep `MPESA_CALLBACK_TOKEN` and `PAYSTACK_SECRET_KEY` in a secret manager. Review KES prices in `/admin/plans`.
4. Run PostgreSQL 13+ (migration 003 uses `gen_random_uuid()`).

## Community rooms
Categorised discussion spaces (`community_rooms`, migration 004): general discussion, trading discussion, market analysis and
premium community. Rooms are `public` or `premium`; a premium community room is always premium (API validation + DB constraint).
- **Access:** premium rooms use the new `premium_community` capability from the tier registry, checked only through `can()`
  (same single rule as signals), so subscription expiry, grace and revocation apply immediately. Staff can enter every room.
- **Visibility:** the lobby (`GET /api/rooms`) lists active rooms to everyone with a `locked` flag; `guidelines` (member-only
  content) is returned only by `GET /api/rooms/:slug` to viewers who may enter (401 for visitors, 403 `PREMIUM_REQUIRED`
  for free members; both carry only the public summary). Archived rooms return 404 to everyone but staff.
- **Management:** moderators and admins use `/api/staff/rooms` (list, create, edit, archive, restore) and the web pages under
  `/staff/rooms`. Slugs are immutable; there is no delete. Every change is written to `audit_log`.
- **Not yet built:** messaging/chat, notifications and moderation workflows.

### Messaging (Prompt 4B)
Chat inside community rooms (`room_messages`, migration 005). Messaging always requires a signed-in user, even in public rooms.
- **Access:** every chat endpoint (history, send, edit, delete, stream) goes through one `authorizeRoom()` check that reuses the
  room rules above, so a lapsed subscription locks chat like it locks the room page. Archived rooms are hidden from members and
  read-only for staff. A message is only reachable through its own room.
- **Endpoints (`/api/rooms/:slug/...`):** `GET messages?limit&before` (newest page first, `before` = cursor from `nextBefore`),
  `POST messages`, `PATCH messages/:id` (author only), `DELETE messages/:id` (author, or moderator/admin; staff deletes are
  audited; deleting wipes the content and leaves a tombstone), `GET stream` (Server-Sent Events).
- **Real time:** Server-Sent Events plus plain HTTP writes, with no extra infrastructure. The browser reconnects by itself and the
  client re-fetches the newest page on every (re)connect, so missed messages, edits and deletes are recovered. Open streams
  re-check session and room access every `CHAT_STREAM_RECHECK_MS` and are closed when access is lost. The hub is in-process:
  **run a single API instance**, or swap `chat/hub.ts` for a shared bus (PostgreSQL LISTEN/NOTIFY or Redis) before scaling out.
  If a reverse proxy sits in front, disable response buffering for `/api/rooms/*/stream` (`X-Accel-Buffering: no` is already sent).
- **Safety:** authors come from the session only (strict payloads reject `authorId` etc.); max 2000 characters; control and
  bidi-override/zero-width characters are rejected or stripped; sends, edits and deletes are limited per user
  (`CHAT_WRITES_PER_MINUTE`); retried sends are idempotent through an optional `clientId`; message text is stored as plain text and
  only ever rendered as text, never as HTML.
- **Not yet built:** notifications and moderation tools (reports, mutes, bans).

### Moderation (Prompt 4C)
Reporting, a moderator queue, message hiding/removal and account restrictions (migration 006). Moderation is a layer over rooms and
messaging, not a second system: it reuses the room access check, the role model, `audit_log` and the live-event hub.
- **Reports:** any signed-in member who can read a message can report it (`POST /api/rooms/:slug/messages/:id/report`) with a reason
  and optional details. One report per person per message; not your own message; not an already hidden/removed one. The reported
  text is **snapshotted** on the report, so edits, hiding or removal never change the evidence. Abuse limits (`REPORTS_PER_HOUR`,
  `REPORTS_PER_DAY`) are counted from stored reports, so they survive restarts. Reporters are never revealed to the reported member.
- **Queue and decisions (`/api/moderation/*`, moderators and admins):** list/filter reports, view one, resolve or dismiss it,
  and **hide** (reversible, text kept for staff), **unhide** or **remove** (permanent, text wiped) a message. Hide/remove need a
  reason, which the author is shown, settle every open report on that message, and are broadcast over the existing live stream
  without the reason or the hidden text.
- **Rank rule:** moderators act on members; administrators on moderators and members; nobody on administrators or themselves.
  Nobody closes a report they filed or one about themselves.
- **Restrictions (`/api/admin/*`, administrators only):** `muted` (can read, report and delete their own messages, cannot post or
  edit) and `suspended` (every request except logout/login is refused with the reason). Reason required; optional duration;
  they expire on their own and can be lifted. History is kept. Enforced centrally in the auth plugin and the shared room check,
  and open live streams close within `CHAT_STREAM_RECHECK_MS`.
- **Audit:** `report.resolved`, `report.dismissed`, `message.hidden`, `message.unhidden`, `message.removed`, `user.restricted`,
  `user.restriction_lifted`. Hide/remove entries keep a snapshot of the content, because the chat copy is wiped on removal.
- **Not yet built:** notifications (people learn of actions when they next use the app), appeals, automatic moderation.

## Security model
- Sessions: random 256-bit token in an `httpOnly`, `SameSite=Lax` (`Secure` in production) cookie; only its SHA-256 hash is stored.
- Authorization is enforced **server-side** (`requireRole`); frontend guards are UX only.
- Roles: visitor (unauthenticated), `free`, `premium`, `moderator`, `admin`. Registration always creates `free`.
- Login/register/reset are rate limited; unknown email and wrong password are indistinguishable; reset requests never reveal whether an email exists.
- Password reset tokens are single-use, expire (default 30 min), and sign the user out everywhere.
- No secrets in code; all configuration via environment variables.
