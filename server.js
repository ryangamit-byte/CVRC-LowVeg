// Seed Stock Monitor - backend (Express + JSON file storage)
// Run: npm install && npm start   ->  http://localhost:3000
// Default admin login: admin / admin123  (CHANGE IT after first login)

const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');
const STORAGE_WARN_DAYS = 730;

const round = n => Math.round(n * 1000) / 1000;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

/* ---------- storage (swap this block for SQLite/MySQL later) ---------- */
function init() {
  if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  return {
    seq: { seeds: 4, tx: 0, users: 1, audit: 0 },
    users: [{ id: 1, username: 'admin', hash: bcrypt.hashSync('admin123', 10), role: 'admin', active: true }],
    seeds: [
      { id: 1, crop: 'Ampalaya', variety: 'Galaxy F1', unit: 'kg', reorder: 5, equivalent_price: 120 },
      { id: 2, crop: 'Eggplant', variety: 'Dumaguete Long Purple', unit: 'kg', reorder: 5, equivalent_price: 110 },
      { id: 3, crop: 'Tomato', variety: 'Diamante Max', unit: 'kg', reorder: 3, equivalent_price: 150 },
      { id: 4, crop: 'Okra', variety: 'Smooth Green', unit: 'kg', reorder: 10, equivalent_price: 90 },
    ],
    tx: [],
    audit: [],
  };
}
const db = init();
function pruneAudit() {
  const cutoff = Date.now() - (1000 * 60 * 60 * 24 * 30 * 6);
  db.audit = db.audit.filter(entry => {
    const ts = new Date(entry.ts || 0).getTime();
    return Number.isFinite(ts) && ts >= cutoff;
  });
  if (db.audit.length > 2000) db.audit = db.audit.slice(-2000);
}
function save() {
  pruneAudit();
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 2));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
}
function log(user, action, detail = '') {
  pruneAudit();
  db.audit.push({ id: ++db.seq.audit, ts: new Date().toISOString(), user, action, detail });
  if (db.audit.length > 2000) db.audit.shift();
}
pruneAudit();
save();

/* ---------- stock logic ---------- */
const seedName = id => {
  const s = db.seeds.find(x => x.id === id);
  return s ? `${s.crop} - ${s.variety}` : '(deleted seed)';
};
const stockOf = id =>
  round(db.tx.filter(t => t.seed_id === id).reduce((a, t) => a + (t.type === 'IN' ? t.qty : -t.qty), 0));

// Lots still on the shelf. Stock-out is deducted from the earliest-expiring lot first (FEFO).
function lotsOf(id) {
  let out = db.tx.filter(t => t.seed_id === id && t.type === 'OUT').reduce((a, t) => a + t.qty, 0);
  const ins = db.tx
    .filter(t => t.seed_id === id && t.type === 'IN')
    .sort((a, b) => (a.harvest_date || a.expiry || '9999').localeCompare(b.harvest_date || b.expiry || '9999') || a.date.localeCompare(b.date));
  const lots = [];
  for (const i of ins) {
    const used = Math.min(out, i.qty);
    out -= used;
    if (i.qty - used > 0) lots.push({ lot_no: i.lot_no, harvest_date: i.harvest_date || i.expiry || null, remaining: round(i.qty - used) });
  }
  return lots;
}
function qualitySummaryForSeed(id) {
  let out = db.tx.filter(t => t.seed_id === id && t.type === 'OUT').reduce((a, t) => a + t.qty, 0);
  const ins = db.tx
    .filter(t => t.seed_id === id && t.type === 'IN' && ['clean', 'unclean'].includes(t.seed_quality))
    .sort((a, b) => (a.harvest_date || a.expiry || '9999').localeCompare(b.harvest_date || b.expiry || '9999') || a.date.localeCompare(b.date));
  const result = { clean: 0, unclean: 0 };
  for (const i of ins) {
    const used = Math.min(out, i.qty);
    out -= used;
    const remaining = round(i.qty - used);
    if (remaining <= 0) continue;
    if (i.seed_quality === 'clean') result.clean += remaining;
    if (i.seed_quality === 'unclean') result.unclean += remaining;
  }
  return result;
}
function seedView(s) {
  const stock = stockOf(s.id);
  const lots = lotsOf(s.id);
  return {
    ...s,
    stock,
    lots,
    nearest_harvest_date: lots.map(l => l.harvest_date).filter(Boolean).sort()[0] || null,
    status: stock <= 0 ? 'OUT' : stock <= s.reorder ? 'LOW' : 'OK',
  };
}

