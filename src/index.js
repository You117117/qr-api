// QR Ordering API
// Blocs 1-3 migrés vers la DB (tables, sessions, commandes)
// Bloc 4: calcul centralisé des statuts métier côté backend.

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const express = require('express');
const cors = require('cors');
const qrRouter = require('./qr');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);


const app = express();
app.use(cors());
app.use(express.json());

app.get('/debug/tenants', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tenants')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('GET /debug/tenants supabase error:', error);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({ ok: true, tenants: data });
  } catch (err) {
    console.error('GET /debug/tenants unexpected error:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

app.get('/debug/restaurant-tables', async (req, res) => {
  try {
    const tables = await getRestaurantTablesFromDb();
    return res.json({ ok: true, tables });
  } catch (err) {
    console.error('GET /debug/restaurant-tables error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'internal_error' });
  }
});

app.get('/debug/sessions', async (_req, res) => {
  try {
    const storage = await detectSessionStorageMode();
    if (storage !== 'db') {
      return res.json({ ok: true, storage, sessions: tableState });
    }

    const sessionMap = await getActiveSessionsMapFromDb();
    const businessDay = getBusinessDayKey();
    const now = new Date();
    const sessions = await Promise.all(Array.from(sessionMap.values()).map(async (sessionState) => {
      const businessState = await getTableBusinessState(sessionState.tableCode, businessDay, now, sessionMap);
      return {
        ...sessionState,
        rawStatus: sessionState.status || null,
        status: businessState.status,
        pending: businessState.pending,
        lastTicketAt: businessState.lastTicketAt,
        lastTicket: businessState.lastTicketSummary,
      };
    }));
    return res.json({
      ok: true,
      storage,
      startedAtColumn: SESSION_STARTED_AT_COLUMN,
      sessions,
    });
  } catch (err) {
    console.error('GET /debug/sessions error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'internal_error' });
  }
});

app.get('/debug/orders', async (_req, res) => {
  try {
    const businessDay = getBusinessDayKey();
    const snapshot = await getOrderStorageSnapshot(businessDay);
    return res.json({ ok: true, storage: snapshot.storage, businessDay, tickets: snapshot.tickets, error: snapshot.error || null });
  } catch (err) {
    console.error('GET /debug/orders error:', err);
    return res.status(500).json({ ok: false, error: err.message || 'internal_error' });
  }
});

// ---- Session client (démarrage sans commande : prénom validé) ----
    // Body attendu : { table }
    app.post('/session/start', async (req, res) => {
      try {
        const table = normalizeTableCode(req.body?.table || '');
        if (!table) return res.json({ ok: true });

        const session = await ensureActiveSessionForTable(table, nowIso());

        return res.json({
          ok: true,
          storage: await detectTicketStorageMode(),
          sessionStartAt: session.sessionStartAt || null,
        });
      } catch (err) {
        console.error('POST /session/start error', err);
        return res.status(500).json({ ok: false, error: 'internal_error' });
      }
    });

async function getRestaurantTablesFromDb() {
  const { data, error } = await supabase
    .from('restaurant_tables')
    .select('id, tenant_id, code, label, seats, is_active, created_at')
    .eq('is_active', true)
    .order('code', { ascending: true });

  if (error) {
    throw error;
  }

  return data || [];
}

async function getRestaurantTableCodesFromDb() {
  const tables = await getRestaurantTablesFromDb();
  return tables.map((t) => t.code);
}

async function getRestaurantTableByCodeFromDb(tableCode) {
  const code = String(tableCode || '').trim().toUpperCase();
  if (!code) return null;

  const { data, error } = await supabase
    .from('restaurant_tables')
    .select('id, tenant_id, code, label, seats, is_active, created_at')
    .eq('code', code)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

const SESSION_TABLE = process.env.SESSION_TABLE || 'table_sessions';
const SESSION_STARTED_AT_COLUMN = process.env.SESSION_STARTED_AT_COLUMN || 'opened_at';
let sessionStorageModeCache = null;
const ORDERS_TABLE = process.env.ORDERS_TABLE || 'orders';
const ORDER_ITEMS_TABLE = process.env.ORDER_ITEMS_TABLE || 'order_items';
const SESSION_EVENTS_TABLE = process.env.SESSION_EVENTS_TABLE || 'table_session_events';
let ticketStorageModeCache = null;
let sessionEventsStorageModeCache = null;

function getBusinessDayRange(businessDay) {
  const start = new Date(`${businessDay}T00:00:00.000Z`);
  start.setUTCHours(RESET_HOUR, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

async function detectTicketStorageMode() {
  if (ticketStorageModeCache) return ticketStorageModeCache;
  try {
    const [ordersResp, itemsResp] = await Promise.all([
      supabase.from(ORDERS_TABLE).select('id', { head: true, count: 'exact' }).limit(1),
      supabase.from(ORDER_ITEMS_TABLE).select('id', { head: true, count: 'exact' }).limit(1),
    ]);
    if (ordersResp.error || itemsResp.error) {
      const err = ordersResp.error || itemsResp.error;
      console.warn(`[tickets] fallback mémoire activé: tables "${ORDERS_TABLE}" / "${ORDER_ITEMS_TABLE}" indisponibles`, err.message || err);
      ticketStorageModeCache = 'memory';
      return ticketStorageModeCache;
    }
    ticketStorageModeCache = 'db';
    console.log(`[tickets] storage mode = db (${ORDERS_TABLE}, ${ORDER_ITEMS_TABLE})`);
    return ticketStorageModeCache;
  } catch (err) {
    console.warn('[tickets] fallback mémoire activé: détection impossible', err.message || err);
    ticketStorageModeCache = 'memory';
    return ticketStorageModeCache;
  }
}

function extrasToNotes(extras) {
  if (!Array.isArray(extras) || !extras.length) return null;
  const clean = extras.map((x) => String(x || '').trim()).filter(Boolean);
  return clean.length ? `Extras: ${clean.join(', ')}` : null;
}

function notesToExtras(notes) {
  const raw = String(notes || '').trim();
  if (!raw.startsWith('Extras:')) return [];
  return raw.slice(7).split(',').map((x) => x.trim()).filter(Boolean);
}

async function detectSessionEventsStorageMode() {
  if (sessionEventsStorageModeCache) return sessionEventsStorageModeCache;
  try {
    const { error } = await supabase
      .from(SESSION_EVENTS_TABLE)
      .select('id', { head: true, count: 'exact' })
      .limit(1);

    if (error) {
      console.warn(`[session-events] journal DB indisponible sur "${SESSION_EVENTS_TABLE}":`, error.message || error);
      sessionEventsStorageModeCache = 'disabled';
      return sessionEventsStorageModeCache;
    }

    sessionEventsStorageModeCache = 'db';
    console.log(`[session-events] storage mode = db (${SESSION_EVENTS_TABLE})`);
    return sessionEventsStorageModeCache;
  } catch (err) {
    console.warn('[session-events] détection impossible:', err.message || err);
    sessionEventsStorageModeCache = 'disabled';
    return sessionEventsStorageModeCache;
  }
}

function buildSessionEventPayload(eventType, sessionState, tableCode, extra = {}) {
  return {
    tenant_id: sessionState?.tenantId || extra.tenantId || null,
    table_session_id: sessionState?.id || extra.sessionId || null,
    table_id: sessionState?.tableId || extra.tableId || null,
    table_code: normalizeTableCode(tableCode || sessionState?.tableCode || extra.tableCode || null),
    event_type: String(eventType || '').trim() || 'unknown',
    payload: {
      status: extra.status || sessionState?.status || null,
      posConfirmed: typeof extra.posConfirmed === 'boolean' ? extra.posConfirmed : !!sessionState?.posConfirmed,
      closedWithAnomaly: typeof extra.closedWithAnomaly === 'boolean' ? extra.closedWithAnomaly : !!sessionState?.closedWithAnomaly,
      reason: extra.reason || null,
      note: extra.note || null,
      source: extra.source || 'api',
      staffId: extra.staffId || null,
      total: typeof extra.total === 'number' ? extra.total : (sessionState?.sessionTotal ?? null),
      metadata: extra.metadata || null,
    },
    created_at: extra.createdAt || nowIso(),
  };
}

async function appendSessionEvent(eventType, sessionState, tableCode, extra = {}) {
  const storage = await detectSessionEventsStorageMode();
  const payload = buildSessionEventPayload(eventType, sessionState, tableCode, extra);

  if (storage !== 'db') {
    return { ok: false, storage, skipped: true, payload };
  }

  const { error } = await supabase.from(SESSION_EVENTS_TABLE).insert(payload);
  if (error) {
    console.error('[session-events] insert failed:', error.message || error, payload);
    return { ok: false, storage: 'db-error', error: error.message || String(error), payload };
  }

  return { ok: true, storage: 'db' };
}

async function getSessionEventsForBusinessDay(businessDay) {
  const storage = await detectSessionEventsStorageMode();
  if (storage !== 'db') {
    return { storage, events: [] };
  }

  const { startIso, endIso } = getBusinessDayRange(businessDay);
  const { data, error } = await supabase
    .from(SESSION_EVENTS_TABLE)
    .select('*')
    .gte('created_at', startIso)
    .lt('created_at', endIso)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[session-events] read failed:', error.message || error);
    return { storage: 'db-error', events: [], error: error.message || String(error) };
  }

  return { storage: 'db', events: data || [] };
}

function mapDbRowsToTicket(orderRow, itemRows, sessionRow, tableCode) {
  const items = (itemRows || []).map((row) => ({
    id: row.id,
    name: row.product_name || 'Article',
    qty: Number(row.quantity || 0),
    price: Number(row.unit_price || 0),
    clientName: row.guest_name || undefined,
    extras: notesToExtras(row.notes),
  }));
  const total = items.reduce((sum, it) => sum + Number(it.qty || 0) * Number(it.price || 0), 0);
  const createdAt = orderRow.created_at || nowIso();
  return {
    id: orderRow.id,
    table: tableCode,
    items,
    total: Math.round(total * 100) / 100,
    createdAt,
    date: getBusinessDayKey(new Date(createdAt)),
    sessionKey: sessionRow?.opened_at || sessionRow?.id || createdAt,
    sessionStartedAt: sessionRow?.opened_at || null,
    printedAt: orderRow.printed_at || null,
    paidAt: sessionRow?.pos_confirmed_at || null,
    closedAt: sessionRow?.closed_at || null,
    paid: !!sessionRow?.pos_confirmed,
    posConfirmed: !!sessionRow?.pos_confirmed,
    posConfirmedAt: sessionRow?.pos_confirmed_at || null,
    closedWithException: !!sessionRow?.closed_with_anomaly,
    exceptionReason: sessionRow?.closed_with_anomaly ? 'POS_NON_CONFIRME' : null,
    clientName: null,
    sequenceInSession: orderRow.sequence_in_session || null,
  };
}

async function getOrderStorageSnapshot(businessDay) {
  const mode = await detectTicketStorageMode();
  if (mode !== 'db') {
    return {
      storage: mode,
      tickets: tickets.filter((t) => t.date === businessDay).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))),
    };
  }

  const { startIso, endIso } = getBusinessDayRange(businessDay);
  const { data: orderRows, error: ordersError } = await supabase
    .from(ORDERS_TABLE)
    .select('*')
    .gte('created_at', startIso)
    .lt('created_at', endIso)
    .order('created_at', { ascending: true });

  if (ordersError) {
    console.error('[tickets] getOrderStorageSnapshot fallback mémoire:', ordersError.message || ordersError);
    return {
      storage: 'memory-fallback',
      tickets: tickets.filter((t) => t.date === businessDay).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))),
      error: ordersError.message || String(ordersError),
    };
  }

  const orders = orderRows || [];
  if (!orders.length) {
    return { storage: 'db', tickets: [] };
  }

  const orderIds = orders.map((o) => o.id);
  const sessionIds = [...new Set(orders.map((o) => o.table_session_id).filter(Boolean))];
  const [itemsResp, sessionsResp, tables] = await Promise.all([
    supabase.from(ORDER_ITEMS_TABLE).select('*').in('order_id', orderIds).order('created_at', { ascending: true }),
    sessionIds.length ? supabase.from(SESSION_TABLE).select('*').in('id', sessionIds) : Promise.resolve({ data: [], error: null }),
    getRestaurantTablesFromDb(),
  ]);

  if (itemsResp.error || sessionsResp.error) {
    const err = itemsResp.error || sessionsResp.error;
    console.error('[tickets] getOrderStorageSnapshot fallback mémoire:', err.message || err);
    return {
      storage: 'memory-fallback',
      tickets: tickets.filter((t) => t.date === businessDay).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))),
      error: err.message || String(err),
    };
  }

  const itemsByOrderId = new Map();
  (itemsResp.data || []).forEach((row) => {
    const arr = itemsByOrderId.get(row.order_id) || [];
    arr.push(row);
    itemsByOrderId.set(row.order_id, arr);
  });
  const sessionsById = new Map((sessionsResp.data || []).map((s) => [s.id, s]));
  const codeByTableId = new Map((tables || []).map((t) => [t.id, normalizeTableCode(t.code)]));

  return {
    storage: 'db',
    tickets: orders.map((orderRow) => {
      const sessionRow = sessionsById.get(orderRow.table_session_id) || null;
      const tableCode = codeByTableId.get(sessionRow?.table_id) || null;
      return mapDbRowsToTicket(orderRow, itemsByOrderId.get(orderRow.id) || [], sessionRow, tableCode);
    }).filter((t) => t.table),
  };
}

