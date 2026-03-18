// ═══════════════════════════════════════════════════════════════
//  LifeAI Backend — Node.js + Express + Groq + Firebase + PayPal
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

// PayPal Configuration
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API = process.env.NODE_ENV === 'production' 
  ? 'https://api-m.paypal.com' 
  : 'https://api-m.sandbox.paypal.com';

// ─────────────────────────────────────────
//  FIREBASE INITIALIZATION
// ─────────────────────────────────────────
const serviceAccount = {
  type: "service_account",
  project_id: "ai-life-assistant-c9b14",
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token"
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});

const db = admin.firestore();

// ─────────────────────────────────────────
//  IN-MEMORY STORE (for development)
// ─────────────────────────────────────────
const memoryDb = {
  appointments: [],
  expenses: [],
  tasks: [],
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
//  AUTHENTICATION MIDDLEWARE
// ─────────────────────────────────────────
async function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(403).json({ error: 'Invalid token' });
  }
}

// ─────────────────────────────────────────
//  USAGE CHECK MIDDLEWARE
// ─────────────────────────────────────────
async function checkUsage(req, res, next, feature) {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    
    if (!userDoc.exists) {
      // Create default free user
      await db.collection('users').doc(req.user.uid).set({
        email: req.user.email,
        displayName: req.user.name || '',
        plan: 'free',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        usage: {
          tasks: 0,
          chatMessages: 0,
          appointments: 0,
          lastReset: new Date().toISOString().split('T')[0]
        }
      });
      return next();
    }
    
    const userData = userDoc.data();
    
    // Pro users have no limits
    if (userData.plan === 'pro') {
      return next();
    }
    
    // Check daily reset for chat
    const today = new Date().toISOString().split('T')[0];
    if (userData.usage?.lastReset !== today) {
      await db.collection('users').doc(req.user.uid).update({
        'usage.chatMessages': 0,
        'usage.lastReset': today
      });
    }
    
    // Check limits
    if (feature === 'chat' && userData.usage?.chatMessages >= 5) {
      return res.status(403).json({ 
        error: 'limit_reached',
        message: 'You\'ve used all 5 free chat messages today. Upgrade to Pro for unlimited chats!',
        upgradeUrl: '/pricing.html'
      });
    }
    
    next();
  } catch (err) {
    console.error('Usage check error:', err);
    next(); // Allow on error
  }
}

