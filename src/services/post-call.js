/**
 * Post-call webhook service
 * Sends call data to BuddyHelps Dashboard
 */

import { logger } from '../utils/logger.js';

const webhookLogger = logger.child('WEBHOOK');

/**
 * Send call data to BuddyHelps Dashboard
 * @param {string} userId - User ID (unused for BuddyHelps)
 * @param {Object} callData - Complete call data including userConfig
 * @returns {Promise<Object>} Webhook response
 */
export async function sendToWebhook(userId, callData) {
  const { userConfig, collectedData } = callData;

  // Map to BuddyHelps Dashboard format
  const payload = {
    // Caller info
    caller_phone: callData.fromNumber,
    caller_name: collectedData.callerName || null,
    caller_address: collectedData.address || null,
    callback_number: collectedData.contactPhone || callData.fromNumber,

    // Issue details
    problem: collectedData.issue || null,
    urgency: mapUrgencyLevel(collectedData.emergency),

    // Call content
    transcript: formatTranscript(callData.transcript),

    // Business config (from dashboard API)
    business_name: userConfig?.business_name || null,
    plumber_phone: userConfig?.plumber_phone || null,
    plumber_email: userConfig?.plumber_email || null,
    twilio_number: callData.toNumber,

    // Demo flag - skip notifications for demo calls
    is_demo: userConfig?.is_demo || false,

    // Twilio call SID for recording lookup
    call_sid: callData.callSid,
  };

  try {
    webhookLogger.info('Sending call data to BuddyHelps Dashboard', {
      callSid: callData.callSid,
      webhookUrl: process.env.WEBHOOK_URL,
      businessName: payload.business_name,
    });

    const response = await fetch(process.env.WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000), // 30 second timeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Webhook returned ${response.status}: ${errorText}`);
    }

    const result = await response.json();

    webhookLogger.info('Call data sent to dashboard successfully', {
      callId: result.callId,
      detailsUrl: result.detailsUrl,
      callSid: callData.callSid,
    });

    return result;
  } catch (error) {
    webhookLogger.error('Failed to send to dashboard', error, {
      callSid: callData.callSid,
    });

    // IMPORTANT: Don't throw - call still succeeded even if webhook failed
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

export default {
  sendToWebhook,
};
