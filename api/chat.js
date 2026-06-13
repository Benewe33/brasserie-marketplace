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
            role: 'assistant', content: null,
            tool_calls: [{ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } }]
          });
        }
        for (const block of toolResultBlocks) {
          groqMessages.push({
            role: 'tool', tool_call_id: block.tool_use_id,
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
          });
        }
      }
    }

    const filteredMessages = groqMessages.filter(m => m.content !== '' && (m.content !== null || m.tool_calls));
    const systemMsg = filteredMessages.find(m => m.role === 'system');
    const convoMsgs = filteredMessages.filter(m => m.role !== 'system').slice(-4);
    const trimmedMessages = systemMsg ? [systemMsg, ...convoMsgs] : convoMsgs;

    const groqTools = (tools || []).map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema }
    }));

    // Détecter si c'est le premier tour (pas encore de résultat d'outil)
    const hasToolResult = filteredMessages.some(m => m.role === 'tool');
    const isFirstTurn = !hasToolResult && groqTools.length > 0;

    const body = {
      model: 'llama-3.3-70b-versatile', // 70B respecte bien tool_choice:required
      max_tokens: Math.min(max_tokens || 350, 350),
      messages: trimmedMessages,
      temperature: 0.1
    };

    if (groqTools.length > 0) {
      body.tools = groqTools;
      body.tool_choice = isFirstTurn ? 'required' : 'auto';
    }

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    // Si rate limit → fallback sur llama-3.1-8b-instant
    if (data.error?.code === 'rate_limit_exceeded') {
      body.model = 'llama-3.1-8b-instant';
      body.tool_choice = 'auto'; // 8b gère mal required
      const res2 = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
        body: JSON.stringify(body)
      });
      const data2 = await res2.json();
      if (data2.error) return res.status(500).json({ error: data2.error.message });
      return res.status(200).json(formatResponse(data2));
    }

    if (data.error) return res.status(500).json({ error: data.error.message || JSON.stringify(data.error) });
    return res.status(200).json(formatResponse(data));

  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ error: error.message });
  }
}

function formatResponse(data) {
  const msg = data.choices?.[0]?.message;
  const content = [];
  if (msg?.content) content.push({ type: 'text', text: msg.content });
  if (msg?.tool_calls?.length > 0) {
    for (const tc of msg.tool_calls) {
      content.push({
        type: 'tool_use', id: tc.id, name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}')
      });
    }
  }
  return { content, stop_reason: msg?.tool_calls?.length > 0 ? 'tool_use' : 'end_turn' };
}
