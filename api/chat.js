// api/chat.js — Proxy Groq avec Tool Calling
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

    const groqMessages = [];
    if (system) groqMessages.push({ role: 'system', content: system });

    for (const m of (messages || [])) {
      if (typeof m.content === 'string') {
        groqMessages.push({ role: m.role, content: m.content });
        continue;
      }
      if (Array.isArray(m.content)) {
        const textBlocks = m.content.filter(b => b.type === 'text');
        const toolUseBlocks = m.content.filter(b => b.type === 'tool_use');
        const toolResultBlocks = m.content.filter(b => b.type === 'tool_result');

        if (textBlocks.length > 0 && toolUseBlocks.length === 0 && toolResultBlocks.length === 0) {
          groqMessages.push({ role: m.role, content: textBlocks.map(b => b.text).join('\n') });
        }

        for (const block of toolUseBlocks) {
          groqMessages.push({
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: JSON.stringify(block.input) }
            }]
          });
        }

        for (const block of toolResultBlocks) {
          groqMessages.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
          });
        }
      }
    }

    const filteredMessages = groqMessages.filter(m =>
      m.content !== '' && (m.content !== null || m.tool_calls)
    );

    const groqTools = (tools || []).map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema
      }
    }));

    // Limiter l'historique pour réduire les tokens
    const recentMessages = filteredMessages.slice(0, 1).concat(filteredMessages.slice(-6));

    const body = {
      model: 'gemma2-9b-it',   // 15 000 TPM — limite la plus haute sur free tier
      max_tokens: Math.min(max_tokens || 400, 400),  // réduit pour économiser les tokens
      messages: recentMessages,
      temperature: 0.2
    };

    if (groqTools.length > 0) {
      body.tools = groqTools;
      const hasToolResult = filteredMessages.some(m => m.role === 'tool');
      body.tool_choice = hasToolResult ? 'auto' : 'required';
    }

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + API_KEY
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message || JSON.stringify(data.error) });

    const choice = data.choices?.[0];
    const msg = choice?.message;

    const content = [];
    if (msg?.content) content.push({ type: 'text', text: msg.content });
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
