const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '1mb' }));

// Health check FIRST - Railway needs this to confirm app is alive
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', apiKeyPresent: !!process.env.ANTHROPIC_API_KEY });
});

// Root health check for Railway
app.get('/', (req, res, next) => {
  if (req.headers['user-agent'] && req.headers['user-agent'].includes('Railway')) {
    return res.status(200).send('OK');
  }
  next();
});

// API proxy
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

    console.log('API call:', body.model, 'webSearch:', useWebSearch);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    const data = await response.json();
    console.log('Response:', data.stop_reason, (data.content||[]).map(b=>b.type).join(','), data.error ? JSON.stringify(data.error) : '');
    res.json(data);
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// PWA files
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Service-Worker-Allowed', '/');
  res.sendFile(path.join(__dirname, 'sw.js'));
});

app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(__dirname, 'manifest.json'));
});

// Static files
app.use(express.static(path.join(__dirname)));

// Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'clearsignalq.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ClearsignalQ running on port ${PORT}`);
  console.log(`API key present: ${!!process.env.ANTHROPIC_API_KEY}`);
});
