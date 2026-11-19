# 4HUB — Project Instructions

Read this file completely before starting any implementation task. Repository: https://github.com/kayosi/4HUB.git
(`main` is the source of truth; continue from it, never recreate the project.)

## 1. Purpose
4HUB is a responsive **web application** (desktop, tablet, mobile browsers) for a trading community and premium
trading-content platform. It is NOT a native app and NOT a PWA. One codebase; no separate mobile projects.

Delivered so far: foundation (auth, roles, design system) · signals (core product) · billing and subscriptions ·
community rooms (Prompt 4A) · community messaging (Prompt 4B) · community moderation (Prompt 4C). Not built yet (do not start unprompted): notifications,
appeals, automatic moderation, courses, bots, copy trading.

## 2. Architecture and stack
npm workspaces monorepo.
- `apps/api` — Fastify 5 + TypeScript, Zod 4 validation, `pg` (PostgreSQL), Argon2id, pino. ESM (`.js` import suffixes).
- `apps/web` — React 19 + TypeScript + Vite, React Router, plain CSS (`src/styles/tokens.css`, `app.css`).
- Tests: Vitest. API integration tests run on in-memory Postgres (`pg-mem`) through `app.inject`; web tests use
  Testing Library with a mocked `fetch`.
- CI: `.github/workflows/ci.yml` runs `npm run check` (lint, typecheck, tests, build).

API layout (`apps/api/src`): `app.ts` (factory, registers route plugins under `/api`), `config.ts`, `db/` (pool,
`withTransaction`, migration runner, user repos), `auth/` (`roles.ts`, `access.ts`), `plugins/auth.ts`
(`requireAuth`, `requireRole`, `requireCapability`), `routes/`, domain folders (`signals/`, `billing/`, `rooms/`, `chat/`, `moderation/`),
`errors.ts` (`AppError`, `badRequest`, `forbidden`, `notFound`, `conflict`), `lib/validate.ts` (`parse`).

A new module = route plugin in `routes/` + registration in `app.ts` + SQL migration + web pages + tests.

## 3. Database and migrations
- Plain SQL files in `apps/api/migrations`, applied in filename order, each in a transaction; **never edit an applied
  migration**, add the next number (`NNN_name.sql`). Current: 001 init, 002 profiles+signals, 003 billing, 004 community rooms, 005 room messages, 006 community moderation.
- Conventions: `uuid` primary keys generated in application code (`randomUUID()`), `timestamptz` timestamps,
  `check` constraints for enums, money as integer minor units.
- Keep SQL compatible with both PostgreSQL 13+ and `pg-mem` (tests): avoid regex or string-function (`length`, `char_length`) check constraints and partial indexes; enforce lengths in Zod.
- Every money/access/content-management change writes `audit_log` via `audit()` (`billing/repo.ts`), inside the same transaction.

## 4. Authentication and authorization
- Roles: `free`, `moderator`, `admin` (visitor = no session). **Premium is not a role**; it is derived from the
  subscription at request time.
- Sessions: httpOnly cookie, SHA-256 token hash stored. CSRF: Origin check on state-changing requests.
- **One rule for paid content:** `can(user, capability)` in `auth/access.ts`. Capabilities are defined per tier in
  `billing/tiers.ts` (`premium_signals`, `premium_community`). Never read `entitlement.capabilities`, compare roles to
  'premium', or re-implement subscription state elsewhere; `test/premium-access.test.ts` enforces this.
- Staff (`moderator`, `admin`) implicitly hold premium *content* capabilities (`STAFF_CAPABILITIES`) so they can moderate.
- Enforce authorization on the server for every request; frontend guards are UX only.
- Error semantics: 401 unauthenticated, 403 forbidden / `PREMIUM_REQUIRED`, 404 for resources the caller may not know about.

## 5. Security requirements
Validate all input with Zod (`parse()`); use strict objects for write payloads (no mass assignment); parameterised SQL
only; transactions for multi-step writes; no secrets in code (env via `config.ts`); locked/premium responses go through
whitelist serializers and never contain restricted fields; never weaken security or tests to make something pass.

## 6. Frontend conventions
- Pages in `src/pages`, shared UI in `src/components/ui` (`Button`, `Card`, `Badge`, `Field`, `Alert`, `Spinner`) and
  `components/ui/states.tsx` (`EmptyState`, `ErrorState`, `AccessDenied`, `NotFoundState`).
- Data loading with `useAsync` and `api()` (`lib/api.ts`, throws `ApiError`). Every data page needs loading, empty,
  error and access-denied states.
