// Qi payment integration foundation. No live gateway/device connection is enabled.
// All amounts are integer Iraqi dinars. No card data, PIN or gateway secrets are stored.
import crypto from 'node:crypto';

export const QI_PROVIDER = 'qi';
export const QI_CHANNELS = Object.freeze(['pos', 'gateway']);
export const QI_STATES = Object.freeze(['pending', 'confirmed', 'failed', 'cancelled', 'refunded']);

export function initializeQiIntegration(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS qi_payment_intents (
      id TEXT PRIMARY KEY,
      invoice_id INTEGER,
      channel TEXT NOT NULL CHECK(channel IN ('pos','gateway')),
      amount_iqd INTEGER NOT NULL CHECK(amount_iqd>0),
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','confirmed','failed','cancelled','refunded')),
      provider_reference TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qi_provider_events (
      event_id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL REFERENCES qi_payment_intents(id),
      received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS qi_settlement_records (
      id TEXT PRIMARY KEY,
      provider_reference TEXT NOT NULL UNIQUE,
      amount_iqd INTEGER NOT NULL,
      fee_iqd INTEGER NOT NULL DEFAULT 0,
      settled_at TEXT,
      matched_at TEXT
    );
  `);
}

export function createQiIntent(db, {invoiceId = null, channel, amountIqd}) {
  if (!QI_CHANNELS.includes(channel) || !Number.isSafeInteger(amountIqd) || amountIqd <= 0)
    throw new Error('Invalid Qi payment intent');
  const id = crypto.randomUUID(), now = new Date().toISOString();
  db.prepare('INSERT INTO qi_payment_intents(id,invoice_id,channel,amount_iqd,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, invoiceId, channel, amountIqd, 'pending', now, now);
  return {id, invoiceId, channel, amountIqd, state:'pending'};
}

// Provider confirmation must first be authenticated by a Qi-specific adapter.
// This module intentionally does not post journals or mark invoices as paid.
export function recordVerifiedQiEvent(db, {eventId, intentId, state, providerReference}) {
  if (!eventId || !intentId || !QI_STATES.includes(state) || state === 'pending')
    throw new Error('Invalid Qi event');
  const apply = db.transaction(() => {
    const intent = db.prepare('SELECT * FROM qi_payment_intents WHERE id=?').get(intentId);
    if (!intent) throw new Error('Qi intent not found');
    if (db.prepare('SELECT 1 FROM qi_provider_events WHERE event_id=?').get(eventId))
      return {duplicate:true, state:intent.state};
    if (intent.state !== 'pending') throw new Error('Qi intent already finalized');
    if (state === 'confirmed' && !providerReference) throw new Error('Missing Qi transaction reference');
    db.prepare('INSERT INTO qi_provider_events(event_id,intent_id,received_at) VALUES(?,?,?)')
      .run(eventId,intentId,new Date().toISOString());
    db.prepare('UPDATE qi_payment_intents SET state=?,provider_reference=?,updated_at=? WHERE id=?')
      .run(state,providerReference||null,new Date().toISOString(),intentId);
    return {duplicate:false,state};
  });
  return apply();
}
