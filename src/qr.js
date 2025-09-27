// src/qr.js — PNG per table + PDF sheet
const express = require('express');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');

const router = express.Router();

function buildClientUrl(table) {
  const client = process.env.CLIENT_URL || '';
  const api = process.env.API_PUBLIC_URL || '';
  const params = new URLSearchParams({ table, api });
  if (process.env.HMAC_SECRET) {
    const sig = crypto.createHmac('sha256', process.env.HMAC_SECRET)
      .update(`${table}|${api}`).digest('hex').slice(0, 16);
    params.set('s', sig);
  }
  return `${client}?${params.toString()}`;
}

router.get('/qr/:table.png', async (req, res) => {
  try {
    const table = String(req.params.table||'').trim();
    if (!table) return res.status(400).json({ ok:false, error:'missing table' });
    const png = await QRCode.toBuffer(buildClientUrl(table), { type:'png', width:600, margin:1 });
    res.type('png').send(png);
  } catch (e) { console.error(e); res.status(500).json({ ok:false }); }
});

router.get('/qr-sheet.pdf', async (req, res) => {
  try {
    const tablesParam = (req.query.tables || '').trim();
    const count = parseInt(req.query.count || '0', 10);
    let tables = [];
    if (tablesParam) tables = tablesParam.split(',').map(s=>s.trim()).filter(Boolean);
    else if (count>0) tables = Array.from({length:count}, (_,i)=>`T${i+1}`);
    else tables = Array.from({length:12}, (_,i)=>`T${i+1}`);

    res.type('pdf');
    const doc = new PDFDocument({ size:'A4', margin:24 }); doc.pipe(res);
    doc.fontSize(16).text('QR Commande — Tables', { align:'center' }).moveDown(0.5);
    const cols=3, cellW=(doc.page.width-doc.page.margins.left-doc.page.margins.right)/cols, cellH=250;
    let col=0,row=0;
    for (const t of tables) {
      const png = await QRCode.toBuffer(buildClientUrl(t), { type:'png', width:380, margin:1 });
      const x = doc.page.margins.left + col*cellW + 14;
      const y = 80 + row*cellH;
      doc.fontSize(12).text(`Table ${t}`, x, y-4);
      doc.image(png, x, y, { width:180 });
      doc.fontSize(8).fillColor('#555').text(buildClientUrl(t), x, y+190, { width:220 }).fillColor('black');
      col++; if (col>=cols) { col=0; row++; }
      if (80 + (row+1)*cellH > (doc.page.height - doc.page.margins.bottom)) { doc.addPage(); row=0; col=0; }
    }
    doc.end();
  } catch (e) { console.error(e); res.status(500).json({ ok:false }); }
});

module.exports = router;
