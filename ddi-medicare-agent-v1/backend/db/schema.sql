-- DDI Medicare Voice Agent — Database Schema
-- Run this once to set up the database
-- psql -d ddi_agent -f schema.sql

-- Audit log (HIPAA/CMS: 7-year retention)
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  action_type VARCHAR(50) NOT NULL,
  client_id VARCHAR(100),
  client_email VARCHAR(255),
  client_name VARCHAR(255),
  description TEXT,
  broker_approved BOOLEAN NOT NULL DEFAULT false,
  payload JSONB,
  retention_until DATE GENERATED ALWAYS AS (timestamp::date + INTERVAL '7 years') STORED
);

CREATE INDEX idx_audit_timestamp ON audit_log(timestamp DESC);
CREATE INDEX idx_audit_client_id ON audit_log(client_id);
CREATE INDEX idx_audit_action_type ON audit_log(action_type);

-- Client match cache (local index of SparkAdvisor clients for fast email/name matching)
CREATE TABLE IF NOT EXISTS client_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sparkadvisor_id VARCHAR(100) UNIQUE,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(50),
  dob DATE,
  state VARCHAR(2),
  part_b_effective DATE,
  current_plan VARCHAR(255),
  carrier VARCHAR(100),
  soa_status VARCHAR(50) DEFAULT 'none',
  soa_completed_at TIMESTAMPTZ,
  last_synced TIMESTAMPTZ DEFAULT now(),
  raw JSONB
);

CREATE INDEX idx_client_email ON client_cache(email);
CREATE INDEX idx_client_name ON client_cache(name);
CREATE INDEX idx_client_sparkadvisor_id ON client_cache(sparkadvisor_id);

-- Appointments (from Manus booking + Outlook Calendar)
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES client_cache(id),
  client_name VARCHAR(255),
  client_email VARCHAR(255),
  appointment_dt TIMESTAMPTZ NOT NULL,
  source VARCHAR(50), -- 'manus_booking' | 'outlook_calendar' | 'sparkadvisor'
  outlook_event_id VARCHAR(500),
  sparkadvisor_id VARCHAR(100),
  booking_notes TEXT,
  parsed_tags JSONB,
  soa_completed BOOLEAN DEFAULT false,
  briefing_ready BOOLEAN DEFAULT false,
  briefing_played BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_appt_dt ON appointments(appointment_dt);
CREATE INDEX idx_appt_client ON appointments(client_id);

-- Session notes (in-meeting voice notes buffer)
CREATE TABLE IF NOT EXISTS meeting_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID REFERENCES client_cache(id),
  client_name VARCHAR(255),
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ,
  notes_raw TEXT[],
  summary TEXT,
  action_items JSONB,
  disposition VARCHAR(50),
  synced_to_sparkadvisor BOOLEAN DEFAULT false,
  broker_approved BOOLEAN DEFAULT false
);

-- Pending actions (writes awaiting broker verbal approval)
CREATE TABLE IF NOT EXISTS pending_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  action_type VARCHAR(50) NOT NULL,
  client_id VARCHAR(100),
  payload JSONB NOT NULL,
  tts_readback TEXT,
  status VARCHAR(20) DEFAULT 'pending', -- 'pending' | 'approved' | 'cancelled'
  expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '10 minutes')
);

-- OAuth tokens (Microsoft Graph)
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider VARCHAR(50) NOT NULL DEFAULT 'microsoft',
  access_token TEXT,
  refresh_token TEXT,
  expires_at TIMESTAMPTZ,
  scope TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Graph subscriptions (for calendar change notifications)
CREATE TABLE IF NOT EXISTS graph_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id VARCHAR(500) UNIQUE,
  resource VARCHAR(255),
  change_types TEXT,
  expires_at TIMESTAMPTZ,
  client_state VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT now()
);

COMMENT ON TABLE audit_log IS 'HIPAA/CMS compliant audit trail. Retain 7 years minimum per CMS guidance.';
COMMENT ON COLUMN audit_log.broker_approved IS 'True only after explicit broker verbal approval. No write occurs without this.';
