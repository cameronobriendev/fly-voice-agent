/**
 * Call Events Tracker
 * Collects detailed events during a call for post-call debugging
 */

import { logger } from '../utils/logger.js';

const eventsLogger = logger.child('EVENTS');

// Store events per call
const callEvents = new Map();

/**
 * Initialize event tracking for a call
 * @param {string} callSid - Twilio call SID
 */
export function initCallEvents(callSid) {
  callEvents.set(callSid, {
    events: [],
    turnNumber: 0,
    startTime: Date.now(),
  });

  addEvent(callSid, 'call_start', {
    timestamp: new Date().toISOString(),
  });
}

/**
 * Add a generic event
 * @param {string} callSid - Twilio call SID
 * @param {string} eventType - Type of event
 * @param {Object} data - Event data
 */
export function addEvent(callSid, eventType, data = {}) {
  const callData = callEvents.get(callSid);
  if (!callData) {
    eventsLogger.warn('No event tracking for call', { callSid });
    return;
  }

  const event = {
    event_type: eventType,
    timestamp: data.timestamp || new Date().toISOString(),
    event_data: data,
  };

  callData.events.push(event);
}

/**
 * Track a conversation turn with full timing data
 * @param {string} callSid - Twilio call SID
 * @param {Object} turnData - Turn data with timing info
 */
export function addTurnEvent(callSid, turnData) {
  const callData = callEvents.get(callSid);
  if (!callData) {
    eventsLogger.warn('No event tracking for call', { callSid });
    return;
  }

  callData.turnNumber++;

  const event = {
    event_type: 'turn',
    turn_number: callData.turnNumber,
    timestamp: turnData.timestamp || new Date().toISOString(),

    // User input
    user_transcript_raw: turnData.transcriptRaw || null,
    user_transcript: turnData.transcript || null,
    corrections_applied: turnData.corrections || null,

    // AI output
    ai_response: turnData.aiResponse || null,
    llm_provider: turnData.llmProvider || null,
    llm_model: turnData.llmModel || null,
    llm_tokens_in: turnData.tokensIn || null,
    llm_tokens_out: turnData.tokensOut || null,

    // Latencies
    stt_latency: turnData.sttLatency || null,
    llm_latency: turnData.llmLatency || null,
    tts_latency: turnData.ttsLatency || null,
    tts_audio_ms: turnData.ttsAudioMs || null,
    tts_streaming_ms: turnData.ttsStreamingMs || null,
    pipeline_latency: turnData.pipelineLatency || null,
  };

  callData.events.push(event);

  eventsLogger.debug('Turn recorded', {
    callSid,
    turnNumber: callData.turnNumber,
    llmLatency: turnData.llmLatency,
    pipelineLatency: turnData.pipelineLatency,
  });
}

/**
 * Track an error
 * @param {string} callSid - Twilio call SID
 * @param {string} errorType - Type of error
 * @param {Error|string} error - Error object or message
 * @param {Object} context - Additional context
 */
export function addErrorEvent(callSid, errorType, error, context = {}) {
  addEvent(callSid, 'error', {
    error_type: errorType,
    message: error?.message || String(error),
    stack: error?.stack || null,
    ...context,
  });
}

/**
 * Get all events for a call
 * @param {string} callSid - Twilio call SID
 * @returns {Array} Events array
 */
export function getEvents(callSid) {
  const callData = callEvents.get(callSid);
  return callData?.events || [];
}

/**
 * Get events and clean up
 * @param {string} callSid - Twilio call SID
 * @returns {Array} Events array
 */
export function finishAndGetEvents(callSid) {
  const callData = callEvents.get(callSid);
  if (!callData) return [];

  // Add call end event
  addEvent(callSid, 'call_end', {
    duration_ms: Date.now() - callData.startTime,
    total_turns: callData.turnNumber,
  });

  const events = callData.events;

  // Clean up
  callEvents.delete(callSid);

  return events;
}

/**
 * Send events to dashboard
 * @param {string} callId - Dashboard call ID (32-char)
 * @param {Array} events - Events array
 */
export async function sendEventsToDashboard(callId, events) {
  const eventsUrl = process.env.WEBHOOK_URL?.replace('/api/call-complete', '/api/call-events');

  if (!eventsUrl) {
    eventsLogger.warn('No events URL configured');
    return { error: 'No events URL' };
  }

  try {
    const response = await fetch(eventsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ call_id: callId, events }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Events API returned ${response.status}`);
    }

    const result = await response.json();
    eventsLogger.info('Events sent to dashboard', {
      callId,
      eventCount: events.length,
      inserted: result.inserted,
    });

    return result;
  } catch (error) {
    eventsLogger.error('Failed to send events', error, { callId });
    return { error: error.message };
  }
}

export default {
  initCallEvents,
  addEvent,
  addTurnEvent,
  addErrorEvent,
  getEvents,
  finishAndGetEvents,
  sendEventsToDashboard,
};
