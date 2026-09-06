const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('node:crypto');
const path = require('node:path');
const db = require('./db');
const { getDict } = require('./i18n');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1d' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 8 },
  })
);

// ---------- Helpers ----------

function resolveLang(req) {
  const q = req.query.lang || req.body.lang;
  return q === 'en' ? 'en' : 'ar';
}

function altLangUrlFor(req, lang) {
  const nextLang = lang === 'ar' ? 'en' : 'ar';
  const params = new URLSearchParams(req.query);
  params.set('lang', nextLang);
  return `${req.path}?${params.toString()}`;
}

app.use((req, res, next) => {
  const lang = resolveLang(req);
  res.locals.t = getDict(lang);
  res.locals.altLangUrl = altLangUrlFor(req, lang);
  next();
});

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function generateReference() {
  // Human-friendly, hard to guess sequentially: e.g. RH-7K3F9Q
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0,O,1,I)
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[crypto.randomInt(0, chars.length)];
  }
  return `RH-${code}`;
}

// Basic phone validation: digits, spaces, +, - ; 8-15 digits total.
function isValidPhone(phone) {
  const digits = (phone || '').replace(/[^0-9]/g, '');
  return digits.length >= 8 && digits.length <= 15;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function requireOperator(req, res, next) {
  if (!req.session.operatorId) {
    return res.redirect(`/operator/login?lang=${res.locals.t.lang}`);
  }
  next();
}

const statusLabelKey = {
  pending: 'statusPending',
  confirmed: 'statusConfirmed',
  cancelled: 'statusCancelled',
  no_show: 'statusNoShow',
};

// ---------- Queries ----------

function getActiveCities() {
  return db.prepare('SELECT * FROM cities WHERE is_active = 1 ORDER BY name_en').all();
}

function getCityById(id) {
  return db.prepare('SELECT * FROM cities WHERE id = ?').get(id);
}

function searchTrips(originId, destinationId, date) {
  return db
    .prepare(
      `SELECT trips.*, operators.company_name
       FROM trips
       JOIN operators ON operators.id = trips.operator_id
       WHERE trips.origin_city_id = ?
         AND trips.destination_city_id = ?
         AND trips.date = ?
         AND trips.status = 'active'
       ORDER BY trips.departure_time ASC`
    )
    .all(originId, destinationId, date);
}

function getTripWithCities(tripId) {
  return db
    .prepare(
      `SELECT trips.*, operators.company_name,
              oc.name_ar AS origin_ar, oc.name_en AS origin_en,
              dc.name_ar AS destination_ar, dc.name_en AS destination_en
       FROM trips
       JOIN operators ON operators.id = trips.operator_id
       JOIN cities oc ON oc.id = trips.origin_city_id
       JOIN cities dc ON dc.id = trips.destination_city_id
       WHERE trips.id = ?`
    )
    .get(tripId);
}

// ---------- Public routes ----------

app.get('/', (req, res) => {
  const t = res.locals.t;
  res.render('home', {
    t,
    altLangUrl: res.locals.altLangUrl,
    cities: getActiveCities(),
    query: req.query,
    today: todayStr(),
  });
});

app.get('/search', (req, res) => {
  const t = res.locals.t;
  const { origin, destination, date } = req.query;
  const cities = getActiveCities();

  if (!origin || !destination || !date) {
    return res.redirect(`/?lang=${t.lang}`);
  }
  if (origin === destination) {
    return res.render('home', {
      t,
      altLangUrl: res.locals.altLangUrl,
      cities,
      query: req.query,
      today: todayStr(),
      errorBanner: t.errorSameCity,
    });
  }

  const originCity = getCityById(origin);
  const destinationCity = getCityById(destination);
  if (!originCity || !destinationCity) {
    return res.redirect(`/?lang=${t.lang}`);
  }

  const trips = searchTrips(origin, destination, date);
  res.render('results', {
    t,
    altLangUrl: res.locals.altLangUrl,
    trips,
    origin: originCity,
    destination: destinationCity,
    date,
  });
});

app.get('/trip/:id', (req, res) => {
  const t = res.locals.t;
  const trip = getTripWithCities(req.params.id);
  if (!trip || trip.status !== 'active' || trip.available_seats <= 0) {
    return res.status(404).send('Trip not found or unavailable.');
  }
  res.render('trip', { t, altLangUrl: res.locals.altLangUrl, trip });
});

app.post('/trip/:id/book', (req, res) => {
  const t = res.locals.t;
  const trip = getTripWithCities(req.params.id);
  if (!trip || trip.status !== 'active') {
    return res.status(404).send('Trip not found or unavailable.');
  }

  const { passenger_name, passenger_phone, passenger_id_number, seats_count } = req.body;
  const fieldErrors = {};
  const seats = parseInt(seats_count, 10);

  if (!passenger_name || !passenger_name.trim()) fieldErrors.passenger_name = t.errorRequired;
  if (!passenger_phone || !isValidPhone(passenger_phone)) fieldErrors.passenger_phone = t.errorPhone;
  if (!seats || seats < 1) fieldErrors.seats_count = t.errorSeats;
  else if (seats > trip.available_seats) fieldErrors.seats_count = t.errorNotEnoughSeats;

  if (Object.keys(fieldErrors).length > 0) {
    return res.render('trip', {
      t,
      altLangUrl: res.locals.altLangUrl,
      trip,
      fieldErrors,
      form: req.body,
    });
  }

  // Duplicate-booking guard: same phone + same trip within the last 15 minutes.
  const recentDuplicate = db
    .prepare(
      `SELECT id FROM bookings
       WHERE trip_id = ? AND passenger_phone = ?
         AND status != 'cancelled'
         AND created_at >= datetime('now', '-15 minutes')`
    )
    .get(trip.id, passenger_phone.trim());

  if (recentDuplicate) {
    return res.render('trip', {
      t,
      altLangUrl: res.locals.altLangUrl,
      trip,
      errorBanner: t.errorDuplicate,
      form: req.body,
    });
  }

  // Re-check seat availability and decrement atomically within a transaction-like sequence.
  const freshTrip = db.prepare('SELECT available_seats FROM trips WHERE id = ?').get(trip.id);
  if (!freshTrip || freshTrip.available_seats < seats) {
    return res.render('trip', {
      t,
      altLangUrl: res.locals.altLangUrl,
      trip: getTripWithCities(trip.id),
      fieldErrors: { seats_count: t.errorNotEnoughSeats },
      form: req.body,
    });
  }

  let reference = generateReference();
  // Ensure uniqueness (extremely unlikely to collide, but guard anyway).
  while (db.prepare('SELECT id FROM bookings WHERE booking_reference = ?').get(reference)) {
    reference = generateReference();
  }

  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE trips SET available_seats = available_seats - ? WHERE id = ? AND available_seats >= ?`
    ).run(seats, trip.id, seats);

    const info = db
      .prepare(
        `INSERT INTO bookings
          (trip_id, passenger_name, passenger_phone, passenger_id_number, seats_count, status, booking_reference)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`
      )
      .run(
        trip.id,
        passenger_name.trim(),
        passenger_phone.trim(),
        (passenger_id_number || '').trim() || null,
        seats,
        reference
      );

    db.prepare(
      `INSERT INTO booking_status_logs (booking_id, old_status, new_status, changed_by) VALUES (?, '', 'pending', 'system')`
    ).run(Number(info.lastInsertRowid));

    db.exec('COMMIT');

    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(Number(info.lastInsertRowid));
    return res.render('confirmation', {
      t,
      altLangUrl: res.locals.altLangUrl,
      booking,
      trip: getTripWithCities(trip.id),
    });
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(err);
    return res.render('trip', {
      t,
      altLangUrl: res.locals.altLangUrl,
      trip: getTripWithCities(trip.id),
      errorBanner: t.errorGeneric,
      form: req.body,
    });
  }
});

app.get('/lookup', (req, res) => {
  const t = res.locals.t;
  const { phone, ref } = req.query;

  if (!phone || !ref) {
    return res.render('lookup', { t, altLangUrl: res.locals.altLangUrl, query: req.query });
  }

  const booking = db
    .prepare('SELECT * FROM bookings WHERE passenger_phone = ? AND booking_reference = ?')
    .get(phone.trim(), ref.trim().toUpperCase());

  if (!booking) {
    return res.render('lookup', { t, altLangUrl: res.locals.altLangUrl, query: req.query, notFound: true });
  }

  const trip = getTripWithCities(booking.trip_id);
  res.render('lookup', {
    t,
    altLangUrl: res.locals.altLangUrl,
    query: req.query,
    booking,
    trip,
    statusLabel: t[statusLabelKey[booking.status]],
  });
});

// ---------- Operator (admin) routes ----------

app.get('/operator/login', (req, res) => {
  const t = res.locals.t;
  if (req.session.operatorId) return res.redirect(`/operator/dashboard?lang=${t.lang}`);
  res.render('operator/login', { t, altLangUrl: res.locals.altLangUrl });
});

app.post('/operator/login', (req, res) => {
  const t = res.locals.t;
  const { username, password } = req.body;
  const operator = db.prepare('SELECT * FROM operators WHERE username = ?').get((username || '').trim());

  if (!operator || !bcrypt.compareSync(password || '', operator.password_hash)) {
    return res.render('operator/login', {
      t,
      altLangUrl: res.locals.altLangUrl,
      errorBanner: t.invalidCredentials,
    });
  }

  req.session.operatorId = operator.id;
  res.redirect(`/operator/dashboard?lang=${t.lang}`);
});

app.post('/operator/logout', (req, res) => {
  const lang = resolveLang(req);
  req.session.destroy(() => res.redirect(`/operator/login?lang=${lang}`));
});

app.get('/operator/dashboard', requireOperator, (req, res) => {
  const t = res.locals.t;
  const operator = db.prepare('SELECT * FROM operators WHERE id = ?').get(req.session.operatorId);
  const trips = db
    .prepare(
      `SELECT trips.*, oc.name_ar AS origin_ar, oc.name_en AS origin_en,
              dc.name_ar AS destination_ar, dc.name_en AS destination_en
       FROM trips
       JOIN cities oc ON oc.id = trips.origin_city_id
       JOIN cities dc ON dc.id = trips.destination_city_id
       WHERE trips.operator_id = ?
       ORDER BY trips.date DESC, trips.departure_time ASC`
    )
    .all(operator.id);

  res.render('operator/dashboard', { t, altLangUrl: res.locals.altLangUrl, operator, trips });
});

app.get('/operator/trips/new', requireOperator, (req, res) => {
  const t = res.locals.t;
  res.render('operator/new-trip', {
    t,
    altLangUrl: res.locals.altLangUrl,
    cities: getActiveCities(),
    today: todayStr(),
  });
});

app.post('/operator/trips/new', requireOperator, (req, res) => {
  const t = res.locals.t;
  const {
    origin_city_id, destination_city_id, date, departure_time,
    duration_minutes, vehicle_type, total_seats, price_syp,
  } = req.body;

  const seats = parseInt(total_seats, 10);
  const price = parseInt(price_syp, 10);
  const duration = parseInt(duration_minutes, 10);
  const validVehicles = ['bus', 'minibus', 'shared_taxi'];

  if (
    !origin_city_id || !destination_city_id || origin_city_id === destination_city_id ||
    !date || !departure_time || !duration || duration < 1 ||
    !validVehicles.includes(vehicle_type) ||
    !seats || seats < 1 || !Number.isFinite(price) || price < 0
  ) {
    return res.render('operator/new-trip', {
      t,
      altLangUrl: res.locals.altLangUrl,
      cities: getActiveCities(),
      today: todayStr(),
      errorBanner: t.errorGeneric,
    });
  }

  db.prepare(
    `INSERT INTO trips
      (origin_city_id, destination_city_id, date, departure_time, duration_minutes,
       vehicle_type, total_seats, available_seats, price_syp, operator_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
  ).run(
    origin_city_id, destination_city_id, date, departure_time, duration,
    vehicle_type, seats, seats, price, req.session.operatorId
  );

  res.redirect(`/operator/dashboard?lang=${t.lang}`);
});

app.get('/operator/trips/:id/bookings', requireOperator, (req, res) => {
  const t = res.locals.t;
  const trip = getTripWithCities(req.params.id);
  if (!trip || trip.operator_id !== req.session.operatorId) {
    return res.status(404).send('Not found.');
  }
  const bookings = db
    .prepare('SELECT * FROM bookings WHERE trip_id = ? ORDER BY created_at DESC')
    .all(trip.id);

  const statusLabels = {
    pending: t.statusPending,
    confirmed: t.statusConfirmed,
    cancelled: t.statusCancelled,
    no_show: t.statusNoShow,
  };

  res.render('operator/bookings', { t, altLangUrl: res.locals.altLangUrl, trip, bookings, statusLabels });
});

app.post('/operator/bookings/:id/status', requireOperator, (req, res) => {
  const t = res.locals.t;
  const { status } = req.body;
  const validStatuses = ['confirmed', 'cancelled', 'no_show'];
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);

  if (!booking || !validStatuses.includes(status)) {
    return res.status(400).send('Invalid request.');
  }

  const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(booking.trip_id);
  if (!trip || trip.operator_id !== req.session.operatorId) {
    return res.status(404).send('Not found.');
  }

  // Only allow sane transitions.
  const allowedFrom = {
    confirmed: ['pending'],
    cancelled: ['pending', 'confirmed'],
    no_show: ['confirmed'],
  };
  if (!allowedFrom[status].includes(booking.status)) {
    return res.redirect(`/operator/trips/${trip.id}/bookings?lang=${t.lang}`);
  }

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE bookings SET status = ? WHERE id = ?').run(status, booking.id);
    db.prepare(
      `INSERT INTO booking_status_logs (booking_id, old_status, new_status, changed_by) VALUES (?, ?, ?, ?)`
    ).run(booking.id, booking.status, status, `operator:${req.session.operatorId}`);

    // Cancelling a previously pending/confirmed booking releases its seats.
    if (status === 'cancelled') {
      db.prepare('UPDATE trips SET available_seats = available_seats + ? WHERE id = ?').run(
        booking.seats_count,
        trip.id
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(err);
  }

  res.redirect(`/operator/trips/${trip.id}/bookings?lang=${t.lang}`);
});

// ---------- Fallback ----------

app.use((req, res) => {
  res.status(404).send('Page not found.');
});

module.exports = app;
