const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '1mb' }));

// Simple API proxy - Anthropic handles web search internally
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

    // Log what we're sending for debugging
    console.log('API call - model:', body.model, 'webSearch:', useWebSearch, 'tools:', body.tools ? body.tools.map(t=>t.type).join(',') : 'none');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    const data = await response.json();
    
    // Log response for debugging
    console.log('API response - stop_reason:', data.stop_reason, 'content_types:', (data.content||[]).map(b=>b.type).join(','), 'error:', data.error ? JSON.stringify(data.error) : 'none');

    res.json(data);
  } catch (error) {
    console.error('API error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', apiKeyPresent: !!process.env.ANTHROPIC_API_KEY });
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'clearsignalq.html'));
});

app.listen(PORT, () => {
  console.log(`ClearsignalQ running on port ${PORT}`);
  console.log(`API key present: ${!!process.env.ANTHROPIC_API_KEY}`);
});
