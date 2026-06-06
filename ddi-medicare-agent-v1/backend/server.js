require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');
const { Server } = require('socket.io');
const cron = require('node-cron');
const WebSocket = require('ws');

const webhookRoutes = require('./routes/webhooks');
const voiceRoutes = require('./routes/voice');
const authRoutes = require('./routes/auth');
const { buildAndPlayMorningBriefing } = require('./services/briefing');
const { renewCalendarSubscription } = require('./services/graph');
const deepgram = require('./services/deepgram');

const app = express();
const server = http.createServer(app);

// ─── Socket.IO (real-time broker UI updates) ──────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
  },
});
app.set('io', io);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:3000', credentials: true }));

// Raw body for webhook signature validation
app.use('/webhooks', express.raw({ type: 'application/json', limit: '1mb' }), (req, res, next) => {
  if (req.body && Buffer.isBuffer(req.body)) {
    req.rawBody = req.body;
    try { req.body = JSON.parse(req.body.toString()); } catch { req.body = {}; }
  }
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/webhooks', webhookRoutes);
app.use('/voice', voiceRoutes);
app.use('/auth', authRoutes);

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ─── Deepgram STT WebSocket Proxy ─────────────────────────────────────────────
// Proxies browser audio to Deepgram — broker's API key never exposed to browser
const wss = new WebSocket.Server({ server, path: '/stt' });

wss.on('connection', (browserWs) => {
  console.log('[STT] Browser connected to STT proxy');

  let dgWs = null;
  let transcriptBuffer = '';

  const onTranscript = (transcript) => {
    transcriptBuffer = transcript;
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify({ type: 'transcript', transcript }));
    }
  };

  dgWs = deepgram.createStreamingSTT(onTranscript, (err) => {
    if (browserWs.readyState === WebSocket.OPEN) {
      browserWs.send(JSON.stringify({ type: 'error', message: err.message }));
    }
  });

  browserWs.on('message', (audioData) => {
    // Forward raw audio to Deepgram
    if (dgWs && dgWs.readyState === WebSocket.OPEN) {
      dgWs.send(audioData);
    }
  });

  browserWs.on('close', () => {
    if (dgWs && dgWs.readyState === WebSocket.OPEN) {
      dgWs.close();
    }
    console.log('[STT] Browser disconnected');
  });

  browserWs.on('error', (e) => console.error('[STT] Browser WS error:', e.message));
});

// ─── TTS endpoint ─────────────────────────────────────────────────────────────
app.post('/tts', async (req, res) => {
  const { text, voice } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

  try {
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
  ).catch(() => ({ rows: [] }));

  res.json(result.rows);
});

// ─── Clients API ──────────────────────────────────────────────────────────────
app.get('/api/clients/search', async (req, res) => {
  const db = require('./db');
  const q = req.query.q || '';
  const result = await db.query(
    `SELECT id, sparkadvisor_id, name, email, phone, current_plan, carrier, soa_status
     FROM client_cache WHERE LOWER(name) LIKE LOWER($1) OR LOWER(email) LIKE LOWER($1) LIMIT 10`,
    [`%${q}%`]
  ).catch(() => ({ rows: [] }));
  res.json(result.rows);
});

// ─── Pending actions API ──────────────────────────────────────────────────────
app.get('/api/pending', async (req, res) => {
  const db = require('./db');
  const result = await db.query(
    `SELECT * FROM pending_actions WHERE status = 'pending' ORDER BY created_at DESC LIMIT 5`
  ).catch(() => ({ rows: [] }));
  res.json(result.rows);
});

// ─── Audit log API (read-only) ─────────────────────────────────────────────────
app.get('/api/audit', async (req, res) => {
  const db = require('./db');
  const result = await db.query(
    `SELECT id, timestamp, action_type, client_name, client_email, description, broker_approved
     FROM audit_log ORDER BY timestamp DESC LIMIT 100`
  ).catch(() => ({ rows: [] }));
  res.json(result.rows);
});

// ─── Trigger briefing manually ────────────────────────────────────────────────
app.post('/api/briefing/trigger', async (req, res) => {
  res.json({ status: 'building' });
  try {
    await buildAndPlayMorningBriefing(io);
  } catch (e) {
    console.error('[Briefing] Manual trigger failed:', e);
  }
});

// ─── Socket.IO connection ─────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[Socket] Broker UI connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('[Socket] Broker UI disconnected:', socket.id);
  });
});

// ─── Scheduled Jobs ───────────────────────────────────────────────────────────
const briefingTime = process.env.MORNING_BRIEFING_TIME || '08:00';
const [briefHour, briefMin] = briefingTime.split(':');

// Morning briefing — daily at configured time (CT)
cron.schedule(`${briefMin} ${briefHour} * * *`, async () => {
  console.log('[Cron] Triggering morning briefing');
  try {
    await buildAndPlayMorningBriefing(io);
  } catch (e) {
    console.error('[Cron] Morning briefing failed:', e);
  }
}, { timezone: process.env.TIMEZONE || 'America/Chicago' });

// Renew Microsoft Graph calendar subscription every 47 hours
cron.schedule('0 */47 * * *', async () => {
  console.log('[Cron] Renewing Graph calendar subscription');
  try {
    await renewCalendarSubscription();
  } catch (e) {
    console.error('[Cron] Subscription renewal failed:', e);
  }
});

// Clean up expired pending actions every hour
cron.schedule('0 * * * *', async () => {
  const db = require('./db');
  await db.query(
    `UPDATE pending_actions SET status = 'expired' WHERE status = 'pending' AND expires_at < now()`
  ).catch(() => {});
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n🎙️  DDI Medicare Voice Agent backend running on port ${PORT}`);
  console.log(`   Broker: ${process.env.BROKER_NAME || 'Larry'} <${process.env.BROKER_EMAIL}>`);
  console.log(`   NPN: ${process.env.BROKER_NPN}`);
  console.log(`   Morning briefing: ${briefingTime} CT`);
  console.log(`   Frontend: ${process.env.FRONTEND_URL}`);
  console.log(`   STT proxy: ws://localhost:${PORT}/stt\n`);
});

module.exports = { app, server, io };