// ─────────────────────────────────────────
//  GROQ HELPERS
// ─────────────────────────────────────────
async function askGroq(systemPrompt, userMessage) {
  try {
    const response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: 800,
        temperature: 0.7,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
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
      method: 'POST',
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
//  HEALTH CHECK
// ═══════════════════════════════════════════════════════════════
app.get('/health-check', (_req, res) => {
  res.json({
    status: 'ok',
    ai: `Groq — ${GROQ_MODEL}`,
    timestamp: new Date().toISOString(),
    apiKey: GROQ_API_KEY ? '✓ Set' : '✗ Missing',
  });
});

// ═══════════════════════════════════════════════════════════════
//  SUBSCRIPTION ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// Get subscription status
app.get('/api/subscription/status', authenticateToken, async (req, res) => {
  try {
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    
    if (!userDoc.exists) {
      await db.collection('users').doc(req.user.uid).set({
        email: req.user.email,
        displayName: req.user.name || '',
        plan: 'free',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        usage: {
          tasks: 0,
          chatMessages: 0,
          appointments: 0,
          lastReset: new Date().toISOString().split('T')[0]
        }
      });
      return res.json({ plan: 'free', usage: { tasks: 0, chatMessages: 0, appointments: 0 } });
    }
    
    const userData = userDoc.data();
    res.json({
      plan: userData.plan || 'free',
      usage: userData.usage || {},
      subscription: userData.subscription || null
    });
  } catch (err) {
    console.error('Subscription status error:', err);
    res.status(500).json({ error: 'Failed to get subscription status' });
  }
});

// Create PayPal order
app.post('/api/create-paypal-order', authenticateToken, async (req, res) => {
  try {
    const { plan, amount, userId, email } = req.body;
    
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    
    const response = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: `${userId}_${plan}`,
          description: `LifeAI Pro ${plan.includes('yearly') ? 'Yearly' : 'Monthly'} Subscription`,
          amount: {
            currency_code: 'GBP',
            value: amount
          }
        }],
        application_context: {
          brand_name: 'LifeAI',
          landing_page: 'BILLING',
          user_action: 'PAY_NOW',
          return_url: 'https://lifeai-home.onrender.com/pricing.html',
          cancel_url: 'https://lifeai-home.onrender.com/pricing.html'
        }
      })
    });
    
    const order = await response.json();
    res.json({ id: order.id });
  } catch (err) {
    console.error('Create PayPal order error:', err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Capture PayPal order
app.post('/api/capture-paypal-order', authenticateToken, async (req, res) => {
  try {
    const { orderId, userId } = req.body;
    
    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    
    const response = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`
      }
    });
    
    const capture = await response.json();
    
    if (capture.status === 'COMPLETED') {
      const amount = capture.purchase_units[0].payments.captures[0].amount.value;
      const plan = amount === '67.00' ? 'pro_yearly' : 'pro_monthly';
      
      await db.collection('users').doc(userId).update({
        plan: 'pro',
        subscription: {
          plan: plan,
          status: 'active',
          orderId: orderId,
          amount: amount,
          currency: 'GBP',
          startDate: admin.firestore.FieldValue.serverTimestamp(),
          endDate: plan === 'pro_yearly' 
            ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) 
            : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          paymentId: capture.purchase_units[0].payments.captures[0].id
        },
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      await db.collection('transactions').add({
        userId,
        orderId,
        amount,
        plan,
        status: 'completed',
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    
    res.json(capture);
  } catch (err) {
    console.error('Capture PayPal order error:', err);
    res.status(500).json({ error: 'Failed to capture order' });
  }
});

// ═══════════════════════════════════════════════════════════════
//  API ENDPOINTS (with usage tracking)
// ═══════════════════════════════════════════════════════════════

app.post('/plan-day', authenticateToken, async (req, res) => {
  try {
    const { tasks = [], appointments = [] } = req.body;
    
    // Check task limit for free users
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const userData = userDoc.data();
    
    if (userData.plan !== 'pro' && tasks.length > 10) {
      return res.status(403).json({ 
        error: 'limit_reached',
        message: 'Free tier limit: maximum 10 tasks. Upgrade to Pro for unlimited tasks!'
      });
    }
    
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

app.post('/draft-email', authenticateToken, async (req, res) => {
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

app.post('/finance-summary', authenticateToken, async (req, res) => {
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

app.post('/chat', authenticateToken, async (req, res) => {
  try {
    // Check and update usage
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const userData = userDoc.data();
    
    if (userData.plan !== 'pro') {
      const today = new Date().toISOString().split('T')[0];
      if (userData.usage?.lastReset !== today) {
        await db.collection('users').doc(req.user.uid).update({
          'usage.chatMessages': 1,
          'usage.lastReset': today
        });
      } else if (userData.usage?.chatMessages >= 5) {
        return res.status(403).json({ 
          error: 'limit_reached',
          message: 'Daily chat limit reached. Upgrade to Pro for unlimited chats!'
        });
      } else {
        await db.collection('users').doc(req.user.uid).update({
          'usage.chatMessages': admin.firestore.FieldValue.increment(1)
        });
      }
    }
    
    const { message, history = [], sessionId = 'default' } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const system = `You are LifeAI — a warm, knowledgeable personal life assistant.
You help with: day planning, tasks, emails, finances, health, and appointments.
Be friendly, concise, and proactive. Use light emojis occasionally.
Keep responses under 180 words unless more detail is asked for.`;

    const reply = await askGroqWithHistory(system, history, message);

    if (!memoryDb.chatSessions[sessionId]) memoryDb.chatSessions[sessionId] = [];
    memoryDb.chatSessions[sessionId].push(
      { role: 'user', content: message },
      { role: 'assistant', content: reply }
    );
    if (memoryDb.chatSessions[sessionId].length > 40) {
      memoryDb.chatSessions[sessionId] = memoryDb.chatSessions[sessionId].slice(-40);
    }

    res.json({ reply });
  } catch (err) {
    console.error('[/chat]', err.message);
    res.status(500).json({ error: 'Chat failed', details: err.message });
  }
});

app.post('/appointments', authenticateToken, async (req, res) => {
  try {
    const { title, datetime, location = '', notes = '' } = req.body;
    if (!title || !datetime) return res.status(400).json({ error: 'title and datetime required' });
    
    // Check appointment limit for free users
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    const userData = userDoc.data();
    
    if (userData.plan !== 'pro') {
      const userAppointments = memoryDb.appointments.filter(a => a.userId === req.user.uid);
      if (userAppointments.length >= 3) {
        return res.status(403).json({ 
          error: 'limit_reached',
          message: 'Free tier limit: maximum 3 appointments. Upgrade to Pro for unlimited appointments!'
        });
      }
    }
    
    const appointment = { 
      id: Date.now(), 
      userId: req.user.uid,
      title, 
      datetime, 
      location, 
      notes, 
      createdAt: new Date().toISOString() 
    };
    memoryDb.appointments.push(appointment);
    res.json({ success: true, appointment });
  } catch (err) {
    console.error('[/appointments]', err.message);
    res.status(500).json({ error: 'Failed to save appointment', details: err.message });
  }
});

app.get('/appointments', authenticateToken, (req, res) => {
  const userAppointments = memoryDb.appointments.filter(a => a.userId === req.user.uid);
  res.json({ appointments: userAppointments });
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
  console.log(`   AI: Groq — ${GROQ_MODEL}`);
  console.log(`   Firebase: ✓ Connected`);
  console.log(`   PayPal: ${PAYPAL_CLIENT_ID ? '✓ Configured' : '✗ Missing'}`);
  console.log(`   Groq API key: ${GROQ_API_KEY ? '✓ Set' : '✗ NOT SET'}`);
});
