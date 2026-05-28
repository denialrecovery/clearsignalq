const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Proxy Anthropic API calls securely
app.post('/api/claude', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ error: 'API call failed' });
  }
});

// Serve the app
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'clearsignalq.html'));
});

app.listen(PORT, () => {
  console.log(`ClearsignalQ running on port ${PORT}`);
});
