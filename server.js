const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

console.log('Server starting...');
console.log('API Key present:', !!process.env.ANTHROPIC_API_KEY);
console.log('Port:', PORT);

// Proxy Anthropic API calls securely
app.post('/api/claude', async (req, res) => {
  console.log('API call received for model:', req.body?.model);
  
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    
    if (!apiKey) {
      console.error('No API key found!');
      return res.status(500).json({ error: 'API key not configured in Railway Variables' });
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify(req.body)
    });

    console.log('Anthropic response status:', response.status);
    
    const data = await response.json();
    
    if (data.error) {
      console.error('Anthropic API error:', JSON.stringify(data.error));
    }
    
    res.json(data);
  } catch (error) {
    console.error('Server error:', error.message);
    res.status(500).json({ error: error.message || 'API call failed' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    apiKeyPresent: !!process.env.ANTHROPIC_API_KEY,
    timestamp: new Date().toISOString()
  });
});

// Serve the main app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'clearsignalq.html'));
});

app.listen(PORT, () => {
  console.log(`ClearsignalQ running on port ${PORT}`);
  console.log(`API Key configured: ${!!process.env.ANTHROPIC_API_KEY}`);
});
