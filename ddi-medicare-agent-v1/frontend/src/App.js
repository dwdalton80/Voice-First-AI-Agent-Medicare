import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import {
  Mic, MicOff, Phone, Mail, Calendar, CheckCircle,
  AlertTriangle, Clock, User, FileText, ExternalLink,
  ChevronRight, Volume2, VolumeX, Zap, Activity,
  Shield, Bell, X, Check, RefreshCw
} from 'lucide-react';

const BACKEND = process.env.REACT_APP_BACKEND_URL || 'http://localhost:3001';
const SUNFIRE_PURL = 'https://www.sunfirematrix.com/app/consumer/ember/?sfpath=spa&sfagid=20791041';

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [mode, setMode] = useState('solo'); // solo | meeting | review
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [agentResponse, setAgentResponse] = useState(null);
  const [pendingAction, setPendingAction] = useState(null);
  const [activeClient, setActiveClient] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [meetingNotes, setMeetingNotes] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [emails, setEmails] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [msConnected, setMsConnected] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [briefingScript, setBriefingScript] = useState('');

  const socketRef = useRef(null);
  const wsRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const audioQueueRef = useRef([]);
  const isPlayingRef = useRef(false);

  // ─── Socket.IO setup ────────────────────────────────────────────────────────
  useEffect(() => {
    socketRef.current = io(BACKEND, { transports: ['websocket'] });
    const s = socketRef.current;

    s.on('morning_briefing', (data) => {
      setBriefingScript(data.script);
      if (data.audio && !isMuted) playAudioBase64(data.audio);
      if (data.data?.appointments) setAppointments(data.data.appointments);
      if (data.data?.emails) setEmails(data.data.emails);
      if (data.data?.alerts) setAlerts(data.data.alerts);
    });

    s.on('new_booking', (data) => {
      addNotification({
        type: data.is_new_client ? 'new_client' : 'appointment',
        message: `New booking: ${data.name} — ${formatTime(data.appointment_date)}`,
        data,
        priority: 'high',
      });
      fetchAppointments();
    });

    s.on('soa_completed', (data) => {
      addNotification({
        type: 'soa',
        message: `SOA completed by client`,
        data,
      });
      fetchAppointments();
    });

    s.on('meeting_started', (data) => {
      setMode('meeting');
      setSessionId(data.session_id);
      setActiveClient(data.client);
      setMeetingNotes([]);
    });

    s.on('meeting_summary_ready', (data) => {
      setMode('review');
      setAgentResponse({ summary: data.summary, pending_id: data.pending_id });
    });

    s.on('crm_synced', () => {
      setMode('solo');
      setActiveClient(null);
      setSessionId(null);
      setMeetingNotes([]);
      addNotification({ type: 'success', message: 'Meeting notes saved to SparkAdvisor' });
    });

    s.on('calendar_event', fetchAppointments);
    s.on('enrollment_confirmed', () => addNotification({ type: 'success', message: 'Enrollment confirmed — tasks created' }));

    return () => s.disconnect();
  }, []);

  // ─── Load initial data ───────────────────────────────────────────────────────
  useEffect(() => {
    fetchAppointments();
    checkAuthStatus();
  }, []);

  async function fetchAppointments() {
    try {
      const r = await fetch(`${BACKEND}/api/appointments?days=7`);
      const data = await r.json();
      setAppointments(data);
    } catch (e) {
      console.warn('Could not fetch appointments:', e.message);
    }
  }

  async function checkAuthStatus() {
    try {
      const r = await fetch(`${BACKEND}/auth/status`);
      const data = await r.json();
      setMsConnected(data.microsoft);
    } catch {}
  }

  // ─── Audio playback queue ────────────────────────────────────────────────────
  function playAudioBase64(base64) {
    if (isMuted || mode === 'meeting') return;
    audioQueueRef.current.push(base64);
    if (!isPlayingRef.current) drainAudioQueue();
  }

  async function drainAudioQueue() {
    if (audioQueueRef.current.length === 0) { isPlayingRef.current = false; return; }
    isPlayingRef.current = true;
    const base64 = audioQueueRef.current.shift();
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'audio/mpeg' });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => { URL.revokeObjectURL(url); drainAudioQueue(); };
    audio.onerror = () => { URL.revokeObjectURL(url); drainAudioQueue(); };
    await audio.play().catch(() => drainAudioQueue());
  }

  // ─── STT WebSocket ───────────────────────────────────────────────────────────
  async function startListening() {
    if (isListening) return stopListening();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
      mediaStreamRef.current = stream;

      const wsUrl = BACKEND.replace('http', 'ws') + '/stt';
      wsRef.current = new WebSocket(wsUrl);

      wsRef.current.onopen = () => {
        setIsListening(true);
        audioContextRef.current = new AudioContext({ sampleRate: 16000 });
        const source = audioContextRef.current.createMediaStreamSource(stream);
        processorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1);

        processorRef.current.onaudioprocess = (e) => {
          if (wsRef.current?.readyState !== WebSocket.OPEN) return;
          const float32 = e.inputBuffer.getChannelData(0);
          const int16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            int16[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32767)));
          }
          wsRef.current.send(int16.buffer);
        };

        source.connect(processorRef.current);
        processorRef.current.connect(audioContextRef.current.destination);
      };

      wsRef.current.onmessage = async (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'transcript' && msg.transcript) {
          setTranscript(msg.transcript);
          stopListening();
          await processTranscript(msg.transcript);
        }
      };

      wsRef.current.onerror = () => { stopListening(); };
    } catch (e) {
      console.error('Microphone error:', e);
      addNotification({ type: 'error', message: 'Microphone access denied' });
    }
  }

  function stopListening() {
    setIsListening(false);
    if (processorRef.current) { processorRef.current.disconnect(); processorRef.current = null; }
    if (audioContextRef.current) { audioContextRef.current.close(); audioContextRef.current = null; }
    if (mediaStreamRef.current) { mediaStreamRef.current.getTracks().forEach(t => t.stop()); mediaStreamRef.current = null; }
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
  }

  // ─── Process transcript ──────────────────────────────────────────────────────
  async function processTranscript(text) {
    setIsProcessing(true);
    setAgentResponse(null);

    try {
      const r = await fetch(`${BACKEND}/voice/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: text, session_id: sessionId, mode }),
      });
      const data = await r.json();

      setAgentResponse(data);

      if (data.audio && !isMuted && mode !== 'meeting') {
        playAudioBase64(data.audio);
      }

      if (data.action === 'pending_approval') {
        setPendingAction({ id: data.pending_id, tts: data.tts, ...data });
      } else {
        setPendingAction(null);
      }

      if (data.action === 'note_added' && data.screen_message) {
        setMeetingNotes(n => [...n, data.screen_message.replace('✓ Note: ', '')]);
      }

      if (data.action === 'meeting_started') {
        setMode('meeting');
        setSessionId(data.session_id);
        setActiveClient(data.client);
      }

      if (data.action === 'open_sunfire' || data.action === 'open_enrollment') {
        window.open(data.url || SUNFIRE_PURL, '_blank');
      }

      if (data.mode === 'solo') {
        setMode('solo');
      }
    } catch (e) {
      console.error('Voice processing error:', e);
      addNotification({ type: 'error', message: 'Voice processing failed' });
    } finally {
      setIsProcessing(false);
    }
  }

  function addNotification(notif) {
    const id = Date.now();
    setNotifications(n => [{ ...notif, id, ts: new Date() }, ...n.slice(0, 9)]);
    setTimeout(() => setNotifications(n => n.filter(x => x.id !== id)), 8000);
  }

  // ─── Keyboard shortcut (Space = push to talk) ────────────────────────────────
  useEffect(() => {
    const down = (e) => { if (e.code === 'Space' && e.target.tagName !== 'INPUT') { e.preventDefault(); startListening(); } };
    const up = (e) => { if (e.code === 'Space') { e.preventDefault(); stopListening(); } };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [isListening, mode, sessionId]);

  function formatTime(dt) {
    if (!dt) return '';
    return new Date(dt).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
  }

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={styles.root}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <div style={styles.logo}>
            <Zap size={18} color="#00d4aa" />
            <span style={styles.logoText}>DDI Agent</span>
          </div>
          <div style={styles.modeBadge(mode)}>
            {mode === 'solo' && <><Activity size={11} /> Solo</>}
            {mode === 'meeting' && <><Phone size={11} /> In Meeting</>}
            {mode === 'review' && <><FileText size={11} /> Review</>}
          </div>
        </div>

        <div style={styles.headerCenter}>
          {mode === 'meeting' && activeClient && (
            <span style={styles.meetingClient}>
              <User size={13} />
              {activeClient.name || 'Client'}
              {activeClient.soa_status === 'completed' && <CheckCircle size={12} color="#00d4aa" />}
            </span>
          )}
        </div>

        <div style={styles.headerRight}>
          {!msConnected && (
            <a href={`${BACKEND}/auth/microsoft`} style={styles.connectBtn}>
              Connect Outlook
            </a>
          )}
          <button onClick={() => setIsMuted(!isMuted)} style={styles.iconBtn} title={isMuted ? 'Unmute' : 'Mute'}>
            {isMuted ? <VolumeX size={16} color="#888" /> : <Volume2 size={16} color="#00d4aa" />}
          </button>
          <button onClick={() => fetch(`${BACKEND}/api/briefing/trigger`, { method: 'POST' })}
            style={styles.iconBtn} title="Trigger morning briefing">
            <Bell size={16} color="#888" />
          </button>
        </div>
      </header>

      {/* Notification strip */}
      {notifications.length > 0 && (
        <div style={styles.notifBar}>
          {notifications.slice(0, 3).map(n => (
            <div key={n.id} style={styles.notif(n.type)}>
              {n.type === 'error' ? <AlertTriangle size={12} /> :
               n.type === 'success' ? <CheckCircle size={12} /> :
               n.type === 'new_client' ? <User size={12} /> : <Bell size={12} />}
              {n.message}
            </div>
          ))}
        </div>
      )}

      {/* Main layout */}
      <div style={styles.main}>

        {/* Left panel — Appointments */}
        <div style={styles.panel}>
          <div style={styles.panelHeader}>
            <Calendar size={14} color="#00d4aa" />
            <span>Upcoming</span>
          </div>
          <div style={styles.panelBody}>
            {appointments.length === 0 ? (
              <div style={styles.empty}>No appointments in the next 7 days</div>
            ) : appointments.map((appt, i) => (
              <div key={i} style={styles.apptCard(appt.is_new_client)}>
                <div style={styles.apptTime}>{formatTime(appt.appointment_dt)}</div>
                <div style={styles.apptName}>
                  {appt.is_new_client && <span style={styles.newBadge}>NEW</span>}
                  {appt.client_name}
                </div>
                <div style={styles.apptMeta}>
                  {appt.soa_completed
                    ? <span style={styles.soaDone}><CheckCircle size={11} /> SOA complete</span>
                    : <span style={styles.soaPending}><AlertTriangle size={11} /> SOA pending</span>}
                </div>
                <button
                  onClick={() => processTranscript(`Brief me on ${appt.client_name}`)}
                  style={styles.briefBtn}
                >
                  Brief me <ChevronRight size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* Center panel — Voice control */}
        <div style={styles.centerPanel}>

          {/* Voice orb */}
          <div style={styles.orbArea}>
            <button
              onMouseDown={startListening}
              onMouseUp={stopListening}
              onTouchStart={startListening}
              onTouchEnd={stopListening}
              style={styles.orb(isListening, isProcessing)}
              disabled={isProcessing}
            >
              <div style={styles.orbInner(isListening)}>
                {isProcessing ? <RefreshCw size={28} color="#fff" style={{ animation: 'spin 1s linear infinite' }} /> :
                 isListening ? <Mic size={28} color="#fff" /> :
                 <Mic size={28} color={mode === 'meeting' ? '#fff' : '#aaa'} />}
              </div>
              {isListening && <div style={styles.orbRing} />}
            </button>
            <div style={styles.orbLabel}>
              {isProcessing ? 'Processing...' :
               isListening ? 'Listening...' :
               mode === 'meeting' ? 'Hold SPACE or tap to speak' :
               'Hold SPACE or tap to speak'}
            </div>
          </div>

          {/* Transcript display */}
          {transcript && (
            <div style={styles.transcriptBox}>
              <span style={styles.transcriptLabel}>You said</span>
              <span style={styles.transcriptText}>"{transcript}"</span>
            </div>
          )}

          {/* Agent response */}
          {agentResponse && !pendingAction && (
            <div style={styles.responseBox}>
              {agentResponse.screen_message && (
                <div style={styles.screenMessage}>{agentResponse.screen_message}</div>
              )}
              {agentResponse.client && mode !== 'meeting' && (
                <ClientCard client={agentResponse.client} />
              )}
            </div>
          )}

          {/* Pending approval */}
          {pendingAction && (
            <div style={styles.pendingBox}>
              <div style={styles.pendingIcon}><Shield size={16} color="#f59e0b" /></div>
              <div style={styles.pendingText}>{pendingAction.tts}</div>
              <div style={styles.pendingActions}>
                <button onClick={() => processTranscript('Looks good')} style={styles.approveBtn}>
                  <Check size={14} /> Confirm
                </button>
                <button onClick={() => processTranscript('Cancel')} style={styles.cancelBtn}>
                  <X size={14} /> Cancel
                </button>
              </div>
            </div>
          )}

          {/* Meeting notes */}
          {mode === 'meeting' && (
            <div style={styles.notesPanel}>
              <div style={styles.notesPanelHeader}>
                <FileText size={13} color="#00d4aa" />
                <span>Meeting Notes</span>
                <span style={styles.notesCount}>{meetingNotes.length} notes</span>
              </div>
              <div style={styles.notesList}>
                {meetingNotes.length === 0 ? (
                  <div style={styles.empty}>Say "Add note:" followed by your note</div>
                ) : meetingNotes.map((note, i) => (
                  <div key={i} style={styles.noteItem}>
                    <span style={styles.noteDot}>·</span> {note}
                  </div>
                ))}
              </div>
              <button
                onClick={() => processTranscript('End meeting — summarize')}
                style={styles.endMeetingBtn}
              >
                End Meeting & Summarize
              </button>
            </div>
          )}

          {/* Meeting summary review */}
          {mode === 'review' && agentResponse?.summary && (
            <div style={styles.summaryPanel}>
              <div style={styles.summaryHeader}>Meeting Summary</div>
              <p style={styles.summaryText}>{agentResponse.summary.summary}</p>
              {agentResponse.summary.action_items?.length > 0 && (
                <div>
                  <div style={styles.summarySubhead}>Action Items</div>
                  {agentResponse.summary.action_items.map((item, i) => (
                    <div key={i} style={styles.actionItem}>
                      <CheckCircle size={11} color="#00d4aa" />
                      <span>{item.task}</span>
                      {item.due_date && <span style={styles.dueDate}>{item.due_date}</span>}
                    </div>
                  ))}
                </div>
              )}
              <div style={styles.summaryMeta}>
                Disposition: <strong style={{ color: dispositionColor(agentResponse.summary.disposition) }}>
                  {agentResponse.summary.disposition?.replace('_', ' ').toUpperCase()}
                </strong>
              </div>
            </div>
          )}

          {/* Quick commands */}
          {mode === 'solo' && !agentResponse && !pendingAction && (
            <div style={styles.quickCommands}>
              {[
                'Brief me on [client]',
                'Send SOA to [client]',
                'Check emails',
                'Add new lead',
              ].map(cmd => (
                <div key={cmd} style={styles.quickCmd}>{cmd}</div>
              ))}
            </div>
          )}

          {/* SunfireMatrix quick link */}
          <a href={SUNFIRE_PURL} target="_blank" rel="noreferrer" style={styles.sfLink}>
            <ExternalLink size={12} />
            Open SunfireMatrix
          </a>
        </div>

        {/* Right panel — Emails & Alerts */}
        <div style={styles.panel}>
          <div style={styles.panelHeader}>
            <Mail size={14} color="#00d4aa" />
            <span>Client Emails</span>
          </div>
          <div style={styles.panelBody}>
            {!msConnected ? (
              <div style={styles.connectPrompt}>
                <a href={`${BACKEND}/auth/microsoft`} style={styles.connectLink}>
                  Connect Outlook to see emails
                </a>
              </div>
            ) : emails.length === 0 ? (
              <div style={styles.empty}>No unread client emails</div>
            ) : emails.slice(0, 6).map((email, i) => (
              <div key={i} style={styles.emailCard}>
                <div style={styles.emailFrom}>{email.from_name || email.from_email}</div>
                <div style={styles.emailSubject}>{email.subject}</div>
                <div style={styles.emailPreview}>{email.preview}</div>
                <button
                  onClick={() => processTranscript(`Reply to ${email.from_name} — `)}
                  style={styles.replyBtn}
                >
                  Reply <ChevronRight size={10} />
                </button>
              </div>
            ))}
          </div>

          {alerts.length > 0 && (
            <>
              <div style={{ ...styles.panelHeader, marginTop: 12 }}>
                <AlertTriangle size={14} color="#f59e0b" />
                <span>Eligibility Alerts</span>
              </div>
              <div style={styles.panelBody}>
                {alerts.slice(0, 4).map((alert, i) => (
                  <div key={i} style={styles.alertCard(alert.priority)}>
                    <div style={styles.alertType}>{alert.type.replace(/_/g, ' ')}</div>
                    <div style={styles.alertMsg}>{alert.message}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Syne:wght@400;600;700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0a0c0f; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:.6; transform:scale(1.05); } }
        @keyframes ripple { to { transform:scale(2.5); opacity:0; } }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: #111; } ::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
      `}</style>
    </div>
  );
}

