// QR Ordering API — backend en mémoire (Option A)
// Logique centralisée des statuts de table + endpoints pour PWA client & staff.

const express = require('express');
const cors = require('cors');
const qrRouter = require('./qr');

const app = express();
app.use(cors());
app.use(express.json());

// ---- Session client (démarrage sans commande : prénom validé) ----
    // Body attendu : { table }
    app.post('/session/start', (req, res) => {
      try {
        const table = String(req.body?.table || '').trim();
        if (!table) return res.json({ ok: true });

        if (!tableState[table]) {
          tableState[table] = { closedManually: false, sessionStartAt: null };
        }

        // Nouvelle session client => on annule éventuellement la clôture manuelle
        tableState[table].closedManually = false;

        let sessionStartAt = tableState[table].sessionStartAt;
        if (!sessionStartAt) {
          sessionStartAt = nowIso();
          tableState[table].sessionStartAt = sessionStartAt;
        }

        return res.json({ ok: true, sessionStartAt });
      } catch (err) {
        console.error('POST /session/start error', err);
        return res.status(500).json({ ok: false, error: 'internal_error' });
      }
    });

// ---- Constantes métier ----

// Tables physiques disponibles (T1..T10)
const TABLE_IDS = Array.from({ length: 10 }, (_, i) => `T${i + 1}`);

// Durées (en millisecondes)
const PREP_MS = 20 * 60 * 1000;    // 20 min de préparation avant "À encoder en caisse"

const RESET_HOUR = 3;              // Changement de journée business à 03:00

