// ═══════════════════════════════════════════════════════════════
//  LifeAI Backend — Node.js + Express + Groq API (Free)
//  Deploy to Render (free tier) at render.com
//  ─────────────────────────────────────────────────────────────
//  ENDPOINTS:
//    POST /plan-day        → AI-generated daily schedule
//    POST /draft-email     → AI email draft
//    POST /finance-summary → AI expense analysis
//    POST /chat            → General AI conversation
//    POST /appointments    → Store appointments
//    GET  /health-check    → Server status ping
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────
//  GROQ API CONFIG
//  Set GROQ_API_KEY in your Render env vars
//  Get your free key at: console.groq.com
// ─────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL     = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL   = 'llama3-70b-8192'; // fast, free, very capable

// ─────────────────────────────────────────
//  IN-MEMORY DATABASE
// ─────────────────────────────────────────
const db = {
  appointments: [],
  expenses:     [],
  tasks:        [],
  chatSessions: {},
};

// ─────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '2mb' }));

app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────
//  HELPER — call Groq API
//  Groq uses the OpenAI-compatible format
// ─────────────────────────────────────────
async function askGroq(systemPrompt, userMessage) {
  const response = await fetch(GROQ_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model:       GROQ_MODEL,
      max_tokens:  800,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage  },
      ],
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error: ${response.status} — ${err}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

// ─────────────────────────────────────────
//  HELPER — call Groq with chat history
// ─────────────────────────────────────────
async function askGroqWithHistory(systemPrompt, history, newMessage) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.map(h => ({
      role:    h.role === 'assistant' ? 'assistant' : 'user',
      content: h.content,
    })),
    { role: 'user', content: newMessage },
  ];

  const response = await fetch(GROQ_URL, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model:       GROQ_MODEL,
      max_tokens:  600,
      temperature: 0.7,
      messages,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error: ${response.status} — ${err}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content || '';
}

// ═══════════════════════════════════════════════════════════════
//  GET /health-check
// ═══════════════════════════════════════════════════════════════
app.get('/health-check', (_req, res) => {
  res.json({
    status:    'ok',
    ai:        'Groq — Llama 3 70B',
    timestamp: new Date().toISOString(),
    apiKey:    GROQ_API_KEY ? '✓ Set' : '✗ Missing',
  });
});