// ─── Client Card component ────────────────────────────────────────────────────
function ClientCard({ client }) {
  if (!client) return null;
  return (
    <div style={styles.clientCard}>
      <div style={styles.clientName}><User size={13} /> {client.name}</div>
      {client.current_plan && (
        <div style={styles.clientPlan}>{client.carrier} · {client.current_plan}</div>
      )}
      {client.email && <div style={styles.clientEmail}>{client.email}</div>}
    </div>
  );
}

function dispositionColor(d) {
  if (d === 'enrolled') return '#00d4aa';
  if (d === 'declined') return '#ef4444';
  if (d === 'follow_up') return '#f59e0b';
  return '#888';
}

// ─── Styles ───────────────────────────────────────────────────────────────────
const C = {
  bg: '#0a0c0f',
  panel: '#0f1216',
  border: '#1e2330',
  accent: '#00d4aa',
  accentDim: 'rgba(0,212,170,0.12)',
  text: '#e8eaf0',
  textMuted: '#666',
  textSub: '#9ca3af',
  warn: '#f59e0b',
  error: '#ef4444',
  font: "'Syne', sans-serif",
  mono: "'DM Mono', monospace",
};

const styles = {
  root: { fontFamily: C.font, background: C.bg, minHeight: '100vh', color: C.text, display: 'flex', flexDirection: 'column' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', borderBottom: `1px solid ${C.border}`, background: 'rgba(15,18,22,0.95)', backdropFilter: 'blur(10px)', position: 'sticky', top: 0, zIndex: 100 },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  headerCenter: { flex: 1, display: 'flex', justifyContent: 'center' },
  headerRight: { display: 'flex', alignItems: 'center', gap: 8 },
  logo: { display: 'flex', alignItems: 'center', gap: 6 },
  logoText: { fontWeight: 800, fontSize: 15, letterSpacing: '-0.5px', color: C.text },
  modeBadge: (mode) => ({
    display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600,
    padding: '3px 8px', borderRadius: 20, fontFamily: C.mono,
    background: mode === 'meeting' ? 'rgba(239,68,68,0.15)' : mode === 'review' ? 'rgba(245,158,11,0.15)' : C.accentDim,
    color: mode === 'meeting' ? '#ef4444' : mode === 'review' ? C.warn : C.accent,
    border: `1px solid ${mode === 'meeting' ? 'rgba(239,68,68,0.3)' : mode === 'review' ? 'rgba(245,158,11,0.3)' : 'rgba(0,212,170,0.3)'}`,
  }),
  meetingClient: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 600, color: '#ef4444' },
  connectBtn: { fontSize: 11, padding: '4px 10px', background: C.accentDim, color: C.accent, border: `1px solid rgba(0,212,170,0.3)`, borderRadius: 6, textDecoration: 'none', fontWeight: 600 },
  iconBtn: { background: 'none', border: 'none', cursor: 'pointer', padding: 4, borderRadius: 6, display: 'flex', alignItems: 'center' },
  notifBar: { display: 'flex', gap: 8, padding: '6px 20px', background: '#0d0f12', borderBottom: `1px solid ${C.border}`, flexWrap: 'wrap' },
  notif: (type) => ({
    display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, padding: '3px 10px',
    borderRadius: 20, fontFamily: C.mono,
    background: type === 'error' ? 'rgba(239,68,68,0.1)' : type === 'success' ? C.accentDim : 'rgba(245,158,11,0.1)',
    color: type === 'error' ? '#ef4444' : type === 'success' ? C.accent : C.warn,
  }),
  main: { display: 'flex', flex: 1, gap: 0, minHeight: 0 },
  panel: { width: 260, flexShrink: 0, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', maxHeight: 'calc(100vh - 50px)', overflowY: 'auto' },
  panelHeader: { display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: C.textSub, borderBottom: `1px solid ${C.border}`, position: 'sticky', top: 0, background: C.panel },
  panelBody: { padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 },
  centerPanel: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 20px', gap: 16, overflowY: 'auto', maxHeight: 'calc(100vh - 50px)' },
  orbArea: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, marginBottom: 4 },
  orb: (listening, processing) => ({
    width: 100, height: 100, borderRadius: '50%', border: 'none', cursor: 'pointer',
    background: listening ? 'rgba(239,68,68,0.2)' : processing ? C.accentDim : 'rgba(255,255,255,0.04)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative',
    transition: 'all 0.2s', outline: 'none',
    boxShadow: listening ? '0 0 0 1px rgba(239,68,68,0.4), 0 0 30px rgba(239,68,68,0.15)' :
               processing ? `0 0 0 1px rgba(0,212,170,0.4), 0 0 30px ${C.accentDim}` :
               '0 0 0 1px rgba(255,255,255,0.08)',
  }),
  orbInner: (listening) => ({
    width: 72, height: 72, borderRadius: '50%',
    background: listening ? 'rgba(239,68,68,0.8)' : 'rgba(255,255,255,0.06)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'all 0.15s',
    animation: listening ? 'pulse 1s ease-in-out infinite' : 'none',
  }),
  orbRing: {
    position: 'absolute', width: '100%', height: '100%', borderRadius: '50%',
    border: '2px solid rgba(239,68,68,0.4)', animation: 'ripple 1.5s ease-out infinite',
  },
  orbLabel: { fontSize: 11, color: C.textMuted, fontFamily: C.mono, letterSpacing: 0.5 },
  transcriptBox: { display: 'flex', flexDirection: 'column', gap: 3, padding: '10px 14px', background: 'rgba(255,255,255,0.03)', borderRadius: 8, border: `1px solid ${C.border}`, maxWidth: 480, width: '100%' },
  transcriptLabel: { fontSize: 10, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 1, fontFamily: C.mono },
  transcriptText: { fontSize: 14, color: C.text, fontStyle: 'italic' },
  responseBox: { width: '100%', maxWidth: 480 },
  screenMessage: { padding: '10px 14px', background: C.accentDim, border: `1px solid rgba(0,212,170,0.2)`, borderRadius: 8, fontSize: 13, color: C.accent },
  pendingBox: { display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 16px', background: 'rgba(245,158,11,0.06)', border: `1px solid rgba(245,158,11,0.25)`, borderRadius: 10, maxWidth: 480, width: '100%' },
  pendingIcon: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: C.warn, textTransform: 'uppercase', letterSpacing: 0.5 },
  pendingText: { fontSize: 13, color: C.text, lineHeight: 1.6 },
  pendingActions: { display: 'flex', gap: 8 },
  approveBtn: { display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', background: C.accent, color: '#000', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: C.font },
  cancelBtn: { display: 'flex', alignItems: 'center', gap: 5, padding: '7px 14px', background: 'rgba(255,255,255,0.06)', color: C.textSub, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', fontFamily: C.font },
  quickCommands: { display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'center', maxWidth: 400 },
  quickCmd: { padding: '5px 11px', background: 'rgba(255,255,255,0.04)', border: `1px solid ${C.border}`, borderRadius: 20, fontSize: 11, color: C.textMuted, fontFamily: C.mono },
  sfLink: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: C.textMuted, textDecoration: 'none', padding: '5px 10px', borderRadius: 6, border: `1px solid ${C.border}`, marginTop: 'auto' },
  notesPanel: { width: '100%', maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px', background: '#0f1216', border: `1px solid ${C.border}`, borderRadius: 10 },
  notesPanelHeader: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: C.textSub },
  notesCount: { marginLeft: 'auto', fontSize: 11, color: C.textMuted, fontFamily: C.mono },
  notesList: { maxHeight: 160, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 },
  noteItem: { fontSize: 12, color: C.textSub, lineHeight: 1.6 },
  noteDot: { color: C.accent, marginRight: 4 },
  empty: { fontSize: 12, color: C.textMuted, padding: '8px 0', textAlign: 'center' },
  endMeetingBtn: { padding: '8px 14px', background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: C.font },
  summaryPanel: { width: '100%', maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 10, padding: '14px 16px', background: '#0f1216', border: `1px solid ${C.border}`, borderRadius: 10 },
  summaryHeader: { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: C.accent },
  summaryText: { fontSize: 13, color: C.text, lineHeight: 1.7 },
  summarySubhead: { fontSize: 11, fontWeight: 700, color: C.textSub, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 },
  actionItem: { display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 12, color: C.textSub, marginBottom: 4, lineHeight: 1.5 },
  dueDate: { marginLeft: 'auto', fontSize: 10, color: C.textMuted, fontFamily: C.mono, flexShrink: 0 },
  summaryMeta: { fontSize: 11, color: C.textMuted, fontFamily: C.mono },
  apptCard: (isNew) => ({
    padding: '8px 10px', background: isNew ? 'rgba(245,158,11,0.04)' : 'rgba(255,255,255,0.02)',
    border: `1px solid ${isNew ? 'rgba(245,158,11,0.2)' : C.border}`, borderRadius: 7,
    display: 'flex', flexDirection: 'column', gap: 4,
  }),
  apptTime: { fontSize: 10, color: C.textMuted, fontFamily: C.mono },
  apptName: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 600, color: C.text },
  newBadge: { fontSize: 9, fontWeight: 800, padding: '1px 5px', background: 'rgba(245,158,11,0.2)', color: C.warn, borderRadius: 3, letterSpacing: 0.5 },
  apptMeta: { display: 'flex', gap: 6 },
  soaDone: { display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: C.accent, fontFamily: C.mono },
  soaPending: { display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, color: C.warn, fontFamily: C.mono },
  briefBtn: { alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, background: 'none', border: `1px solid ${C.border}`, color: C.textMuted, borderRadius: 4, padding: '2px 7px', cursor: 'pointer', fontFamily: C.font },
  emailCard: { padding: '8px 10px', background: 'rgba(255,255,255,0.02)', border: `1px solid ${C.border}`, borderRadius: 7, display: 'flex', flexDirection: 'column', gap: 3 },
  emailFrom: { fontSize: 12, fontWeight: 600, color: C.text },
  emailSubject: { fontSize: 11, color: C.textSub },
  emailPreview: { fontSize: 11, color: C.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' },
  replyBtn: { alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: 3, fontSize: 10, background: 'none', border: `1px solid ${C.border}`, color: C.textMuted, borderRadius: 4, padding: '2px 7px', cursor: 'pointer', fontFamily: C.font },
  alertCard: (priority) => ({
    padding: '8px 10px', background: priority === 'high' ? 'rgba(239,68,68,0.05)' : 'rgba(245,158,11,0.04)',
    border: `1px solid ${priority === 'high' ? 'rgba(239,68,68,0.2)' : 'rgba(245,158,11,0.15)'}`, borderRadius: 7,
    display: 'flex', flexDirection: 'column', gap: 3,
  }),
  alertType: { fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1, color: C.warn },
  alertMsg: { fontSize: 11, color: C.textSub, lineHeight: 1.5 },
  connectPrompt: { padding: '12px 0', textAlign: 'center' },
  connectLink: { fontSize: 12, color: C.accent, textDecoration: 'none' },
  clientCard: { padding: '10px 12px', background: 'rgba(255,255,255,0.02)', border: `1px solid ${C.border}`, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 },
  clientName: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 600, color: C.text },
  clientPlan: { fontSize: 11, color: C.textSub },
  clientEmail: { fontSize: 10, color: C.textMuted, fontFamily: C.mono },
};
