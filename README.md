# Rehla (رحلة) — Intercity Trip Booking MVP

A working prototype of the intercity bus/minibus/shared-taxi booking platform
described in the PRD: passengers search trips between cities and submit a
booking request (no online payment, no user accounts); operators log in to
create trips and confirm/cancel bookings.

## Stack

- **Backend:** Node.js + Express, server-rendered with EJS templates (no
  heavy frontend framework, per the "lightweight" requirement).
- **Database:** SQLite via Node's built-in `node:sqlite` module — zero native
  dependencies, single file (`data/app.db`), trivial to swap for
  PostgreSQL/MySQL later since all queries are plain SQL in `src/db.js` /
  `src/app.js`.
- **Auth:** `express-session` (cookie-based) + `bcryptjs` password hashing
  for operator accounts.
- **i18n:** a plain dictionary (`src/i18n.js`) — Arabic (RTL) is the default,
  English (LTR) is a toggle. No i18n library/build step needed.
- **Styling:** one hand-written CSS file using the palette and fonts from the
  brief (deep teal primary, warm amber accents, Cairo for Arabic, Roboto for
  English), mobile-first, large touch targets. No CSS framework.
- **JS:** one small vanilla file (`public/js/app.js`) — double-submit
  guard and a client-side hint that origin ≠ destination. Everything else is
  plain HTML forms / full page loads, which keeps the JS payload near zero
  for slow connections.

## Running it

```bash
npm install
npm start
# -> http://localhost:3000
```

The database is created and seeded automatically on first run
(`data/app.db`), with demo cities, two demo operators, and a few days of
demo trips.

**Demo operator logins:**
- `sham_express` / `demo1234`
- `coast_star` / `demo1234`

To reset all data, stop the server and delete `data/app.db` — it will
reseed on the next start.

## What's implemented (maps to the PRD's acceptance criteria)

- Search trips between any two active cities on a given date.
- Results show live available seats and price; sold-out trips are clearly
  marked and not bookable.
- End-to-end booking flow: passenger name/phone/optional ID/seat count →
  server-side validation → unique booking reference (`RH-XXXXXX`) → stored
  with `pending` status.
- Seats are decremented on booking and released automatically if an operator
  cancels a booking later.
- Duplicate-request guard: the same phone number can't submit a second
  booking for the same trip within 15 minutes (adjustable in
  `src/app.js`, search for `-15 minutes`).
- Passengers can look up a booking's status with phone + reference number
  (no login required, per the "no user accounts" scope).
- Operators log in, create trips, and move bookings through
  `pending → confirmed / cancelled` and `confirmed → no_show / cancelled`.
  Only these transitions are allowed server-side.
- Fully bilingual: Arabic is `dir="rtl"`, English is `dir="ltr"`; a toggle in
  the header preserves the current page/query string.
- No JS framework, minified single CSS file, system-font fallbacks — pages
  are small and should load well under the 3G / <4s target. See
  "Performance notes" below for the one external dependency that affects
  this (web fonts).

## Project structure

```
trips-site/
├── server.js              # entry point
├── src/
│   ├── app.js              # all routes (public + operator/admin)
│   ├── db.js                # schema + seed data (node:sqlite)
│   └── i18n.js               # ar/en dictionary
├── views/                  # EJS templates (server-rendered)
│   ├── partials/            # head/header/footer/tail
│   ├── operator/             # login, dashboard, new-trip, bookings
│   └── *.ejs                  # home, results, trip, confirmation, lookup
├── public/
│   ├── css/style.css        # design tokens + all styles
│   └── js/app.js             # ~30 lines of vanilla JS
└── data/app.db              # SQLite file, created on first run
```

## Data model

Matches the PRD exactly: `cities`, `operators`, `trips`, `bookings`,
`booking_status_logs` (all status changes are logged with who/when/old→new).
See `src/db.js` for the full schema with types and constraints.

## Notes on gaps flagged earlier (and what this build does about them)

- **Duplicate bookings:** implemented as same-phone + same-trip within 15
  minutes (not counting already-cancelled attempts). This is a starting
  point — tune the window as needed.
- **Overbooking / concurrency:** seat decrement happens inside a SQL
  transaction with a `WHERE available_seats >= ?` guard, so two simultaneous
  bookings for the last seat can't both succeed. SQLite's single-writer
  model makes this safe without extra locking; if you migrate to
  Postgres/MySQL, keep the same "conditional UPDATE inside a transaction"
  pattern.
- **Pending-booking expiry:** **not implemented yet.** Right now a `pending`
  booking holds its seats indefinitely until an operator acts on it. For a
  real deployment, add a background job (cron or a simple `setInterval`)
  that auto-cancels `pending` bookings older than N hours and releases their
  seats — the `booking_status_logs` table already supports logging that as
  `changed_by = 'system:expiry'`.
- **Operator-to-operator isolation:** enforced — the bookings and trip
  management routes check `trip.operator_id === session.operatorId` and
  404 otherwise.
- **Booking reference format:** 6 unambiguous base-32-ish characters
  (excludes `0`, `O`, `1`, `I`) prefixed `RH-`, e.g. `RH-7K3F9Q`.

## Performance notes

- Arabic/English fonts (Cairo, Roboto) are loaded from Google Fonts via
  `<link>` tags for simplicity. On a genuinely low-bandwidth / offline-prone
  network (or to hit the <3–4s-on-3G target reliably), self-host the two
  font files instead and drop the external request — the CSS already has
  system-font fallbacks so the page is fully usable even if the fonts fail
  to load.
- No client-side JS framework, no build step, one CSS file, one small JS
  file: there is very little to minify or bundle. If you want to go
  further, gzip/Brotli-compress static assets at the web-server/reverse-proxy
  layer (nginx, Caddy) in production.

## Moving to production

This MVP uses SQLite for zero-setup local development. Before going live:

1. Swap `node:sqlite` for `pg` (PostgreSQL) or `mysql2`, keeping the same
   table shapes — the SQL in `src/db.js`/`src/app.js` is close to
   standard and should port with minor syntax changes (e.g. `datetime('now')`
   → `NOW()`).
2. Set a real `SESSION_SECRET` environment variable (a long random string)
   instead of the `dev-secret-change-in-production` default.
3. Put the app behind HTTPS (via your host/reverse proxy) — cookies are
   already flagged `httpOnly`/`sameSite: lax`; add `secure: true` once
   HTTPS is in place.
4. Add the pending-booking expiry job described above.
5. Consider rate-limiting `/trip/:id/book` and `/operator/login` at the
   reverse-proxy level to reduce spam/brute-force risk.
