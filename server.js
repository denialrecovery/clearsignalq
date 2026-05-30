const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '2mb' }));

// ── DATABASE (optional - app works without it) ─────────────────────────────────
let pool = null;

async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log('No DATABASE_URL - running without database');
    return;
  }
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: false, // Railway internal network doesn't need SSL
      connectionTimeoutMillis: 5000,
    });
    await pool.query('SELECT 1');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        id SERIAL PRIMARY KEY,
        name VARCHAR(200),
        title VARCHAR(200),
        company VARCHAR(200),
        email VARCHAR(200),
        phone VARCHAR(50),
        location VARCHAR(200),
        linkedin VARCHAR(300),
        website VARCHAR(200),
        source VARCHAR(50),
        org_type VARCHAR(50),
        deal_type VARCHAR(20),
        notes TEXT,
        score INTEGER DEFAULT 80,
        added_at TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log('Database connected and ready');
  } catch (err) {
    console.log('Database unavailable - running without it:', err.message);
    pool = null;
  }
}

// ── CONTACT ENDPOINTS ─────────────────────────────────────────────────────────
app.get('/api/contacts', async (req, res) => {
  if (!pool) return res.json({ contacts: [], total: 0 });
  try {
    const limit = parseInt(req.query.limit) || 500;
    const search = req.query.search || '';
    let result;
    if (search) {
      result = await pool.query(
        `SELECT * FROM contacts WHERE name ILIKE $1 OR company ILIKE $1 OR title ILIKE $1 OR email ILIKE $1 ORDER BY added_at DESC LIMIT $2`,
        [`%${search}%`, limit]
      );
    } else {
      result = await pool.query(`SELECT * FROM contacts ORDER BY added_at DESC LIMIT $1`, [limit]);
    }
    const count = await pool.query(search ? 
      `SELECT COUNT(*) FROM contacts WHERE name ILIKE $1 OR company ILIKE $1 OR title ILIKE $1 OR email ILIKE $1` :
      `SELECT COUNT(*) FROM contacts`,
      search ? [`%${search}%`] : []
    );
    res.json({ contacts: result.rows, total: parseInt(count.rows[0].count) });
  } catch (err) {
    console.error('Get contacts error:', err.message);
    res.json({ contacts: [], total: 0 });
  }
});

app.post('/api/contacts', async (req, res) => {
  if (!pool) return res.json({ success: false, error: 'No database' });
  try {
    const c = req.body;
    await pool.query(
      `INSERT INTO contacts (name,title,company,email,phone,location,linkedin,website,source,org_type,deal_type,notes,score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [c.name||'',c.title||'',c.company||'',c.email||'',c.phone||'',
       c.location||'',c.linkedin||'',c.website||'',c.source||'Manual',
       c.org_type||'',c.deal_type||'provider',c.notes||'',c.score||80]
    );
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.post('/api/contacts/bulk', async (req, res) => {
  if (!pool) return res.json({ success: false, saved: 0, error: 'No database' });
  try {
    const { contacts } = req.body;
    if (!contacts?.length) return res.json({ success: true, saved: 0 });
    let saved = 0;
    for (const c of contacts) {
      try {
        await pool.query(
          `INSERT INTO contacts (name,title,company,email,phone,location,linkedin,website,source,org_type,deal_type,notes,score)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [c.name||c.n||'',c.title||c.t||'',c.company||c.c||'',c.email||c.e||'',
           c.phone||c.p||'',c.location||c.l||'',c.linkedin||c.li||'',c.website||'',
           c.source||c.s||'Imported',c.org_type||c.orgType||'',
           c.deal_type||c.dealType||'provider',c.notes||'',c.score||80]
        );
        saved++;
      } catch(e) { /* skip duplicates */ }
    }
    res.json({ success: true, saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/contacts/:id', async (req, res) => {
  if (!pool) return res.json({ success: false });
  try {
    await pool.query('DELETE FROM contacts WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ANTHROPIC API PROXY ────────────────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'No API key configured' });

    const useWebSearch = req.body.useWebSearch === true;
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
    if (useWebSearch) headers['anthropic-beta'] = 'web-search-2025-03-05';

    const body = { ...req.body };
    delete body.useWebSearch;
    delete body.useScanKey;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers, body: JSON.stringify(body)
    });
    const data = await response.json();
    console.log('Claude:', data.stop_reason, data.error ? JSON.stringify(data.error) : 'ok');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── APOLLO SEARCH ──────────────────────────────────────────────────────────────
app.post('/api/apollo-search', async (req, res) => {
  try {
    const apolloKey = process.env.APOLLO_API_KEY;
    if (!apolloKey) return res.status(500).json({ error: 'No Apollo API key configured' });

    const { title, industry, location, size } = req.body;
    const payload = {
      api_key: apolloKey,
      page: 1,
      per_page: 25,
      person_titles: [title],
      person_locations: location ? [location] : ['United States'],
      reveal_personal_emails: true,
      reveal_phone_number: true,
    };
    if (size) payload.organization_num_employees_ranges = [size];

    const response = await fetch('https://api.apollo.io/v1/mixed_people/api_search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apolloKey },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    console.log('Apollo:', data.people?.length || 0, 'contacts', data.error || 'ok');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── APOLLO ENRICH ─────────────────────────────────────────────────────────────
app.post('/api/apollo-enrich', async (req, res) => {
  try {
    const apolloKey = process.env.APOLLO_API_KEY;
    if (!apolloKey) return res.status(500).json({ error: 'No Apollo API key' });
    const { name, company, email, linkedin } = req.body;
    const payload = { api_key: apolloKey, reveal_personal_emails: true };
    if (email) payload.email = email;
    if (name) { const p = name.split(' '); payload.first_name = p[0]; payload.last_name = p.slice(1).join(' '); }
    if (company) payload.organization_name = company;
    if (linkedin) payload.linkedin_url = linkedin;
    const response = await fetch('https://api.apollo.io/api/v1/people/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apolloKey },
      body: JSON.stringify(payload)
    });
    res.json(await response.json());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── HEALTH CHECK ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    apollo: !!process.env.APOLLO_API_KEY,
    database: !!pool
  });
});

// ── PWA ────────────────────────────────────────────────────────────────────────
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'sw.js'));
});
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(__dirname, 'manifest.json'));
});

// ── STATIC + FALLBACK ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'clearsignalq.html')));

// ── START ──────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`ClearsignalQ running on port ${PORT}`);
  console.log(`Anthropic: ${!!process.env.ANTHROPIC_API_KEY} | Apollo: ${!!process.env.APOLLO_API_KEY} | DB URL: ${!!process.env.DATABASE_URL}`);
  await initDB();
});