async function syncSessionTotalInDb(sessionId) {
  if (!sessionId) return null;
  if ((await detectTicketStorageMode()) !== 'db') return null;

  const { data: rows, error } = await supabase
    .from(ORDERS_TABLE)
    .select('id, table_session_id, order_items(quantity, unit_price)')
    .eq('table_session_id', sessionId);

  if (error) {
    console.error('[tickets] syncSessionTotalInDb skipped:', error.message || error);
    return null;
  }

  const total = (rows || []).reduce((sum, orderRow) => {
    const nested = Array.isArray(orderRow.order_items) ? orderRow.order_items : [];
    return sum + nested.reduce((s, item) => s + Number(item.quantity || 0) * Number(item.unit_price || 0), 0);
  }, 0);

  const rounded = Math.round(total * 100) / 100;
  const { error: updateError } = await supabase
    .from(SESSION_TABLE)
    .update({ session_total: rounded })
    .eq('id', sessionId);

  if (updateError) {
    console.error('[tickets] syncSessionTotalInDb update failed:', updateError.message || updateError);
    return null;
  }

  return rounded;
}

async function listTicketsForBusinessDayFromDb(businessDay) {
  const snapshot = await getOrderStorageSnapshot(businessDay);
  return snapshot.tickets;
}

function normalizeTableCode(value) {
  return String(value || '').trim().toUpperCase();
}

function getFallbackTableState(tableCode) {
  const table = normalizeTableCode(tableCode);
  if (!table) {
    return { closedManually: false, sessionStartAt: null };
  }

  if (!tableState[table]) {
    tableState[table] = { closedManually: false, sessionStartAt: null };
  }

  return tableState[table];
}

function getSessionStartedAt(row) {
  if (!row || typeof row !== 'object') return null;
  return row[SESSION_STARTED_AT_COLUMN] || row.opened_at || row.started_at || row.created_at || null;
}

async function detectSessionStorageMode() {
  if (sessionStorageModeCache) {
    return sessionStorageModeCache;
  }

  try {
    const { error } = await supabase
      .from(SESSION_TABLE)
      .select(`id, ${SESSION_STARTED_AT_COLUMN}`, { head: true, count: 'exact' })
      .limit(1);

    if (error) {
      console.warn(`[sessions] fallback mémoire activé: table "${SESSION_TABLE}" indisponible`, error.message || error);
      sessionStorageModeCache = 'memory';
      return sessionStorageModeCache;
    }

    sessionStorageModeCache = 'db';
    console.log(`[sessions] storage mode = db (${SESSION_TABLE})`);
    return sessionStorageModeCache;
  } catch (err) {
    console.warn(`[sessions] fallback mémoire activé: détection impossible sur "${SESSION_TABLE}"`, err.message || err);
    sessionStorageModeCache = 'memory';
    return sessionStorageModeCache;
  }
}

function mapSessionRowToState(row, tableCode = null) {
  if (!row) {
    return { closedManually: false, sessionStartAt: null };
  }

  return {
    id: row.id || null,
    tenantId: row.tenant_id || null,
    tableId: row.table_id || null,
    tableCode: normalizeTableCode(tableCode || row.table_code || row.code || null),
    closedManually: !!row.closed_manually || !!row.closed_with_anomaly || !!row.closed_at,
    sessionStartAt: getSessionStartedAt(row),
    closedAt: row.closed_at || null,
    status: row.status || STATUS.EMPTY,
    posConfirmed: !!row.pos_confirmed,
    posConfirmedAt: row.pos_confirmed_at || null,
    closedWithAnomaly: !!row.closed_with_anomaly,
    sessionTotal: row.session_total ?? null,
    closureType: row.closed_with_anomaly ? 'anomaly' : (row.closed_at ? 'normal' : null),
  };
}

