# Developer Handoff Specification
## Medicare Broker Voice-First AI Agent
**Project:** DDI Medicare Voice Agent  
**Broker:** Larry — DDI Insurance Group  
**Email:** larry@ddinsgroup.com  
**Website:** ddinsgroup.com (Manus AI)  
**Version:** 1.0 — Ready for Development  
**PRD Reference:** Medicare_Voice_AI_Agent_PRD v1.6

---

## 1. System Overview

A voice-first AI desktop agent for a solo Medicare insurance broker. The agent automates the full client lifecycle — from booking through post-meeting CRM sync — using voice commands. Primary interface is a desktop web app the broker keeps open during the workday.

**Primary workflow the agent supports:**
1. Client books on ddinsgroup.com → redirected to SunfireMatrix PURL for SOA + plan review
2. Agent detects booking, creates SparkAdvisor lead, checks SOA status
3. Morning voice briefing consolidates appointments, tasks, and client emails
4. In-person meeting: push-to-talk voice commands for plan lookup, comparisons, enrollment
5. Post-meeting: voice summary → approved → auto-synced to SparkAdvisor

---

## 2. Confirmed Credentials & Identifiers

| Item | Value |
|---|---|
| Broker email | larry@ddinsgroup.com |
| Microsoft tenant | ddinsgroup.com (Microsoft 365 Business) |
| SunfireMatrix PURL | `https://www.sunfirematrix.com/app/consumer/ember/?sfpath=spa&sfagid=20791041` |
| SunfireMatrix Agent ID | `sfagid=20791041` |
| SunfireMatrix FMO | `ember` |
| Booking site | ddinsgroup.com (Manus AI — full-stack, React/Tailwind) |
| Licensed states | Oklahoma, Texas |
| CRM | SparkAdvisor |

**Secrets management:** All API keys, tokens, and OAuth credentials stored in environment variables. Never hardcoded. Use a secrets manager (e.g. AWS Secrets Manager, Doppler, or `.env` with restricted access) for local dev.

---

## 3. Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React + Tailwind CSS | Desktop web app; broker-facing only |
| Backend | Node.js or Python (FastAPI) | Webhook listener, API orchestration |
| STT | Deepgram Nova-3 | Streaming WebSocket for live commands; async batch for post-meeting |
| TTS | Deepgram Aura-2 | REST endpoint; sub-200ms first audio |
| LLM | GPT-4o or Claude 3.5 Sonnet | Summarization, intent classification, email drafting, NLU |
| CRM | SparkAdvisor | PURL reads + webhooks |
| Enrollment | SunfireMatrix (via SparkAdvisor) | Deep-link with sfagid pre-populated |
| Med Supp quoting | CSG Actuarial | Deep-link handoff |
| Email + Calendar | Microsoft Graph API | OAuth 2.0, delegated, larry@ddinsgroup.com |
| Booking intake | Manus AI site (ddinsgroup.com) | Form webhook → auto lead creation |
| Session memory | Redis | Active session context per broker workday |
| Persistent store | PostgreSQL | Client match cache, audit log, sent email log |
| Hosting | Railway, Render, or AWS | Single-region; US-based required for HIPAA |

---

## 4. Integration #1 — Manus AI Booking Site

### What it does
When a client books on ddinsgroup.com, the Manus booking form captures:
- `name` (string)
- `email` (string) — **primary matching key**
- `phone` (string)
- `appointment_date` (ISO 8601 datetime)
- `notes` (free text)

After submission, the client is redirected to:
```
https://www.sunfirematrix.com/app/consumer/ember/?sfpath=spa&sfagid=20791041
```

### Developer task
1. **Access the Manus site codebase** — Manus generates exportable React/Tailwind source code. Export or access the booking form's submission handler.
2. **Add a webhook or server-side POST** on form submission that sends booking data to the agent backend endpoint: `POST /webhooks/booking-received`
3. If Manus doesn't support adding a webhook directly, add a hidden form action or use Manus's built-in notification/integration feature to POST to the agent.

### Booking received handler
```
POST /webhooks/booking-received
Payload:
{
  "name": "Jane Smith",
  "email": "jane@example.com",
  "phone": "405-555-1234",
  "appointment_date": "2026-06-15T14:00:00-05:00",
  "notes": "Turning 65 in July, want to compare Medicare Advantage plans"
}
```

