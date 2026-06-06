const fetch = require('node-fetch');
const WebSocket = require('ws');

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const STT_URL = 'wss://api.deepgram.com/v1/listen';
const TTS_URL = 'https://api.deepgram.com/v1/speak';

// ─── TTS: Text → Audio Buffer ────────────────────────────────────────────────
async function synthesize(text, voice = 'aura-2-thalia-en') {
  if (!text || text.trim().length === 0) throw new Error('Empty TTS text');

  const response = await fetch(`${TTS_URL}?model=${voice}`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${DEEPGRAM_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Deepgram TTS error ${response.status}: ${err}`);
  }

  const audioBuffer = await response.arrayBuffer();
  return Buffer.from(audioBuffer);
}

// ─── STT: Batch transcription of a file/buffer ───────────────────────────────
async function transcribeBatch(audioBuffer, mimeType = 'audio/wav') {
  const response = await fetch(
    'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&punctuate=true&diarize=true&language=en-US',
    {
      method: 'POST',
      headers: {
        'Authorization': `Token ${DEEPGRAM_API_KEY}`,
        'Content-Type': mimeType,
      },
      body: audioBuffer,
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Deepgram STT error ${response.status}: ${err}`);
  }

  const result = await response.json();
  return result?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
}

// ─── STT: Streaming WebSocket factory ────────────────────────────────────────
// Returns a configured WS client for the browser to proxy through,
// or use directly from server-side audio streams.
function createStreamingSTT(onTranscript, onError) {
  const params = new URLSearchParams({
    model: 'nova-3',
    language: 'en-US',
    smart_format: 'true',
    punctuate: 'true',
    interim_results: 'false',
    endpointing: '300',
    encoding: 'linear16',
    sample_rate: '16000',
  });

  const ws = new WebSocket(`${STT_URL}?${params}`, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
  });

  ws.on('open', () => {
    console.log('[Deepgram STT] WebSocket connected');
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'Results' && msg.is_final) {
        const transcript = msg.channel?.alternatives?.[0]?.transcript;
        if (transcript && transcript.trim().length > 0) {
          onTranscript(transcript.trim());
        }
      }
    } catch (e) {
      // non-JSON keepalive messages — ignore
    }
  });

  ws.on('error', (err) => {
    console.error('[Deepgram STT] WebSocket error:', err);
    if (onError) onError(err);
  });

  ws.on('close', () => {
    console.log('[Deepgram STT] WebSocket closed');
  });

  return ws;
}

module.exports = { synthesize, transcribeBatch, createStreamingSTT };