async function getSessionStateForTable(tableCode) {
  const table = normalizeTableCode(tableCode);
  if (!table) {
    return { closedManually: false, sessionStartAt: null };
  }

  const mode = await detectSessionStorageMode();
  if (mode !== 'db') {
    return { ...getFallbackTableState(table) };
  }

  const tableRow = await getRestaurantTableByCodeFromDb(table);
  if (!tableRow) {
    return { closedManually: false, sessionStartAt: null };
  }

  const { data, error } = await supabase
    .from(SESSION_TABLE)
    .select('*')
    .eq('table_id', tableRow.id)
    .is('closed_at', null)
    .order(SESSION_STARTED_AT_COLUMN, { ascending: false })
    .limit(1);

  if (error) {
    console.error(`[sessions] getSessionStateForTable fallback mémoire for ${table}:`, error.message || error);
    return { ...getFallbackTableState(table) };
  }

  const row = Array.isArray(data) && data.length ? data[0] : null;
  if (!row) {
    return { closedManually: false, sessionStartAt: null };
  }

  return mapSessionRowToState(row, tableRow.code);
}

async function getActiveSessionsMapFromDb() {
  const mode = await detectSessionStorageMode();
  const map = new Map();

  if (mode !== 'db') {
    Object.entries(tableState).forEach(([table, flags]) => {
      map.set(table, {
        id: null,
        tenantId: null,
        tableId: null,
        tableCode: table,
        closedManually: !!flags.closedManually,
        sessionStartAt: flags.sessionStartAt || null,
        closedAt: null,
        status: STATUS.EMPTY,
      });
    });
    return map;
  }

  const [sessionsResp, tables] = await Promise.all([
    supabase
      .from(SESSION_TABLE)
      .select('*')
      .is('closed_at', null)
      .order(SESSION_STARTED_AT_COLUMN, { ascending: false }),
    getRestaurantTablesFromDb(),
  ]);

  const { data, error } = sessionsResp;

  if (error) {
    console.error('[sessions] getActiveSessionsMapFromDb fallback mémoire:', error.message || error);
    Object.entries(tableState).forEach(([table, flags]) => {
      map.set(table, {
        id: null,
        tenantId: null,
        tableId: null,
        tableCode: table,
        closedManually: !!flags.closedManually,
        sessionStartAt: flags.sessionStartAt || null,
        closedAt: null,
        status: STATUS.EMPTY,
      });
    });
    return map;
  }

  const codeByTableId = new Map((tables || []).map((row) => [row.id, normalizeTableCode(row.code)]));

  (data || []).forEach((row) => {
    const tableCode = codeByTableId.get(row.table_id) || normalizeTableCode(row.table_code);
    if (!tableCode || map.has(tableCode)) return;
    map.set(tableCode, mapSessionRowToState(row, tableCode));
  });

  return map;
}



async function getLatestSessionsMapFromDb() {
  const mode = await detectSessionStorageMode();
  const map = new Map();

  if (mode !== 'db') {
    Object.entries(tableState).forEach(([table, flags]) => {
      map.set(table, {
        id: null,
        tenantId: null,
        tableId: null,
        tableCode: table,
        closedManually: !!flags.closedManually,
        sessionStartAt: flags.sessionStartAt || null,
        closedAt: null,
        status: STATUS.EMPTY,
        posConfirmed: false,
        posConfirmedAt: null,
        closedWithAnomaly: false,
        sessionTotal: null,
        closureType: null,
      });
    });
    return map;
  }

  const [sessionsResp, tables] = await Promise.all([
    supabase
      .from(SESSION_TABLE)
      .select('*')
      .order(SESSION_STARTED_AT_COLUMN, { ascending: false }),
    getRestaurantTablesFromDb(),
  ]);

  const { data, error } = sessionsResp;

  if (error) {
    console.error('[sessions] getLatestSessionsMapFromDb fallback mémoire:', error.message || error);
    Object.entries(tableState).forEach(([table, flags]) => {
      map.set(table, {
        id: null,
        tenantId: null,
        tableId: null,
        tableCode: table,
        closedManually: !!flags.closedManually,
        sessionStartAt: flags.sessionStartAt || null,
        closedAt: null,
        status: STATUS.EMPTY,
        posConfirmed: false,
        posConfirmedAt: null,
        closedWithAnomaly: false,
        sessionTotal: null,
        closureType: null,
      });
    });
    return map;
  }

  const codeByTableId = new Map((tables || []).map((row) => [row.id, normalizeTableCode(row.code)]));

  (data || []).forEach((row) => {
    const tableCode = codeByTableId.get(row.table_id) || normalizeTableCode(row.table_code);
    if (!tableCode || map.has(tableCode)) return;
    map.set(tableCode, mapSessionRowToState(row, tableCode));
  });

  return map;
}

function isIsoInCurrentBusinessDay(isoValue) {
  if (!isoValue) return false;
  return String(isoValue).slice(0, 10) === getBusinessDayKey();
}

async function ensureActiveSessionForTable(tableCode, startedAt = nowIso()) {
  const table = normalizeTableCode(tableCode);
  if (!table) {
    return { closedManually: false, sessionStartAt: null };
  }

  const current = await getSessionStateForTable(table);
  if (current && current.sessionStartAt && !current.closedAt) {
    if (!current.closedManually && current.sessionStartAt) {
      const fallback = getFallbackTableState(table);
      fallback.closedManually = false;
      fallback.sessionStartAt = current.sessionStartAt;
    }
    return current;
  }

  const mode = await detectSessionStorageMode();
  if (mode !== 'db') {
    const fallback = getFallbackTableState(table);
    fallback.closedManually = false;
    if (!fallback.sessionStartAt) {
      fallback.sessionStartAt = startedAt;
    }
    return { ...fallback, tableCode: table };
  }

  const tableRow = await getRestaurantTableByCodeFromDb(table);
  if (!tableRow) {
    const fallback = getFallbackTableState(table);
    fallback.closedManually = false;
    if (!fallback.sessionStartAt) {
      fallback.sessionStartAt = startedAt;
    }
    return { ...fallback, tableCode: table };
  }

  const payload = {
    tenant_id: tableRow.tenant_id,
    table_id: tableRow.id,
    closed_at: null,
    status: STATUS.EMPTY,
    pos_confirmed: false,
    pos_confirmed_at: null,
    closed_with_anomaly: false,
    session_total: 0,
  };

  payload[SESSION_STARTED_AT_COLUMN] = startedAt;

  const { data, error } = await supabase
    .from(SESSION_TABLE)
    .insert(payload)
    .select('*')
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error(`[sessions] ensureActiveSessionForTable fallback mémoire for ${table}:`, error.message || error);
    const fallback = getFallbackTableState(table);
    fallback.closedManually = false;
    if (!fallback.sessionStartAt) {
      fallback.sessionStartAt = startedAt;
    }
    return { ...fallback, tableCode: table };
  }

  const fallback = getFallbackTableState(table);
  fallback.closedManually = false;
  fallback.sessionStartAt = getSessionStartedAt(data) || startedAt;

  return mapSessionRowToState(data, tableRow.code) || { ...fallback, tableCode: table };
}

