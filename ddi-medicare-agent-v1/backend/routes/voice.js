const express = require('express');
const router = express.Router();
const db = require('../db');
const llm = require('../services/llm');
const deepgram = require('../services/deepgram');
const sparkadvisor = require('../services/sparkadvisor');
const graph = require('../services/graph');
const { v4: uuidv4 } = require('uuid');

// ─── Process voice transcript → intent → action ───────────────────────────────
router.post('/process', async (req, res) => {
  const { transcript, session_id, mode } = req.body;
  if (!transcript) return res.status(400).json({ error: 'No transcript provided' });

  console.log(`[Voice] [${mode || 'solo'}] "${transcript}"`);

  try {
    const { intent, entities } = await llm.classifyIntent(transcript);
    console.log(`[Voice] Intent: ${intent}`, entities);

    const result = await routeIntent(intent, entities, session_id, mode, req.app.get('io'));

    // Generate TTS audio for response if not in meeting mode
    let audio = null;
    if (result.tts && mode !== 'meeting') {
      try {
        const audioBuffer = await deepgram.synthesize(result.tts);
        audio = audioBuffer.toString('base64');
      } catch (e) {
        console.warn('[Voice] TTS synthesis failed:', e.message);
      }
    }

    return res.json({ intent, entities, ...result, audio });
  } catch (e) {
    console.error('[Voice] Processing error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// ─── Intent Router ─────────────────────────────────────────────────────────────
async function routeIntent(intent, entities, sessionId, mode, io) {
  switch (intent) {

    case 'brief_me':
      return await handleBriefMe(entities);

    case 'send_soa':
      return await handleSendSOA(entities);

    case 'start_meeting':
      return await handleStartMeeting(entities, io);

    case 'add_note':
      return await handleAddNote(entities, sessionId);

    case 'end_meeting':
      return await handleEndMeeting(sessionId, io);

    case 'approve':
      return await handleApprove(sessionId, io);

    case 'cancel':
      return await handleCancel(sessionId);

    case 'add_task':
      return await handleAddTask(entities);

    case 'new_lead':
      return await handleNewLead(entities);

    case 'check_email':
      return await handleCheckEmail(entities);

    case 'reply_email':
      return await handleReplyEmail(entities, sessionId);

    case 'morning_briefing':
      return { tts: 'Building your morning briefing now.', action: 'trigger_briefing' };

    case 'pull_plans':
      return await handlePullPlans(entities);

    case 'start_enrollment':
      return await handleStartEnrollment(entities);

    case 'unknown':
    default:
      return {
        tts: "I didn't catch that. You can say things like: brief me on a client, send SOA, start meeting, add note, or check emails.",
        action: 'unknown',
      };
  }
}

// ─── Brief Me ─────────────────────────────────────────────────────────────────
async function handleBriefMe(entities) {
  const clientName = entities.client_name;
  if (!clientName) {
    return { tts: 'Who would you like me to brief you on?', action: 'needs_client_name' };
  }

  const client = await findClientByName(clientName);
  if (!client) {
    return {
      tts: `I couldn't find ${clientName} in SparkAdvisor. Want me to search again or add them as a new lead?`,
      action: 'client_not_found',
      entities,
    };
  }

  // Build briefing text
  const parts = [];
  parts.push(`Here's your briefing on ${client.name}.`);

  if (client.dob) {
    const age = Math.floor((Date.now() - new Date(client.dob)) / (365.25 * 24 * 60 * 60 * 1000));
    parts.push(`Age ${age}.`);
  }

  if (client.current_plan && client.carrier) {
    parts.push(`Currently on ${client.carrier} ${client.current_plan}.`);
  }

  const appt = await db.query(
    `SELECT * FROM appointments WHERE client_id = $1 ORDER BY appointment_dt DESC LIMIT 1`,
    [client.id]
  ).then(r => r.rows[0]).catch(() => null);

  if (appt) {
    const soaStatus = appt.soa_completed
      ? 'SOA completed.'
      : 'SOA not yet completed — you may want to confirm before the meeting.';
    parts.push(soaStatus);

    if (appt.parsed_tags?.medicare_interest?.length > 0) {
      parts.push(`They expressed interest in ${appt.parsed_tags.medicare_interest.join(' and ')}.`);
    }
    if (appt.parsed_tags?.t65) {
      parts.push(`They are turning 65 — initial enrollment window applies.`);
    }
    if (appt.booking_notes) {
      parts.push(`Booking notes: ${appt.booking_notes}`);
    }
  }

  parts.push(`Ready for the meeting.`);

  return {
    tts: parts.join(' '),
    action: 'briefing_complete',
    client,
  };
}

// ─── Send SOA ─────────────────────────────────────────────────────────────────
async function handleSendSOA(entities) {
  const clientName = entities.client_name;
  if (!clientName) {
    return { tts: 'Who should I send the SOA to?', action: 'needs_client_name' };
  }

  const client = await findClientByName(clientName);
  if (!client) {
    return { tts: `I couldn't find ${clientName} in SparkAdvisor.`, action: 'client_not_found' };
  }

  // Queue pending action — requires approval
  const pendingId = await queuePendingAction('send_soa', client.sparkadvisor_id, {
    client_id: client.sparkadvisor_id,
    client_name: client.name,
    delivery_method: 'sms',
  }, `Send SOA and BlazeSync link to ${client.name} via text message. Say "send it" to confirm.`);

  return {
    tts: `I'll send the SOA and BlazeSync link to ${client.name} via text. Say "send it" to confirm, or "cancel" to stop.`,
    action: 'pending_approval',
    pending_id: pendingId,
    client,
  };
}

// ─── Start Meeting ─────────────────────────────────────────────────────────────
async function handleStartMeeting(entities, io) {
  const clientName = entities.client_name;
  if (!clientName) {
    return { tts: 'Who is this meeting with?', action: 'needs_client_name' };
  }

  const client = await findClientByName(clientName);

  // Check SOA status
  if (client) {
    const appt = await db.query(
      `SELECT soa_completed FROM appointments WHERE client_id = $1 ORDER BY appointment_dt DESC LIMIT 1`,
      [client.id]
    ).then(r => r.rows[0]).catch(() => null);

    if (appt && !appt.soa_completed) {
      // CMS compliance warning — broker can override
      return {
        tts: `Warning: SOA has not been completed for ${client.name}. CMS requires a completed SOA before presenting plans. Say "override" to proceed anyway, or "send SOA" to send the link now.`,
        action: 'soa_compliance_warning',
        client,
        requires_override: true,
      };
    }
  }

  // Create meeting session
  const sessionId = uuidv4();
  await db.query(
    `INSERT INTO meeting_sessions (id, client_id, client_name)
     VALUES ($1, $2, $3)`,
    [sessionId, client?.id || null, client?.name || clientName]
  );

  if (io) {
    io.emit('meeting_started', {
      session_id: sessionId,
      client_name: client?.name || clientName,
      client,
    });
  }

  return {
    tts: null, // Silent in meeting mode — screen overlay only
    action: 'meeting_started',
    session_id: sessionId,
    mode: 'meeting',
    client,
    screen_message: `Meeting started with ${client?.name || clientName}. Push-to-talk active. Wake word disabled.`,
  };
}

// ─── Add Note ─────────────────────────────────────────────────────────────────
async function handleAddNote(entities, sessionId) {
  const noteText = entities.note_text;
  if (!noteText) {
    return { action: 'no_note_text', screen_message: 'Note not captured — try again' };
  }

  if (sessionId) {
    await db.query(
      `UPDATE meeting_sessions SET notes_raw = array_append(notes_raw, $1) WHERE id = $2`,
      [noteText, sessionId]
    );
  }

  return {
    tts: null, // Silent in meeting mode
    action: 'note_added',
    screen_message: `✓ Note: ${noteText}`,
  };
}

// ─── End Meeting ──────────────────────────────────────────────────────────────
async function handleEndMeeting(sessionId, io) {
  if (!sessionId) {
    return { tts: 'No active meeting session found.', action: 'no_session' };
  }

  const session = await db.query(
    `SELECT * FROM meeting_sessions WHERE id = $1`,
    [sessionId]
  ).then(r => r.rows[0]);

  if (!session) {
    return { tts: 'Could not find the meeting session.', action: 'session_not_found' };
  }

  const notes = session.notes_raw || [];
  if (notes.length === 0) {
    return {
      tts: "I don't have any notes from this meeting. What would you like me to log in SparkAdvisor?",
      action: 'no_notes',
    };
  }

  // Summarize with LLM
  const summary = await llm.summarizeMeeting(notes, session.client_name);

  // Save summary to session
  await db.query(
    `UPDATE meeting_sessions SET summary = $1, action_items = $2, disposition = $3, ended_at = now()
     WHERE id = $4`,
    [summary.summary, JSON.stringify(summary.action_items), summary.disposition, sessionId]
  );

  // Queue pending action (needs broker approval before writing to SparkAdvisor)
  const pendingId = await queuePendingAction(
    'post_meeting_sync',
    session.client_id,
    { session_id: sessionId, summary, client_name: session.client_name },
    summary.tts_readback
  );

  if (io) {
    io.emit('meeting_summary_ready', {
      session_id: sessionId,
      summary,
      pending_id: pendingId,
    });
  }

  return {
    tts: summary.tts_readback + " Say 'looks good' to save to SparkAdvisor, or tell me what to change.",
    action: 'pending_approval',
    pending_id: pendingId,
    summary,
    mode: 'review',
  };
}

// ─── Approve pending action ───────────────────────────────────────────────────
async function handleApprove(sessionId, io) {
  // Find most recent pending action for this session
  const pending = await db.query(
    `SELECT * FROM pending_actions WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1`
  ).then(r => r.rows[0]);

  if (!pending) {
    return { tts: "There's nothing waiting for approval right now.", action: 'nothing_pending' };
  }

  await db.query(`UPDATE pending_actions SET status = 'approved' WHERE id = $1`, [pending.id]);

  try {
    const result = await executePendingAction(pending, io);
    return result;
  } catch (e) {
    return { tts: `Something went wrong: ${e.message}. Please try again.`, action: 'execution_error' };
  }
}

async function executePendingAction(pending, io) {
  const { action_type, client_id, payload } = pending;

  switch (action_type) {
    case 'send_soa': {
      await sparkadvisor.sendBlazeSync(payload.client_id, payload.delivery_method);
      await sparkadvisor.logAudit('send_blazesync', client_id, null, payload.client_name, payload, true);
      if (io) io.emit('soa_sent', payload);
      return { tts: `SOA and BlazeSync link sent to ${payload.client_name}.`, action: 'soa_sent' };
    }

    case 'post_meeting_sync': {
      const session = await db.query(
        `SELECT * FROM meeting_sessions WHERE id = $1`,
        [payload.session_id]
      ).then(r => r.rows[0]);

      if (session && client_id) {
        // Write notes to SparkAdvisor
        await sparkadvisor.updateNotes(
          client_id,
          payload.summary.summary,
          payload.summary.disposition
        );

        // Create tasks
        for (const item of payload.summary.action_items || []) {
          await sparkadvisor.createTask(client_id, {
            description: item.task,
            due_date: item.due_date,
            priority: item.priority || 'normal',
            task_type: 'follow_up',
          });
        }

        // Mark session as synced
        await db.query(
          `UPDATE meeting_sessions SET synced_to_sparkadvisor = true, broker_approved = true WHERE id = $1`,
          [session.id]
        );
      }

      if (io) io.emit('crm_synced', { session_id: payload.session_id, client_name: payload.client_name });
      return {
        tts: `Meeting notes saved to SparkAdvisor for ${payload.client_name}. ${payload.summary.action_items?.length || 0} follow-up tasks created.`,
        action: 'crm_synced',
        mode: 'solo',
      };
    }

    case 'send_email': {
      await graph.sendEmail(payload.to_address, payload.subject, payload.html_body);
      await sparkadvisor.logAudit('email_sent', client_id, payload.to_address, payload.client_name, {
        subject: payload.subject,
        to: payload.to_address,
      }, true);
      if (io) io.emit('email_sent', { to: payload.to_address, subject: payload.subject });
      return { tts: `Email sent to ${payload.client_name}.`, action: 'email_sent' };
    }

    default:
      return { tts: 'Action completed.', action: 'completed' };
  }
}

// ─── Cancel pending action ────────────────────────────────────────────────────
async function handleCancel(sessionId) {
  await db.query(
    `UPDATE pending_actions SET status = 'cancelled' WHERE status = 'pending'`
  );
  return { tts: 'Cancelled.', action: 'cancelled' };
}

// ─── Add Task ─────────────────────────────────────────────────────────────────
async function handleAddTask(entities) {
  const { client_name, time_ref, note_text } = entities;
  if (!client_name) {
    return { tts: 'Which client should I create a task for?', action: 'needs_client_name' };
  }

  const client = await findClientByName(client_name);
  const dueDate = parseDateRef(time_ref) || getTomorrowDate();
  const description = note_text || `Follow up with ${client_name}`;

  if (client) {
    await sparkadvisor.createTask(client.sparkadvisor_id, {
      description,
      due_date: dueDate,
      task_type: 'follow_up',
      priority: 'normal',
    });
  }

  return {
    tts: `Task created: ${description}, due ${time_ref || 'tomorrow'}.`,
    action: 'task_created',
  };
}

// ─── New Lead ─────────────────────────────────────────────────────────────────
async function handleNewLead(entities) {
  const { client_name } = entities;
  if (!client_name) {
    return { tts: "What's their name?", action: 'needs_client_name' };
  }

  return {
    tts: `Got it. What's ${client_name}'s phone number or email?`,
    action: 'collecting_lead_info',
    entities,
  };
}

// ─── Check Email ──────────────────────────────────────────────────────────────
async function handleCheckEmail(entities) {
  try {
    const clientEmails = await db.query(
      `SELECT email FROM client_cache WHERE email IS NOT NULL`
    ).then(r => r.rows.map(r => r.email));

    const emails = await graph.getUnreadClientEmails(clientEmails);

    if (emails.length === 0) {
      return { tts: 'No unread emails from clients right now.', action: 'no_emails', emails: [] };
    }

    const names = emails.slice(0, 3).map(e =>
      `${e.from?.emailAddress?.name || e.from?.emailAddress?.address}: ${e.subject}`
    ).join('. ');

    return {
      tts: `You have ${emails.length} unread client email${emails.length > 1 ? 's' : ''}. ${names}`,
      action: 'emails_fetched',
      emails: emails.slice(0, 10),
    };
  } catch (e) {
    return { tts: "I couldn't check emails right now. Make sure Outlook is connected.", action: 'email_error' };
  }
}

// ─── Reply Email ──────────────────────────────────────────────────────────────
async function handleReplyEmail(entities, sessionId) {
  const { client_name, note_text } = entities;
  if (!client_name || !note_text) {
    return { tts: 'Who should I reply to, and what should I say?', action: 'needs_more_info' };
  }

  const client = await findClientByName(client_name);
  if (!client?.email) {
    return { tts: `I couldn't find an email address for ${client_name}.`, action: 'client_not_found' };
  }

  const draft = await llm.draftEmail(client.name, client.email, note_text);

  const pendingId = await queuePendingAction('send_email', client.sparkadvisor_id, {
    to_address: client.email,
    client_name: client.name,
    subject: draft.subject,
    html_body: `<p>${draft.body.replace(/\n/g, '<br>')}</p>`,
  }, draft.tts_readback);

  return {
    tts: draft.tts_readback + " Say 'send it' to send, or 'cancel' to discard.",
    action: 'pending_approval',
    pending_id: pendingId,
    draft,
  };
}

// ─── Pull Plans ───────────────────────────────────────────────────────────────
async function handlePullPlans(entities) {
  const client = await findClientByName(entities.client_name);
  const sfUrl = process.env.SUNFIREMATRIX_PURL;

  return {
    tts: null,
    action: 'open_sunfire',
    screen_message: `Opening SunfireMatrix for ${client?.name || entities.client_name}`,
    url: sfUrl,
    client,
  };
}

// ─── Start Enrollment ─────────────────────────────────────────────────────────
async function handleStartEnrollment(entities) {
  const client = await findClientByName(entities.client_name);
  const sfUrl = process.env.SUNFIREMATRIX_PURL;

  return {
    tts: `Opening enrollment in SunfireMatrix for ${client?.name || 'client'}. Review all fields before submitting.`,
    action: 'open_enrollment',
    url: sfUrl,
    client,
    screen_message: `⚠️ Review all pre-filled fields before submitting. Broker confirmation required.`,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function findClientByName(name) {
  if (!name) return null;
  const result = await db.query(
    `SELECT * FROM client_cache WHERE LOWER(name) LIKE LOWER($1) LIMIT 1`,
    [`%${name}%`]
  ).catch(() => ({ rows: [] }));
  return result.rows[0] || null;
}

async function queuePendingAction(actionType, clientId, payload, ttsReadback) {
  const id = uuidv4();
  await db.query(
    `INSERT INTO pending_actions (id, action_type, client_id, payload, tts_readback, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')`,
    [id, actionType, clientId, JSON.stringify(payload), ttsReadback]
  );
  return id;
}

function parseDateRef(ref) {
  if (!ref) return null;
  const today = new Date();
  if (ref.includes('week')) {
    today.setDate(today.getDate() + 7 * (parseInt(ref) || 1));
    return today.toISOString().split('T')[0];
  }
  if (ref.includes('day')) {
    today.setDate(today.getDate() + (parseInt(ref) || 1));
    return today.toISOString().split('T')[0];
  }
  if (ref.includes('month')) {
    today.setMonth(today.getMonth() + (parseInt(ref) || 1));
    return today.toISOString().split('T')[0];
  }
  return null;
}

function getTomorrowDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

module.exports = router;
