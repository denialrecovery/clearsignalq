const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '10mb' }));

// API route MUST come before static files
app.post('/api/claude', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'No API key configured' });
    }

    const useWebSearch = req.body.useWebSearch === true;
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
    if (useWebSearch) {
      headers['anthropic-beta'] = 'web-search-2025-03-05';
    }

    const body = { ...req.body };
    delete body.useWebSearch;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    const data = await response.json();
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

// Static files AFTER API routes
app.use(express.static(path.join(__dirname)));

// Catch-all serves the app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'clearsignalq.html'));
});

app.listen(PORT, () => {
  console.log(`ClearsignalQ running on port ${PORT}`);
  console.log(`API key present: ${!!process.env.ANTHROPIC_API_KEY}`);
});
