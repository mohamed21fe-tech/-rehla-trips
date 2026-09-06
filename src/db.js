const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'app.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS cities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name_ar TEXT NOT NULL,
    name_en TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS operators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    contact_info TEXT
  );

  CREATE TABLE IF NOT EXISTS trips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origin_city_id INTEGER NOT NULL REFERENCES cities(id),
    destination_city_id INTEGER NOT NULL REFERENCES cities(id),
    date TEXT NOT NULL,
    departure_time TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    vehicle_type TEXT NOT NULL CHECK (vehicle_type IN ('bus','minibus','shared_taxi')),
    total_seats INTEGER NOT NULL,
    available_seats INTEGER NOT NULL,
    price_syp INTEGER NOT NULL,
    operator_id INTEGER NOT NULL REFERENCES operators(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','completed'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trip_id INTEGER NOT NULL REFERENCES trips(id),
    passenger_name TEXT NOT NULL,
    passenger_phone TEXT NOT NULL,
    passenger_id_number TEXT,
    seats_count INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','cancelled','no_show')),
    booking_reference TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS booking_status_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    booking_id INTEGER NOT NULL REFERENCES bookings(id),
    old_status TEXT NOT NULL,
    new_status TEXT NOT NULL,
    changed_by TEXT NOT NULL,
    changed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_trips_search ON trips(origin_city_id, destination_city_id, date, status);
  CREATE INDEX IF NOT EXISTS idx_bookings_trip ON bookings(trip_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_phone ON bookings(passenger_phone, trip_id);
`);

function seedIfEmpty() {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM cities').get();
  if (count > 0) return;

  const cities = [
    ['دمشق', 'Damascus'],
    ['حلب', 'Aleppo'],
    ['حمص', 'Homs'],
    ['حماة', 'Hama'],
    ['اللاذقية', 'Lattakia'],
    ['طرطوس', 'Tartus'],
    ['درعا', 'Daraa'],
    ['إدلب', 'Idlib'],
    ['دير الزور', 'Deir ez-Zor'],
    ['القامشلي', 'Qamishli'],
  ];
  const insertCity = db.prepare('INSERT INTO cities (name_ar, name_en, is_active) VALUES (?, ?, 1)');
  const cityIds = {};
  for (const [ar, en] of cities) {
    const info = insertCity.run(ar, en);
    cityIds[en] = Number(info.lastInsertRowid);
  }

  const insertOperator = db.prepare(
    'INSERT INTO operators (company_name, username, password_hash, contact_info) VALUES (?, ?, ?, ?)'
  );
  const demoHash = bcrypt.hashSync('demo1234', 10);
  const op1 = insertOperator.run('الشام إكسبرس', 'sham_express', demoHash, '+963-11-1234567');
  const op2 = insertOperator.run('نجمة الساحل', 'coast_star', demoHash, '+963-41-7654321');
  const operatorIds = [Number(op1.lastInsertRowid), Number(op2.lastInsertRowid)];

  const insertTrip = db.prepare(`
    INSERT INTO trips (origin_city_id, destination_city_id, date, departure_time, duration_minutes,
      vehicle_type, total_seats, available_seats, price_syp, operator_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `);

  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  const dates = [0, 1, 2, 3].map((offset) => {
    const d = new Date(today);
    d.setDate(d.getDate() + offset);
    return fmt(d);
  });

  const demoTrips = [
    ['Damascus', 'Aleppo', '07:00', 300, 'bus', 44, 44, 45000],
    ['Damascus', 'Aleppo', '13:30', 300, 'bus', 44, 12, 45000],
    ['Damascus', 'Homs', '09:00', 105, 'minibus', 14, 6, 18000],
    ['Damascus', 'Lattakia', '08:15', 240, 'bus', 44, 30, 40000],
    ['Aleppo', 'Lattakia', '10:00', 210, 'shared_taxi', 4, 2, 35000],
    ['Homs', 'Tartus', '16:00', 90, 'minibus', 14, 14, 15000],
    ['Damascus', 'Daraa', '06:30', 120, 'shared_taxi', 4, 0, 20000],
  ];

  let opToggle = 0;
  for (const date of dates) {
    for (const [origin, dest, time, dur, vType, total, avail, price] of demoTrips) {
      insertTrip.run(
        cityIds[origin],
        cityIds[dest],
        date,
        time,
        dur,
        vType,
        total,
        avail,
        price,
        operatorIds[opToggle % operatorIds.length]
      );
      opToggle++;
    }
  }

  console.log('Seed data inserted. Demo operator login: sham_express / demo1234 (or coast_star / demo1234)');
}

seedIfEmpty();

module.exports = db;
