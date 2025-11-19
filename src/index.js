// QR Ordering API — standalone (multi-repo) v1.1 mock + QR
// Endpoints :
//   GET  /health
//   GET  /menu
//   POST /orders
//   GET  /tables        et  /staff/tables
//   GET  /summary       et  /staff/summary
//   POST /print         et  /staff/print
//   POST /confirm       et  /staff/confirm
//   GET  /qr/:table.png
//   GET  /qr-sheet.pdf

const express = require('express');
const cors = require('cors');
const qrRouter = require('./qr');

const app = express();
app.use(cors());
app.use(express.json());

// -------- Constantes métier --------
const TABLE_IDS = Array.from({ length: 10 }, (_, i) => `T${i + 1}`);

// Règles de statuts
const PREP_MS = 20 * 60 * 1000;   // 20 minutes : En préparation → Doit payé
const PAY_CLEAR_MS = 30 * 1000;   // 30 secondes : Payée → Vide
const RESET_HOUR = 3;             // fin de journée à 03:00

const STATUS = {
  EMPTY: 'Vide',
  ORDERED: 'Commandée',
  PREP: 'En préparation',
  PAY_DUE: 'Doit payé',
  PAID: 'Payée',
};

// -------- Mock menu --------
const MENU = [
  { id: "m1", name: "Margherita",   price: 8.5,  category: "Pizzas" },
  { id: "m2", name: "Regina",       price: 10.0, category: "Pizzas" },
  { id: "m3", name: "Cheeseburger", price: 12.0, category: "Burgers" },
  { id: "m4", name: "Frites",       price: 3.5,  category: "Sides" },
  { id: "m5", name: "Tiramisu",     price: 5.0,  category: "Desserts" },
  { id: "m6", name: "Coca 33cl",    price: 2.8,  category: "Boissons" }
];

// -------- Stockage en mémoire (mock) --------
let tickets = [];
let seqId = 1;

// -------- Helpers temporels --------
const nowIso = () => new Date().toISOString();

/**
 * Clé de journée de service (business day) avec coupure à RESET_HOUR.
 * Exemple : "2025-11-19"
 */
function getBusinessDayKey(date = new Date()) {
  const d = new Date(date);
  const h = d.getHours();
  if (h < RESET_HOUR) {
    // Avant 03:00, on considère que l'on est toujours sur la journée d'hier
    d.setDate(d.getDate() - 1);
  }
  return d.toISOString().slice(0, 10); // "YYYY-MM-DD"
}

// -------- Endpoints simples --------

// Healthcheck
app.get('/health', (_req, res) => res.json({ ok: true }));

// Menu (mock)
app.get('/menu', (_req, res) => res.json({ ok: true, items: MENU }));

// -------- Création de commande : POST /orders --------
// Reçoit { table, items:[{id, qty,...}] } depuis la PWA client
// Normalise avec les prix du MENU et crée un ticket pour la journée en cours.
app.post('/orders', (req, res) => {
  try {
    const { table, items } = req.body || {};
    const t = String(table || '').trim();
    if (!t) return res.status(400).json({ ok: false, error: 'missing table' });
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'empty items' });
    }

    // Normalisation des lignes avec le MENU
    const normalized = items.map(it => {
      const m = MENU.find(x => x.id === it.id) || { price: it.price || 0, name: it.name || 'Article' };
      return {
        id: it.id,
        name: it.name || m.name,
        qty: Number(it.qty || 1),
        price: Number(m.price || 0)
      };
    });

    const subtotal = normalized.reduce((s, i) => s + i.qty * i.price, 0);
    const vat = subtotal * 0.10;
    const total = Math.round((subtotal + vat) * 100) / 100;

    const now = new Date();
    const ticket = {
      id: `TCK${seqId++}`,
      table: t,
      items: normalized,
      total,
      createdAt: now.toISOString(),
      date: getBusinessDayKey(now),
      // nouveaux champs "mémoire en ligne"
      printedAt: null,
      paidAt: null,
      closedAt: null,
      paid: false // pour compatibilité éventuelle avec l'ancien code
    };

    tickets.push(ticket);
    res.json({ ok: true, ticket });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

