// QR Ordering API — standalone (multi‑repo) v1.1 mock + QR
// Endpoints: /health, /menu, /orders, /tables, /summary, /print, /confirm
// QR: /qr/:table.png, /qr-sheet.pdf
// NOTE: This is the mock (no DB/Redis). Suitable to pair with your Vercel PWAs.

const express = require('express');
const cors = require('cors');
const qrRouter = require('./qr');

const app = express();
app.use(cors());
app.use(express.json());

// -------- Mock storage --------
const TABLE_IDS = Array.from({ length: 10 }, (_, i) => `T${i + 1}`);
let tickets = [];
let seqId = 1;

const MENU = [
  { id: "m1", name: "Margherita",   price: 8.5,  category: "Pizzas" },
  { id: "m2", name: "Regina",       price: 10.0, category: "Pizzas" },
  { id: "m3", name: "Cheeseburger", price: 12.0, category: "Burgers" },
  { id: "m4", name: "Frites",       price: 3.5,  category: "Sides" },
  { id: "m5", name: "Tiramisu",     price: 5.0,  category: "Desserts" },
  { id: "m6", name: "Coca 33cl",    price: 2.8,  category: "Boissons" }
];

const nowIso = () => new Date().toISOString();
const todayStr = () => new Date().toISOString().slice(0,10);

// ---- Health ----
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---- Menu ----
app.get('/menu', (_req, res) => res.json({ ok: true, items: MENU }));

// ---- Orders (mock creates a ticket immediately) ----
app.post('/orders', (req, res) => {
  try {
    const { table, items } = req.body || {};
    const t = String(table||'').trim();
    if (!t) return res.status(400).json({ ok:false, error:'missing table' });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ ok:false, error:'empty items' });

    // normalize using server MENU prices
    const normalized = items.map(it => {
      const m = MENU.find(x => x.id === it.id) || { price: it.price || 0, name: it.name || 'Item' };
      return { id: it.id, name: it.name || m.name, qty: Number(it.qty||1), price: Number(m.price||0) };
    });
    const subtotal = normalized.reduce((s,i)=>s+i.qty*i.price,0);
    const vat = subtotal * 0.10;
    const total = Math.round((subtotal + vat) * 100) / 100;

    const ticket = { id:`TCK${seqId++}`, table:t, items: normalized, total, paid:false, createdAt: nowIso(), date: todayStr() };
    tickets.push(ticket);
    res.json({ ok:true, ticket });
  } catch (e) {
    console.error(e); res.status(500).json({ ok:false });
  }
});

// ---- Staff ----
function lastTicket(table){
  const ts = tickets.filter(x=>x.table===table).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  return ts.length ? ts[ts.length-1] : null;
}

app.get('/tables', (_req,res) => {
  const out = TABLE_IDS.map(id => {
    const last = lastTicket(id);
    return { id, pending: 0, lastTicket: last ? { total:last.total, at:last.createdAt } : null };
  });
  res.json({ tables: out });
});
app.get('/summary', (_req,res) => {
  const d = todayStr();
  const list = tickets.filter(t=>t.date===d).map(t => ({
    id: t.id, table: t.table, total: t.total, items: t.items,
    time: new Date(t.createdAt).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' })
  }));
  res.json({ tickets: list });
});
app.post('/print', (_req,res) => res.json({ ok:true }));
app.post('/confirm', (req,res) => { try {
  const last = lastTicket(String(req.body?.table||'').trim()); if (last) last.paid = true;
  res.json({ ok:true });
} catch { res.status(500).json({ ok:false }); } });

// ---- QR routes ----
app.use(require('./qr'));

// ---- Start ----
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`QR API listening on ${PORT}`));
