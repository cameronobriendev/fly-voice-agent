/**
 * Post-call webhook service
 * Sends call data to your existing webhook endpoint
 */

import { logger } from '../utils/logger.js';

const webhookLogger = logger.child('WEBHOOK');

/**
 * Send call data to webhook endpoint
 * @param {string} userId - User ID
 * @param {Object} callData - Complete call data
 * @returns {Promise<Object>} Webhook response
 */
export async function sendToWebhook(userId, callData) {
  // Map call data to leadsaveai.calls schema
  const payload = {
    user_id: userId,

    // Twilio identifiers
    twilio_call_sid: callData.callSid,

    // Caller info
    caller_phone: callData.fromNumber, // E.164 format
    caller_name: callData.collectedData.callerName || null,
    caller_email: callData.collectedData.callerEmail || null,

    // Timing
    call_started_at: callData.startedAt, // ISO 8601 timestamp
    call_ended_at: callData.endedAt, // ISO 8601 timestamp
    duration_seconds: callData.duration,

    // Issue details
    issue_description: callData.collectedData.issue || null,
    urgency_level: mapUrgencyLevel(callData.collectedData.emergency),

    // Call content
    transcript: formatTranscript(callData.transcript),

    // Metadata
    ai_confidence_score: calculateConfidenceScore(callData.collectedData),
    status: 'new',
    notes: buildNotes(callData),
  };

  try {
    webhookLogger.info('Sending call data to webhook', {
      userId,
      callSid: callData.callSid,
      webhookUrl: process.env.WEBHOOK_URL,
    });

    const response = await fetch(process.env.WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.WEBHOOK_SECRET}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000), // 30 second timeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Webhook returned ${response.status}: ${errorText}`);
    }

    const result = await response.json();

    webhookLogger.info('Call data sent successfully', {
      callId: result.call_id,
      callSid: callData.callSid,
    });

    return result;
  } catch (error) {
    webhookLogger.error('Failed to send to webhook', error, {
      callSid: callData.callSid,
    });

    // IMPORTANT: Don't throw - call still succeeded even if webhook failed
    // The voice agent's job is done, webhook failure shouldn't stop us
    return { error: error.message };
  }
}

/**
 * Map emergency status to urgency level
 * @param {boolean|undefined} isEmergency - Emergency flag
 * @returns {string} Urgency level
 */
function mapUrgencyLevel(isEmergency) {
  if (isEmergency === true) return 'urgent';
  if (isEmergency === false) return 'low';
  return 'medium'; // default
}

/**
 * Format transcript array to plain text
 * @param {Array} transcript - Array of {speaker, text}
 * @returns {string} Formatted transcript
 */
function formatTranscript(transcript) {
  if (!transcript || !Array.isArray(transcript)) return '';

  return transcript
    .map((t) => {
      const speaker = t.speaker === 'ai' ? 'Agent' : 'Customer';
      return `${speaker}: ${t.text}`;
    })
    .join('\n');
}

/**
 * Calculate confidence score based on collected data
 * @param {Object} collectedData - Data collected during call
 * @returns {number} Confidence score (0-100)
 */
function calculateConfidenceScore(collectedData) {
  let score = 0;
  const fields = [
    'serviceType',
    'propertyType',
    'issue',
    'started',
    'contactPhone',
    'callbackTime',
  ];

  fields.forEach((field) => {
    if (
      collectedData[field] &&
      String(collectedData[field]).trim().length > 0
    ) {
      score += 16.67; // Each field is worth ~17% (100/6)
    }
  });

  return Math.round(score);
}

/**
 * Build notes from collected data
 * @param {Object} callData - Complete call data
 * @returns {string} Notes text
 */
function buildNotes(callData) {
  const cd = callData.collectedData;
  const notes = [];

  if (cd.serviceType) notes.push(`Service: ${cd.serviceType}`);
  if (cd.propertyType) notes.push(`Property: ${cd.propertyType}`);
  if (cd.started) notes.push(`Started: ${cd.started}`);
  if (cd.callbackTime) notes.push(`Callback: ${cd.callbackTime}`);
  if (cd.notes) notes.push(`Additional: ${cd.notes}`);

  // Add call metrics
  notes.push(`\nCall Metrics:`);
  notes.push(`- LLM Provider: ${callData.llmProvider}`);
  notes.push(`- Avg Latency: ${callData.avgLatency}ms`);
  notes.push(`- Cost: $${callData.totalCost.toFixed(4)}`);

  return notes.join('\n');
}

export default {
  sendToWebhook,
};
