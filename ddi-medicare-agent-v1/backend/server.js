require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');
const { Server } = require('socket.io');
const cron = require('node-cron');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const allowedOrigin = process.env.FRONTEND_URL || '*';
const io = new Server(server, {
  cors: { origin: allowedOrigin, methods: ['GET', 'POST'] },
});
app.set('io', io);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: allowedOrigin, credentials: true }));

// Raw body for webhook signature validation — must come before express.json
app.use('/webhooks', (req, res, next) => {
  let data = '';
  req.setEncoding('utf8');
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch { req.body = {}; }
    next();
  });
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Health check (Railway pings this to verify it's alive) ──────────────────
app.get('/', (req, res) => res.json({ status: 'ok', service: 'DDI Medicare Voice Agent', broker: 'larry@ddinsgroup.com' }));
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─── Routes (loaded after middleware) ────────────────────────────────────────
let webhookRoutes, voiceRoutes, authRoutes;
try {
  webhookRoutes = require('./routes/webhooks');
  voiceRoutes = require('./routes/voice');
  authRoutes = require('./routes/auth');
  app.use('/webhooks', webhookRoutes);
  app.use('/voice', voiceRoutes);
  app.use('/auth', authRoutes);
  console.log('[Server] Routes loaded');
} catch (e) {
  console.error('[Server] Route loading error:', e.message);
}

// ─── TTS endpoint ─────────────────────────────────────────────────────────────
app.post('/tts', async (req, res) => {
  const { text, voice } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });
  try {
    const deepgram = require('./services/deepgram');
    const audioBuffer = await deepgram.synthesize(text, voice);
    res.set('Content-Type', 'audio/mpeg');
    res.send(audioBuffer);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Appointments API ─────────────────────────────────────────────────────────
app.get('/api/appointments', async (req, res) => {
  const db = require('./db');
  const days = parseInt(req.query.days) || 7;
  const start = new Date();
  const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const result = await db.query(
    `SELECT a.*, c.current_plan, c.carrier, c.dob, c.state
     FROM appointments a
     LEFT JOIN client_cache c ON a.client_id = c.id
     WHERE a.appointment_dt BETWEEN $1 AND $2
     ORDER BY a.appointment_dt ASC`,
    [start.toISOString(), end.toISOString()]
  );
  res.json(result.rows);
});

// ─── Clients search ───────────────────────────────────────────────────────────
app.get('/api/clients/search', async (req, res) => {
  const db = require('./db');
  const q = req.query.q || '';
  const result = await db.query(
    `SELECT id, sparkadvisor_id, name, email, phone, current_plan, carrier, soa_status
     FROM client_cache WHERE LOWER(name) LIKE LOWER($1) OR LOWER(email) LIKE LOWER($1) LIMIT 10`,
    [`%${q}%`]
  );
  res.json(result.rows);
});

// ─── Pending actions ──────────────────────────────────────────────────────────
app.get('/api/pending', async (req, res) => {
  const db = require('./db');
  const result = await db.query(
    `SELECT * FROM pending_actions WHERE status = 'pending' ORDER BY created_at DESC LIMIT 5`
  );
  res.json(result.rows);
});

// ─── Audit log ────────────────────────────────────────────────────────────────
app.get('/api/audit', async (req, res) => {
  const db = require('./db');
  const result = await db.query(
    `SELECT id, timestamp, action_type, client_name, client_email, description, broker_approved
     FROM audit_log ORDER BY timestamp DESC LIMIT 100`
  );
  res.json(result.rows);
});

// ─── Manual briefing trigger ──────────────────────────────────────────────────
app.post('/api/briefing/trigger', async (req, res) => {
  res.json({ status: 'building' });
  try {
    const { buildAndPlayMorningBriefing } = require('./services/briefing');
    await buildAndPlayMorningBriefing(io);
  } catch (e) {
    console.error('[Briefing] Manual trigger failed:', e.message);
  }
});

// ─── Deepgram STT WebSocket Proxy ─────────────────────────────────────────────
const wss = new WebSocket.Server({ server, path: '/stt' });
wss.on('connection', (browserWs) => {
  console.log('[STT] Browser connected');
  let dgWs = null;

  try {
    const deepgram = require('./services/deepgram');
    dgWs = deepgram.createStreamingSTT(
      (transcript) => {
        if (browserWs.readyState === WebSocket.OPEN) {
          browserWs.send(JSON.stringify({ type: 'transcript', transcript }));
        }
      },
      (err) => {
        if (browserWs.readyState === WebSocket.OPEN) {
          browserWs.send(JSON.stringify({ type: 'error', message: err.message }));
        }
      }
    );
  } catch (e) {
    console.warn('[STT] Deepgram not configured:', e.message);
  }

  browserWs.on('message', (audioData) => {
    if (dgWs && dgWs.readyState === WebSocket.OPEN) dgWs.send(audioData);
  });

  browserWs.on('close', () => {
    if (dgWs && dgWs.readyState === WebSocket.OPEN) dgWs.close();
    console.log('[STT] Browser disconnected');
  });

  browserWs.on('error', (e) => console.error('[STT] Error:', e.message));
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[Socket] Broker UI connected:', socket.id);
  socket.on('disconnect', () => console.log('[Socket] Disconnected:', socket.id));
});

// ─── Scheduled jobs (only if keys are present) ───────────────────────────────
const briefingTime = process.env.MORNING_BRIEFING_TIME || '08:00';
const [briefHour, briefMin] = briefingTime.split(':');

cron.schedule(`${briefMin} ${briefHour} * * *`, async () => {
  if (!process.env.ANTHROPIC_API_KEY) return;
  console.log('[Cron] Morning briefing');
  try {
    const { buildAndPlayMorningBriefing } = require('./services/briefing');
    await buildAndPlayMorningBriefing(io);
  } catch (e) {
    console.error('[Cron] Briefing error:', e.message);
  }
}, { timezone: process.env.TIMEZONE || 'America/Chicago' });

// Renew Graph subscription every 47 hours
cron.schedule('0 */47 * * *', async () => {
  if (!process.env.MICROSOFT_CLIENT_ID) return;
  try {
    const { renewCalendarSubscription } = require('./services/graph');
    await renewCalendarSubscription();
  } catch (e) {
    console.error('[Cron] Subscription renewal error:', e.message);
  }
});

// Expire pending actions hourly
cron.schedule('0 * * * *', async () => {
  const db = require('./db');
  await db.query(`UPDATE pending_actions SET status = 'expired' WHERE status = 'pending' AND expires_at < now()`);
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎙️  DDI Medicare Voice Agent`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Broker: ${process.env.BROKER_NAME || 'Larry'} <${process.env.BROKER_EMAIL || 'larry@ddinsgroup.com'}>`);
  console.log(`   DB: ${process.env.DATABASE_URL ? 'Connected' : 'Not configured'}`);
  console.log(`   Anthropic: ${process.env.ANTHROPIC_API_KEY ? 'Configured' : 'Missing'}`);
  console.log(`   Deepgram: ${process.env.DEEPGRAM_API_KEY ? 'Configured' : 'Missing'}\n`);
});

module.exports = { app, server, io };