// -------- Helpers Staff --------

// Dernier ticket d'une table pour la journée actuelle
function lastTicketForTable(table, businessDay) {
  const list = tickets
    .filter(t => t.table === table && t.date === businessDay)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return list.length ? list[list.length - 1] : null;
}

// Calcule le statut d'une table en fonction de son dernier ticket
function computeStatusFromTicket(ticket, now = new Date()) {
  if (!ticket) {
    return STATUS.EMPTY;
  }

  const nowTs = now.getTime();
  const printedTs = ticket.printedAt ? new Date(ticket.printedAt).getTime() : null;
  const paidTs = ticket.paidAt ? new Date(ticket.paidAt).getTime() : null;

  // 1) Paiement → "Payée" pendant PAY_CLEAR_MS puis "Vide"
  if (paidTs) {
    const diff = nowTs - paidTs;
    if (diff < PAY_CLEAR_MS) {
      return STATUS.PAID;
    }
    return STATUS.EMPTY;
  }

  // 2) Imprimé mais pas payé → "En préparation" puis "Doit payé"
  if (printedTs) {
    const diff = nowTs - printedTs;
    if (diff < PREP_MS) {
      return STATUS.PREP;
    }
    return STATUS.PAY_DUE;
  }

  // 3) Commande enregistrée mais pas encore imprimée
  return STATUS.ORDERED;
}

// Payload /tables pour la journée en cours
function tablesPayload() {
  const businessDay = getBusinessDayKey();
  const now = new Date();

  const out = TABLE_IDS.map(id => {
    const last = lastTicketForTable(id, businessDay);
    const status = computeStatusFromTicket(last, now);

    const pending = status === STATUS.EMPTY ? 0 : 1;

    return {
      id,
      pending,
      status,
      lastTicketAt: last ? last.createdAt : null,
      lastTicket: last
        ? { total: last.total, at: last.createdAt }
        : null
    };
  });

  return { tables: out };
}

// Payload /summary pour la journée en cours
function summaryPayload() {
  const businessDay = getBusinessDayKey();
  const list = tickets
    .filter(t => t.date === businessDay)
    .map(t => ({
      id: t.id,
      table: t.table,
      total: t.total,
      items: t.items,
      time: new Date(t.createdAt).toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit'
      })
    }));

  return { tickets: list };
}

// Monte les routes Staff sur un préfixe donné ("", "/staff")
function mountStaffRoutes(prefix = '') {
  // Liste des tables + statuts
  app.get(prefix + '/tables', (_req, res) => {
    try {
      res.json(tablesPayload());
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false });
    }
  });

  // Résumé du jour
  app.get(prefix + '/summary', (_req, res) => {
    try {
      res.json(summaryPayload());
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false });
    }
  });

  // Impression cuisine : marque printedAt sur le dernier ticket de la table
  app.post(prefix + '/print', (req, res) => {
    try {
      const table = String(req.body?.table || '').trim();
      if (!table) {
        // pour compatibilité, on accepte aussi sans table (no-op)
        return res.json({ ok: true });
      }
      const businessDay = getBusinessDayKey();
      const last = lastTicketForTable(table, businessDay);
      if (last) {
        last.printedAt = nowIso();
      }
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false });
    }
  });

  // Paiement confirmé : marque paidAt sur le dernier ticket de la table
  app.post(prefix + '/confirm', (req, res) => {
    try {
      const table = String(req.body?.table || '').trim();
      if (!table) {
        return res.json({ ok: true });
      }
      const businessDay = getBusinessDayKey();
      const last = lastTicketForTable(table, businessDay);
      if (last) {
        const now = nowIso();
        last.paidAt = now;
        last.paid = true;
      }
      res.json({ ok: true });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false });
    }
  });
}

// ---- Mount root & /staff ----
mountStaffRoutes('');
mountStaffRoutes('/staff');

// ---- QR routes ----
app.use(qrRouter);

// ---- Start ----
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`QR API listening on ${PORT}`));