**On receipt:**
1. Search SparkAdvisor for existing record by email
2. If found: link appointment to existing record, update next contact date
3. If not found: create new lead in SparkAdvisor with all captured fields
4. Parse `notes` field with LLM — extract Medicare type signal, urgency, coverage questions — store as structured tags on SparkAdvisor record
5. Log booking in agent's PostgreSQL audit table
6. Queue pre-meeting briefing prep for 30 minutes before `appointment_date`

---

## 5. Integration #2 — Microsoft Graph API (Outlook)

### Setup (one-time)
1. Log into [portal.azure.com](https://portal.azure.com) with larry@ddinsgroup.com
2. Go to Microsoft Entra ID → App registrations → New registration
3. Name: **DDI Medicare Agent**
4. Supported account types: **Accounts in this organizational directory only (ddinsgroup.com)**
5. Redirect URI: `https://[your-agent-domain]/auth/microsoft/callback`
6. After registration, go to API Permissions → Add:
   - `Mail.Read` (delegated)
   - `Mail.Send` (delegated)
   - `Calendars.Read` (delegated)
7. Grant admin consent
8. Create a client secret under Certificates & Secrets — store as `MICROSOFT_CLIENT_SECRET`
9. Note: `client_id` (Application ID) and `tenant_id` (Directory ID) from Overview tab

### Auth flow
```
GET /auth/microsoft → redirect to Microsoft OAuth
GET /auth/microsoft/callback → exchange code for tokens
Store: access_token, refresh_token, expiry in secrets manager
Auto-refresh: refresh access_token before expiry using refresh_token
```

### Calendar — new booking detection
```javascript
// Subscribe to calendar change notifications
POST https://graph.microsoft.com/v1.0/subscriptions
{
  "changeType": "created,updated",
  "notificationUrl": "https://[agent-domain]/webhooks/calendar-event",
  "resource": "/me/events",
  "expirationDateTime": "[48 hours from now]",  // max 4230 min for calendar
  "clientState": "[random secret to validate]"
}
// Renew subscription every 48 hours via cron job
```

**On calendar event webhook:**
```
POST /webhooks/calendar-event
1. Validate clientState
2. Parse event: subject, start, attendees, organizer
3. Match attendee email to SparkAdvisor record
4. If booking already created via Manus webhook: link and confirm
5. If new (no prior Manus webhook): create lead from calendar event data
6. Add to morning briefing queue
```

### Email — client email fetch
```javascript
// Fetch unread emails from known client addresses
GET /me/messages
  ?$filter=isRead eq false and from/emailAddress/address in [client_email_list]
  &$select=id,subject,from,receivedDateTime,bodyPreview,body
  &$orderby=receivedDateTime desc
  &$top=50

// Mark as read after broker reviews
PATCH /me/messages/{id}
{ "isRead": true }
```

### Email — send on broker approval
```javascript
POST /me/sendMail
{
  "message": {
    "subject": "[drafted subject]",
    "body": { "contentType": "HTML", "content": "[drafted body]" },
    "toRecipients": [{ "emailAddress": { "address": "[client email]" } }]
  },
  "saveToSentItems": true
}
// After send: log to SparkAdvisor activity record + PostgreSQL audit log
```

---

## 6. Integration #3 — SparkAdvisor

### Method
SparkAdvisor uses **PURL links** for data reads and **webhooks** for event push.

**Critical first step:** Open a support ticket with SparkAdvisor requesting:
- Full webhook event catalog (event names, payload schemas)
- Webhook authentication method (HMAC signature or token)
- Whether these events are available: `appointment.created`, `soa.completed`, `enrollment.confirmed`
- PURL read format and available fields per client record

### PURL read (client data)
```
GET https://sparkadvisor.com/api/client/{client_id}
// or PURL format — confirm exact endpoint with SparkAdvisor support
Headers: Authorization: Bearer {SPARKADVISOR_API_KEY}

Returns: name, DOB, Medicare ID, address, phone, email,
         current plan(s), carrier, premium, anniversary date,
         drug list, preferred providers, open tasks, last activity
```

### Webhook listener
```
POST /webhooks/sparkadvisor
Headers: X-SparkAdvisor-Signature: {hmac_signature}  // validate before processing

Events to handle:
- appointment.created → trigger pre-meeting briefing prep
- appointment.updated → update briefing queue
- soa.completed → update SOA status flag; alert broker if < 24h before meeting
- enrollment.confirmed → log policy; create 30-day check-in task; create AEP task
```

### Writes to SparkAdvisor (via webhook payload)
All writes confirmed by broker verbally before executing:
```
POST /webhooks/sparkadvisor-write  // or SparkAdvisor's designated write endpoint

Supported write types:
- create_lead: { name, email, phone, source, notes, appointment_date }
- update_notes: { client_id, note_text, call_date, disposition }
- create_task: { client_id, due_date, task_type, description, priority }
- log_policy: { client_id, carrier, plan_name, effective_date, plan_type }
- upload_document: { client_id, doc_type: "SOA", file: base64_pdf }
- send_blazesync: { client_id, delivery_method: "sms"|"email" }
```

---

## 7. Integration #4 — Deepgram (STT + TTS)

### Setup
1. Create Deepgram account at deepgram.com
2. **Sign HIPAA BAA** before storing any API key — this is a prerequisite, not optional
3. Store API key as `DEEPGRAM_API_KEY`

### STT — broker voice commands (streaming)
```javascript
// WebSocket connection for push-to-talk
const ws = new WebSocket('wss://api.deepgram.com/v1/listen', {
  headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }
})
// Params:
{
  model: 'nova-3',
  language: 'en-US',
  smart_format: true,
  punctuate: true,
  interim_results: false,  // final transcripts only for command processing
  endpointing: 300         // 300ms silence = end of utterance
}

// On transcript received → pass to intent classifier
```

### STT — post-meeting summary (async batch)
```javascript
// After meeting ends, transcribe full session notes
POST https://api.deepgram.com/v1/listen
Headers: Authorization: Token {DEEPGRAM_API_KEY}
Body: audio file or URL
Params: model=nova-3&smart_format=true&punctuate=true&diarize=true
// diarize=true to separate broker voice notes from any ambient audio
```

### TTS — agent voice output
```javascript
// Morning briefing, confirmations, summaries
POST https://api.deepgram.com/v1/speak
Headers: Authorization: Token {DEEPGRAM_API_KEY}
Body: { "text": "[briefing text]" }
Params: model=aura-2-thalia-en  // professional female voice; or aura-2-orion-en (male)
// Returns: audio/mpeg stream → pipe to browser audio output
```

**Voice rule:** TTS never auto-plays during meeting mode. Only plays when broker is alone (solo mode) or explicitly triggers readback with push-to-talk.

---

## 8. Integration #5 — SunfireMatrix

SunfireMatrix does not expose a public API for third-party developers. Integration is through:

### Deep-link launch (enrollment)
```
Broker's agent portal:
https://www.sunfirematrix.com/app/agent/ember/
// Broker logs in once; session maintained in browser

Client enrollment via broker PURL:
https://www.sunfirematrix.com/app/consumer/ember/?sfpath=spa&sfagid=20791041
// This URL is sent to clients post-booking (already live on ddinsgroup.com)
```

**At enrollment trigger (UC-5):**
1. Agent opens SparkAdvisor's native Sunfire enrollment flow (SparkAdvisor embeds SunfireMatrix)
2. Client data is pre-staged inside SparkAdvisor's Sunfire integration (drugs, providers, demographics pulled from BlazeSync + SparkAdvisor record)
3. Broker reviews and submits
4. Enrollment confirmation webhook from SparkAdvisor triggers policy log

### CSG Actuarial (Medicare Supplement fallback)
```
// Deep-link with pre-fill params — confirm exact URL format with CSG Actuarial
https://csgactuarial.com/[broker-portal]?zip={zip}&dob={dob}&gender={gender}
```

---

## 9. LLM Integration

### Model
- **Primary:** `gpt-4o` or `claude-3-5-sonnet-20241022`
- **Cost optimization:** Use smaller model (GPT-4o-mini or Claude Haiku) for intent classification only; full model for summarization and email drafting

### Key prompts to build

**Intent classifier** (fast, cheap model):
```
System: You are an intent classifier for a Medicare insurance broker AI assistant.
Classify the broker's voice command into one of these intents:
[brief_me, send_soa, start_meeting, pull_plans, compare_plans, start_enrollment,
 add_note, end_meeting, check_email, reply_email, add_task, new_lead, morning_briefing]
Return JSON: { "intent": "...", "entities": { "client_name": "...", "plan_name": "..." } }
User: {transcript}
```

**Post-meeting summarizer:**
```
System: You are summarizing a Medicare broker's meeting notes.
Extract: client goals, plans discussed, client reactions, objections, agreed next steps, action items with due dates.
Return JSON: { "summary": "...", "action_items": [{ "task": "...", "due_date": "..." }], "disposition": "enrolled|follow_up|declined|callback" }
Notes: {raw_notes}
```

**Email drafter:**
```
System: You are drafting a professional email on behalf of Larry at DDI Insurance Group (larry@ddinsgroup.com).
Write in a warm, professional tone appropriate for Medicare clients.
Keep it concise — 3-5 sentences unless more detail is required.
Sign off as: Larry | DDI Insurance Group | larry@ddinsgroup.com
User: Draft a reply to {client_name} saying: {broker_instruction}
Context from prior emails: {thread_summary}
```

**Booking notes parser:**
```
System: Parse this Medicare appointment booking note. Extract any signals about:
Medicare type interest (MA, PDP, Medigap, DSNP), current coverage status,
urgency indicators, T65 status, special needs flags.
Return JSON: { "medicare_interest": [...], "t65": true|false, "current_coverage": "...", "urgency": "high|normal", "tags": [...] }
Notes: {booking_notes}
```

---

## 10. Voice Command → Action Routing

| Voice Command | Intent | Action |
|---|---|---|
| "Brief me on [name]" | `brief_me` | Fetch SparkAdvisor PURL → TTS briefing |
| "Send SOA to [name]" | `send_soa` | Send BlazeSync via SparkAdvisor webhook |
| "Start meeting with [name]" | `start_meeting` | Activate meeting mode; disable wake word; enable push-to-talk only |
| "Pull up plans for [name]" | `pull_plans` | Open SparkAdvisor Sunfire with client pre-staged |
| "Compare [Plan A] and [Plan B]" | `compare_plans` | Side-by-side on screen + TTS top 3 diffs |
| "Start enrollment" | `start_enrollment` | Launch Sunfire enrollment; auto-fill broker writing number |
| "Add note: [text]" | `add_note` | Append to session notes buffer |
| "End meeting — summarize" | `end_meeting` | LLM summary → TTS readback → await approval |
| "Looks good" / "Send it" | `approve` | Execute pending SparkAdvisor write or email send |
| "Check emails" | `check_email` | Graph API fetch → TTS summary |
| "Reply to [name] — [instruction]" | `reply_email` | LLM draft → TTS readback → await approval |
| "Add new lead — [details]" | `new_lead` | Create SparkAdvisor record |
| "Remind me to call [name] in [time]" | `add_task` | Create SparkAdvisor task |

---

## 11. Morning Briefing — Data Assembly

Run daily at broker's configured time (suggest 8:00 AM CT). Assemble from three sources:

```python
def build_morning_briefing():
    # 1. SparkAdvisor tasks
    tasks_due = sparkadvisor.get_tasks(due_date=today, status="open")
    soas_pending = sparkadvisor.get_clients(soa_status="sent", soa_completed=False)

    # 2. Outlook Calendar — next 7 days
    calendar_events = graph.get_calendar_view(start=today, end=today+7days)
    appointments = match_events_to_sparkadvisor(calendar_events)

    # 3. Outlook Email — unread from known clients
    client_emails = graph.get_unread_messages(from_addresses=known_client_emails)
    email_summary = llm.summarize_emails(client_emails)

    # 4. State-specific eligibility alerts (OK + TX)
    eligibility_alerts = check_eligibility_windows(broker_state=["OK","TX"])
    # - T65 clients: 90/60/30-day windows
    # - AEP Oct 15 – Dec 7: flag if within 30 days
    # - SEP flags: Medicaid status, loss of coverage

    # 5. Build TTS script
    script = llm.build_briefing_script(tasks_due, appointments, email_summary, eligibility_alerts)
    audio = deepgram.tts(script, model="aura-2-thalia-en")
    return audio
```

**Sample briefing script output:**
> "Good morning, Larry. Today is Tuesday June 10th. You have 2 appointments today — Jane Smith at 10am, SOA completed, Medicare Advantage interest noted. New prospect Tom Brown at 2pm, no SparkAdvisor record yet — I'll prompt you to add him. You have 3 follow-up tasks due today: call Carol White, resend SOA to David Green, and follow up with Bob Jones on his drug coverage question. You have 4 unread client emails — Jane Smith replied about her plan comparison, and Mary Davis confirmed Thursday. Also: Susan Lee turns 65 in 60 days — her initial enrollment window opens August 1st. Ready to start?"

---

## 12. Oklahoma & Texas Eligibility Logic

```python
def check_eligibility_windows(clients, states=["OK","TX"]):
    alerts = []
    today = date.today()

    for client in clients:
        # T65 window alerts
        if client.part_b_effective_date:
            days_until = (client.part_b_effective_date - today).days
            if days_until in [90, 60, 30, 0]:
                alerts.append(T65Alert(client, days_until))

        # AEP window (Oct 15 – Dec 7)
        aep_start = date(today.year, 10, 15)
        days_to_aep = (aep_start - today).days
        if 0 < days_to_aep <= 30:
            alerts.append(AEPAlert(client))

        # SEP triggers
        if client.medicaid_status_changed:
            alerts.append(SEPAlert(client, reason="dual_eligible"))
        if client.loss_of_coverage_date:
            sep_deadline = client.loss_of_coverage_date + timedelta(days=63)
            if today <= sep_deadline:
                alerts.append(SEPAlert(client, reason="loss_of_coverage"))

        # OK + TX: NO birthday rule for Medigap
        # Medigap guaranteed issue only during:
        # - 6-month initial Medigap OEP (starts on Part B effective date)
        # - Federal SEP triggers (loss of MA, etc.)
        # Do NOT generate birthday month Medigap alerts for OK or TX

    return alerts
```

---

## 13. Compliance Requirements (Non-Negotiable)

### HIPAA
- [ ] Deepgram HIPAA BAA signed before first API call with PHI audio
- [ ] All PHI transmitted over TLS 1.3 minimum
- [ ] PHI at rest encrypted AES-256
- [ ] No raw audio stored outside SparkAdvisor's native recording system
- [ ] Deepgram processes audio in-memory; no secondary audio store
- [ ] Audit log table: every SparkAdvisor write and email send logged with timestamp, action type, client ID, broker_approved=true

### CMS Rules
- [ ] SOA must be marked complete before agent allows meeting mode to fully activate
  - If SOA incomplete: show warning — "SOA not completed for [client]. Proceeding without a completed SOA may violate CMS requirements. Continue anyway?" (broker can override with confirmation)
- [ ] Agent never recommends a specific plan — presents data only
- [ ] SOA language (if agent-generated) must use CMS model verbatim
- [ ] Enrollment: broker always manually reviews and submits — no autonomous submission

### Email
- [ ] Agent never sends email without explicit broker verbal "Send it" approval
- [ ] Every sent email logged in audit table: timestamp, to, subject, client_id
- [ ] SparkAdvisor activity record updated after every sent email

### Audit log schema
```sql
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  action_type VARCHAR(50) NOT NULL,  -- 'sparkadvisor_write', 'email_sent', 'enrollment_triggered'
  client_id VARCHAR(100),
  client_email VARCHAR(255),
  description TEXT,
  broker_approved BOOLEAN NOT NULL DEFAULT false,
  payload JSONB,
  retention_until DATE  -- 7 years from timestamp per CMS
);
```

---

## 14. Frontend — UI Modes

The agent desktop app has three distinct modes:

### Solo Mode (default)
- Wake word active: "Hey Spark"
- TTS auto-plays for all agent responses
- Full voice command set available
- Morning briefing auto-plays at configured time

### Meeting Mode (activated by "Start meeting with [name]")
- Wake word **disabled** — push-to-talk only (keyboard shortcut or on-screen button)
- TTS **disabled** — all output is screen overlay only
- Right-side panel shows: client summary card, plan comparison data, active notes buffer
- "Add note: [text]" appends to notes in real time
- Client-facing display (if second screen connected) shows only Sunfire plan comparison — no agent UI visible

### Review Mode (activated by "End meeting — summarize")
- Agent reads summary aloud for broker approval
- Broker says "Looks good" to approve or verbally corrects any item
- After approval: all writes execute simultaneously
- Returns to Solo Mode after completion

---

## 15. Phase 1 Deliverables (Weeks 1–6)

**Goal:** Working voice → SparkAdvisor + Outlook loop. Broker can run mornings and post-meetings with voice.

### Must-have for Phase 1 sign-off:
- [ ] Deepgram HIPAA BAA signed
- [ ] SparkAdvisor webhook schema confirmed; webhook listener live and tested
- [ ] Microsoft Entra ID app registered under ddinsgroup.com; OAuth flow working
- [ ] Manus booking site webhook confirmed and POSTing to `/webhooks/booking-received`
- [ ] `POST /webhooks/booking-received` → SparkAdvisor lead creation working end-to-end
- [ ] Microsoft Graph calendar change notification subscription live
- [ ] Morning briefing assembles and plays via Deepgram TTS (all 3 sources)
- [ ] UC-1: Pre-meeting briefing by voice command working
- [ ] UC-2: SOA dispatch ("Send SOA to [name]") working
- [ ] UC-4: Post-meeting summary → TTS readback → broker approval → SparkAdvisor write working
- [ ] Audit log writing on every SparkAdvisor write and email send
- [ ] Basic React frontend: solo mode UI, push-to-talk button, client summary card

### Phase 1 is NOT:
- Meeting mode (Phase 2)
- Email read/draft/send (Phase 2)
- Enrollment launch (Phase 2)
- Plan comparison (Phase 2)
- Mobile app (Phase 3)

---

## 16. Phase 2 Deliverables (Weeks 7–12)

- [ ] UC-3: In-person meeting mode (push-to-talk, screen overlay, notes buffer)
- [ ] UC-4: Plan comparison assist (SunfireMatrix pre-stage + CSG Actuarial for Med Supp)
- [ ] UC-5: SunfireMatrix enrollment launch (broker writing number auto-populated)
- [ ] UC-6: Post-meeting summary with real-time notes integration
- [ ] UC-9: Outlook email read, summarize, draft, send on approval
- [ ] OK/TX eligibility flag logic in morning briefing
- [ ] SOA compliance gate in meeting mode
- [ ] Meeting mode UI: right-side overlay panel, push-to-talk button, notes display

---

## 17. Phase 3 Deliverables (Weeks 13–18)

- [ ] UC-8: Lead intake by voice ("Add new lead — [details]")
- [ ] Compliance audit log dashboard (read-only UI for broker)
- [ ] Mobile-responsive voice interface (iOS Safari, Android Chrome)
- [ ] AEP season automation: bulk outreach task creation for full book
- [ ] Performance monitoring: latency dashboard for STT, TTS, LLM, API calls

---

## 18. Environment Variables Required

```env
# Deepgram
DEEPGRAM_API_KEY=

# Microsoft Graph
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=          # ddinsgroup.com tenant
MICROSOFT_REDIRECT_URI=

# SparkAdvisor
SPARKADVISOR_API_KEY=
SPARKADVISOR_WEBHOOK_SECRET=  # for HMAC validation

# LLM
OPENAI_API_KEY=               # or ANTHROPIC_API_KEY
LLM_MODEL=gpt-4o

# Database
DATABASE_URL=                 # PostgreSQL connection string
REDIS_URL=                    # Redis for session memory

# App
BROKER_EMAIL=larry@ddinsgroup.com
BROKER_NPN=20791041
SUNFIREMATRIX_PURL=https://www.sunfirematrix.com/app/consumer/ember/?sfpath=spa&sfagid=20791041
MORNING_BRIEFING_TIME=08:00   # CT
```

---

## 19. First Week Checklist (Developer Day 1–5)

| Day | Task |
|---|---|
| 1 | Clone/scaffold project. Set up PostgreSQL + Redis locally. Confirm Deepgram account + BAA status. |
| 1 | Open SparkAdvisor support ticket: request webhook catalog, payload schemas, auth method. |
| 2 | Register Microsoft Entra ID app under ddinsgroup.com. Complete OAuth flow. Test `GET /me/messages` and `GET /me/calendarView`. |
| 2 | Access Manus site codebase (ddinsgroup.com). Identify booking form submission handler. Add webhook POST to agent endpoint. Test with sample booking. |
| 3 | Deepgram STT: build push-to-talk WebSocket connection. Test live transcription with broker's voice. |
| 3 | Deepgram TTS: build REST call + audio playback in browser. Test morning briefing script. |
| 4 | Build intent classifier prompt. Test with 20 sample broker commands. Target >90% accuracy. |
| 4 | Build SparkAdvisor PURL fetch. Map response fields to agent data model. |
| 5 | Wire together: booking webhook → SparkAdvisor lead create → calendar event → morning briefing queue. Test full Phase 1 loop end-to-end with test data. |

---

*Handoff document v1.0 — all decisions finalized, credentials confirmed, ready for development*  
*Contact: larry@ddinsgroup.com*
