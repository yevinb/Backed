// ═══════════════════════════════════════════════════════════════
//  LifeAI Backend — Node.js + Express + Claude API
//  Deploy to Render (free tier) at render.com
//  ─────────────────────────────────────────────────────────────
//  ENDPOINTS:
//    POST /plan-day        → AI-generated daily schedule
//    POST /draft-email     → AI email draft
//    POST /finance-summary → AI expense analysis
//    POST /chat            → General AI conversation
//    POST /appointments    → Store appointments (+ Google Cal stub)
//    GET  /health-check    → Server status ping
// ═══════════════════════════════════════════════════════════════

const express  = require('express');
const cors     = require('cors');
const Anthropic = require('@anthropic-ai/sdk').default;

const app  = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────
//  ANTHROPIC CLIENT
//  Set ANTHROPIC_API_KEY in your Render env vars
// ─────────────────────────────────────────
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY, // never hard-code this
});

// ─────────────────────────────────────────
//  IN-MEMORY DATABASE (for demo/testing)
//  In production: swap for PostgreSQL / MongoDB
// ─────────────────────────────────────────
const db = {
  appointments: [],
  expenses:     [],
  tasks:        [],
  chatSessions: {},  // sessionId → message array
};

// ─────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json({ limit: '2mb' }));  // parse JSON bodies

// Simple request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─────────────────────────────────────────
//  HELPER — call Claude API
//  Wraps the Anthropic SDK in a clean function
// ─────────────────────────────────────────
async function askClaude({ systemPrompt, userMessage, maxTokens = 800 }) {
  const message = await anthropic.messages.create({
    model:      'claude-sonnet-4-20250514',   // fast + capable model
    max_tokens: maxTokens,
    system:     systemPrompt,
    messages: [
      { role: 'user', content: userMessage }
    ],
  });

  // The response content is an array; extract the first text block
  const textBlock = message.content.find(b => b.type === 'text');
  return textBlock ? textBlock.text : '';
}

// ─────────────────────────────────────────
//  HELPER — call Claude with conversation history
// ─────────────────────────────────────────
async function askClaudeWithHistory({ systemPrompt, messages, maxTokens = 600 }) {
  const response = await anthropic.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    system:     systemPrompt,
    messages,    // array of { role, content } objects
  });
  const textBlock = response.content.find(b => b.type === 'text');
  return textBlock ? textBlock.text : '';
}

