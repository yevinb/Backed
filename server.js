// ═══════════════════════════════════════════════════════════════
//  LifeAI Backend — Node.js + Express + Groq + Gmail API
// ═══════════════════════════════════════════════════════════════

const express  = require('express');
const cors     = require('cors');
const { google } = require('googleapis');

const app  = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────
const GROQ_API_KEY       = process.env.GROQ_API_KEY;
const GMAIL_CLIENT_ID    = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI       = 'https://backed-1-837p.onrender.com/auth/gmail/callback';
const FIT_REDIRECT_URI   = 'https://backed-1-837p.onrender.com/auth/fit/callback';

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// ─────────────────────────────────────────
//  IN-MEMORY STORE (tokens per user)
// ─────────────────────────────────────────
const db = {
  appointments: [],
  expenses:     [],
  tasks:        [],
  chatSessions: {},
  gmailTokens:  {},
  fitTokens:    {}, // uid → { access_token, refresh_token }
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
//  GMAIL OAUTH HELPER
// ─────────────────────────────────────────
function getOAuthClient() {
  return new google.auth.OAuth2(
    GMAIL_CLIENT_ID,
    GMAIL_CLIENT_SECRET,
    REDIRECT_URI
  );
}

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

// ═══════════════════════════════════════════════════════════════
//  GMAIL AUTH ROUTES
// ═══════════════════════════════════════════════════════════════

// Step 1: Frontend calls this to get the Google auth URL
app.get('/auth/gmail', (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid required' });

  const oauth2Client = getOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
    ],
    state: uid, // pass uid through so we know who connected
    prompt: 'consent',
  });

  res.json({ url });
});

// Step 2: Google redirects here after user approves
app.get('/auth/gmail/callback', async (req, res) => {
  const { code, state: uid } = req.query;
  if (!code || !uid) return res.status(400).send('Missing code or uid');

  try {
    const oauth2Client = getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);
    db.gmailTokens[uid] = tokens;
    console.log(`Gmail connected for uid: ${uid}`);
    // Redirect back to dashboard with success
    res.send(`
      <html><body>
        <script>
          window.opener && window.opener.postMessage('gmail-connected', '*');
          window.close();
        </script>
        <p>Gmail connected! You can close this window.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('[/auth/gmail/callback]', err.message);
    res.status(500).send('Authentication failed: ' + err.message);
  }
});

// Check if Gmail is connected for a user
app.get('/auth/gmail/status', (req, res) => {
  const { uid } = req.query;
  res.json({ connected: !!(uid && db.gmailTokens[uid]) });
});

// ═══════════════════════════════════════════════════════════════
//  GMAIL API ROUTES
// ═══════════════════════════════════════════════════════════════

// GET /gmail/inbox?uid=xxx — fetch latest emails
app.get('/gmail/inbox', async (req, res) => {
  const { uid } = req.query;
  if (!uid || !db.gmailTokens[uid]) {
    return res.status(401).json({ error: 'Gmail not connected' });
  }

  try {
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(db.gmailTokens[uid]);

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Get list of latest 20 inbox messages
    const list = await gmail.users.messages.list({
      userId: 'me',
      maxResults: 20,
      labelIds: ['INBOX'],
    });

    if (!list.data.messages) return res.json({ emails: [] });

    // Fetch details for each message
    const emails = await Promise.all(
      list.data.messages.map(async (msg) => {
        const full = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'metadata',
          metadataHeaders: ['From', 'Subject', 'Date'],
        });

        const headers = full.data.payload.headers;
        const getHeader = (name) => headers.find(h => h.name === name)?.value || '';

        return {
          id:      msg.id,
          from:    getHeader('From'),
          subject: getHeader('Subject'),
          date:    getHeader('Date'),
          snippet: full.data.snippet,
          unread:  full.data.labelIds?.includes('UNREAD') || false,
        };
      })
    );

    // Update tokens if refreshed
    db.gmailTokens[uid] = oauth2Client.credentials;

    res.json({ emails });
  } catch (err) {
    console.error('[/gmail/inbox]', err.message);
    res.status(500).json({ error: 'Failed to fetch emails', details: err.message });
  }
});

// POST /gmail/send — send an email
app.post('/gmail/send', async (req, res) => {
  const { uid, to, subject, body } = req.body;
  if (!uid || !db.gmailTokens[uid]) {
    return res.status(401).json({ error: 'Gmail not connected' });
  }
  if (!to || !subject || !body) {
    return res.status(400).json({ error: 'to, subject and body are required' });
  }

  try {
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(db.gmailTokens[uid]);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Encode email in base64
    const raw = Buffer.from(
      `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
    ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });

    db.gmailTokens[uid] = oauth2Client.credentials;
    res.json({ success: true });
  } catch (err) {
    console.error('[/gmail/send]', err.message);
    res.status(500).json({ error: 'Failed to send email', details: err.message });
  }
});

