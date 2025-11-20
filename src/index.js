// QR Ordering API — backend en mémoire (Option A)
// Logique centralisée des statuts de table + endpoints pour PWA client & staff.

const express = require('express');
const cors = require('cors');
const qrRouter = require('./qr');

const app = express();
app.use(cors());
app.use(express.json());

// ---- Constantes métier ----

// Tables physiques disponibles (T1..T10)
const TABLE_IDS = Array.from({ length: 10 }, (_, i) => `T${i + 1}`);

// Durées (en millisecondes)
const BUFFER_MS = 120 * 1000;      // 120s avant que la commande soit considérée "imprimée" automatiquement
const PREP_MS = 20 * 60 * 1000;    // 20 min de préparation avant "Doit payé"
const PAY_CLEAR_MS = 30 * 1000;    // 30s d'affichage "Payée" avant retour à "Vide"
const RESET_HOUR = 3;              // Changement de journée business à 03:00

const STATUS = {
  EMPTY: 'Vide',
  ORDERED: 'Commandée',
  PREP: 'En préparation',
  PAY_DUE: 'Doit payé',
  PAID: 'Payée',
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

// ---- État des tables (clôture manuelle) ----
// Exemple : tableState["T6"] = { closedManually: true }
const tableState = {};

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

app.get('/menu', (_req, res) => {
  res.json({ ok: true, items: MENU });
});

// ---- Création de commande : POST /orders ----
// Body attendu : { table, items:[{id, qty}] }
app.post('/orders', (req, res) => {
  try {
    const { table, items } = req.body || {};
    const t = String(table || '').trim();
    if (!t) {
      return res.status(400).json({ ok: false, error: 'missing table' });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'empty items' });
    }

    // Normalisation des items par rapport au menu
    const normalized = items.map((it) => {
      const menuItem = MENU.find((m) => m.id === it.id) || {
        price: it.price || 0,
        name: it.name || 'Article',
      };
      return {
        id: it.id,
        name: it.name || menuItem.name,
        qty: Number(it.qty || 1),
        price: Number(menuItem.price || 0),
      };
    });

    const subtotal = normalized.reduce(
      (sum, it) => sum + it.qty * it.price,
      0
    );
    const vat = subtotal * 0.1;
    const total = Math.round((subtotal + vat) * 100) / 100;

    const now = new Date();
    const ticket = {
      id: `TCK${seqId++}`,
      table: t,
      items: normalized,
      total,
      createdAt: now.toISOString(),
      date: getBusinessDayKey(now),
      printedAt: null,
      paidAt: null,
      closedAt: null,
      paid: false,
    };

    tickets.push(ticket);

    res.json({ ok: true, ticket });
  } catch (err) {
    console.error('POST /orders error', err);
    res.status(500).json({ ok: false, error: 'internal_error' });
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
    const last = lastTicketForTable(id, businessDay);
    const status = computeStatusFromTicket(last, now);

    let lastTicketAt = last ? last.createdAt : null;
    let lastTicket = last
      ? { total: last.total, at: last.createdAt }
      : null;

    const flags = tableState[id] || { closedManually: false };

    // Auto-clear après paiement : table Vide + dernier ticket payé
    const autoCleared = !!(
      status === STATUS.EMPTY &&
      last &&
      last.paidAt
    );

    const cleared = !!(flags.closedManually || autoCleared);

    if (cleared) {
      lastTicketAt = null;
      lastTicket = null;
    }

    const pending = status === STATUS.EMPTY ? 0 : 1;

    return {
      id,
      pending,
      status,
      lastTicketAt,
      lastTicket,
      cleared,
      closedManually: !!flags.closedManually,
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
      time: new Date(t.createdAt).toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
      }),
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
        last.printedAt = nowIso();
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
        tableState[table] = { closedManually: false };
      }
      tableState[table].closedManually = true;

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
        tableState[table] = { closedManually: false };
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