// ═══════════════════════════════════════════════════════════════
//  ROUTE: GET /health-check
//  Simple ping to verify the server is alive
// ═══════════════════════════════════════════════════════════════
app.get('/health-check', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ═══════════════════════════════════════════════════════════════
//  ROUTE: POST /plan-day
//  Takes tasks + appointments, returns an AI-generated daily plan
//
//  Request body:
//    { tasks: [{ name, priority }], appointments: [{ title, datetime }] }
//
//  Response:
//    { plan: "..." }
// ═══════════════════════════════════════════════════════════════
app.post('/plan-day', async (req, res) => {
  try {
    const { tasks = [], appointments = [] } = req.body;

    // Build a structured prompt from the user's data
    const taskList = tasks.length
      ? tasks.map(t => `  • [${t.priority.toUpperCase()}] ${t.name}`).join('\n')
      : '  • No pending tasks';

    const aptList = appointments.length
      ? appointments.map(a => {
          const dt = new Date(a.datetime);
          const time = dt.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
          const date = dt.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
          return `  • ${a.title} at ${time} (${date})`;
        }).join('\n')
      : '  • No fixed appointments today';

    const systemPrompt = `You are LifeAI, a warm, organised, and encouraging personal assistant. 
You help users plan their day in a realistic, time-blocked way. 
Keep plans friendly, practical, and concise. Use short paragraphs and bullet time-blocks.
Format: "HH:MM — Activity" style, with a brief motivational note at the end.
Keep response under 250 words.`;

    const userMessage = `Please create an optimised daily schedule for me. Here's my data:

PENDING TASKS:
${taskList}

TODAY'S FIXED APPOINTMENTS:
${aptList}

Today's date: ${new Date().toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long' })}

Create a realistic, time-blocked schedule starting from 8:00 AM. 
Prioritise high-priority tasks in peak morning hours. 
Include short breaks and don't overload the day.`;

    const plan = await askClaude({ systemPrompt, userMessage, maxTokens: 500 });

    // Save to in-memory db (optional)
    db.tasks = tasks;

    res.json({ plan });

  } catch (err) {
    console.error('[/plan-day] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate plan', details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ROUTE: POST /draft-email
//  Takes email intent/key-points, returns a polished AI draft
//
//  Request body:
//    { to, subject, points, tone? }
//
//  Response:
//    { draft: "..." }
// ═══════════════════════════════════════════════════════════════
app.post('/draft-email', async (req, res) => {
  try {
    const { to = '', subject = '', points, tone = 'professional' } = req.body;

    if (!points) {
      return res.status(400).json({ error: 'Please provide key points for the email' });
    }

    const systemPrompt = `You are an expert email writer. You write ${tone}, clear, and concise emails.
Always include: a proper greeting, well-structured body, and a polite sign-off.
Keep emails under 200 words unless the content requires more.
Do NOT include placeholders like [Your Name] — use "[Your Name]" only at the very end.
Output ONLY the email text — no explanations or meta-commentary.`;

    const userMessage = `Draft an email with these details:
To: ${to || 'the recipient'}
Subject: ${subject || '(please suggest an appropriate subject)'}
Key points to include: ${points}
Tone: ${tone}

Write the complete email, starting with "Subject: ..." on the first line.`;

    const draft = await askClaude({ systemPrompt, userMessage, maxTokens: 600 });

    res.json({ draft });

  } catch (err) {
    console.error('[/draft-email] Error:', err.message);
    res.status(500).json({ error: 'Failed to draft email', details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ROUTE: POST /finance-summary
//  Takes an array of expense objects, returns AI analysis
//
//  Request body:
//    { expenses: [{ desc, amount, category, date? }] }
//
//  Response:
//    { summary: "..." }
// ═══════════════════════════════════════════════════════════════
app.post('/finance-summary', async (req, res) => {
  try {
    const { expenses = [] } = req.body;

    if (!expenses.length) {
      return res.status(400).json({ error: 'No expense data provided' });
    }

    // Aggregate data before sending to Claude (saves tokens)
    const total = expenses.reduce((s, e) => s + parseFloat(e.amount || 0), 0);
    const byCategory = expenses.reduce((acc, e) => {
      acc[e.category] = (acc[e.category] || 0) + parseFloat(e.amount || 0);
      return acc;
    }, {});
    const categoryBreakdown = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, amt]) => `  • ${cat}: £${amt.toFixed(2)}`)
      .join('\n');

    const recentItems = expenses
      .slice(-5)
      .map(e => `  • ${e.desc} — £${parseFloat(e.amount).toFixed(2)} (${e.category})`)
      .join('\n');

    const systemPrompt = `You are LifeAI's financial advisor module. 
You analyse personal expense data and provide friendly, actionable insights.
Be encouraging, not judgmental. Give 2-3 specific, practical tips.
Use £ for currency. Keep response under 200 words.
Use emojis sparingly but effectively.`;

    const userMessage = `Analyse my expenses and give me a helpful summary:

Total logged: £${total.toFixed(2)}

Breakdown by category:
${categoryBreakdown}

Recent transactions:
${recentItems}

Please provide:
1. A brief overall assessment
2. The biggest spending area and whether it seems reasonable
3. 2 specific money-saving tips based on this data`;

    const summary = await askClaude({ systemPrompt, userMessage, maxTokens: 400 });

    // Persist to in-memory db
    db.expenses = expenses;

    res.json({ summary, total: total.toFixed(2), byCategory });

  } catch (err) {
    console.error('[/finance-summary] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate summary', details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ROUTE: POST /chat
//  General AI conversation with memory of recent history
//
//  Request body:
//    { message: string, history?: [{ role, content }], sessionId?: string }
//
//  Response:
//    { reply: "..." }
// ═══════════════════════════════════════════════════════════════
app.post('/chat', async (req, res) => {
  try {
    const { message, history = [], sessionId = 'default' } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const systemPrompt = `You are LifeAI — a warm, knowledgeable, and proactive personal life assistant.
You help with: day planning, task management, email drafting, financial advice, health reminders, and calendar management.
Personality traits:
  - Friendly and encouraging, never robotic
  - Concise but thorough — don't over-explain
  - Proactive: offer follow-up suggestions when helpful
  - Use light emojis occasionally to keep the tone warm
  - If asked to do something you'd normally route to an endpoint (plan day, draft email, etc.), do it inline in chat
Keep responses under 180 words unless the user asks for something detailed.`;

    // Build the messages array including history for context
    const messages = [
      ...history.map(h => ({ role: h.role, content: h.content })),
      { role: 'user', content: message }
    ];

    const reply = await askClaudeWithHistory({ systemPrompt, messages, maxTokens: 500 });

    // Persist session history server-side (optional, helps with longer sessions)
    if (!db.chatSessions[sessionId]) db.chatSessions[sessionId] = [];
    db.chatSessions[sessionId].push(
      { role: 'user', content: message },
      { role: 'assistant', content: reply }
    );
    // Keep only last 20 exchanges per session
    if (db.chatSessions[sessionId].length > 40) {
      db.chatSessions[sessionId] = db.chatSessions[sessionId].slice(-40);
    }

    res.json({ reply });

  } catch (err) {
    console.error('[/chat] Error:', err.message);
    res.status(500).json({ error: 'Chat failed', details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ROUTE: POST /appointments
//  Store an appointment and (stub) sync to Google Calendar
//
//  Request body:
//    { title, datetime, location, notes }
//
//  Response:
//    { success: true, appointment: {...}, calendarUrl?: string }
// ═══════════════════════════════════════════════════════════════
app.post('/appointments', async (req, res) => {
  try {
    const { title, datetime, location = '', notes = '' } = req.body;

    if (!title || !datetime) {
      return res.status(400).json({ error: 'title and datetime are required' });
    }

    const appointment = {
      id:        Date.now(),
      title,
      datetime,
      location,
      notes,
      createdAt: new Date().toISOString(),
    };

    db.appointments.push(appointment);

    // ─ Google Calendar integration stub ─
    // To enable: implement OAuth2 flow using googleapis npm package
    // Steps:
    //   1. npm install googleapis
    //   2. Create OAuth2 client with your Google Cloud credentials
    //   3. Exchange code for tokens, store in db.googleTokens
    //   4. Use calendar.events.insert() to create the event
    //
    // Example (requires auth setup):
    // const { google } = require('googleapis');
    // const calendar = google.calendar({ version: 'v3', auth: oauthClient });
    // await calendar.events.insert({
    //   calendarId: 'primary',
    //   resource: {
    //     summary: title,
    //     location,
    //     description: notes,
    //     start: { dateTime: new Date(datetime).toISOString() },
    //     end:   { dateTime: new Date(new Date(datetime).getTime() + 60*60*1000).toISOString() },
    //   }
    // });

    res.json({
      success:     true,
      appointment,
      message:     'Appointment saved. Connect Google OAuth to enable Calendar sync.',
    });

  } catch (err) {
    console.error('[/appointments] Error:', err.message);
    res.status(500).json({ error: 'Failed to save appointment', details: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
//  ROUTE: GET /appointments
//  Retrieve all stored appointments
// ═══════════════════════════════════════════════════════════════
app.get('/appointments', (_req, res) => {
  res.json({ appointments: db.appointments });
});

// ═══════════════════════════════════════════════════════════════
//  ROUTE: POST /health-reminder
//  Generate a personalised health reminder message from Claude
// ═══════════════════════════════════════════════════════════════
app.post('/health-reminder', async (req, res) => {
  try {
    const { metrics = {}, reminderType = 'general' } = req.body;
    // metrics example: { steps: 6240, water: 1.4, sleep: 6.5, weight: 75 }

    const systemPrompt = `You are a caring, motivating health coach embedded in LifeAI.
Generate short, friendly, personalised health reminders.
Be positive and specific, not generic. Under 80 words.`;

    const userMessage = `Generate a health reminder for type: "${reminderType}".
User's current metrics: ${JSON.stringify(metrics)}
Make it personal to their actual numbers if provided.`;

    const reminder = await askClaude({ systemPrompt, userMessage, maxTokens: 150 });
    res.json({ reminder });

  } catch (err) {
    console.error('[/health-reminder] Error:', err.message);
    res.status(500).json({ error: 'Failed to generate reminder', details: err.message });
  }
});

// ─────────────────────────────────────────
//  404 handler
// ─────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ─────────────────────────────────────────
//  GLOBAL ERROR HANDLER
// ─────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[Global Error]', err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// ─────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🟢 LifeAI Backend running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health-check`);
  console.log(`   Claude API key: ${process.env.ANTHROPIC_API_KEY ? '✓ Set' : '✗ NOT SET — set ANTHROPIC_API_KEY env var!'}`);
});