async function closeActiveSessionForTable(tableCode, options = {}) {
  const table = normalizeTableCode(tableCode);
  if (!table) {
    return { ok: true, sessionStartAt: null, closedManually: true, mode: await detectSessionStorageMode() };
  }

  const {
    closedAt = nowIso(),
    closedManually = true,
    posConfirmed = false,
    closedWithAnomaly = false,
    reason = null,
    note = null,
    source = 'api',
    staffId = null,
    metadata = null,
    sessionState = null,
  } = options || {};

  const mode = await detectSessionStorageMode();
  const fallback = getFallbackTableState(table);
  fallback.closedManually = !!closedManually;
  fallback.sessionStartAt = null;

  if (mode !== 'db') {
    return { ok: true, sessionStartAt: null, closedManually: !!closedManually, mode: 'memory' };
  }

  const current = (sessionState && sessionState.id)
    ? sessionState
    : await getSessionStateForTable(table);
  if (!current || !current.sessionStartAt || current.closedAt) {
    return { ok: true, sessionStartAt: null, closedManually: !!closedManually, mode: 'db' };
  }

  const updatePayload = {
    closed_at: closedAt,
    status: closedWithAnomaly ? STATUS.CLOSED_WITH_ANOMALY : STATUS.CLOSED,
    closed_with_anomaly: !!closedWithAnomaly,
    pos_confirmed: !!posConfirmed,
    pos_confirmed_at: posConfirmed ? (current.posConfirmedAt || closedAt) : null,
  };

  const { error } = await supabase
    .from(SESSION_TABLE)
    .update(updatePayload)
    .eq('id', current.id)
    .is('closed_at', null);

  if (error) {
    console.error(`[sessions] closeActiveSessionForTable fallback mémoire for ${table}:`, error.message || error);
    return { ok: true, sessionStartAt: null, closedManually: !!closedManually, mode: 'memory-fallback' };
  }

  const sessionTotal = await syncSessionTotalInDb(current.id);
  await appendSessionEvent('session_closed', {
    ...current,
    status: updatePayload.status,
    posConfirmed: !!updatePayload.pos_confirmed,
    posConfirmedAt: updatePayload.pos_confirmed_at,
    closedWithAnomaly: !!updatePayload.closed_with_anomaly,
    sessionTotal: sessionTotal ?? current.sessionTotal ?? null,
  }, table, {
    createdAt: closedAt,
    posConfirmed: !!updatePayload.pos_confirmed,
    closedWithAnomaly: !!updatePayload.closed_with_anomaly,
    reason,
    note,
    source,
    staffId,
    total: sessionTotal ?? current.sessionTotal ?? null,
    metadata,
    status: updatePayload.status,
  });

  return {
    ok: true,
    sessionStartAt: null,
    closedManually: !!closedManually,
    mode: 'db',
    closedAt,
    closureType: closedWithAnomaly ? 'anomaly' : 'normal',
    posConfirmed: !!updatePayload.pos_confirmed,
    reason: reason || null,
  };
}

async function reopenTableSessionState(tableCode) {
  const table = normalizeTableCode(tableCode);
  if (!table) {
    return { ok: true, sessionStartAt: null, closedManually: false };
  }

  const fallback = getFallbackTableState(table);
  fallback.closedManually = false;

  return { ok: true, sessionStartAt: fallback.sessionStartAt || null, closedManually: false };
}

// ---- Constantes métier ----

// Durées (en millisecondes)
const PREP_MS = 60 * 1000;    // 1 min de préparation avant "À encoder en caisse"

const RESET_HOUR = 3;              // Changement de journée business à 03:00

const STATUS = {
  EMPTY: 'Vide',
  ORDERED: 'Commandée',
  PREP: 'En préparation',
  PAY_DUE: 'À encoder en caisse',
  PAID: 'Encodage caisse confirmé',
  IN_PROGRESS: 'En cours',
  NEW_ORDER: 'Nouvelle commande',
  CLOSED: 'Clôturée',
  CLOSED_WITH_ANOMALY: 'Clôture avec anomalie',
};

// ---- Mock menu ----

const MENU = [
  { id: 'm1', name: 'Margherita',   price: 8.5,  category: 'Pizzas' },
  { id: 'm2', name: 'Regina',       price: 10.0, category: 'Pizzas' },
  { id: 'm3', name: 'Cheeseburger', price: 12.0, category: 'Burgers' },
  { id: 'm4', name: 'Frites',       price: 3.5,  category: 'Sides' },
  { id: 'm5', name: 'Tiramisu',     price: 5.0,  category: 'Desserts' },
  { id: 'm6', name: 'Coca 33cl',    price: 2.8,  category: 'Boissons' },
];

// ---- Stockage mémoire résiduel (fallback transitoire) ----

let tickets = [];
let seqId = 1;

// ---- État des tables (fallback legacy si la table Supabase des sessions n'existe pas encore) ----
// IMPORTANT:
// - bloc 2 = sessions pilotées par la DB en priorité
// - ce store mémoire reste uniquement comme filet de sécurité pour ne pas casser le serveur
//   tant que la table Supabase de sessions n'est pas encore présente / alignée.
const tableState = {};


// ---- Paniers en mémoire (par table + invité) ----
// Structure : carts["T6"] = {
//   guests: {
//     [guestKey]: {
//       name: "Younes",
//       items: {
//         [cartKey]: { item: { id, name, price }, qty, unitPrice, supplements: [...] }
//       }
//     }
//   }
// };
const carts = {};

function buildCartKeyServer(item, supplements) {
  const base = item && item.id ? String(item.id) : 'item';
  if (!Array.isArray(supplements) || !supplements.length) return base;
  const names = supplements
    .map((s) => (s && (s.name || s.label || s.id || '')) || '')
    .filter(Boolean)
    .sort()
    .join('|');
  return base + '::' + names;
}

function ensureGuestCart(table, guestKey, guestName) {
  if (!carts[table]) {
    carts[table] = { guests: {} };
  }
  if (!carts[table].guests[guestKey]) {
    carts[table].guests[guestKey] = {
      name: guestName || '',
      items: {},
    };
  } else if (guestName && !carts[table].guests[guestKey].name) {
    carts[table].guests[guestKey].name = guestName;
  }
  return carts[table].guests[guestKey];
}

function hasCartItemsForTable(table) {
  const bucket = carts[table];
  if (!bucket || !bucket.guests) return false;

  return Object.values(bucket.guests).some((guest) => {
    return Object.values((guest && guest.items) || {}).some((entry) => {
      return Number((entry && entry.qty) || 0) > 0;
    });
  });
}

function cartPayloadForTable(table, requestingGuestKey) {
  const bucket = carts[table];
  if (!bucket || !bucket.guests) {
    return {
      table,
      items: [],
      totals: { subtotal: 0, vat: 0, total: 0 },
      canSubmit: false,
    };
  }

  const items = [];
  Object.entries(bucket.guests).forEach(([gKey, guest]) => {
    const gName = guest.name || '';
    Object.entries(guest.items || {}).forEach(([cartKey, entry]) => {
      const item = entry.item || {};
      const unit =
        typeof entry.unitPrice === 'number'
          ? entry.unitPrice
          : Number(item.price || 0);
      const qty = Number(entry.qty || 0);
      if (!qty || !item.id) return;
      items.push({
        key: cartKey,
        itemId: item.id,
        name: item.name || 'Article',
        price: unit,
        qty,
        supplements: entry.supplements || [],
        guestName: gName,
        guestKey: gKey,
        isOwner: requestingGuestKey ? requestingGuestKey === gKey : false,
      });
    });
  });

  const subtotal = items.reduce(
    (sum, it) => sum + it.qty * (it.price || 0),
    0
  );
  const vat = subtotal * 0.1;
  const total = Math.round((subtotal + vat) * 100) / 100;

  return {
    table,
    items,
    totals: { subtotal, vat, total },
    canSubmit: items.length > 0,
  };
}

// ---- Helpers temporels ----

const nowIso = () => new Date().toISOString();

/**
 * Retourne la clé de journée business: "YYYY-MM-DD"
 * avec coupure à RESET_HOUR (ex: 03:00).
 */