const STATUS = {
  EMPTY: 'Vide',
  ORDERED: 'Commandée',
  PREP: 'En préparation',
  PAY_DUE: 'À encoder en caisse',
  PAID: 'Encodage caisse confirmé',
  IN_PROGRESS: 'En cours',
  NEW_ORDER: 'Nouvelle commande',
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

// ---- Stockage en mémoire ----

let tickets = [];
let seqId = 1;

// ---- État des tables (clôture & session) ----
// Exemple : tableState["T6"] = { closedManually: true, sessionStartAt: "2025-11-21T..." }
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
app.get('/session/validate', (req, res) => {
  try {
    const rawTable = (req.query && (req.query.table || req.query.t)) || '';
    const table = String(rawTable || '').trim().toUpperCase();
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
    const flags = tableState[table] || { closedManually: false, sessionStartAt: null };
    // Starting a new session must always start from a clean slate.
    // If the table was cleared/closed or had no active session, purge server cart.
    if (!flags.sessionStartAt || flags.closedManually) {
      try { delete carts[table]; } catch (e) {}
    }

    const hasSession = !!flags.sessionStartAt;

    // Si une nouvelle session client a démarré après le dernier ticket,
    // on ignore ce ticket (ancienne session).
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

    // Auto-clear après paiement : table Vide + dernier ticket payé,
    // UNIQUEMENT s'il n'y a PAS de session client en cours.
    const autoCleared = !!(
      statusFromTicket === STATUS.EMPTY &&
      last &&
      last.paidAt &&
      !hasSession
    );

    if (autoCleared) {
      if (!tableState[table]) {
        tableState[table] = { closedManually: false, sessionStartAt: null };
      }
      tableState[table].sessionStartAt = null;
    }

    const flagsAfter = tableState[table] || { closedManually: false, sessionStartAt: null };
    const cleared = !!(flagsAfter.closedManually || autoCleared);
    const sessionActive = !!(flagsAfter.sessionStartAt && !cleared);
    const serverSessionTs = sessionActive ? flagsAfter.sessionStartAt : null;

    let shouldResetClient = false;
    let reason = null;

    if (!sessionActive) {
      shouldResetClient = true;
      reason = 'TABLE_CLEARED';
    } else {
      // Session active côté backend, on compare les timestamps si dispo.
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
        } catch (e) {
          // En cas de doute on ne force pas le reset, le front fera sa vie.
        }
      }
    }

    return res.json({
      ok: true,
      table,
      sessionActive,
      serverSessionTs,
      shouldResetClient,
      reason,
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
app.post('/orders', (req, res) => {
  try {
    const { table, items, clientName } = req.body || {};
    const t = String(table || '').trim();
    if (!t) {
      return res.status(400).json({ ok: false, error: 'missing table' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'empty items' });
    }

    const rootClientName =
      typeof clientName === 'string' ? clientName.trim() : '';

    if (!hasCartItemsForTable(t)) {
      return res.status(409).json({
        ok: false,
        error: 'cart_already_submitted',
      });
    }

    // Normalisation des items par rapport au menu + prénom & suppléments
    const normalized = items.map((it) => {
      const menuItem = MENU.find((m) => m.id === it.id) || {
        price: it.price || 0,
        name: it.name || 'Article',
      };

      const qty = Number(it.qty || it.quantity || 1);
      const price = Number(
        typeof it.price === 'number' ? it.price : menuItem.price || 0
      );
      const name = it.name || menuItem.name;

      // Prénom / nom du client pour cette ligne
      const lineClientNameRaw =
        it.clientName ||
        it.customerName ||
        it.ownerName ||
        rootClientName ||
        '';

      const lineClientName =
        typeof lineClientNameRaw === 'string'
          ? lineClientNameRaw.trim()
          : '';

      // Suppléments / options éventuels
      let extrasSrc = null;
      if (Array.isArray(it.extras)) extrasSrc = it.extras;
      else if (Array.isArray(it.options)) extrasSrc = it.options;
      else if (Array.isArray(it.supplements)) extrasSrc = it.supplements;
      else if (Array.isArray(it.toppings)) extrasSrc = it.toppings;

      const extras =
        Array.isArray(extrasSrc)
          ? extrasSrc
              .map((e) =>
                typeof e === 'string'
                  ? e.trim()
                  : (e && (e.label || e.name || e.title || '')).trim()
              )
              .filter(Boolean)
          : [];

      return {
        id: it.id,
        name,
        qty,
        price,
        clientName: lineClientName || undefined,
        extras: extras.length ? extras : undefined,
      };
    });

    const subtotal = normalized.reduce(
      (sum, it) => sum + it.qty * it.price,
      0
    );
    const vat = subtotal * 0.1;
    const total = Math.round((subtotal + vat) * 100) / 100;

    const now = new Date();
    const createdAt = now.toISOString();
    const businessDay = getBusinessDayKey(now);

    // Initialiser ou mettre à jour l'état de la table
    if (!tableState[t]) {
      tableState[t] = { closedManually: false, sessionStartAt: null };
    }

    // Nouvelle commande = réouverture éventuelle de la table.
    // Si la session était "reset" (sessionStartAt null), on démarre une NOUVELLE session.
    tableState[t].closedManually = false;
    if (!tableState[t].sessionStartAt) {
      tableState[t].sessionStartAt = createdAt;
    }

    const ticketClientName = rootClientName || null;

    const ticket = {
      id: `TCK${seqId++}`,
      table: t,
      items: normalized,
      total,
      createdAt,
      date: businessDay,
      sessionKey: tableState[t].sessionStartAt || createdAt,
      sessionStartedAt: tableState[t].sessionStartAt || createdAt,
      printedAt: null,
      paidAt: null,
      closedAt: null,
      paid: false,
      clientName: ticketClientName,
    };

    tickets.push(ticket);

    try {
      delete carts[t];
    } catch (e) {}

    res.json({ ok: true, ticket });
  } catch (err) {
    console.error('POST /orders error', err);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// ---- Récupération des commandes côté client : GET /client/orders?table=T4 ----
app.get('/client/orders', (req, res) => {
  try {
    const rawTable = (req.query && (req.query.table || req.query.t)) || '';
    const table = String(rawTable || '').trim().toUpperCase();
    if (!table) {
      return res.json({ ok: true, table: null, sessionActive: false, sessionStartAt: null, orders: [], mergedItems: [], grandTotal: 0 });
    }

    const businessDay = getBusinessDayKey();
    let list = ticketsForTable(table, businessDay);

    const flags = tableState[table] || { closedManually: false, sessionStartAt: null };
    // IMPORTANT: if no active sessionStartAt, we must NOT return old tickets from earlier sessions.
    if (!flags.sessionStartAt) {
      return res.json({ ok: true, table, sessionActive: false, sessionStartAt: null, orders: [], mergedItems: [], grandTotal: 0 });
    }

    if (flags.sessionStartAt) {
      try {
        const sessTs = new Date(flags.sessionStartAt).getTime();
        if (!Number.isNaN(sessTs)) {
          list = list.filter((ticket) => {
            const createdTs = new Date(ticket.createdAt).getTime();
            return !Number.isNaN(createdTs) && createdTs >= sessTs;
          });
        }
      } catch (e) {}
    }

    if (!list.length) {
      return res.json({ ok: true, table, sessionActive: true, sessionStartAt: flags.sessionStartAt, orders: [], mergedItems: [], grandTotal: 0 });
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
    });
  } catch (err) {
    console.error('GET /client/orders error', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});
// ---- Helpers Staff ----

function ticketsForTable(table, businessDay) {
  return tickets
    .filter((t) => t.table === table && t.date === businessDay)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function lastTicketForTable(table, businessDay) {
  const list = ticketsForTable(table, businessDay);
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

  const nowTs = now.getTime();
  const paidTs = ticket.paidAt ? new Date(ticket.paidAt).getTime() : null;

  if (paidTs) {
    return STATUS.PAID;
  }

  if (!ticket.printedAt) {
    return STATUS.ORDERED;
  }

  const printedTs = new Date(ticket.printedAt).getTime();
  if (Number.isNaN(printedTs)) {
    return STATUS.ORDERED;
  }

  const diffPrep = nowTs - printedTs;
  if (diffPrep < PREP_MS) {
    return STATUS.PREP;
  }

  return STATUS.PAY_DUE;
}


// ---- Payload /tables ----

function tablesPayload() {
  const businessDay = getBusinessDayKey();
  const now = new Date();

  const raw = TABLE_IDS.map((id) => {
  let last = lastTicketForTable(id, businessDay);
  const flags = tableState[id] || { closedManually: false, sessionStartAt: null };

  // Indique s'il y a une session client active (prénom validé)
  const hasSession = !!flags.sessionStartAt;

  // Si une nouvelle session client a démarré après le dernier ticket,
  // on ignore ce ticket (il appartient à l'ancienne session).
  if (hasSession && last) {
    try{
      const sessTs = new Date(flags.sessionStartAt).getTime();
      const lastTs = new Date(last.createdAt).getTime();
      if (!Number.isNaN(sessTs) && !Number.isNaN(lastTs) && lastTs < sessTs){
        last = null;
      }
    }catch(e){}
  }

  const statusFromTicket = computeStatusFromTicket(last, now);

  const autoCleared = false;

    const cleared = !!flags.closedManually;

    // Statut effectif renvoyé au front :
    // - si clôture manuelle → toujours "Vide"
    // - sinon ce que donne computeStatusFromTicket
    let effectiveStatus = statusFromTicket;
    if (flags.closedManually) {
      effectiveStatus = STATUS.EMPTY;
    }
// Si une session client est ouverte et qu'il n'y a pas encore de ticket
// pour cette session, on considère la table comme "En cours".
if (!cleared && hasSession && !last) {
  effectiveStatus = STATUS.IN_PROGRESS;
}

    // Surcharge éventuelle : "Nouvelle commande" quand un ticket additionnel récent arrive
    // sans modifier les timers métiers existants.
    if (!flags.closedManually && last && !cleared) {
      let list = ticketsForTable(id, businessDay);

      // IMPORTANT: "Nouvelle commande" must be evaluated only inside the CURRENT session.
      // After a manual close/reset, old tickets from earlier sessions of the same day
      // must not make the first ticket of the new session look like an additional order.
      if (flags.sessionStartAt) {
        try {
          const sessTs = new Date(flags.sessionStartAt).getTime();
          if (!Number.isNaN(sessTs)) {
            list = list.filter((ticket) => {
              const createdTs = new Date(ticket.createdAt).getTime();
              return !Number.isNaN(createdTs) && createdTs >= sessTs;
            });
          }
        } catch (e) {}
      }

      if (list.length >= 2) {
        const prev = list[list.length - 2];

        // Statut "avant" la nouvelle commande (sur le ticket précédent)
        const prevStatus = computeStatusFromTicket(prev, now);

        // "Nouvelle commande" doit rester affiché jusqu'à l'impression manuelle
        // du DERNIER ticket de la session.
        // Donc :
        // - au moins 2 tickets dans la session active
        // - dernier ticket pas encore imprimé
        // - table ni vide ni payée
        // - et le statut précédent était déjà en cours de traitement
        if (
          !last.printedAt &&
          effectiveStatus !== STATUS.EMPTY &&
          effectiveStatus !== STATUS.PAID &&
          (prevStatus === STATUS.ORDERED || prevStatus === STATUS.PREP || prevStatus === STATUS.PAY_DUE)
        ) {
          effectiveStatus = STATUS.NEW_ORDER;
        }
      }
    }

    let lastTicketAt = last ? last.createdAt : null;
    let lastTicket = last
      ? { total: last.total, at: last.createdAt }
      : null;

    // Si la table est "cleared" (auto ou manuelle), on ne remonte plus le dernier ticket
    if (cleared) {
      lastTicketAt = null;
      lastTicket = null;
    }

    const pending = effectiveStatus === STATUS.EMPTY ? 0 : 1;

    return {
      id,
      pending,
      status: effectiveStatus,
      lastTicketAt,
      lastTicket,
      cleared,
      closedManually: !!flags.closedManually,
      sessionStartAt: flags.sessionStartAt || null,
    };
  });

  // Tri : d'abord les tables avec activité (dernier ticket), du plus récent au plus ancien,
  // puis les tables vides par ordre naturel (T1, T2, ...)
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

  return { tables: raw };
}


function computeSummarySessionStatus(sessionTickets, now = new Date()) {
  if (!Array.isArray(sessionTickets) || !sessionTickets.length) {
    return STATUS.EMPTY;
  }

  const sorted = [...sessionTickets].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const last = sorted[sorted.length - 1];
  const statusFromLast = computeStatusFromTicket(last, now);

  // Session manually closed or auto-closed after payment:
  // keep the final meaningful historical state instead of falling back to "Vide".
  if (last.closedAt) {
    if (last.paidAt) return STATUS.PAID;
    return 'Clôturée';
  }

  return statusFromLast;
}

function groupTicketsBySessionForDay(businessDay) {
  const rows = [];
  const groups = new Map();

  tickets
    .filter((t) => t.date === businessDay)
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

function summaryPayload() {
  const businessDay = getBusinessDayKey();
  const now = new Date();

  const list = groupTicketsBySessionForDay(businessDay)
    .map((group) => {
      const orderedTickets = [...group.tickets].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const lastTicket = orderedTickets[orderedTickets.length - 1] || null;
      const status = computeSummarySessionStatus(orderedTickets, now);
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
  app.get(prefix + '/tables', (_req, res) => {
    try {
      res.json(tablesPayload());
    } catch (err) {
      console.error('GET /tables error', err);
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // GET summary
  app.get(prefix + '/summary', (_req, res) => {
    try {
      res.json(summaryPayload());
    } catch (err) {
      console.error('GET /summary error', err);
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // POST print
  app.post(prefix + '/print', (req, res) => {
    try {
      const table = String(req.body?.table || '').trim();
      if (!table) return res.json({ ok: true });

      const businessDay = getBusinessDayKey();
      const last = lastTicketForTable(table, businessDay);
      if (last && !last.printedAt) {
        last.printedAt = nowIso();
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('POST /print error', err);
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // POST confirm (encodage caisse confirmé)
  app.post(prefix + '/confirm', (req, res) => {
    try {
      const table = String(req.body?.table || '').trim();
      if (!table) return res.json({ ok: true });

      const businessDay = getBusinessDayKey();
      const last = lastTicketForTable(table, businessDay);
      if (last) {
        const now = nowIso();
        last.paidAt = now;
        last.paid = true;
        last.posConfirmed = true;
        last.posConfirmedAt = now;
        last.closedWithException = false;
        last.exceptionReason = null;
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('POST /confirm error', err);
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // POST cancel-confirm (annuler encodage caisse)
  app.post(prefix + '/cancel-confirm', (req, res) => {
    try {
      const table = String(req.body?.table || '').trim();
      if (!table) return res.json({ ok: true });

      const businessDay = getBusinessDayKey();
      const last = lastTicketForTable(table, businessDay);
      if (last) {
        last.paidAt = null;
        last.paid = false;
        last.posConfirmed = null;
        last.posConfirmedAt = null;
        last.closedWithException = false;
        last.exceptionReason = null;
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('POST /cancel-confirm error', err);
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // POST close-table (clôturer la table manuellement)
  app.post(prefix + '/close-table', (req, res) => {
    try {
      const table = String(req.body?.table || '').trim();
      // Manual close must clear any server-side shared cart so a new session starts clean.
      try { delete carts[table]; } catch (e) {}

      if (!table) return res.json({ ok: true });

      if (!tableState[table]) {
        tableState[table] = { closedManually: false, sessionStartAt: null };
      }

      const activeSessionKey = tableState[table].sessionStartAt || null;
      const closedAt = nowIso();

      if (activeSessionKey) {
        tickets.forEach((ticket) => {
          if (
            ticket.table === table &&
            ticket.date === getBusinessDayKey() &&
            (ticket.sessionKey || ticket.sessionStartedAt || ticket.createdAt) === activeSessionKey
          ) {
            ticket.closedAt = closedAt;
            ticket.posConfirmed = posConfirmed;
            ticket.posConfirmedAt = posConfirmed ? closedAt : (ticket.posConfirmedAt || null);
            ticket.closedWithException = closedWithException;
            ticket.exceptionReason = closedWithException ? 'POS_NON_CONFIRME' : null;
          }
        });
      }

      tableState[table].closedManually = true;
      tableState[table].sessionStartAt = null;

      res.json({ ok: true });
    } catch (err) {
      console.error('POST /close-table error', err);
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // POST cancel-close (annuler clôture manuelle)
  app.post(prefix + '/cancel-close', (req, res) => {
    try {
      const table = String(req.body?.table || '').trim();
      if (!table) return res.json({ ok: true });

      if (!tableState[table]) {
        tableState[table] = { closedManually: false, sessionStartAt: null };
      }
      tableState[table].closedManually = false;

      res.json({ ok: true });
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