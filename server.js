// ═══════════════════════════════════════════════════════════════
//  LifeAI Backend — Node.js + Express + Groq API + Push Notifications
// ═══════════════════════════════════════════════════════════════

const express   = require('express');
const cors      = require('cors');
const webpush   = require('web-push');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || 'BOicrh8l9bmKZdvdc5JFCZ57Kk6K5T_l5zrbhQlWQk33atUkMRr9wrCbLUvN0kqSojgyckzcedcIrVpIObgp_bo';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'SlgdoZxoBkDPKAiaXBu_cmCS9AJY1yfFlP17Us_b_5I';

webpush.setVapidDetails(
  'mailto:admin@smartlifeai.co.uk',
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY
);

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ─────────────────────────────────────────
//  IN-MEMORY STORE
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
//  GROQ HELPERS
// ─────────────────────────────────────────
async function askGroq(systemPrompt, userMessage) {
  try {
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
    if (!response.ok) throw new Error(`Groq error: ${response.status}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (error) {
    console.error('askGroq error:', error);
    throw error;
  }
}

async function askGroqWithHistory(systemPrompt, history, newMessage) {
  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...history.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content })),
      { role: 'user', content: newMessage },
    ];
    const response = await fetch(GROQ_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({ model: GROQ_MODEL, max_tokens: 600, temperature: 0.7, messages }),
    });
    if (!response.ok) throw new Error(`Groq error: ${response.status}`);
    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } catch (error) {
    console.error('askGroqWithHistory error:', error);
    throw error;
  }
}

app.get('/health-check', (_req, res) => {
  res.json({
    status:    'ok',
    ai:        `Groq — ${GROQ_MODEL}`,
    timestamp: new Date().toISOString(),
    apiKey:    GROQ_API_KEY ? '✓ Set' : '✗ Missing',
    googleFit: GOOGLE_CLIENT_ID ? '✓ Configured' : '✗ Missing',
  });
});

app.post('/plan-day', async (req, res) => {
  try {
    const { tasks = [], appointments = [] } = req.body;
    const taskList = tasks.length
      ? tasks.map(t => `  • [${t.priority.toUpperCase()}] ${t.name}`).join('\n')
      : '  • No pending tasks';
    const aptList = appointments.length
      ? appointments.map(a => {
          const dt = new Date(a.datetime);
          const time = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
          return `  • ${a.title} at ${time}`;
        }).join('\n')
      : '  • No fixed appointments today';

    const system = `You are LifeAI, a warm and encouraging personal assistant.
Create realistic, time-blocked daily plans. Format each block as "HH:MM — Activity".
Be friendly and concise. End with a short motivational note. Max 250 words.`;

    const prompt = `Create an optimised daily schedule for me.
PENDING TASKS:\n${taskList}\nTODAY'S APPOINTMENTS:\n${aptList}
Today: ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
Start from 8:00 AM. Prioritise high-priority tasks in the morning. Include short breaks.`;

    const plan = await askGroq(system, prompt);
    res.json({ plan });
  } catch (err) {
    console.error('[/plan-day]', err.message);
    res.status(500).json({ error: 'Failed to generate plan', details: err.message });
  }
});

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

app.post('/finance-summary', async (req, res) => {
  try {
    const { expenses = [], subscriptions = [], profile = {} } = req.body;
    if (!expenses.length && !subscriptions.length) {
      return res.status(400).json({ error: 'No expense or subscription data' });
    }

    const total = expenses.reduce((s, e) => s + parseFloat(e.amount || e.amt || 0), 0);
    const byCategory = expenses.reduce((acc, e) => {
      const cat = e.category || e.cat || 'Other';
      acc[cat] = (acc[cat] || 0) + parseFloat(e.amount || e.amt || 0);
      return acc;
    }, {});

    const subBurn = subscriptions
      .filter(s => s.status !== 'cancelled')
      .reduce((sum, s) => sum + (s.cycle === 'yearly' ? s.amount / 12 : s.amount), 0);
    const unusedSave = subscriptions
      .filter(s => s.status === 'unused')
      .reduce((sum, s) => sum + (s.cycle === 'yearly' ? s.amount / 12 : s.amount), 0);

    const breakdown = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, amt]) => `  • ${cat}: £${amt.toFixed(2)}`)
      .join('\n');

    const subList = subscriptions.length
      ? subscriptions.map(s => `  • ${s.name}: £${s.amount}/${s.cycle} (${s.status})`).join('\n')
      : '  • None tracked';

    const income = profile.monthlyIncome || 0;
    const savingsRate = income ? Math.max(0, Math.round(((income - total - subBurn) / income) * 100)) : null;

    const system = `You are a friendly financial advisor for LifeAI users in the UK.
Analyse expenses AND subscriptions. Be encouraging, not judgmental. Use £ for currency. Max 220 words. Use emojis sparingly.
Highlight subscription waste if unused services exist. Suggest concrete next steps.`;

    const prompt = `Analyse my finances:
Monthly income: ${income ? '£' + income.toFixed(2) : 'not set'}
Expense total tracked: £${total.toFixed(2)}
${breakdown ? 'By category:\n' + breakdown : ''}

Subscription burn: £${subBurn.toFixed(2)}/mo (£${(subBurn * 12).toFixed(2)}/yr)
Potential savings from unused subs: £${unusedSave.toFixed(2)}/mo
Subscriptions:
${subList}
${savingsRate !== null ? 'Estimated savings rate: ' + savingsRate + '%' : ''}

Give: 1) brief assessment 2) subscription insight 3) two practical saving tips.`;

    const summary = await askGroq(system, prompt);
    res.json({ summary, total: total.toFixed(2), byCategory, subBurn: subBurn.toFixed(2), unusedSave: unusedSave.toFixed(2) });
  } catch (err) {
    console.error('[/finance-summary]', err.message);
    res.status(500).json({ error: 'Failed to generate summary', details: err.message });
  }
});

app.post('/chat', async (req, res) => {
  try {
    const { message, history = [], sessionId = 'default' } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const system = `You are LifeAI — the intelligent personal command centre at smartlifeai.co.uk.
You help users in the UK with: day planning, tasks, emails, finances (including subscriptions), health, and appointments.
Be warm, concise, and actionable. Use £ for money. Light emojis only when natural.
Never make up numbers — if data is in the user's message, use it. Keep responses under 180 words unless asked for more.`;

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

app.post('/appointments', async (req, res) => {
  try {
    const { title, datetime, location = '', notes = '' } = req.body;
    if (!title || !datetime) return res.status(400).json({ error: 'title and datetime required' });
    const appointment = { id: Date.now(), title, datetime, location, notes, createdAt: new Date().toISOString() };
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

// ═══════════════════════════════════════════════════════════════
//  POST /push/send — send a push notification
// ═══════════════════════════════════════════════════════════════
app.post('/push/send', async (req, res) => {
  try {
    const { subscription, title, body, url } = req.body;
    if (!subscription) return res.status(400).json({ error: 'subscription required' });

    const payload = JSON.stringify({ title, body, url: url || '/dashboard.html' });
    await webpush.sendNotification(JSON.parse(subscription), payload);
    res.json({ success: true });
  } catch (err) {
    console.error('[/push/send]', err.message);
    res.status(500).json({ error: 'Failed to send notification', details: err.message });
  }
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
  console.log(`   AI: Groq — ${GROQ_MODEL} (Free)`);
  console.log(`   Groq API key: ${GROQ_API_KEY ? '✓ Set' : '✗ NOT SET'}`);
  console.log(`   Google Fit: ${GOOGLE_CLIENT_ID ? '✓ Configured' : '✗ NOT SET'}`);
});
