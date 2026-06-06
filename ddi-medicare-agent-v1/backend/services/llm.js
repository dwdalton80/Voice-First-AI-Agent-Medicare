const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const INTENTS = [
  'brief_me', 'send_soa', 'start_meeting', 'pull_plans', 'compare_plans',
  'start_enrollment', 'add_note', 'end_meeting', 'approve', 'cancel',
  'check_email', 'reply_email', 'add_task', 'new_lead', 'morning_briefing', 'unknown'
];

// ─── Intent Classification (fast) ───────────────────────────────────────────
async function classifyIntent(transcript) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 200,
    system: `You are an intent classifier for a Medicare insurance broker AI assistant named Spark.
Classify the broker's voice command into exactly one intent from this list:
${INTENTS.join(', ')}

Extract named entities when present.

Return ONLY valid JSON in this exact format:
{"intent": "intent_name", "entities": {"client_name": "...", "plan_name": "...", "time_ref": "...", "note_text": "..."}}

Rules:
- "Looks good", "Send it", "Confirmed", "Yes do it" → approve
- "Cancel", "Never mind", "Stop" → cancel
- "Brief me on Jane" → brief_me with client_name: "Jane"
- "Add note: she prefers HMO" → add_note with note_text: "she prefers HMO"
- "Remind me to call Bob in 2 weeks" → add_task with client_name: "Bob", time_ref: "2 weeks"
- If unclear → unknown`,
    messages: [{ role: 'user', content: transcript }]
  });

  try {
    return JSON.parse(response.content[0].text);
  } catch {
    return { intent: 'unknown', entities: {} };
  }
}

// ─── Post-Meeting Summarizer ─────────────────────────────────────────────────
async function summarizeMeeting(notes, clientName) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: `You are summarizing notes from a Medicare insurance broker's in-person client meeting.
The broker is Larry at DDI Insurance Group, licensed in Oklahoma and Texas.

Extract and structure the following. Return ONLY valid JSON:
{
  "summary": "2-3 sentence narrative summary of the meeting",
  "client_goals": ["..."],
  "plans_discussed": [{"carrier": "...", "plan_name": "...", "type": "MA|PDP|Medigap|DSNP", "client_reaction": "positive|neutral|negative"}],
  "objections": ["..."],
  "next_steps": ["..."],
  "action_items": [{"task": "...", "due_date": "YYYY-MM-DD or relative like 'in 2 weeks'", "priority": "high|normal"}],
  "disposition": "enrolled|follow_up|declined|callback|pending_info",
  "tts_readback": "A natural spoken summary Larry can listen to for approval, 3-5 sentences"
}`,
    messages: [{
      role: 'user',
      content: `Client name: ${clientName}\n\nMeeting notes:\n${notes.join('\n')}`
    }]
  });

  try {
    return JSON.parse(response.content[0].text);
  } catch (e) {
    return { summary: notes.join(' '), action_items: [], disposition: 'follow_up', tts_readback: notes.join(' ') };
  }
}

// ─── Email Drafter ───────────────────────────────────────────────────────────
async function draftEmail(clientName, clientEmail, brokerInstruction, threadContext = '') {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 500,
    system: `You are drafting a professional email on behalf of Larry at DDI Insurance Group.
Email: larry@ddinsgroup.com

Tone: Warm, professional, clear. Appropriate for Medicare-eligible clients (often 60-70+ years old).
Length: 3-5 sentences unless more detail is genuinely needed.
Sign-off: Larry | DDI Insurance Group | larry@ddinsgroup.com | (Your phone number)

Return ONLY valid JSON:
{"subject": "...", "body": "...", "tts_readback": "Here's the draft email to [name]: [subject line]. [first 2 sentences of body]. Want me to send it?"}`,
    messages: [{
      role: 'user',
      content: `Client name: ${clientName}
Client email: ${clientEmail}
${threadContext ? `Prior email context: ${threadContext}` : ''}

Larry's instruction: ${brokerInstruction}`
    }]
  });

  try {
    return JSON.parse(response.content[0].text);
  } catch {
    return { subject: 'Follow up', body: brokerInstruction, tts_readback: `Draft ready. Want me to send it?` };
  }
}

// ─── Booking Notes Parser ────────────────────────────────────────────────────
async function parseBookingNotes(notes) {
  if (!notes || notes.trim().length < 3) {
    return { medicare_interest: [], t65: false, current_coverage: 'unknown', urgency: 'normal', tags: [] };
  }

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    system: `Parse Medicare appointment booking notes. Return ONLY valid JSON:
{
  "medicare_interest": ["MA", "PDP", "Medigap", "DSNP"] (subset based on notes),
  "t65": true/false (are they turning 65?),
  "current_coverage": "employer|COBRA|Medicaid|Medicare|none|unknown",
  "urgency": "high|normal",
  "tags": ["turning_65", "losing_coverage", "plan_change", "new_to_medicare", "special_needs", "drug_coverage_question"]
}`,
    messages: [{ role: 'user', content: notes }]
  });

  try {
    return JSON.parse(response.content[0].text);
  } catch {
    return { medicare_interest: [], t65: false, current_coverage: 'unknown', urgency: 'normal', tags: [] };
  }
}

// ─── Morning Briefing Script Builder ────────────────────────────────────────
async function buildBriefingScript({ tasks, appointments, emailSummary, eligibilityAlerts, brokerName }) {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    timeZone: 'America/Chicago'
  });

  const context = {
    date: today,
    broker_name: brokerName || 'Larry',
    appointments: appointments.map(a => ({
      client: a.client_name,
      time: new Date(a.appointment_dt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' }),
      soa_done: a.soa_completed,
      is_new: !a.client_id,
      tags: a.parsed_tags?.tags || []
    })),
    tasks_due: tasks.map(t => ({ description: t.description, client: t.client_name, priority: t.priority })),
    emails: emailSummary,
    eligibility_alerts: eligibilityAlerts
  };

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    system: `You are Spark, a voice AI assistant for Larry, a Medicare insurance broker at DDI Insurance Group in Oklahoma and Texas.
Build a concise, natural-sounding morning briefing script for text-to-speech playback.
Speak directly to Larry. Be specific with names and times.
Keep it under 90 seconds when spoken (roughly 200-250 words).
End with "Ready to start?"
Don't use bullet-point language — speak in natural flowing sentences.
Prioritize: appointments first, urgent tasks, important emails, eligibility alerts.`,
    messages: [{
      role: 'user',
      content: `Build the morning briefing from this data:\n${JSON.stringify(context, null, 2)}`
    }]
  });

  return response.content[0].text;
}

module.exports = {
  classifyIntent,
  summarizeMeeting,
  draftEmail,
  parseBookingNotes,
  buildBriefingScript,
};
