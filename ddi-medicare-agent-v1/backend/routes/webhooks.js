const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');
const sparkadvisor = require('../services/sparkadvisor');
const graph = require('../services/graph');
const llm = require('../services/llm');

// ─── Manus Booking Site ───────────────────────────────────────────────────────
router.post('/booking-received', async (req, res) => {
  // Respond immediately so booking site doesn't time out
  res.status(200).json({ received: true });

  const { name, email, phone, appointment_date, notes } = req.body;
  if (!name || !email) {
    console.warn('[Webhook/booking] Missing name or email:', req.body);
    return;
  }

  console.log(`[Webhook/booking] New booking: ${name} <${email}> on ${appointment_date}`);

  try {
    // 1. Parse notes with LLM
    const parsed = await llm.parseBookingNotes(notes || '');

    // 2. Find or create SparkAdvisor record
    let saClient = null;
    try {
      saClient = await sparkadvisor.findClientByEmail(email);
    } catch { /* SparkAdvisor may be unavailable */ }

    let clientCacheId = null;

    if (!saClient) {
      // Create new lead in SparkAdvisor
      try {
        const lead = await sparkadvisor.createLead({
          name, email, phone,
          notes: `[DDI Agent] Booked via ddinsgroup.com. ${notes || ''}`.trim(),
          appointment_date,
          tags: parsed.tags || [],
        });
        console.log(`[Webhook/booking] Created SparkAdvisor lead for ${name}`);

        // Cache locally
        const cached = await db.query(
          `INSERT INTO client_cache (sparkadvisor_id, name, email, phone, raw)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (sparkadvisor_id) DO UPDATE SET name=$2, email=$3, phone=$4
           RETURNING id`,
          [lead?.id || email, name, email, phone, JSON.stringify({ name, email, phone })]
        );
        clientCacheId = cached.rows[0]?.id;
      } catch (e) {
        console.warn('[Webhook/booking] SparkAdvisor lead creation failed:', e.message);
        // Still cache locally
        const cached = await db.query(
          `INSERT INTO client_cache (sparkadvisor_id, name, email, phone, raw)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [`pending_${email}`, name, email, phone, JSON.stringify({ name, email, phone })]
        );
        clientCacheId = cached.rows[0]?.id;
      }
    } else {
      clientCacheId = saClient.id;
    }

    // 3. Store appointment
    await db.query(
      `INSERT INTO appointments (client_id, client_name, client_email, appointment_dt, source, booking_notes, parsed_tags)
       VALUES ($1, $2, $3, $4, 'manus_booking', $5, $6)
       ON CONFLICT DO NOTHING`,
      [clientCacheId, name, email, appointment_date, notes, JSON.stringify(parsed)]
    );

    // 4. Audit log
    await sparkadvisor.logAudit('booking_received', clientCacheId, email, name, req.body, true);

    // 5. Emit real-time update to broker UI
    const io = req.app.get('io');
    if (io) {
      io.emit('new_booking', {
        name, email, phone, appointment_date, notes,
        parsed_tags: parsed,
        is_new_client: !saClient,
      });
    }

    console.log(`[Webhook/booking] Booking processed for ${name}`);
  } catch (e) {
    console.error('[Webhook/booking] Processing error:', e);
  }
});

// ─── Microsoft Graph Calendar Notifications ───────────────────────────────────
router.post('/calendar-event', async (req, res) => {
  // Microsoft validation handshake
  if (req.query.validationToken) {
    return res.status(200).send(req.query.validationToken);
  }

  // Validate clientState
  const clientState = process.env.WEBHOOK_VALIDATION_TOKEN || 'ddi-agent-secret';
  const notifications = req.body?.value || [];

  for (const notification of notifications) {
    if (notification.clientState !== clientState) {
      console.warn('[Webhook/calendar] Invalid clientState:', notification.clientState);
      continue;
    }
  }

  res.status(202).json({ received: true });

  // Process notifications async
  for (const notification of notifications) {
    try {
      await processCalendarEvent(notification, req.app.get('io'));
    } catch (e) {
      console.error('[Webhook/calendar] Event processing error:', e);
    }
  }
});

async function processCalendarEvent(notification, io) {
  const resourceData = notification.resourceData;
  if (!resourceData?.id) return;

  // Fetch full event details
  let event;
  try {
    const token = await graph.getAccessToken();
    const fetch = require('node-fetch');
    const resp = await fetch(
      `https://graph.microsoft.com/v1.0/me/events/${resourceData.id}?$select=id,subject,start,end,attendees,bodyPreview`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    event = await resp.json();
  } catch (e) {
    console.warn('[Webhook/calendar] Could not fetch event details:', e.message);
    return;
  }

  if (!event?.id) return;

  // Check if we already have this from Manus booking
  const existing = await db.query(
    `SELECT id FROM appointments WHERE outlook_event_id = $1 LIMIT 1`,
    [event.id]
  );

  if (!existing.rows[0]) {
    // New appointment not from Manus — try to match to client
    const attendeeEmail = event.attendees?.find(
      a => a.emailAddress?.address?.toLowerCase() !== process.env.BROKER_EMAIL?.toLowerCase()
    )?.emailAddress?.address;

    const cachedClient = attendeeEmail
      ? await db.query(`SELECT * FROM client_cache WHERE LOWER(email) = LOWER($1) LIMIT 1`, [attendeeEmail])
          .then(r => r.rows[0]).catch(() => null)
      : null;

    await db.query(
      `INSERT INTO appointments (client_id, client_name, client_email, appointment_dt, outlook_event_id, source)
       VALUES ($1, $2, $3, $4, $5, 'outlook_calendar')
       ON CONFLICT DO NOTHING`,
      [
        cachedClient?.id || null,
        cachedClient?.name || event.subject,
        attendeeEmail || null,
        event.start?.dateTime,
        event.id,
      ]
    );

    if (io) {
      io.emit('calendar_event', {
        outlook_event_id: event.id,
        subject: event.subject,
        start: event.start?.dateTime,
        attendee_email: attendeeEmail,
        is_matched: !!cachedClient,
        client_name: cachedClient?.name,
      });
    }
  } else {
    // Update existing appointment with Outlook event ID
    await db.query(
      `UPDATE appointments SET outlook_event_id = $1 WHERE id = $2`,
      [event.id, existing.rows[0].id]
    );
  }
}

// ─── SparkAdvisor Webhooks ────────────────────────────────────────────────────
router.post('/sparkadvisor', (req, res) => {
  // Validate HMAC signature (once SparkAdvisor confirms their auth method)
  const signature = req.headers['x-sparkadvisor-signature'];
  if (process.env.SPARKADVISOR_WEBHOOK_SECRET && signature) {
    const expected = crypto
      .createHmac('sha256', process.env.SPARKADVISOR_WEBHOOK_SECRET)
      .update(JSON.stringify(req.body))
      .digest('hex');
    if (signature !== `sha256=${expected}`) {
      console.warn('[Webhook/sparkadvisor] Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  res.status(200).json({ received: true });

  const { event, data } = req.body;
  const io = req.app.get('io');

  console.log(`[Webhook/sparkadvisor] Event: ${event}`);

  switch (event) {
    case 'appointment.created':
    case 'appointment.updated':
      handleSAAppointment(data, io);
      break;
    case 'soa.completed':
      handleSOACompleted(data, io);
      break;
    case 'enrollment.confirmed':
      handleEnrollmentConfirmed(data, io);
      break;
    default:
      console.log(`[Webhook/sparkadvisor] Unhandled event: ${event}`);
  }
});

async function handleSAAppointment(data, io) {
  try {
    await db.query(
      `UPDATE appointments SET soa_completed = $1 WHERE client_email = $2`,
      [data.soa_completed || false, data.client_email]
    );
    if (io) io.emit('sparkadvisor_event', { type: 'appointment', data });
  } catch (e) {
    console.error('[SA/appointment] Handler error:', e);
  }
}

async function handleSOACompleted(data, io) {
  try {
    await db.query(
      `UPDATE client_cache SET soa_status = 'completed', soa_completed_at = now()
       WHERE sparkadvisor_id = $1 OR LOWER(email) = LOWER($2)`,
      [data.client_id, data.client_email]
    );
    await db.query(
      `UPDATE appointments SET soa_completed = true WHERE client_email = $1`,
      [data.client_email]
    );
    console.log(`[SA/soa] SOA completed for client: ${data.client_id}`);
    if (io) io.emit('soa_completed', data);
  } catch (e) {
    console.error('[SA/soa] Handler error:', e);
  }
}

async function handleEnrollmentConfirmed(data, io) {
  try {
    // Log policy
    await sparkadvisor.logPolicy(data.client_id, {
      carrier: data.carrier,
      plan_name: data.plan_name,
      plan_type: data.plan_type,
      effective_date: data.effective_date,
    });

    // Schedule 30-day check-in
    const checkInDate = new Date();
    checkInDate.setDate(checkInDate.getDate() + 30);
    await sparkadvisor.createTask(data.client_id, {
      task_type: 'post_enrollment_checkin',
      description: `30-day post-enrollment check-in for ${data.client_name} — ${data.plan_name}`,
      due_date: checkInDate.toISOString().split('T')[0],
      priority: 'normal',
    });

    // Schedule AEP review
    const aepDate = new Date();
    aepDate.setMonth(9); // October
    aepDate.setDate(1);
    if (aepDate < new Date()) aepDate.setFullYear(aepDate.getFullYear() + 1);
    await sparkadvisor.createTask(data.client_id, {
      task_type: 'aep_review',
      description: `AEP annual review — ${data.client_name} — ${data.carrier} ${data.plan_name}`,
      due_date: aepDate.toISOString().split('T')[0],
      priority: 'normal',
    });

    if (io) io.emit('enrollment_confirmed', data);
    console.log(`[SA/enrollment] Enrollment confirmed + tasks created for ${data.client_id}`);
  } catch (e) {
    console.error('[SA/enrollment] Handler error:', e);
  }
}

module.exports = router;
