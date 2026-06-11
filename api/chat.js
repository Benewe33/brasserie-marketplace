// api/chat.js — Proxy OpenRouter avec Tool Calling (modèle gratuit)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { messages, system, tools, max_tokens } = req.body;

    // Construire les messages OpenRouter
    const openRouterMessages = [];
    if (system) openRouterMessages.push({ role: 'system', content: system });

    for (const m of (messages || [])) {
      // Messages simples (texte)
      if (typeof m.content === 'string') {
        openRouterMessages.push({ role: m.role, content: m.content });
        continue;
      }
      // Messages avec blocs (tool_use / tool_result)
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          if (block.type === 'text') {
            openRouterMessages.push({ role: m.role, content: block.text });
          } else if (block.type === 'tool_use') {
            // Appel d'outil côté assistant → function call OpenRouter
            openRouterMessages.push({
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: block.id,
                type: 'function',
                function: { name: block.name, arguments: JSON.stringify(block.input) }
              }]
            });
          } else if (block.type === 'tool_result') {
            // Résultat d'outil → tool message OpenRouter
            openRouterMessages.push({
              role: 'tool',
              tool_call_id: block.tool_use_id,
              content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
            });
          }
        }
      }
    }

    // Convertir tools Anthropic → OpenRouter (OpenAI format)
    const openRouterTools = (tools || []).map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema
      }
    }));

    const body = {
      model: 'mistralai/mistral-small-3.1-24b-instruct:free',
      max_tokens: max_tokens || 1000,
      messages: openRouterMessages
    };
    if (openRouterTools.length > 0) {
      body.tools = openRouterTools;
      body.tool_choice = 'auto';
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_KEY,
        'HTTP-Referer': 'https://brasserie-marketplace.vercel.app',
        'X-Title': 'Yeye Market Assistant'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message || JSON.stringify(data.error) });

    const choice = data.choices?.[0];
    const msg = choice?.message;

    // Convertir réponse OpenRouter → format Anthropic
    const content = [];

    if (msg?.content) {
      content.push({ type: 'text', text: msg.content });
    }

    if (msg?.tool_calls?.length > 0) {
      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}')
        });
      }
    }

    const stopReason = msg?.tool_calls?.length > 0 ? 'tool_use' : 'end_turn';

    return res.status(200).json({ content, stop_reason: stopReason });

  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ error: error.message });
  }
}