// POST /gmail/mark-read — mark email as read
app.post('/gmail/mark-read', async (req, res) => {
  const { uid, messageId } = req.body;
  if (!uid || !db.gmailTokens[uid]) return res.status(401).json({ error: 'Gmail not connected' });

  try {
    const oauth2Client = getOAuthClient();
    oauth2Client.setCredentials(db.gmailTokens[uid]);
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { removeLabelIds: ['UNREAD'] },
    });

    db.gmailTokens[uid] = oauth2Client.credentials;
    res.json({ success: true });
  } catch (err) {
    console.error('[/gmail/mark-read]', err.message);
    res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// ═══════════════════════════════════════════════════════════════
//  GOOGLE FIT ROUTES
// ═══════════════════════════════════════════════════════════════

app.get('/auth/fit', (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'uid required' });

  const oauth2Client = new google.auth.OAuth2(
    GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, FIT_REDIRECT_URI
  );

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/fitness.activity.read',
      'https://www.googleapis.com/auth/fitness.body.read',
    ],
    state: uid,
    prompt: 'consent',
  });

  res.json({ url });
});

app.get('/auth/fit/callback', async (req, res) => {
  const { code, state: uid } = req.query;
  if (!code || !uid) return res.status(400).send('Missing code or uid');

  try {
    const oauth2Client = new google.auth.OAuth2(
      GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, FIT_REDIRECT_URI
    );
    const { tokens } = await oauth2Client.getToken(code);
    db.fitTokens[uid] = tokens;
    console.log(`Google Fit connected for uid: ${uid}`);
    res.send(`
      <html><body>
        <script>
          window.opener && window.opener.postMessage('fit-connected', '*');
          window.close();
        </script>
        <p>Google Fit connected! You can close this window.</p>
      </body></html>
    `);
  } catch (err) {
    console.error('[/auth/fit/callback]', err.message);
    res.status(500).send('Authentication failed: ' + err.message);
  }
});

app.get('/auth/fit/status', (req, res) => {
  const { uid } = req.query;
  res.json({ connected: !!(uid && db.fitTokens[uid]) });
});

// GET /fit/steps?uid=xxx — fetch today's steps from Google Fit
app.get('/fit/steps', async (req, res) => {
  const { uid } = req.query;
  if (!uid || !db.fitTokens[uid]) {
    return res.status(401).json({ error: 'Google Fit not connected' });
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, FIT_REDIRECT_URI
    );
    oauth2Client.setCredentials(db.fitTokens[uid]);

    const fitness = google.fitness({ version: 'v1', auth: oauth2Client });

    // Get today's start and end in milliseconds
    const now = Date.now();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const response = await fitness.users.dataset.aggregate({
      userId: 'me',
      requestBody: {
        aggregateBy: [{
          dataTypeName: 'com.google.step_count.delta',
          dataSourceId: 'derived:com.google.step_count.delta:com.google.android.gms:estimated_steps'
        }],
        bucketByTime: { durationMillis: 86400000 },
        startTimeMillis: startOfDay.getTime(),
        endTimeMillis: now,
      }
    });

    let steps = 0;
    const buckets = response.data.bucket || [];
    buckets.forEach(bucket => {
      const datasets = bucket.dataset || [];
      datasets.forEach(dataset => {
        const points = dataset.point || [];
        points.forEach(point => {
          const values = point.value || [];
          values.forEach(v => { steps += v.intVal || 0; });
        });
      });
    });

    db.fitTokens[uid] = oauth2Client.credentials;
    res.json({ steps });
  } catch (err) {
    console.error('[/fit/steps]', err.message);
    res.status(500).json({ error: 'Failed to fetch steps', details: err.message });
  }
});

app.get('/health-check', (_req, res) => {
  res.json({
    status:    'ok',
    ai:        `Groq — ${GROQ_MODEL}`,
    timestamp: new Date().toISOString(),
    apiKey:    GROQ_API_KEY ? '✓ Set' : '✗ Missing',
    gmail:     GMAIL_CLIENT_ID ? '✓ Configured' : '✗ Missing',
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
    const { expenses = [] } = req.body;
    if (!expenses.length) return res.status(400).json({ error: 'No expense data' });

    const total = expenses.reduce((s, e) => s + parseFloat(e.amount || e.amt || 0), 0);
    const byCategory = expenses.reduce((acc, e) => {
      const cat = e.category || e.cat || 'Other';
      acc[cat] = (acc[cat] || 0) + parseFloat(e.amount || e.amt || 0);
      return acc;
    }, {});

    const breakdown = Object.entries(byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, amt]) => `  • ${cat}: £${amt.toFixed(2)}`)
      .join('\n');

    const system = `You are a friendly financial advisor. Analyse expenses and give actionable insights.
Be encouraging, not judgmental. Use £ for currency. Max 200 words. Use emojis sparingly.`;

    const prompt = `Analyse my spending:\nTotal: £${total.toFixed(2)}\nBy category:\n${breakdown}
Give: 1) brief assessment 2) biggest spending area insight 3) two practical saving tips.`;

    const summary = await askGroq(system, prompt);
    res.json({ summary, total: total.toFixed(2), byCategory });
  } catch (err) {
    console.error('[/finance-summary]', err.message);
    res.status(500).json({ error: 'Failed to generate summary', details: err.message });
  }
});

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
  console.log(`   Gmail: ${GMAIL_CLIENT_ID ? '✓ Configured' : '✗ NOT SET'}`);
});