- Routes in `App.tsx`; guards `RequireAuth` / `RequireRole`. Public-but-adaptive pages sit under `AdaptiveLayout`.
- Design: dark-first, professional, minimal. Tokens: bg `#0B1220`, surface `#111827`, surface-2 `#172033`,
  accent `#2DD4BF`, positive `#34D399`, negative `#F87171`, text `#F8FAFC`, muted `#94A3B8`, border `#243044`.
  No gambling-style visuals, glow effects or gratuitous animation. Use existing CSS variables, not new colours.
- Must be usable at mobile widths (touch targets ≥ 44px, wrapping grids, no horizontal page scroll).

## 7. Testing
From the repo root: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` (`npm run check` runs all).
Focused: `npx vitest run test/<file>.test.ts` inside `apps/api` or `apps/web`. Add regression tests for new behaviour;
run focused tests first, then the full suite once at the end. Report real results only.

## 8. Workflow
- Implement only the requested task; no future-task work, no unrelated refactors, no duplicate functionality.
- If the requested functionality already exists, verify and report instead of rebuilding.
- Update `README.md` and this file when architecture or conventions change.
- Keep responses concise; avoid repeated test runs and unnecessary tooling.

## 9. Git and delivery
The owner manages Git locally. Do NOT initialise repositories, commit, push, branch, merge, reset, or change remote
settings or GitHub permissions. Deliver changed files or a complete project ZIP (excluding `node_modules`, `.git`).
End each task with exactly ONE professional one-line commit message and stop; do not begin the next task.

## 10. Feature notes

### Community rooms (Prompt 4A)
- Table `community_rooms` (migration 004). Categories: `general_discussion`, `trading_discussion`, `market_analysis`,
  `premium_community`. Access: `public` | `premium`. Invariant: category `premium_community` requires access `premium`
  (validated in the API and enforced by a DB check constraint).
- Public metadata (name, description, category, access) is visible to everyone; `guidelines` is member-only content and is
  returned only to viewers who may enter the room. Premium rooms require `can(user, 'premium_community')`.
- Archived rooms are hidden from everyone except staff. Slugs are immutable. No delete endpoint.
- Staff (moderator + admin) manage rooms under `/api/staff/rooms`; members use `/api/rooms`. Management actions are audited
  (`room.created`, `room.updated`, `room.archived`, `room.restored`).
- Out of scope until requested: messages/chat, notifications, moderation workflows, room membership.

### Community messaging (Prompt 4B)
- Table `room_messages` (migration 005): `seq` is a global increasing cursor used for pagination (`before`), deletes are soft
  (content wiped, tombstone kept), `client_id` makes retried sends idempotent.
- Authorization: `authorizeRoom()` in `routes/messages.ts` is the single check for all chat endpoints; it reuses `canEnterRoom`
  (rooms/serialize.ts), which defers to `can()`. Never add a second access rule for chat. Messaging requires a signed-in user.
- Permissions: only the author edits; the author or staff (moderator/admin) deletes; staff deletes of others are audited.
- Real time = Server-Sent Events (`GET /api/rooms/:slug/stream`) fed by the in-process `ChatHub`. Single API instance only
  (see README to scale). Use Fastify's `preClose` hook (not `onClose`) to end open streams on shutdown.
- Message text is plain text: sanitised on write (`chat/sanitize.ts`), never HTML-escaped on the server, and rendered only as a React
  text node. Never use `dangerouslySetInnerHTML` or auto-link message content.
- Rate limits are in-memory per user (`chat/limiter.ts`, injected clock); configurable via `CHAT_*` env vars in `config.ts`.
- Out of scope until requested: notifications, reports/mutes/bans, attachments, reactions, typing indicators, read receipts.

### Community moderation (Prompt 4C)
- Tables (migration 006): `message_reports` (with an immutable content snapshot), `user_restrictions`, and `hidden_at/hidden_by/
  moderation_reason` on `room_messages`. Nothing is ever deleted: reports are closed, restrictions are lifted, audit rows stay.
- Who may do what lives in `moderation/rank.ts` (moderators act on members, admins on moderators and members, nobody on admins or
  themselves; admins may close reports about each other). Never re-implement these rules in a route.
- Restrictions: loaded per request next to the entitlement (`req.user.restrictions`). A suspension is enforced once, in the auth
  plugin; a mute in the shared `authorizeRoom()` (`chat/access.ts`, mode `write`). Do not add per-route checks.
- Content a moderator hid or removed must never reach other members: use `serializeMessage(m, viewer)`; the reason is only for the
  author and staff, and live events (broadcast) never carry it.
- Every moderation write goes through `withTransaction` with an `audit()` entry in the same transaction.
- Staff-facing pages: `/staff/moderation` (queue) and the restriction controls on `/admin`. Restriction UI is admin-only on screen
  and on the server. Success feedback is shown by the page (lists reload and remount their rows).
- Out of scope until requested: notifications, appeals, automated filtering, bulk actions.