/* ---------- app + auth ---------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.users.find(x => x.username === username && x.active);
  if (!u || !bcrypt.compareSync(password || '', u.hash))
    return res.status(401).json({ error: 'Wrong username or password' });
  log(u.username, 'LOGIN');
  save();
  res.json({
    token: jwt.sign({ id: u.id }, SECRET, { expiresIn: '12h' }),
    user: { id: u.id, username: u.username, role: u.role },
  });
});

const auth = (req, res, next) => {
  try {
    const p = jwt.verify((req.headers.authorization || '').slice(7), SECRET);
    const u = db.users.find(x => x.id === p.id && x.active);
    if (!u) throw new Error('inactive');
    req.user = u;
    next();
  } catch {
    res.status(401).json({ error: 'Please log in again' });
  }
};
const admin = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' });

app.use('/api', auth);

app.get('/api/me', (req, res) =>
  res.json({ user: { id: req.user.id, username: req.user.username, role: req.user.role } })
);

/* ---------- seed catalog ---------- */
app.get('/api/seeds', (req, res) => res.json(db.seeds.map(seedView)));

function readSeed(b) {
  const crop = String(b.crop || '').trim();
  const variety = String(b.variety || '').trim();
  const unit = String(b.unit || 'kg').trim();
  const reorder = Number(b.reorder);
  const equivalentPrice = Number(b.equivalent_price ?? 0);
  if (!crop || !variety) return { error: 'Crop and variety are required' };
  if (!(reorder >= 0)) return { error: 'Reorder level must be 0 or more' };
  if (!(equivalentPrice >= 0)) return { error: 'Equivalent price must be 0 or more' };
  return { crop, variety, unit, reorder, equivalent_price: round(equivalentPrice) };
}
app.post('/api/seeds', admin, (req, res) => {
  const v = readSeed(req.body);
  if (v.error) return res.status(400).json(v);
  const s = { id: ++db.seq.seeds, ...v };
  db.seeds.push(s);
  log(req.user.username, 'SEED_ADD', seedName(s.id));
  save();
  res.json(s);
});
app.put('/api/seeds/:id', admin, (req, res) => {
  const s = db.seeds.find(x => x.id == req.params.id);
  if (!s) return res.status(404).json({ error: 'Seed not found' });
  const v = readSeed(req.body);
  if (v.error) return res.status(400).json(v);
  Object.assign(s, v);
  log(req.user.username, 'SEED_EDIT', seedName(s.id));
  save();
  res.json(s);
});
app.delete('/api/seeds/:id', admin, (req, res) => {
  const s = db.seeds.find(x => x.id == req.params.id);
  if (!s) return res.status(404).json({ error: 'Seed not found' });
  if (db.tx.some(t => t.seed_id === s.id))
    return res.status(400).json({ error: 'This seed has transactions and cannot be deleted' });
  log(req.user.username, 'SEED_DELETE', seedName(s.id));
  db.seeds = db.seeds.filter(x => x.id !== s.id);
  save();
  res.json({ ok: true });
});

/* ---------- stock in / out ---------- */
app.get('/api/tx', (req, res) => {
  const { seed_id, type, from, to } = req.query;
  const rows = db.tx
    .filter(t => (!seed_id || t.seed_id == seed_id) && (!type || t.type === type) && (!from || t.date >= from) && (!to || t.date <= to))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
    .slice(0, 500)
    .map(t => ({ ...t, seed: seedName(t.seed_id) }));
  res.json(rows);
});