function getBusinessDayKey(date = new Date()) {
  const d = new Date(date);
  const h = d.getHours();
  if (h < RESET_HOUR) {
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

// ---- Endpoints simples ----

app.get('/health', (_req, res) => {
  res.json({ ok: true, v: 'session-validate-v2' });
});
// ---- Validation de session côté client : GET /session/validate ----
// Query params : table=T4&localSessionTs=ISO_OR_TS
app.get('/session/validate', async (req, res) => {
  try {
    const rawTable = (req.query && (req.query.table || req.query.t)) || '';
    const table = normalizeTableCode(rawTable || '');
    const localSessionTsRaw = (req.query && req.query.localSessionTs) || '';
    const localSessionTs = String(localSessionTsRaw || '').trim() || null;

    if (!table) {
      return res.json({
        ok: true,
        table: null,
        sessionActive: false,
        serverSessionTs: null,
        shouldResetClient: true,
        reason: 'MISSING_TABLE',
      });
    }

    const businessDay = getBusinessDayKey();
    let last = lastTicketForTable(table, businessDay);
    const flags = await getSessionStateForTable(table);

    if (!flags.sessionStartAt || flags.closedManually) {
      try { delete carts[table]; } catch (e) {}
    }

    const hasSession = !!flags.sessionStartAt;

    if (hasSession && last) {
      try {
        const sessTs = new Date(flags.sessionStartAt).getTime();
        const lastTs = new Date(last.createdAt).getTime();
        if (!Number.isNaN(sessTs) && !Number.isNaN(lastTs) && lastTs < sessTs) {
          last = null;
        }
      } catch (e) {}
    }

    const now = new Date();
    const statusFromTicket = computeStatusFromTicket(last, now);

    const autoCleared = !!(
      statusFromTicket === STATUS.EMPTY &&
      last &&
      last.paidAt &&
      !hasSession
    );

    if (autoCleared) {
      await closeActiveSessionForTable(table, {
        closedAt: nowIso(),
        closedManually: false,
      });
    }

    const flagsAfter = autoCleared
      ? { closedManually: false, sessionStartAt: null }
      : await getSessionStateForTable(table);

    const cleared = !!(flagsAfter.closedManually || autoCleared);
    const sessionActive = !!(flagsAfter.sessionStartAt && !cleared);
    const serverSessionTs = sessionActive ? flagsAfter.sessionStartAt : null;

    let shouldResetClient = false;
    let reason = null;

    if (!sessionActive) {
      shouldResetClient = true;
      reason = 'TABLE_CLEARED';
    } else {
      if (!localSessionTs) {
        shouldResetClient = true;
        reason = 'MISSING_LOCAL_SESSION';
      } else {
        try {
          const backendTs = new Date(serverSessionTs).getTime();
          const localTs = new Date(localSessionTs).getTime();
          if (!Number.isNaN(backendTs) && !Number.isNaN(localTs) && backendTs !== localTs) {
            shouldResetClient = true;
            reason = 'NEW_SESSION_ON_SERVER';
          }
        } catch (e) {}
      }
    }

    return res.json({
      ok: true,
      table,
      sessionActive,
      serverSessionTs,
      shouldResetClient,
      reason,
      storage: await detectTicketStorageMode(),
    });
  } catch (err) {
    console.error('GET /session/validate error', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});


// ---- API Panier (PWA client) ----

// GET /cart?table=T1&guestKey=abc
app.get('/cart', (req, res) => {
  try {
    const table = String(req.query.table || '').trim().toUpperCase();
    const guestKey = String(req.query.guestKey || '').trim() || null;
    if (!table) {
      return res.status(400).json({ ok: false, error: 'missing table' });
    }
    const payload = cartPayloadForTable(table, guestKey);
    return res.json({ ok: true, ...payload });
  } catch (err) {
    console.error('GET /cart error', err);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// POST /cart/add
app.post('/cart/add', (req, res) => {
  try {
    const { table, guestKey, guestName, item, qty, supplements, unitPrice } =
      req.body || {};
    const t = String(table || '').trim().toUpperCase();
    const gKey = String(guestKey || '').trim();
    if (!t || !gKey || !item || !item.id) {
      return res.status(400).json({ ok: false, error: 'missing fields' });
    }
    const safeQty = Number(qty || 0);
    if (!safeQty) {
      return res.status(400).json({ ok: false, error: 'invalid qty' });
    }
    const supList = Array.isArray(supplements) ? supplements : [];
    const entryItem = {
      id: String(item.id),
      name: item.name || 'Article',
      price:
        typeof item.price === 'number'
          ? item.price
          : Number(item.price || 0) || 0,
    };
    const guestBucket = ensureGuestCart(t, gKey, guestName || '');
    const key = buildCartKeyServer(entryItem, supList);
    const current = guestBucket.items[key] || {
      item: entryItem,
      qty: 0,
      unitPrice:
        typeof unitPrice === 'number'
          ? unitPrice
          : Number(unitPrice || entryItem.price || 0),
      supplements: supList,
    };
    current.qty += safeQty;
    current.unitPrice =
      typeof unitPrice === 'number'
        ? unitPrice
        : Number(unitPrice || current.unitPrice || entryItem.price || 0);
    current.supplements = supList;
    guestBucket.items[key] = current;

    const payload = cartPayloadForTable(t, gKey);
    return res.json({ ok: true, ...payload });
  } catch (err) {
    console.error('POST /cart/add error', err);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// POST /cart/update-qty
app.post('/cart/update-qty', (req, res) => {
  try {
    const { table, guestKey, key, delta } = req.body || {};
    const t = String(table || '').trim().toUpperCase();
    const gKey = String(guestKey || '').trim();
    if (!t || !gKey || !key) {
      return res.status(400).json({ ok: false, error: 'missing fields' });
    }
    const bucket = carts[t];
    if (!bucket || !bucket.guests || !bucket.guests[gKey]) {
      const payload = cartPayloadForTable(t, gKey);
      return res.json({ ok: true, ...payload });
    }
    const guest = bucket.guests[gKey];
    const entry = guest.items[key];
    if (entry) {
      const d = Number(delta || 0);
      entry.qty = Number(entry.qty || 0) + d;
      if (entry.qty <= 0) {
        delete guest.items[key];
      }
    }
    const payload = cartPayloadForTable(t, gKey);
    return res.json({ ok: true, ...payload });
  } catch (err) {
    console.error('POST /cart/update-qty error', err);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// POST /cart/clear
app.post('/cart/clear', (req, res) => {
  try {
    const { table } = req.body || {};
    const t = String(table || '').trim().toUpperCase();
    if (t && carts[t]) {
      delete carts[t];
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /cart/clear error', err);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});


app.get('/menu', (_req, res) => {
  res.json({ ok: true, items: MENU });
});

// ---- Création de commande : POST /orders ----
// Body attendu : { table, items:[{id, qty}] }
app.post('/orders', async (req, res) => {
  try {
    const { table, items, clientName } = req.body || {};
    const t = normalizeTableCode(table || '');
    if (!t) return res.status(400).json({ ok: false, error: 'missing table' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ ok: false, error: 'empty items' });

    const rootClientName = typeof clientName === 'string' ? clientName.trim() : '';

    const normalized = items.map((it) => {
      const menuItem = MENU.find((m) => m.id === it.id) || { price: it.price || 0, name: it.name || 'Article' };
      const qty = Number(it.qty || it.quantity || 1);
      const price = Number(typeof it.price === 'number' ? it.price : menuItem.price || 0);
      const lineClientNameRaw = it.clientName || it.customerName || it.ownerName || rootClientName || '';
      const lineClientName = typeof lineClientNameRaw === 'string' ? lineClientNameRaw.trim() : '';
      const extrasSrc = Array.isArray(it.extras) ? it.extras : Array.isArray(it.options) ? it.options : Array.isArray(it.supplements) ? it.supplements : Array.isArray(it.toppings) ? it.toppings : [];
      const extras = extrasSrc
        .map((e) => typeof e === 'string' ? e.trim() : (e && (e.label || e.name || e.title || '')).trim())
        .filter(Boolean);
      return {
        id: it.id,
        name: it.name || menuItem.name,
        qty,
        price,
        clientName: lineClientName || undefined,
        extras: extras.length ? extras : undefined,
      };
    });

    const createdAt = nowIso();
    const businessDay = getBusinessDayKey(new Date(createdAt));
    const session = await ensureActiveSessionForTable(t, createdAt);
    const sessionKey = session.sessionStartAt || createdAt;
    const ticketStorageMode = await detectTicketStorageMode();

    if (ticketStorageMode === 'db') {
      if (!session || !session.id || !session.tenantId) {
        return res.status(409).json({
          ok: false,
          error: 'session_not_ready',
          details: 'Aucune session DB active exploitable pour créer la commande.',
          storage: 'db',
        });
      }

      const { data: seqRows, error: seqError } = await supabase
        .from(ORDERS_TABLE)
        .select('sequence_in_session')
        .eq('table_session_id', session.id)
        .order('sequence_in_session', { ascending: false })
        .limit(1);

      if (seqError) {
        console.error('POST /orders sequence lookup failed', seqError.message || seqError);
        return res.status(500).json({
          ok: false,
          error: 'order_sequence_lookup_failed',
          details: seqError.message || String(seqError),
          storage: 'db',
        });
      }

      const nextSeq = ((seqRows && seqRows[0] && seqRows[0].sequence_in_session) || 0) + 1;
      const orderInsertPayload = {
        tenant_id: session.tenantId,
        table_session_id: session.id,
        sequence_in_session: nextSeq,
        order_type: nextSeq === 1 ? 'initial' : 'addition',
        source: 'client',
        printed_at: null,
        created_at: createdAt,
      };

      const { data: orderRow, error: orderError } = await supabase
        .from(ORDERS_TABLE)
        .insert(orderInsertPayload)
        .select('*')
        .limit(1)
        .maybeSingle();

      if (orderError || !orderRow) {
        console.error('POST /orders order insert failed', orderError?.message || orderError);
        return res.status(500).json({
          ok: false,
          error: 'order_insert_failed',
          details: orderError?.message || 'order_row_missing',
          storage: 'db',
          payload: orderInsertPayload,
        });
      }

      const itemPayloads = normalized.map((it) => ({
        tenant_id: session.tenantId,
        order_id: orderRow.id,
        product_name: it.name,
        quantity: Number(it.qty || 0),
        unit_price: Number(it.price || 0),
        guest_name: it.clientName || null,
        notes: extrasToNotes(it.extras),
        created_at: createdAt,
      }));

      const { data: itemRows, error: itemError } = await supabase
        .from(ORDER_ITEMS_TABLE)
        .insert(itemPayloads)
        .select('*');

      if (itemError) {
        console.error('POST /orders item insert failed', itemError.message || itemError);
        await supabase.from(ORDERS_TABLE).delete().eq('id', orderRow.id);
        return res.status(500).json({
          ok: false,
          error: 'order_items_insert_failed',
          details: itemError.message || String(itemError),
          storage: 'db',
          orderId: orderRow.id,
          itemPayloads,
        });
      }

      const ticket = mapDbRowsToTicket(
        orderRow,
        itemRows || [],
        {
          id: session.id,
          table_id: session.tableId,
          opened_at: session.sessionStartAt,
          closed_at: null,
          pos_confirmed: false,
          pos_confirmed_at: null,
          closed_with_anomaly: false,
        },
        t
      );

      await syncSessionTotalInDb(session.id);
      try { delete carts[t]; } catch (e) {}

      return res.json({
        ok: true,
        storage: 'db',
        ticket,
      });
    }

    const subtotal = normalized.reduce((sum, it) => sum + it.qty * it.price, 0);
    const vat = subtotal * 0.1;
    const total = Math.round((subtotal + vat) * 100) / 100;
    const ticket = {
      id: `TCK${seqId++}`,
      table: t,
      items: normalized,
      total,
      createdAt,
      date: businessDay,
      sessionKey,
      sessionStartedAt: sessionKey,
      printedAt: null,
      paidAt: null,
      closedAt: null,
      paid: false,
      clientName: rootClientName || null,
    };
    tickets.push(ticket);

    try { delete carts[t]; } catch (e) {}
    return res.json({ ok: true, storage: 'memory', ticket });
  } catch (err) {
    console.error('POST /orders error', err);
    return res.status(500).json({ ok: false, error: 'internal_error', details: err.message || String(err) });
  }
});

// ---- Récupération des commandes côté client : GET /client/orders?table=T4 ----
app.get('/client/orders', async (req, res) => {
  try {
    const rawTable = (req.query && (req.query.table || req.query.t)) || '';
    const table = normalizeTableCode(rawTable || '');
    if (!table) {
      return res.json({ ok: true, table: null, sessionActive: false, sessionStartAt: null, orders: [], mergedItems: [], grandTotal: 0 });
    }

    const businessDay = getBusinessDayKey();
    let list = await ticketsForTable(table, businessDay);

    const flags = await getSessionStateForTable(table);
    if (!flags.sessionStartAt) {
      return res.json({ ok: true, table, sessionActive: false, sessionStartAt: null, orders: [], mergedItems: [], grandTotal: 0, storage: await detectTicketStorageMode() });
    }

    list = filterTicketsForSession(list, flags.sessionStartAt);

    if (!list.length) {
      return res.json({ ok: true, table, sessionActive: true, sessionStartAt: flags.sessionStartAt, orders: [], mergedItems: [], grandTotal: 0, storage: await detectTicketStorageMode() });
    }

    const orders = list.map((ticket) => ({
      id: ticket.id,
      ts: new Date(ticket.createdAt).getTime(),
      total: ticket.total,
      items: (ticket.items || []).map((it) => ({
        id: it.id,
        name: it.name,
        price: it.price,
        qty: it.qty,
        clientName: it.clientName || null,
        extras: Array.isArray(it.extras) ? it.extras : [],
      })),
    }));

    const grandTotal = orders.reduce((sum, o) => sum + Number(o.total || 0), 0);
    const mergedItems = orders.reduce((all, o) => {
      if (Array.isArray(o.items)) {
        return all.concat(
          o.items.map((it) => ({
            ...it,
            orderId: o.id,
            ts: o.ts,
          }))
        );
      }
      return all;
    }, []);

    return res.json({
      ok: true,
      table,
      sessionActive: true,
      sessionStartAt: flags.sessionStartAt,
      mode: null,
      clientName: null,
      orders,
      grandTotal,
      mergedItems,
      storage: await detectTicketStorageMode(),
    });
  } catch (err) {
    console.error('GET /client/orders error', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});
// ---- Helpers Staff ----

async function ticketsForTable(table, businessDay) {
  const list = await listTicketsForBusinessDayFromDb(businessDay);
  return list.filter((t) => t.table === table).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

async function lastTicketForTable(table, businessDay) {
  const list = await ticketsForTable(table, businessDay);
  return list.length ? list[list.length - 1] : null;
}

/**
 * Calcule le statut d'une table en fonction de son dernier ticket.
 * Règles :
 * - tant que le ticket cuisine n'est pas imprimé → Commandée
 * - après impression (/print) → En préparation pendant PREP_MS
 * - ensuite → À encoder en caisse
 * - après /confirm → Encodage caisse confirmé
 */
function computeStatusFromTicket(ticket, now = new Date()) {
  if (!ticket) {
    return STATUS.EMPTY;
  }

  if (ticket.closedWithException) {
    return STATUS.CLOSED_WITH_ANOMALY;
  }

  const paidTs = ticket.paidAt ? new Date(ticket.paidAt).getTime() : null;
  if (paidTs) {
    if (ticket.closedAt) return STATUS.CLOSED;
    return STATUS.PAID;
  }

  if (ticket.closedAt) {
    return STATUS.CLOSED;
  }

  if (!ticket.printedAt) {
    return STATUS.ORDERED;
  }

  const printedTs = new Date(ticket.printedAt).getTime();
  if (Number.isNaN(printedTs)) {
    return STATUS.ORDERED;
  }

  const nowTs = now.getTime();
  const diffPrep = nowTs - printedTs;
  if (diffPrep < PREP_MS) {
    return STATUS.PREP;
  }

  return STATUS.PAY_DUE;
}

function filterTicketsForSession(ticketsList, sessionStartAt) {
  const list = Array.isArray(ticketsList) ? [...ticketsList] : [];
  if (!sessionStartAt) return list;

  let sessionTs = null;
  try {
    sessionTs = new Date(sessionStartAt).getTime();
  } catch (e) {
    sessionTs = null;
  }
  if (sessionTs == null || Number.isNaN(sessionTs)) return list;

  return list.filter((ticket) => {
    const createdTs = new Date(ticket.createdAt).getTime();
    return !Number.isNaN(createdTs) && createdTs >= sessionTs;
  });
}

function deriveSessionBusinessState({ sessionState, sessionTickets, now = new Date() }) {
  const hasSession = !!(sessionState && sessionState.sessionStartAt && !sessionState.closedAt);
  const filteredTickets = filterTicketsForSession(sessionTickets || [], sessionState?.sessionStartAt)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  const lastTicket = filteredTickets.length ? filteredTickets[filteredTickets.length - 1] : null;
  const prevTicket = filteredTickets.length >= 2 ? filteredTickets[filteredTickets.length - 2] : null;

  let status = STATUS.EMPTY;

  if (lastTicket) {
    status = computeStatusFromTicket(lastTicket, now);

    const prevStatus = prevTicket ? computeStatusFromTicket(prevTicket, now) : null;
    if (
      !lastTicket.printedAt &&
      prevTicket &&
      [STATUS.ORDERED, STATUS.PREP, STATUS.PAY_DUE].includes(prevStatus)
    ) {
      status = STATUS.NEW_ORDER;
    }
  } else if (hasSession) {
    status = STATUS.IN_PROGRESS;
  }

  const pending = lastTicket && !lastTicket.closedAt ? 1 : 0;

  return {
    hasSession,
    tickets: filteredTickets,
    lastTicket,
    lastTicketAt: lastTicket ? lastTicket.createdAt : null,
    lastTicketSummary: lastTicket ? { total: lastTicket.total, at: lastTicket.createdAt } : null,
    status,
    pending,
  };
}

async function getTableBusinessState(tableCode, businessDay = getBusinessDayKey(), now = new Date(), activeSessionsMap = null) {
  const table = normalizeTableCode(tableCode);
  if (!table) {
    return {
      tableCode: null,
      sessionState: { closedManually: false, sessionStartAt: null, closedAt: null },
      hasSession: false,
      tickets: [],
      lastTicket: null,
      lastTicketAt: null,
      lastTicketSummary: null,
      status: STATUS.EMPTY,
      pending: 0,
    };
  }

  const sessionState = activeSessionsMap?.get(table) || await getSessionStateForTable(table);
  const tableTickets = await ticketsForTable(table, businessDay);
  const derived = deriveSessionBusinessState({
    sessionState,
    sessionTickets: tableTickets,
    now,
  });

  return {
    tableCode: table,
    sessionState,
    ...derived,
  };
}



// ---- Payload /tables ----

async function tablesPayload() {
  const businessDay = getBusinessDayKey();
  const now = new Date();
  const tableIds = await getRestaurantTableCodesFromDb();
  const activeSessionsMap = await getActiveSessionsMapFromDb();

  const raw = await Promise.all(tableIds.map(async (id) => {
    const businessState = await getTableBusinessState(id, businessDay, now, activeSessionsMap);
    const activeSessionState = businessState.sessionState || { closedManually: false, sessionStartAt: null, closedAt: null };

    const hasActiveSession = !!(activeSessionState && activeSessionState.sessionStartAt && !activeSessionState.closedAt);

    return {
      id,
      pending: hasActiveSession ? businessState.pending : 0,
      status: hasActiveSession ? businessState.status : STATUS.EMPTY,
      lastTicketAt: hasActiveSession ? businessState.lastTicketAt : null,
      lastTicket: hasActiveSession ? businessState.lastTicketSummary : null,
      cleared: !hasActiveSession,
      closedManually: !hasActiveSession,
      sessionStartAt: hasActiveSession ? (activeSessionState.sessionStartAt || null) : null,
    };
  }));

  raw.sort((a, b) => {
    const aHas = !!a.lastTicketAt;
    const bHas = !!b.lastTicketAt;

    if (aHas && !bHas) return -1;
    if (!aHas && bHas) return 1;
    if (!aHas && !bHas) {
      const aNum = parseInt(a.id.replace(/\D/g, ''), 10);
      const bNum = parseInt(b.id.replace(/\D/g, ''), 10);
      if (!isNaN(aNum) && !isNaN(bNum)) return aNum - bNum;
      return a.id.localeCompare(b.id);
    }

    return new Date(b.lastTicketAt).getTime() - new Date(a.lastTicketAt).getTime();
  });

  return {
    storage: await detectTicketStorageMode(),
    tables: raw,
  };
}


function computeSummarySessionStatus(sessionTickets, now = new Date()) {
  const ordered = Array.isArray(sessionTickets)
    ? [...sessionTickets].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')))
    : [];
  const derived = deriveSessionBusinessState({
    sessionState: {
      sessionStartAt: ordered.length ? (ordered[0].sessionStartedAt || null) : null,
      closedAt: ordered.some((t) => !!t.closedAt) ? true : null,
    },
    sessionTickets: ordered,
    now,
  });
  return derived.status;
}

async function groupTicketsBySessionForDay(businessDay) {
  const rows = [];
  const groups = new Map();

  (await listTicketsForBusinessDayFromDb(businessDay))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .forEach((ticket) => {
      const sessionKey = ticket.sessionKey || ticket.sessionStartedAt || ticket.createdAt || `${ticket.table}-${ticket.id}`;
      const groupKey = `${ticket.table}__${sessionKey}`;

      if (!groups.has(groupKey)) {
        const row = {
          id: groupKey,
          table: ticket.table,
          sessionKey,
          sessionStartedAt: ticket.sessionStartedAt || ticket.sessionKey || ticket.createdAt || null,
          createdAt: ticket.createdAt,
          updatedAt: ticket.createdAt,
          tickets: [],
        };
        groups.set(groupKey, row);
        rows.push(row);
      }

      const row = groups.get(groupKey);
      row.tickets.push(ticket);

      const createdAtTs = new Date(ticket.createdAt).getTime();
      const updatedAtTs = new Date(row.updatedAt).getTime();
      if (!Number.isNaN(createdAtTs) && !Number.isNaN(updatedAtTs) && createdAtTs > updatedAtTs) {
        row.updatedAt = ticket.createdAt;
      }
    });

  return rows;
}

// ---- Payload /summary ----


async function evaluateTableClosureRequest(tableCode, body = {}) {
  const table = normalizeTableCode(tableCode);
  if (!table) {
    return { ok: false, code: 'missing_table', httpStatus: 400, message: 'Table manquante.' };
  }

  const sessionState = await getSessionStateForTable(table);
  if (!sessionState || !sessionState.sessionStartAt || sessionState.closedAt) {
    return { ok: false, code: 'no_active_session', httpStatus: 409, message: 'Aucune session active à clôturer.', sessionState };
  }

  const businessDay = getBusinessDayKey();
  const tableTickets = filterTicketsForSession(await ticketsForTable(table, businessDay), sessionState.sessionStartAt);
  const hasOrders = tableTickets.length > 0;
  const currentStatus = deriveSessionBusinessState({ sessionState, sessionTickets: tableTickets, now: new Date() }).status;
  const requestedClosureType = String(body?.closureType || '').trim().toLowerCase();
  const answer = String(body?.answer || '').trim().toUpperCase();
  const closeAsAnomaly = requestedClosureType === 'anomaly' || !!body?.closedWithException || answer === 'NON';
  const note = typeof body?.note === 'string' ? body.note.trim() : '';
  const reason = typeof body?.reason === 'string' ? body.reason.trim() : '';
  const posConfirmedFlag = typeof body?.posConfirmed === 'boolean' ? body.posConfirmed : !!sessionState.posConfirmed;

  if (!hasOrders) {
    return {
      ok: false,
      code: 'no_orders_for_session',
      httpStatus: 409,
      message: 'Impossible de clôturer une session sans commande.',
      sessionState,
      currentStatus,
      tableTickets,
    };
  }

  if (!closeAsAnomaly) {
    if (!sessionState.posConfirmed) {
      return {
        ok: false,
        code: 'pos_confirmation_required',
        httpStatus: 409,
        message: 'Encodage caisse obligatoire avant clôture normale.',
        sessionState,
        currentStatus,
        tableTickets,
      };
    }

    return {
      ok: true,
      closureType: 'normal',
      closedWithAnomaly: false,
      posConfirmed: true,
      reason: null,
      note: note || null,
      sessionState,
      currentStatus,
      tableTickets,
    };
  }

  return {
    ok: true,
    closureType: 'anomaly',
    closedWithAnomaly: true,
    posConfirmed: posConfirmedFlag,
    reason: reason || 'MANUAL_ANOMALY',
    note: note || null,
    sessionState,
    currentStatus,
    tableTickets,
  };
}

async function summaryPayload() {
  const businessDay = getBusinessDayKey();
  const now = new Date();

  const list = (await groupTicketsBySessionForDay(businessDay))
    .map((group) => {
      const orderedTickets = [...group.tickets].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const lastTicket = orderedTickets[orderedTickets.length - 1] || null;
      const businessStatus = computeSummarySessionStatus(orderedTickets, now);
      const total = orderedTickets.reduce((sum, ticket) => sum + Number(ticket.total || 0), 0);
      const closedAt = orderedTickets.reduce((latest, ticket) => {
        if (!ticket.closedAt) return latest;
        if (!latest) return ticket.closedAt;
        return ticket.closedAt > latest ? ticket.closedAt : latest;
      }, null);
      const paidAt = orderedTickets.reduce((latest, ticket) => {
        if (!ticket.paidAt) return latest;
        if (!latest) return ticket.paidAt;
        return ticket.paidAt > latest ? ticket.paidAt : latest;
      }, null);
      const closedWithException = orderedTickets.some((t) => !!t.closedWithException);
      const posConfirmed = orderedTickets.some((t) => !!t.posConfirmed);

      let status = businessStatus;
      if (closedAt) {
        status = closedWithException ? 'Anomalie pas encodé' : (posConfirmed ? 'Encodé dans la caisse' : 'Clôturée');
      }

      return {
        id: group.id,
        table: group.table,
        sessionKey: group.sessionKey,
        sessionStartedAt: group.sessionStartedAt,
        total,
        status,
        time: new Date(group.createdAt).toLocaleTimeString('fr-FR', {
          hour: '2-digit',
          minute: '2-digit',
        }),
        createdAt: group.createdAt,
        updatedAt: group.updatedAt,
        closedAt: closedAt || null,
        paidAt: paidAt || null,
        isClosed: !!closedAt,
        closureType: orderedTickets.some((t) => !!t.closedWithException) ? 'anomaly' : (closedAt ? 'normal' : null),
        tickets: orderedTickets.map((t) => ({
          id: t.id,
          table: t.table,
          total: t.total,
          items: t.items,
          clientName: t.clientName || null,
          time: new Date(t.createdAt).toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit',
          }),
          createdAt: t.createdAt,
          printedAt: t.printedAt || null,
          paidAt: t.paidAt || null,
          closedAt: t.closedAt || null,
          paid: !!t.paid,
          posConfirmed: typeof t.posConfirmed === 'boolean' ? t.posConfirmed : null,
          closedWithException: !!t.closedWithException,
          exceptionReason: t.exceptionReason || null,
          sessionKey: t.sessionKey || group.sessionKey,
          sessionStartedAt: t.sessionStartedAt || group.sessionStartedAt,
        })),
        lastTicketId: lastTicket ? lastTicket.id : null,
      };
    })
    .sort((a, b) => {
      const aTs = new Date(a.updatedAt || a.createdAt).getTime();
      const bTs = new Date(b.updatedAt || b.createdAt).getTime();
      if (!Number.isNaN(aTs) && !Number.isNaN(bTs)) return bTs - aTs;
      return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
    });

  return { tickets: list };
}
// ---- Montage des routes Staff (root + /staff pour compatibilité) ----

function mountStaffRoutes(prefix = '') {
  // GET tables
  app.get(prefix + '/tables', async (_req, res) => {
    try {
      res.json(await tablesPayload());
    } catch (err) {
      console.error('GET /tables error', err);
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // GET summary
  app.get(prefix + '/summary', async (_req, res) => {
    try {
      res.json(await summaryPayload());
    } catch (err) {
      console.error('GET /summary error', err);
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // POST print
  app.post(prefix + '/print', async (req, res) => {
    try {
      const table = String(req.body?.table || '').trim();
      if (!table) return res.json({ ok: true });

      const businessDay = getBusinessDayKey();
      const last = await lastTicketForTable(table, businessDay);
      if (last && !last.printedAt) {
        const stamp = nowIso();
        if ((await detectTicketStorageMode()) === 'db') {
          await supabase.from(ORDERS_TABLE).update({ printed_at: stamp }).eq('id', last.id);
        } else {
          last.printedAt = stamp;
        }
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('POST /print error', err);
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // POST confirm (encodage caisse confirmé)
  app.post(prefix + '/confirm', async (req, res) => {
    try {
      const table = normalizeTableCode(req.body?.table || '');
      if (!table) return res.json({ ok: true });

      const now = nowIso();
      const sessionState = await getSessionStateForTable(table);
      if (!sessionState || !sessionState.sessionStartAt || sessionState.closedAt) {
        return res.status(409).json({ ok: false, error: 'no_active_session', message: 'Aucune session active à confirmer.' });
      }

      if (sessionState && sessionState.id && (await detectSessionStorageMode()) === 'db') {
        const { error } = await supabase
          .from(SESSION_TABLE)
          .update({ status: STATUS.PAID, pos_confirmed: true, pos_confirmed_at: now, closed_with_anomaly: false })
          .eq('id', sessionState.id);

        if (error) {
          throw error;
        }
      }

      const businessDay = getBusinessDayKey();
      const last = await lastTicketForTable(table, businessDay);
      if (last) {
        last.paidAt = now;
        last.paid = true;
        last.posConfirmed = true;
        last.posConfirmedAt = now;
        last.closedWithException = false;
        last.exceptionReason = null;
      }

      await appendSessionEvent('pos_confirmed', {
        ...sessionState,
        status: STATUS.PAID,
        posConfirmed: true,
        posConfirmedAt: now,
        closedWithAnomaly: false,
      }, table, {
        createdAt: now,
        posConfirmed: true,
        closedWithAnomaly: false,
        source: 'staff_confirm',
        status: STATUS.PAID,
        total: sessionState.sessionTotal ?? null,
      });

      res.json({ ok: true, storage: await detectSessionStorageMode(), confirmedAt: now, journalStorage: await detectSessionEventsStorageMode() });
    } catch (err) {
      console.error('POST /confirm error', err);
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // POST cancel-confirm (annuler encodage caisse)
  app.post(prefix + '/cancel-confirm', async (req, res) => {
    try {
      const table = normalizeTableCode(req.body?.table || '');
      if (!table) return res.json({ ok: true });

      const sessionState = await getSessionStateForTable(table);
      if (!sessionState || !sessionState.sessionStartAt || sessionState.closedAt) {
        return res.status(409).json({ ok: false, error: 'no_active_session', message: 'Aucune session active à rouvrir.' });
      }

      if (sessionState && sessionState.id && (await detectSessionStorageMode()) === 'db') {
        const { error } = await supabase
          .from(SESSION_TABLE)
          .update({ status: STATUS.PAY_DUE, pos_confirmed: false, pos_confirmed_at: null, closed_with_anomaly: false })
          .eq('id', sessionState.id);

        if (error) {
          throw error;
        }
      }

      const businessDay = getBusinessDayKey();
      const last = await lastTicketForTable(table, businessDay);
      if (last) {
        last.paidAt = null;
        last.paid = false;
        last.posConfirmed = false;
        last.posConfirmedAt = null;
        last.closedWithException = false;
        last.exceptionReason = null;
      }

      await appendSessionEvent('pos_confirmation_cancelled', {
        ...sessionState,
        status: STATUS.PAY_DUE,
        posConfirmed: false,
        posConfirmedAt: null,
        closedWithAnomaly: false,
      }, table, {
        createdAt: nowIso(),
        posConfirmed: false,
        closedWithAnomaly: false,
        source: 'staff_cancel_confirm',
        status: STATUS.PAY_DUE,
        total: sessionState.sessionTotal ?? null,
      });

      res.json({ ok: true, storage: await detectSessionStorageMode(), journalStorage: await detectSessionEventsStorageMode() });
    } catch (err) {
      console.error('POST /cancel-confirm error', err);
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // POST close-table (clôturer la table manuellement)
  app.post(prefix + '/close-table', async (req, res) => {
    try {
      const table = normalizeTableCode(req.body?.table || '');
      if (!table) return res.json({ ok: true });

      const evaluation = await evaluateTableClosureRequest(table, req.body || {});
      if (!evaluation.ok) {
        return res.status(evaluation.httpStatus || 409).json({
          ok: false,
          error: evaluation.code,
          message: evaluation.message,
          currentStatus: evaluation.currentStatus || null,
          posConfirmed: !!evaluation.sessionState?.posConfirmed,
        });
      }

      try { delete carts[table]; } catch (e) {}

      const closedAt = nowIso();
      const activeSessionKey = evaluation.sessionState.sessionStartAt || null;

      if (activeSessionKey) {
        tickets.forEach((ticket) => {
          if (
            ticket.table === table &&
            ticket.date === getBusinessDayKey() &&
            (ticket.sessionKey || ticket.sessionStartedAt || ticket.createdAt) === activeSessionKey
          ) {
            ticket.closedAt = closedAt;
            ticket.posConfirmed = evaluation.posConfirmed;
            ticket.posConfirmedAt = evaluation.posConfirmed ? (ticket.posConfirmedAt || evaluation.sessionState.posConfirmedAt || closedAt) : null;
            ticket.closedWithException = evaluation.closedWithAnomaly;
            ticket.exceptionReason = evaluation.closedWithAnomaly ? evaluation.reason : null;
          }
        });
      }

      const result = await closeActiveSessionForTable(table, {
        closedAt,
        closedManually: true,
        posConfirmed: evaluation.posConfirmed,
        closedWithAnomaly: evaluation.closedWithAnomaly,
        reason: evaluation.reason,
        note: evaluation.note,
        source: 'staff_close_table',
        sessionState: evaluation.sessionState,
        metadata: {
          currentStatus: evaluation.currentStatus,
          requestedClosureType: evaluation.closureType,
          ticketCount: evaluation.tableTickets.length,
        },
      });

      res.json({
        ok: true,
        storage: await detectTicketStorageMode(),
        journalStorage: await detectSessionEventsStorageMode(),
        closedAt,
        closureType: evaluation.closureType,
        posConfirmed: evaluation.posConfirmed,
        reason: evaluation.reason,
        note: evaluation.note,
        result,
      });
    } catch (err) {
      console.error('POST /close-table error', err);
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // POST cancel-close (annuler clôture manuelle)
  app.post(prefix + '/cancel-close', async (req, res) => {
    try {
      const table = normalizeTableCode(req.body?.table || '');
      if (!table) return res.json({ ok: true });

      await appendSessionEvent('cancel_close_rejected', null, table, {
        createdAt: nowIso(),
        source: 'staff_cancel_close',
        reason: 'IMMUTABLE_CLOSURE',
        note: 'Une session clôturée ne peut pas être réouverte automatiquement.',
      });

      return res.status(409).json({
        ok: false,
        error: 'immutable_closure',
        message: 'Une session clôturée ne peut pas être réouverte. Il faut ouvrir une nouvelle session.',
      });
    } catch (err) {
      console.error('POST /cancel-close error', err);
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });
}

mountStaffRoutes('');
mountStaffRoutes('/staff');

// ---- QR routes ----
app.use(qrRouter);

// ---- Start server ----
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`QR API listening on port ${PORT}`);
});