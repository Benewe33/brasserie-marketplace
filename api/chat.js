// api/chat.js — Proxy Groq avec Tool Calling + interception fallback
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

    // Convertir messages format Anthropic → Groq
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

    const hasToolResult = filteredMessages.some(m => m.role === 'tool');
    const isFirstTurn = !hasToolResult && groqTools.length > 0;

    // Récupérer le dernier message utilisateur pour l'interception
    const lastUserMsg = [...filteredMessages].reverse().find(m => m.role === 'user')?.content || '';

    const callGroq = async (model, tool_choice) => {
      const body = {
        model,
        max_tokens: Math.min(max_tokens || 350, 350),
        messages: trimmedMessages,
        temperature: 0.1
      };
      if (groqTools.length > 0) {
        body.tools = groqTools;
        body.tool_choice = tool_choice;
      }
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
        body: JSON.stringify(body)
      });
      return r.json();
    };

    let data = await callGroq('llama-3.3-70b-versatile', isFirstTurn ? 'required' : 'auto');

    // Fallback si rate limit
    if (data.error?.type === 'tokens' || data.error?.code === 'rate_limit_exceeded' || (data.error && data.error.message?.includes('rate'))) {
      data = await callGroq('llama-3.1-8b-instant', 'auto');
    }

    if (data.error) return res.status(500).json({ error: data.error.message || JSON.stringify(data.error) });

    const msg = data.choices?.[0]?.message;
    const content = [];

    if (msg?.tool_calls?.length > 0) {
      // Réponse normale avec outil
      if (msg?.content) content.push({ type: 'text', text: msg.content });
      for (const tc of msg.tool_calls) {
        content.push({
          type: 'tool_use', id: tc.id, name: tc.function.name,
          input: JSON.parse(tc.function.arguments || '{}')
        });
      }
    } else if (isFirstTurn && msg?.content) {
      // Le modèle a répondu en texte malgré tool_choice:required → on force l'outil
      const forced = forceToolFromText(lastUserMsg, msg.content, groqTools);
      if (forced) {
        content.push(forced);
      } else {
        content.push({ type: 'text', text: msg.content });
      }
    } else {
      if (msg?.content) content.push({ type: 'text', text: msg.content });
    }

    const stop_reason = content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn';
    return res.status(200).json({ content, stop_reason });

  } catch (error) {
    console.error('Proxy error:', error);
    return res.status(500).json({ error: error.message });
  }
}

// Forcer l'appel d'outil quand le modèle répond en texte
function forceToolFromText(userMsg, aiText, tools) {
  const low = userMsg.toLowerCase();
  const budgetMatch = userMsg.match(/(\d[\d\s]*)/);
  const budget = budgetMatch ? parseInt(budgetMatch[1].replace(/\s/g, '')) : 0;

  // Budget → create_bundle
  if (budget >= 500) {
    return { type: 'tool_use', id: 'forced_' + Date.now(), name: 'create_bundle', input: { budget } };
  }
  // Panier
  if (/panier|cart|commande/.test(low)) {
    return { type: 'tool_use', id: 'forced_' + Date.now(), name: 'show_cart', input: {} };
  }
  // Recherche produit
  const prodKeywords = ['poisson','viande','légume','legume','gombo','gboman','gari','riz','huile',
    'tomate','oignon','oeuf','haricot','piment','banane','mangue','promo','fruit','épice'];
  for (const kw of prodKeywords) {
    if (low.includes(kw)) {
      return { type: 'tool_use', id: 'forced_' + Date.now(), name: 'search_products', input: { query: kw } };
    }
  }
  // Recherche générique
  const words = low.split(/\s+/).filter(w => w.length > 3);
  if (words.length > 0) {
    return { type: 'tool_use', id: 'forced_' + Date.now(), name: 'search_products', input: { query: words[0] } };
  }
  return null;
}