app.post('/api/tx', (req, res) => {
  const b = req.body || {};
  const seed = db.seeds.find(s => s.id == b.seed_id);
  const qty = Number(b.qty);
  const agribusinessQty = Number(b.agribusiness_qty || 0);
  const plantingMaterialQty = Number(b.planting_material_qty || 0);
  const regularTargetQty = Number(b.regular_target_qty || 0);
  const harvestDate = b.harvest_date || b.expiry || null;
  const sourceType = String(b.source_type || 'regular_supply').trim();
  const seedQuality = ['clean', 'unclean'].includes(b.seed_quality) ? b.seed_quality : null;
  if (!seed) return res.status(400).json({ error: 'Choose a seed variety' });
  if (!['IN', 'OUT'].includes(b.type)) return res.status(400).json({ error: 'Choose stock in or stock out' });
  if (!(qty > 0)) return res.status(400).json({ error: 'Quantity must be more than 0' });
  if (!isDate(b.date)) return res.status(400).json({ error: 'Enter a valid date' });
  if (b.type === 'IN' && harvestDate && !isDate(harvestDate)) return res.status(400).json({ error: 'Enter a valid harvest date' });
  if (b.type === 'IN' && sourceType === 'harvest' && !seedQuality) return res.status(400).json({ error: 'Harvest seed must be marked as clean or unclean' });
  const have = stockOf(seed.id);
  if (b.type === 'OUT' && qty > have)
    return res.status(400).json({ error: `Only ${have} ${seed.unit} in stock` });
  if (b.type === 'OUT') {
    const splitTotal = agribusinessQty + plantingMaterialQty + regularTargetQty;
    if (splitTotal > 0 && splitTotal !== qty)
      return res.status(400).json({ error: 'Release quantities must equal the total release quantity' });
  }
  const t = {
    id: ++db.seq.tx,
    seed_id: seed.id,
    type: b.type,
    qty: round(qty),
    date: b.date,
    lot_no: String(b.lot_no || '').trim(),
    harvest_date: b.type === 'IN' ? (harvestDate || null) : null,
    expiry: b.type === 'IN' && harvestDate ? harvestDate : null,
    source_type: b.type === 'IN' ? sourceType : null,
    seed_quality: b.type === 'IN' ? (sourceType === 'harvest' ? seedQuality : null) : null,
    party: String(b.party || '').trim(), // supplier/origin (IN) or recipient (OUT)
    remarks: String(b.remarks || '').trim(),
    agribusiness_qty: b.type === 'OUT' ? round(agribusinessQty) : null,
    planting_material_qty: b.type === 'OUT' ? round(plantingMaterialQty) : null,
    regular_target_qty: b.type === 'OUT' ? round(regularTargetQty) : null,
    user: req.user.username,
    created_at: new Date().toISOString(),
  };
  db.tx.push(t);
  log(req.user.username, 'STOCK_' + t.type, `${seedName(seed.id)} ${t.qty} ${seed.unit}`);
  save();
  res.json(t);
});

app.delete('/api/tx/:id', admin, (req, res) => {
  const t = db.tx.find(x => x.id == req.params.id);
  if (!t) return res.status(404).json({ error: 'Transaction not found' });
  db.tx = db.tx.filter(x => x.id !== t.id);
  if (stockOf(t.seed_id) < 0) {
    db.tx.push(t); // would make stock negative - put it back
    return res.status(400).json({ error: 'Deleting this stock-in would make stock negative' });
  }
  log(req.user.username, 'TX_DELETE', `#${t.id} ${t.type} ${t.qty} ${seedName(t.seed_id)}`);
  save();
  res.json({ ok: true });
});

