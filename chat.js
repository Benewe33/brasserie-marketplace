// api/chat.js — Proxy Claude API réel (remplace l'ancien proxy Groq)
// Le frontend parle déjà nativement le format Anthropic (tool_use / tool_result),
// donc ce proxy se contente de relayer la requête vers l'API Claude, sans traduction.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const API_KEY = process.env.ANTHROPIC_API_KEY
  if (!API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY non configurée' })

  try {
    const { messages, system, tools, max_tokens } = req.body

    const body = {
      model: 'claude-sonnet-4-6',
      max_tokens: max_tokens || 1024,
      messages: messages || [],
    }
    if (system) body.system = system
    if (tools && tools.length > 0) body.tools = tools

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })

    const data = await response.json()

    if (!response.ok) {
      console.error('Erreur Claude API:', data)
      return res.status(response.status).json({ error: data.error?.message || 'Erreur Claude API' })
    }

    // Le frontend attend { content, stop_reason } — c'est exactement ce que Claude renvoie déjà.
    return res.status(200).json({ content: data.content, stop_reason: data.stop_reason })
  } catch (error) {
    console.error('Proxy error:', error)
    return res.status(500).json({ error: error.message })
  }
}
