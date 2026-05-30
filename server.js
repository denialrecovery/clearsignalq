const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '1mb' }));

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

    console.log('Claude API:', body.model, 'webSearch:', useWebSearch);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    const data = await response.json();
    console.log('Claude response:', data.stop_reason, (data.content||[]).map(b=>b.type).join(','), data.error ? JSON.stringify(data.error) : '');
    res.json(data);
  } catch (error) {
    console.error('Claude error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── APOLLO SEARCH PROXY ────────────────────────────────────────────────────────
app.post('/api/apollo-search', async (req, res) => {
  try {
    const apolloKey = process.env.APOLLO_API_KEY;
    if (!apolloKey) return res.status(500).json({ error: 'No Apollo API key configured' });

    const { title, industry, location, size } = req.body;

    const payload = {
      api_key: apolloKey,
      q_keywords: title,
      page: 1,
      per_page: 25,
      person_titles: [title],
      organization_industry_tag_ids: [],
    };

    // Add industry filter
    if (industry) payload.q_organization_industry_tag_ids = [industry];

    // Add location
    if (location) {
      payload.person_locations = [location];
    } else {
      payload.person_locations = ['United States'];
    }

    // Add company size
    if (size) {
      const [min, max] = size.split(',');
      payload.organization_num_employees_ranges = [size];
    }

    console.log('Apollo search:', JSON.stringify({title, industry, location, size}));

    const response = await fetch('https://api.apollo.io/api/v1/mixed_people/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': apolloKey,
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    console.log('Apollo response: people count:', data.people?.length || 0, 'error:', data.error||'none');
    res.json(data);
  } catch (error) {
    console.error('Apollo error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ── APOLLO ENRICH PROXY ───────────────────────────────────────────────────────
app.post('/api/apollo-enrich', async (req, res) => {
  try {
    const apolloKey = process.env.APOLLO_API_KEY;
    if (!apolloKey) return res.status(500).json({ error: 'No Apollo API key' });

    const { name, company, email, linkedin } = req.body;

    const payload = { api_key: apolloKey };
    if (email) payload.email = email;
    if (name) {
      const parts = name.split(' ');
      payload.first_name = parts[0];
      payload.last_name = parts.slice(1).join(' ');
    }
    if (company) payload.organization_name = company;
    if (linkedin) payload.linkedin_url = linkedin;

    const response = await fetch('https://api.apollo.io/api/v1/people/match', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apolloKey,
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── HEALTH CHECK ───────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    apollo: !!process.env.APOLLO_API_KEY
  });
});

// ── PWA FILES ──────────────────────────────────────────────────────────────────
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'sw.js'));
});

app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(__dirname, 'manifest.json'));
});

// ── STATIC FILES ───────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'clearsignalq.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`ClearsignalQ running on port ${PORT}`);
  console.log(`Anthropic key: ${!!process.env.ANTHROPIC_API_KEY}`);
  console.log(`Apollo key: ${!!process.env.APOLLO_API_KEY}`);
});

