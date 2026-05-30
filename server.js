const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '1mb' }));

// Call Anthropic API with multi-turn tool use support
async function callAnthropic(body, apiKey, useWebSearch) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  if (useWebSearch) headers['anthropic-beta'] = 'web-search-2025-03-05';

  let messages = [...body.messages];
  let finalResponse = null;
  let maxTurns = 5; // prevent infinite loops

  while (maxTurns-- > 0) {
    const requestBody = { ...body, messages };
    delete requestBody.useWebSearch;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    // If error, return immediately
    if (data.type === 'error' || data.error) {
      return data;
    }

    finalResponse = data;

    // If done, return
    if (data.stop_reason === 'end_turn' || data.stop_reason === 'max_tokens') {
      return data;
    }

    // If tool_use, we need to process tools and continue
    if (data.stop_reason === 'tool_use') {
      // Add assistant message with tool use
      messages.push({ role: 'assistant', content: data.content });

      // Build tool results
      const toolResults = [];
      for (const block of data.content) {
        if (block.type === 'tool_use') {
          // For web_search, the API handles it internally
          // We just need to acknowledge with an empty result
          // The actual search happens server-side in Anthropic's infrastructure
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: 'Search completed. Please provide the analysis based on search results.'
          });
        }
      }

      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
      } else {
        return finalResponse;
      }
    } else {
      return data;
    }
  }

  return finalResponse;
}

// API proxy with multi-turn support
app.post('/api/claude', async (req, res) => {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'No API key configured' });

    const useWebSearch = req.body.useWebSearch === true;
    const data = await callAnthropic(req.body, apiKey, useWebSearch);
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