/* ---------- dashboard summary ---------- */
app.get('/api/summary', (req, res) => {
  const all = db.seeds.map(seedView);
  const now = new Date();
  const todayIso = now.toISOString().slice(0, 10);
  const expiring = [];
  all.forEach(s =>
    s.lots.forEach(l => {
      if (!l.harvest_date) return;
      const harvest = new Date(l.harvest_date + 'T00:00:00Z');
      const daysInStorage = Math.max(0, Math.floor((new Date(todayIso + 'T00:00:00Z') - harvest) / 86400000));
      if (daysInStorage >= STORAGE_WARN_DAYS) {
        expiring.push({ seed: `${s.crop} - ${s.variety}`, unit: s.unit, ...l, days_in_storage: daysInStorage, warn: true });
      }
    })
  );
  const pricedSeeds = all.map(s => ({
    crop: s.crop,
    variety: s.variety,
    unit: s.unit,
    stock: s.stock,
    reorder: s.reorder,
    equivalent_price: Number(s.equivalent_price || 0),
    total_equivalent_value: round((Number(s.equivalent_price || 0) || 0) * s.stock),
    status: s.status,
  }));
  const qualityTotals = db.seeds.reduce((totals, seed) => {
    const q = qualitySummaryForSeed(seed.id);
    totals.clean += q.clean;
    totals.unclean += q.unclean;
    return totals;
  }, { clean: 0, unclean: 0 });
  expiring.sort((a, b) => a.harvest_date.localeCompare(b.harvest_date));

  const flow = [];
  const releaseFlow = [];
  const monthKeys = [];
  const sumCategory = (month, key) =>
    round(db.tx.filter(t => t.type === 'OUT' && t.date.startsWith(month) && t[key] != null).reduce((a, t) => a + Number(t[key] || 0), 0));
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const m = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const sum = type => round(db.tx.filter(t => t.type === type && t.date.startsWith(m)).reduce((a, t) => a + t.qty, 0));
    monthKeys.push(m);
    flow.push({ month: m, in: sum('IN'), out: sum('OUT') });
    releaseFlow.push({
      month: m,
      agribusiness: sumCategory(m, 'agribusiness_qty'),
      planting_material: sumCategory(m, 'planting_material_qty'),
      regular_target: sumCategory(m, 'regular_target_qty'),
    });
  }
  const monthlyBalance = [];
  for (const seed of db.seeds) {
    let runningBalance = 0;
    for (const month of monthKeys) {
      const beginningBalance = runningBalance;
      const monthIn = round(db.tx.filter(t => t.seed_id === seed.id && t.type === 'IN' && t.date.startsWith(month)).reduce((a, t) => a + t.qty, 0));
      const monthOut = round(db.tx.filter(t => t.seed_id === seed.id && t.type === 'OUT' && t.date.startsWith(month)).reduce((a, t) => a + t.qty, 0));
      runningBalance += monthIn - monthOut;
      monthlyBalance.push({
        month,
        crop: seed.crop,
        variety: seed.variety,
        beginning_balance: round(beginningBalance),
        in: monthIn,
        out: monthOut,
        ending_balance: round(runningBalance),
      });
    }
  }
  res.json({
    total_stock: round(all.filter(s => s.unit === 'kg').reduce((a, s) => a + s.stock, 0)),
    varieties: all.length,
    low: all.filter(s => s.status !== 'OK').length,
    low_items: all.filter(s => s.status !== 'OK'),
    priced_seeds: pricedSeeds,
    expiring,
    flow,
    releaseFlow,
    monthly_balance: monthlyBalance,
    clean_stock: round(qualityTotals.clean),
    unclean_stock: round(qualityTotals.unclean),
    warn_days: STORAGE_WARN_DAYS,
  });
});

/* ---------- admin: users + audit ---------- */
app.get('/api/users', admin, (req, res) =>
  res.json(db.users.map(({ hash, ...u }) => u))
);
app.post('/api/users', admin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || password.length < 6)
    return res.status(400).json({ error: 'Username and a password of 6+ characters are required' });
  if (db.users.some(u => u.username === username)) return res.status(400).json({ error: 'Username already exists' });
  const u = { id: ++db.seq.users, username: username.trim(), hash: bcrypt.hashSync(password, 10), role: role === 'admin' ? 'admin' : 'staff', active: true };
  db.users.push(u);
  log(req.user.username, 'USER_ADD', u.username);
  save();
  res.json({ id: u.id });
});
app.put('/api/users/:id', admin, (req, res) => {
  const u = db.users.find(x => x.id == req.params.id);
  if (!u) return res.status(404).json({ error: 'User not found' });
  const { role, active, password } = req.body || {};
  if (u.id === req.user.id && (active === false || (role && role !== 'admin')))
    return res.status(400).json({ error: 'You cannot deactivate or demote your own account' });
  if (role) u.role = role === 'admin' ? 'admin' : 'staff';
  if (typeof active === 'boolean') u.active = active;
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });
    u.hash = bcrypt.hashSync(password, 10);
  }
  log(req.user.username, 'USER_EDIT', u.username);
  save();
  res.json({ ok: true });
});
app.get('/api/audit', admin, (req, res) => res.json(db.audit.slice(-200).reverse()));

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => console.log(`Seed Stock Monitor running at http://localhost:${PORT}`));
}

module.exports = app;
