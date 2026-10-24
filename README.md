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
  routes/           auth, me, areas (member / moderation / admin)
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

## Security model
- Sessions: random 256-bit token in an `httpOnly`, `SameSite=Lax` (`Secure` in production) cookie; only its SHA-256 hash is stored.
- Authorization is enforced **server-side** (`requireRole`); frontend guards are UX only.
- Roles: visitor (unauthenticated), `free`, `premium`, `moderator`, `admin`. Registration always creates `free`.
- Login/register/reset are rate limited; unknown email and wrong password are indistinguishable; reset requests never reveal whether an email exists.
- Password reset tokens are single-use, expire (default 30 min), and sign the user out everywhere.
- No secrets in code; all configuration via environment variables.
