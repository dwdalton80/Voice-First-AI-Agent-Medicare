const fetch = require('node-fetch');
const db = require('../db');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_URL = `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`;
const AUTH_URL = `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/oauth2/v2.0/authorize`;

// ─── OAuth Flow ───────────────────────────────────────────────────────────────
function getAuthUrl() {
  const params = new URLSearchParams({
    client_id: process.env.MICROSOFT_CLIENT_ID,
    response_type: 'code',
    redirect_uri: process.env.MICROSOFT_REDIRECT_URI,
    scope: 'offline_access Mail.Read Mail.Send Calendars.Read',
    response_mode: 'query',
  });
  return `${AUTH_URL}?${params}`;
}

async function exchangeCode(code) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      code,
      redirect_uri: process.env.MICROSOFT_REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  const data = await response.json();
  await saveTokens(data);
  return data;
}

async function saveTokens(data) {
  const expiresAt = new Date(Date.now() + data.expires_in * 1000);
  await db.query(
    `INSERT INTO oauth_tokens (provider, access_token, refresh_token, expires_at, scope)
     VALUES ('microsoft', $1, $2, $3, $4)
     ON CONFLICT (provider) DO UPDATE
     SET access_token = $1, refresh_token = $2, expires_at = $3, scope = $4, updated_at = now()`,
    [data.access_token, data.refresh_token, expiresAt, data.scope]
  ).catch(() => {
    // Table may use id PK not provider unique — store in memory as fallback
    global._msTokens = { access_token: data.access_token, refresh_token: data.refresh_token, expires_at: expiresAt };
  });
}

async function getAccessToken() {
  // Try DB first
  let token;
  try {
    const result = await db.query(
      `SELECT access_token, refresh_token, expires_at FROM oauth_tokens WHERE provider = 'microsoft' ORDER BY updated_at DESC LIMIT 1`
    );
    token = result.rows[0];
  } catch {
    token = global._msTokens;
  }

  if (!token) throw new Error('Microsoft not connected. Visit /auth/microsoft to connect.');

  // Refresh if expiring within 5 minutes
  if (new Date(token.expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    const refreshed = await refreshToken(token.refresh_token);
    return refreshed.access_token;
  }

  return token.access_token;
}

async function refreshToken(refreshToken) {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await response.json();
  await saveTokens(data);
  return data;
}

// ─── Graph API Helper ─────────────────────────────────────────────────────────
async function graphRequest(path, options = {}) {
  const token = await getAccessToken();
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Graph API ${response.status} on ${path}: ${err}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

// ─── Calendar ─────────────────────────────────────────────────────────────────
async function getUpcomingAppointments(days = 7) {
  const start = new Date().toISOString();
  const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const data = await graphRequest(
    `/me/calendarView?startDateTime=${start}&endDateTime=${end}&$select=id,subject,start,end,attendees,bodyPreview,organizer&$orderby=start/dateTime&$top=50`
  );

  return data?.value || [];
}

async function subscribeToCalendar(notificationUrl) {
  const expirationDateTime = new Date(Date.now() + 4200 * 60 * 1000).toISOString(); // ~70 hours
  const clientState = process.env.WEBHOOK_VALIDATION_TOKEN || 'ddi-agent-secret';

  try {
    const existing = await db.query(
      `SELECT subscription_id FROM graph_subscriptions WHERE resource = '/me/events' AND expires_at > now() LIMIT 1`
    );
    if (existing.rows[0]) {
      console.log('[Graph] Calendar subscription already active:', existing.rows[0].subscription_id);
      return existing.rows[0];
    }
  } catch { /* continue */ }

  const sub = await graphRequest('/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      changeType: 'created,updated',
      notificationUrl,
      resource: '/me/events',
      expirationDateTime,
      clientState,
    }),
  });

  try {
    await db.query(
      `INSERT INTO graph_subscriptions (subscription_id, resource, change_types, expires_at, client_state)
       VALUES ($1, '/me/events', 'created,updated', $2, $3)`,
      [sub.id, expirationDateTime, clientState]
    );
  } catch { /* non-fatal */ }

  console.log('[Graph] Calendar subscription created:', sub.id);
  return sub;
}

async function renewCalendarSubscription() {
  try {
    const result = await db.query(
      `SELECT subscription_id FROM graph_subscriptions WHERE resource = '/me/events' ORDER BY created_at DESC LIMIT 1`
    );
    if (!result.rows[0]) return;

    const newExpiry = new Date(Date.now() + 4200 * 60 * 1000).toISOString();
    await graphRequest(`/subscriptions/${result.rows[0].subscription_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ expirationDateTime: newExpiry }),
    });

    await db.query(
      `UPDATE graph_subscriptions SET expires_at = $1 WHERE subscription_id = $2`,
      [newExpiry, result.rows[0].subscription_id]
    );
    console.log('[Graph] Calendar subscription renewed');
  } catch (e) {
    console.error('[Graph] Subscription renewal failed:', e.message);
  }
}

// ─── Email ────────────────────────────────────────────────────────────────────
async function getUnreadClientEmails(clientEmails) {
  if (!clientEmails || clientEmails.length === 0) return [];

  // Graph doesn't support "from in [list]" directly — fetch unread and filter
  const data = await graphRequest(
    `/me/messages?$filter=isRead eq false&$select=id,subject,from,receivedDateTime,bodyPreview,body&$orderby=receivedDateTime desc&$top=50`
  );

  const messages = data?.value || [];
  const emailSet = new Set(clientEmails.map(e => e.toLowerCase()));

  return messages.filter(m =>
    emailSet.has(m.from?.emailAddress?.address?.toLowerCase())
  );
}

async function sendEmail(toAddress, subject, htmlBody) {
  await graphRequest('/me/sendMail', {
    method: 'POST',
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'HTML', content: htmlBody },
        toRecipients: [{ emailAddress: { address: toAddress } }],
      },
      saveToSentItems: true,
    }),
  });
}

async function markEmailRead(messageId) {
  await graphRequest(`/me/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify({ isRead: true }),
  });
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  getAccessToken,
  getUpcomingAppointments,
  subscribeToCalendar,
  renewCalendarSubscription,
  getUnreadClientEmails,
  sendEmail,
  markEmailRead,
};
