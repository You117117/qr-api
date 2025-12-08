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

        // Si aucune session n'existe encore pour cette table, on en démarre une nouvelle.
        // Sinon, on réutilise le même timestamp pour que tous les invités partagent la même session.
        let sessionStartAt = tableState[table].sessionStartAt;
        if (!sessionStartAt){
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
const BUFFER_MS = 120 * 1000;      // 120s avant que la commande soit considérée "imprimée" automatiquement
const PREP_MS = 20 * 60 * 1000;    // 20 min de préparation avant "Doit payé"
const NEW_ORDER_WINDOW_MS = 3 * 60 * 1000; // 3 min d'affichage pour le statut "Nouvelle commande"

// 🔴 Après Paiement confirmé : 5s "Payée" puis Vide (auto-clôture)
const PAY_CLEAR_MS = 5 * 1000;
const RESET_HOUR = 3;              // Changement de journée business à 03:00

const STATUS = {
  EMPTY: 'Vide',
  ORDERED: 'Commandée',
  PREP: 'En préparation',
  PAY_DUE: 'Doit payé',
  PAID: 'Payée',
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

function cartPayloadForTable(table, requestingGuestKey) {
  const bucket = carts[table];
  if (!bucket || !bucket.guests) {
    return { table, items: [], totals: { subtotal: 0, vat: 0, total: 0 } };
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

  return { table, items, totals: { subtotal, vat, total } };
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
  res.json({ ok: true });
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
      printedAt: null,
      paidAt: null,
      closedAt: null,
      paid: false,
      clientName: ticketClientName,
    };

    tickets.push(ticket);

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
      return res.json({ ok: true, orders: [] });
    }

    const businessDay = getBusinessDayKey();
    let list = ticketsForTable(table, businessDay);

    const flags = tableState[table] || { closedManually: false, sessionStartAt: null };
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
      return res.json({ ok: true, table, orders: [] });
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
        extras: Array.isArray(it.extras) ? it.extras : []
      })),
    }));

    return res.json({
      ok: true,
      table,
      mode: null,
      clientName: null,
      orders,
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
 * - 0..120s après création → Commandée
 * - après 120s (auto-print) ou /print → En préparation pendant PREP_MS
 * - ensuite → Doit payé
 * - après /confirm → Payée pendant PAY_CLEAR_MS, puis Vide
 */
function computeStatusFromTicket(ticket, now = new Date()) {
  if (!ticket) {
    return STATUS.EMPTY;
  }

  const nowTs = now.getTime();
  const createdTs = new Date(ticket.createdAt).getTime();
  const printedTs = ticket.printedAt
    ? new Date(ticket.printedAt).getTime()
    : null;
  const paidTs = ticket.paidAt ? new Date(ticket.paidAt).getTime() : null;

  // 1) Paiement : Payée pendant PAY_CLEAR_MS, puis Vide
  if (paidTs) {
    const diffPaid = nowTs - paidTs;
    if (diffPaid < PAY_CLEAR_MS) {
      return STATUS.PAID;
    }
    return STATUS.EMPTY;
  }

  // 2) Déterminer "effectivement imprimé" :
  // - soit imprimé manuellement (printedAt)
  // - soit buffer de 120s expiré
  let effectivePrintedTs = printedTs;
  if (!effectivePrintedTs) {
    const diffSinceCreate = nowTs - createdTs;
    if (diffSinceCreate >= BUFFER_MS) {
      effectivePrintedTs = createdTs + BUFFER_MS;
    }
  }

  // Si pas encore "imprimé" (ni auto, ni manuel) → Commandée
  if (!effectivePrintedTs) {
    return STATUS.ORDERED;
  }

  // 3) Imprimé mais pas payé : En préparation puis Doit payé
  const diffPrep = nowTs - effectivePrintedTs;
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

  // Auto-clear après paiement : table Vide + dernier ticket payé,
  // UNIQUEMENT s'il n'y a PAS de session client en cours.
  const autoCleared = !!(
    statusFromTicket === STATUS.EMPTY &&
    last &&
    last.paidAt &&
    !hasSession
  );

    // Si auto-cleared → on "reset" la sessionStartAt
    if (autoCleared) {
      if (!tableState[id]) {
        tableState[id] = { closedManually: false, sessionStartAt: null };
      }
      tableState[id].sessionStartAt = null;
    }

    const cleared = !!(flags.closedManually || autoCleared);

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
      const list = ticketsForTable(id, businessDay);
      if (list.length >= 2) {
        const prev = list[list.length - 2];
        const nowTs = now.getTime();
        const lastCreatedTs = new Date(last.createdAt).getTime();
        const diffLast = nowTs - lastCreatedTs;

        // Statut "avant" la nouvelle commande (sur le ticket précédent)
        const prevStatus = computeStatusFromTicket(prev, now);

        // On n'affiche "Nouvelle commande" que si :
        // - il y a au moins 2 tickets dans la journée pour cette table
        // - la dernière commande est très récente (< NEW_ORDER_WINDOW_MS)
        // - la table n'est ni vide ni payée
        // - et le statut "avant" était déjà en préparation ou doit payé
        if (
          diffLast >= 0 &&
          diffLast < NEW_ORDER_WINDOW_MS &&
          effectiveStatus !== STATUS.EMPTY &&
          effectiveStatus !== STATUS.PAID &&
          (prevStatus === STATUS.PREP || prevStatus === STATUS.PAY_DUE)
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

// ---- Payload /summary ----

function summaryPayload() {
  const businessDay = getBusinessDayKey();

  const list = tickets
    .filter((t) => t.date === businessDay)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((t) => ({
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
    }));

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
      if (last) {
        // ⚠️ On calcule le statut ACTUEL avant de toucher à printedAt
        const statusNow = computeStatusFromTicket(last, new Date());

        // Si la commande est encore en "Commandée" → ce print démarre vraiment la préparation
        if (statusNow === STATUS.ORDERED) {
          last.printedAt = nowIso();
        }
        // Si déjà "En préparation" ou "Doit payé" → réimpression simple, on ne change pas le statut
        // donc on NE TOUCHE PAS à printedAt
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('POST /print error', err);
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // POST confirm (paiement confirmé)
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
      }

      res.json({ ok: true });
    } catch (err) {
      console.error('POST /confirm error', err);
      res.status(500).json({ ok: false, error: 'internal_error' });
    }
  });

  // POST cancel-confirm (annuler paiement)
  app.post(prefix + '/cancel-confirm', (req, res) => {
    try {
      const table = String(req.body?.table || '').trim();
      if (!table) return res.json({ ok: true });

      const businessDay = getBusinessDayKey();
      const last = lastTicketForTable(table, businessDay);
      if (last) {
        last.paidAt = null;
        last.paid = false;
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
      if (!table) return res.json({ ok: true });

      if (!tableState[table]) {
        tableState[table] = { closedManually: false, sessionStartAt: null };
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