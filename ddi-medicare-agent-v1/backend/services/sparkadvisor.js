const fetch = require('node-fetch');
const db = require('../db');

const SA_BASE = process.env.SPARKADVISOR_BASE_URL || 'https://sparkadvisor.com';

// ─── NOTE ─────────────────────────────────────────────────────────────────────
// SparkAdvisor webhook schema must be confirmed with SparkAdvisor support.
// Until confirmed, this service uses placeholder endpoints marked with [CONFIRM].
// The structure here matches the PRD spec and will need endpoint URLs updated
// once SparkAdvisor provides their API documentation.
// ─────────────────────────────────────────────────────────────────────────────

async function saRequest(path, options = {}) {
  const url = `${SA_BASE}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.SPARKADVISOR_API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`SparkAdvisor API ${response.status} on ${path}: ${err}`);
  }

  return response.json();
}

// ─── Read client by email (for booking match) ─────────────────────────────────
async function findClientByEmail(email) {
  // First check local cache
  const cached = await db.query(
    `SELECT * FROM client_cache WHERE LOWER(email) = LOWER($1) LIMIT 1`,
    [email]
  );
  if (cached.rows[0]) return cached.rows[0];

  // [CONFIRM] endpoint with SparkAdvisor support
  try {
    const data = await saRequest(`/api/clients?email=${encodeURIComponent(email)}`);
    const client = data?.clients?.[0] || data;
    if (client?.id) await cacheClient(client);
    return client;
  } catch (e) {
    console.warn('[SparkAdvisor] findClientByEmail failed (confirm API endpoint):', e.message);
    return null;
  }
}

// ─── Read client by SparkAdvisor ID ──────────────────────────────────────────
async function getClient(clientId) {
  // Check cache first
  const cached = await db.query(
    `SELECT * FROM client_cache WHERE sparkadvisor_id = $1 LIMIT 1`,
    [clientId]
  );
  if (cached.rows[0] && isRecentlySynced(cached.rows[0].last_synced)) {
    return cached.rows[0];
  }

  // [CONFIRM] endpoint with SparkAdvisor support
  try {
    const data = await saRequest(`/api/clients/${clientId}`);
    await cacheClient(data);
    return data;
  } catch (e) {
    console.warn('[SparkAdvisor] getClient failed:', e.message);
    return cached.rows[0] || null;
  }
}

function isRecentlySynced(lastSynced, maxAgeMinutes = 30) {
  if (!lastSynced) return false;
  return (Date.now() - new Date(lastSynced).getTime()) < maxAgeMinutes * 60 * 1000;
}

async function cacheClient(client) {
  if (!client?.id) return;
  await db.query(
    `INSERT INTO client_cache (sparkadvisor_id, name, email, phone, dob, state, current_plan, carrier, raw, last_synced)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (sparkadvisor_id) DO UPDATE
     SET name=$2, email=$3, phone=$4, dob=$5, state=$6, current_plan=$7, carrier=$8, raw=$9, last_synced=now()`,
    [
      client.id || client.sparkadvisor_id,
      client.name || `${client.first_name || ''} ${client.last_name || ''}`.trim(),
      client.email,
      client.phone,
      client.dob || client.date_of_birth,
      client.state,
      client.current_plan || client.plan_name,
      client.carrier,
      JSON.stringify(client),
    ]
  ).catch(e => console.warn('[Cache] Client cache write failed:', e.message));
}

// ─── Write: Create lead ───────────────────────────────────────────────────────
async function createLead(data) {
  const payload = {
    name: data.name,
    email: data.email,
    phone: data.phone,
    source: 'website_booking',
    notes: data.notes,
    appointment_date: data.appointment_date,
    state: data.state,
    tags: data.tags || [],
  };

  // [CONFIRM] endpoint with SparkAdvisor support
  try {
    const result = await saRequest('/api/leads', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    await logAudit('create_lead', result?.id, data.email, data.name, payload, true);
    return result;
  } catch (e) {
    console.error('[SparkAdvisor] createLead failed:', e.message);
    // Store pending for retry
    await db.query(
      `INSERT INTO pending_actions (action_type, client_id, payload, tts_readback, status)
       VALUES ('create_lead', $1, $2, $3, 'failed_retry')`,
      [data.email, JSON.stringify(payload), `Lead creation for ${data.name} queued for retry`]
    ).catch(() => {});
    throw e;
  }
}

// ─── Write: Update notes ──────────────────────────────────────────────────────
async function updateNotes(clientId, noteText, disposition) {
  const payload = {
    note_text: noteText,
    call_date: new Date().toISOString(),
    disposition,
    source: 'ddi_voice_agent',
  };

  // [CONFIRM] endpoint with SparkAdvisor support
  const result = await saRequest(`/api/clients/${clientId}/notes`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  await logAudit('update_notes', clientId, null, null, payload, true);
  return result;
}

// ─── Write: Create task ───────────────────────────────────────────────────────
async function createTask(clientId, taskData) {
  const payload = {
    client_id: clientId,
    due_date: taskData.due_date,
    task_type: taskData.task_type || 'follow_up',
    description: taskData.description,
    priority: taskData.priority || 'normal',
  };

  // [CONFIRM] endpoint with SparkAdvisor support
  const result = await saRequest('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  await logAudit('create_task', clientId, null, null, payload, true);
  return result;
}

// ─── Write: Log policy enrollment ────────────────────────────────────────────
async function logPolicy(clientId, policyData) {
  const payload = {
    client_id: clientId,
    carrier: policyData.carrier,
    plan_name: policyData.plan_name,
    plan_type: policyData.plan_type,
    effective_date: policyData.effective_date,
    enrolled_at: new Date().toISOString(),
    source: 'ddi_voice_agent',
  };

  // [CONFIRM] endpoint with SparkAdvisor support
  const result = await saRequest('/api/policies', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  await logAudit('log_policy', clientId, null, null, payload, true);
  return result;
}

// ─── Write: Send BlazeSync / SOA link ────────────────────────────────────────
async function sendBlazeSync(clientId, deliveryMethod = 'sms') {
  const payload = {
    client_id: clientId,
    delivery_method: deliveryMethod,
    link_type: 'blazesync',
  };

  // [CONFIRM] endpoint with SparkAdvisor support
  const result = await saRequest('/api/clients/send-blazesync', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  await logAudit('send_blazesync', clientId, null, null, payload, true);
  return result;
}

// ─── Get tasks due today ──────────────────────────────────────────────────────
async function getTasksDueToday() {
  const today = new Date().toISOString().split('T')[0];
  try {
    const data = await saRequest(`/api/tasks?due_date=${today}&status=open`);
    return data?.tasks || data || [];
  } catch (e) {
    console.warn('[SparkAdvisor] getTasksDueToday failed:', e.message);
    return [];
  }
}

// ─── Get clients with pending SOAs ───────────────────────────────────────────
async function getPendingSOAs() {
  try {
    const data = await saRequest('/api/clients?soa_status=sent&soa_completed=false');
    return data?.clients || data || [];
  } catch (e) {
    console.warn('[SparkAdvisor] getPendingSOAs failed:', e.message);
    return [];
  }
}

// ─── Audit log ────────────────────────────────────────────────────────────────
async function logAudit(actionType, clientId, clientEmail, clientName, payload, brokerApproved = false) {
  await db.query(
    `INSERT INTO audit_log (action_type, client_id, client_email, client_name, description, broker_approved, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actionType, clientId, clientEmail, clientName, JSON.stringify(payload)?.substring(0, 200), brokerApproved, JSON.stringify(payload)]
  ).catch(e => console.error('[Audit] Log write failed:', e.message));
}

module.exports = {
  findClientByEmail,
  getClient,
  createLead,
  updateNotes,
  createTask,
  logPolicy,
  sendBlazeSync,
  getTasksDueToday,
  getPendingSOAs,
  logAudit,
  cacheClient,
};
