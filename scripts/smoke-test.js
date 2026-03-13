#!/usr/bin/env node

const BASE_URL = String(process.env.SMOKE_BASE_URL || process.argv[2] || '').trim().replace(/\/+$/, '');
const DATE = String(process.env.SMOKE_DATE || process.argv[3] || '').trim();

if (!BASE_URL) {
  console.error('Usage: node scripts/smoke-test.js <BASE_URL> [YYYY-MM-DD]');
  process.exit(1);
}

const checks = [
  { name: 'health', path: '/health', required: ['ok', 'storage'] },
  { name: 'tables', path: '/tables', required: ['tables'] },
  { name: 'summary', path: `/summary${DATE ? `?date=${DATE}` : ''}`, required: ['ok', 'totals', 'items'] },
  { name: 'history', path: `/history-sessions${DATE ? `?date=${DATE}` : ''}`, required: ['ok', 'items', 'meta'] },
  { name: 'manager', path: `/manager-summary${DATE ? `?date=${DATE}` : ''}`, required: ['ok', 'totals', 'byTable'] },
  { name: 'diagnostic overview', path: `/diagnostic/overview${DATE ? `?date=${DATE}` : ''}`, required: ['ok', 'totals'] },
  { name: 'diagnostic events', path: `/diagnostic/events${DATE ? `?date=${DATE}` : ''}`, required: ['ok', 'items', 'meta'] },
];

function hasPath(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

(async () => {
  let hasFailure = false;

  for (const check of checks) {
    const url = `${BASE_URL}${check.path}`;
    try {
      const res = await fetch(url, { headers: { 'cache-control': 'no-store' } });
      const json = await res.json().catch(() => ({}));
      const missing = check.required.filter((field) => !hasPath(json, field));
      const ok = res.ok && !missing.length;

      console.log(`\n[${ok ? 'OK' : 'FAIL'}] ${check.name}`);
      console.log(`URL: ${url}`);
      console.log(`HTTP: ${res.status}`);
      if (missing.length) console.log(`Missing: ${missing.join(', ')}`);
      if (!ok) {
        hasFailure = true;
        console.log('Payload:', JSON.stringify(json, null, 2));
      }
    } catch (err) {
      hasFailure = true;
      console.log(`\n[FAIL] ${check.name}`);
      console.log(`URL: ${url}`);
      console.log(`Error: ${err.message || err}`);
    }
  }

  process.exit(hasFailure ? 1 : 0);
})();