// ═══════════════════════════════════════════════════════════════
//  POST /plan-day
// ═══════════════════════════════════════════════════════════════
app.post('/plan-day', async (req, res) => {
  try {
    const { tasks = [], appointments = [] } = req.body;

    const taskList = tasks.length
      ? tasks.map(t => `  • [${t.priority.toUpperCase()}] ${t.name}`).join('\n')
      : '  • No pending tasks';

    const aptList = appointments.length
      ? appointments.map(a => {
          const dt   = new Date(a.datetime);
          const time = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
          return `  • ${a.title} at ${time}`;
        }).join('\n')
      : '  • No fixed appointments today';

    const system = `You are LifeAI, a warm and encouraging personal assistant.
Create realistic, time-blocked daily plans. Format each block as "HH:MM — Activity".
Be friendly and concise. End with a short motivational note. Max 250 words.`;

    const prompt = `Create an optimised daily schedule for me.

PENDING TASKS:
${taskList}

TODAY'S APPOINTMENTS:
${aptList}

Today: ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}

Start from 8:00 AM. Prioritise high-priority tasks in the morning. Include short breaks.`;

    const plan = await askGroq(system, prompt);
    res.json({ plan });

  } catch (err) {
    console.error('[/plan-day]', err.message);
    res.status(500).json({ error: 'Failed to generate plan', details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  POST /draft-email
// ═══════════════════════════════════════════════════════════════
app.post('/draft-email', async (req, res) => {
  try {
    const { to = '', subject = '', points, tone = 'professional' } = req.body;

    if (!points) return res.status(400).json({ error: 'Key points are required' });

    const system = `You are an expert email writer. Write ${tone}, clear, concise emails.
Include a proper greeting, structured body, and polite sign-off.
Output ONLY the email text. Start with "Subject: ..." on the first line.`;

    const prompt = `Write an email:
To: ${to || 'the recipient'}
Subject: ${subject || 'suggest an appropriate subject'}
Key points: ${points}
Tone: ${tone}`;

    const draft = await askGroq(system, prompt);
    res.json({ draft });

  } catch (err) {
    console.error('[/draft-email]', err.message);
    res.status(500).json({ error: 'Failed to draft email', details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  POST /finance-summary
// ═══════════════════════════════════════════════════════════════
app.post('/finance-summary', async (req, res) => {
  try {
    const { expenses = [] } = req.body;
    if (!expenses.length) return res.status(400).json({ error: 'No expense data' });

    const total      = expenses.reduce((s, e) => s + parseFloat(e.amount || e.amt || 0), 0);
    const byCategory = expenses.reduce((acc, e) => {
      const cat = e.category || e.cat || 'Other';
      acc[cat]  = (acc[cat] || 0) + parseFloat(e.amount || e.amt || 0);
      return acc;
    }, {});

    const breakdown = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, amt]) => `  • ${cat}: £${amt.toFixed(2)}`)
      .join('\n');

    const system = `You are a friendly financial advisor. Analyse expenses and give actionable insights.
Be encouraging, not judgmental. Use £ for currency. Max 200 words. Use emojis sparingly.`;

    const prompt = `Analyse my spending:

Total: £${total.toFixed(2)}

By category:
${breakdown}

Give: 1) brief assessment 2) biggest spending area insight 3) two practical saving tips.`;

    const summary = await askGroq(system, prompt);
    res.json({ summary, total: total.toFixed(2), byCategory });

  } catch (err) {
    console.error('[/finance-summary]', err.message);
    res.status(500).json({ error: 'Failed to generate summary', details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  POST /chat
// ═══════════════════════════════════════════════════════════════
app.post('/chat', async (req, res) => {
  try {
    const { message, history = [], sessionId = 'default' } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const system = `You are LifeAI — a warm, knowledgeable personal life assistant.
You help with: day planning, tasks, emails, finances, health, and appointments.
Be friendly, concise, and proactive. Use light emojis occasionally.
Keep responses under 180 words unless more detail is asked for.`;

    const reply = await askGroqWithHistory(system, history, message);

    if (!db.chatSessions[sessionId]) db.chatSessions[sessionId] = [];
    db.chatSessions[sessionId].push(
      { role: 'user',      content: message },
      { role: 'assistant', content: reply   }
    );
    if (db.chatSessions[sessionId].length > 40) {
      db.chatSessions[sessionId] = db.chatSessions[sessionId].slice(-40);
    }

    res.json({ reply });

  } catch (err) {
    console.error('[/chat]', err.message);
    res.status(500).json({ error: 'Chat failed', details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  POST /appointments
// ═══════════════════════════════════════════════════════════════
app.post('/appointments', async (req, res) => {
  try {
    const { title, datetime, location = '', notes = '' } = req.body;
    if (!title || !datetime) return res.status(400).json({ error: 'title and datetime required' });

    const appointment = {
      id: Date.now(), title, datetime, location, notes,
      createdAt: new Date().toISOString(),
    };
    db.appointments.push(appointment);
    res.json({ success: true, appointment });

  } catch (err) {
    console.error('[/appointments]', err.message);
    res.status(500).json({ error: 'Failed to save appointment', details: err.message });
  }
});

app.get('/appointments', (_req, res) => {
  res.json({ appointments: db.appointments });
});

// ─────────────────────────────────────────
//  404 + Error handlers
// ─────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  console.error('[Error]', err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ─────────────────────────────────────────
//  START
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🟢 LifeAI Backend running on port ${PORT}`);
  console.log(`   AI: Groq — Llama 3 70B (Free)`);
  console.log(`   Groq API key: ${GROQ_API_KEY ? '✓ Set' : '✗ NOT SET — add GROQ_API_KEY env var!'}`);
});
