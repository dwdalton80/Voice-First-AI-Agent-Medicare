# DDI Medicare Voice Agent

Voice-first AI assistant for Larry at DDI Insurance Group.  
Automates the full Medicare client lifecycle — booking → SOA → meeting → enrollment → CRM sync.

**Broker:** Larry | larry@ddinsgroup.com  
**NPN:** 20791041  
**States:** Oklahoma & Texas  
**SunfireMatrix PURL:** https://www.sunfirematrix.com/app/consumer/ember/?sfpath=spa&sfagid=20791041

---

## Architecture

```
ddinsgroup.com (Manus AI booking)
    ↓ webhook on booking
Backend (Node.js + Express + Socket.IO)
    ↓ intent routing
Deepgram Nova-3 (STT) + Aura-2 (TTS)
    ↓ LLM processing
Claude / GPT-4o (summarization, intent, drafting)
    ↓ writes
SparkAdvisor (CRM) + Microsoft Graph (Outlook)
    ↓ enrollment
SunfireMatrix (via SparkAdvisor)
```

---

## Prerequisites

Before setup, complete these steps:

- [ ] **Deepgram HIPAA BAA** — sign at deepgram.com before any PHI audio is processed
- [ ] **SparkAdvisor webhook schema** — open support ticket, get event names + payload format
- [ ] **Microsoft Entra ID app** — register at portal.azure.com under ddinsgroup.com (see below)
- [ ] **PostgreSQL** — local or hosted (Railway, Supabase, Neon)
- [ ] **Redis** — local or hosted (Railway, Upstash)
- [ ] **Node.js 18+**

---

## Setup

### 1. Clone and install

```bash
# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### 2. Configure environment

```bash
cd backend
cp .env.example .env
# Fill in all values in .env
```

### 3. Set up database

```bash
psql -d ddi_agent -f backend/db/schema.sql
# Or create the DB first:
# createdb ddi_agent && psql -d ddi_agent -f backend/db/schema.sql
```

### 4. Register Microsoft Entra ID app (one-time)

1. Go to [portal.azure.com](https://portal.azure.com) — sign in as larry@ddinsgroup.com
2. Microsoft Entra ID → App registrations → **New registration**
3. Name: `DDI Medicare Agent`
4. Supported account types: **Accounts in this organizational directory only**
5. Redirect URI: `http://localhost:3001/auth/microsoft/callback` (add production URL later)
6. **API Permissions** → Add: `Mail.Read`, `Mail.Send`, `Calendars.Read` (all Delegated)
7. **Grant admin consent**
8. **Certificates & Secrets** → New client secret → copy value
9. Copy **Application (client) ID** and **Directory (tenant) ID** from Overview

Add to `.env`:
```
MICROSOFT_CLIENT_ID=<Application ID>
MICROSOFT_CLIENT_SECRET=<Secret value>
MICROSOFT_TENANT_ID=<Directory ID>
```

### 5. Connect Outlook (one-time per browser)

```bash
# Start backend first
npm run dev

# Visit in browser:
http://localhost:3001/auth/microsoft
# Complete OAuth flow with larry@ddinsgroup.com
```

### 6. Configure Manus booking site webhook

In your ddinsgroup.com booking form submission handler, add a POST to:
```
POST http://localhost:3001/webhooks/booking-received
Content-Type: application/json

{
  "name": "...",
  "email": "...",
  "phone": "...",
  "appointment_date": "2026-06-15T14:00:00-05:00",
  "notes": "..."
}
```

For production, use your deployed backend URL.

---

## Running

```bash
# Terminal 1 — Backend
cd backend && npm run dev

# Terminal 2 — Frontend
cd frontend && npm start
```

Open: http://localhost:3000

---

## Voice Commands (Phase 1)

| Say | What happens |
|---|---|
| "Brief me on [name]" | Reads client summary aloud |
| "Send SOA to [name]" | Queues BlazeSync send, asks for confirmation |
| "Looks good" / "Send it" | Executes pending action |
| "Cancel" | Cancels pending action |
| "Add note: [text]" | Appends note to active meeting session |
| "End meeting — summarize" | Generates summary, reads back for approval |
| "Add new lead — [name]" | Starts lead creation flow |
| "Remind me to call [name] in [time]" | Creates SparkAdvisor task |
| "Check emails" | Reads unread client email summary |
| "Reply to [name] — [instruction]" | Drafts reply, reads back, sends on approval |

**Push-to-talk:** Hold SPACE bar or tap the mic button

---

## Compliance Checklist

- [ ] Deepgram HIPAA BAA signed before first PHI audio
- [ ] All writes require explicit broker verbal "Looks good" / "Send it"
- [ ] SOA compliance warning shown if SOA not complete before meeting
- [ ] No autonomous enrollment submission
- [ ] Audit log writes on every SparkAdvisor write + email sent
- [ ] 7-year audit log retention enforced in DB schema

---

## Phase Roadmap

| Phase | Weeks | Features |
|---|---|---|
| 1 — Foundation | 1–6 | Voice commands, morning briefing, SOA dispatch, post-meeting CRM sync, Outlook email |
| 2 — Meeting Assist | 7–12 | In-person meeting mode, plan comparison, SunfireMatrix enrollment launch, eligibility flags |
| 3 — Polish | 13–18 | Lead intake, audit dashboard, mobile, AEP automation |

---

## Project Structure

```
ddi-agent/
├── backend/
│   ├── server.js              # Express + Socket.IO + WebSocket STT proxy
│   ├── routes/
│   │   ├── webhooks.js        # Manus booking, Graph calendar, SparkAdvisor events
│   │   ├── voice.js           # Transcript → intent → action routing
│   │   └── auth.js            # Microsoft OAuth flow
│   ├── services/
│   │   ├── llm.js             # Claude/GPT-4o — intent, summarize, draft, parse
│   │   ├── deepgram.js        # STT (Nova-3) + TTS (Aura-2)
│   │   ├── graph.js           # Microsoft Graph — email + calendar
│   │   ├── sparkadvisor.js    # SparkAdvisor PURL reads + writes
│   │   ├── eligibility.js     # OK + TX Medicare eligibility logic
│   │   └── briefing.js        # Morning briefing assembly
│   └── db/
│       ├── index.js           # PostgreSQL pool
│       └── schema.sql         # All tables + indexes
├── frontend/
│   └── src/
│       └── App.js             # React UI — solo/meeting/review modes
└── README.md
```

---

## SparkAdvisor API (Pending)

SparkAdvisor webhook schema must be confirmed with their support team before CRM writes go live.  
Until confirmed, all SparkAdvisor write operations log to the audit table and retry queue.

**Open support ticket asking for:**
- Webhook event catalog (event names + payload schemas)
- Webhook auth method (HMAC signature or API token)
- Confirm availability of: `appointment.created`, `soa.completed`, `enrollment.confirmed`
- PURL read endpoint format and available fields

---

*DDI Medicare Voice Agent v1.0 — Phase 1 Build*  
*Larry | DDI Insurance Group | larry@ddinsgroup.com*
