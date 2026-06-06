const sparkadvisor = require('./sparkadvisor');
const graph = require('./graph');
const deepgram = require('./deepgram');
const llm = require('./llm');
const { checkEligibilityWindows } = require('./eligibility');
const db = require('../db');

async function buildAndPlayMorningBriefing(io) {
  console.log('[Briefing] Building morning briefing...');

  try {
    // 1. SparkAdvisor: tasks due today + pending SOAs
    const [tasks, pendingSOAs] = await Promise.allSettled([
      sparkadvisor.getTasksDueToday(),
      sparkadvisor.getPendingSOAs(),
    ]);
    const tasksDue = tasks.status === 'fulfilled' ? tasks.value : [];
    const soasPending = pendingSOAs.status === 'fulfilled' ? pendingSOAs.value : [];

    // 2. Outlook Calendar: next 7 days
    let appointments = [];
    try {
      const calEvents = await graph.getUpcomingAppointments(7);
      appointments = await matchCalendarToClients(calEvents);
    } catch (e) {
      console.warn('[Briefing] Calendar fetch failed:', e.message);
    }

    // 3. Outlook Email: unread client emails
    let emailSummary = [];
    try {
      const clientEmails = await getKnownClientEmails();
      const unreadEmails = await graph.getUnreadClientEmails(clientEmails);
      emailSummary = unreadEmails.slice(0, 10).map(e => ({
        from_name: e.from?.emailAddress?.name || e.from?.emailAddress?.address,
        from_email: e.from?.emailAddress?.address,
        subject: e.subject,
        preview: e.bodyPreview?.substring(0, 100),
      }));
    } catch (e) {
      console.warn('[Briefing] Email fetch failed:', e.message);
    }

    // 4. Eligibility alerts (OK + TX clients)
    let eligibilityAlerts = [];
    try {
      const clients = await db.query(`SELECT * FROM client_cache WHERE state IN ('OK','TX') LIMIT 200`);
      eligibilityAlerts = checkEligibilityWindows(clients.rows);
    } catch (e) {
      console.warn('[Briefing] Eligibility check failed:', e.message);
    }

    // 5. Build script with LLM
    const allTasks = [
      ...tasksDue,
      ...soasPending.map(c => ({
        description: `Resend SOA to ${c.name}`,
        client_name: c.name,
        priority: 'high',
        type: 'soa_followup',
      })),
    ];

    const script = await llm.buildBriefingScript({
      tasks: allTasks,
      appointments,
      emailSummary,
      eligibilityAlerts: eligibilityAlerts.slice(0, 5), // top 5 only
      brokerName: process.env.BROKER_NAME || 'Larry',
    });

    // 6. Synthesize audio
    const audioBuffer = await deepgram.synthesize(script);
    const audioBase64 = audioBuffer.toString('base64');

    // 7. Emit to frontend
    if (io) {
      io.emit('morning_briefing', {
        script,
        audio: audioBase64,
        data: {
          appointments,
          tasks: allTasks,
          emails: emailSummary,
          alerts: eligibilityAlerts,
        },
      });
    }

    console.log('[Briefing] Morning briefing delivered');
    return { script, appointments, tasks: allTasks, emails: emailSummary };
  } catch (e) {
    console.error('[Briefing] Failed to build morning briefing:', e);
    throw e;
  }
}

async function matchCalendarToClients(calEvents) {
  const results = [];

  for (const event of calEvents) {
    const attendeeEmails = event.attendees?.map(a => a.emailAddress?.address).filter(Boolean) || [];
    let matchedClient = null;

    for (const email of attendeeEmails) {
      if (email.toLowerCase() === process.env.BROKER_EMAIL?.toLowerCase()) continue;

      const cached = await db.query(
        `SELECT * FROM client_cache WHERE LOWER(email) = LOWER($1) LIMIT 1`,
        [email]
      ).catch(() => ({ rows: [] }));

      if (cached.rows[0]) {
        matchedClient = cached.rows[0];
        break;
      }
    }

    // Also check appointments table from Manus booking
    const booked = await db.query(
      `SELECT * FROM appointments WHERE outlook_event_id = $1 LIMIT 1`,
      [event.id]
    ).catch(() => ({ rows: [] }));

    results.push({
      outlook_event_id: event.id,
      client_id: matchedClient?.id || booked.rows[0]?.client_id || null,
      client_name: matchedClient?.name || booked.rows[0]?.client_name || event.subject,
      client_email: matchedClient?.email || booked.rows[0]?.client_email || attendeeEmails.find(e => e !== process.env.BROKER_EMAIL),
      appointment_dt: event.start?.dateTime,
      soa_completed: matchedClient?.soa_status === 'completed' || booked.rows[0]?.soa_completed || false,
      is_new_client: !matchedClient && !booked.rows[0],
      parsed_tags: booked.rows[0]?.parsed_tags || {},
      source: 'outlook_calendar',
    });
  }

  return results;
}

async function getKnownClientEmails() {
  const result = await db.query(`SELECT email FROM client_cache WHERE email IS NOT NULL LIMIT 1000`);
  return result.rows.map(r => r.email).filter(Boolean);
}

module.exports = { buildAndPlayMorningBriefing };
