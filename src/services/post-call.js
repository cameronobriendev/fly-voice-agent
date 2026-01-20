/**
 * Post-call webhook service
 * Sends call data to BuddyHelps Dashboard
 */

import { logger } from '../utils/logger.js';

const webhookLogger = logger.child('WEBHOOK');

// Retry config
const MAX_RETRIES = 3;
const INITIAL_DELAY_MS = 1000; // 1s, 2s, 4s exponential backoff

// Pumble API for alerts
const PUMBLE_API = process.env.PUMBLE_API;

// Failure rate tracking (in-memory, resets on deploy)
const FAILURE_WINDOW_MS = 15 * 60 * 1000; // 15 minute window
const FAILURE_THRESHOLD = 3; // Alert if 3+ failures in window
const failureTimestamps = [];
let thresholdAlertSent = false; // Prevent alert spam

/**
 * Send alert to Pumble
 */
async function notifyPumble(message) {
  if (!PUMBLE_API) {
    webhookLogger.warn('PUMBLE_API not configured, skipping notification');
    return;
  }

  try {
    await fetch('https://pumble-api-keys.addons.marketplace.cake.com/sendMessage', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': PUMBLE_API,
      },
      body: JSON.stringify({
        channel: 'buddyhelps-alerts',
        text: message,
      }),
    });
    webhookLogger.info('Pumble alert sent');
  } catch (err) {
    webhookLogger.error('Pumble notification failed', err);
  }
}

/**
 * Track webhook failure and check threshold
 * @returns {boolean} True if threshold exceeded
 */
function trackFailure() {
  const now = Date.now();
  failureTimestamps.push(now);

  // Clean old failures outside window
  const cutoff = now - FAILURE_WINDOW_MS;
  while (failureTimestamps.length > 0 && failureTimestamps[0] < cutoff) {
    failureTimestamps.shift();
  }

  // Check if threshold exceeded
  if (failureTimestamps.length >= FAILURE_THRESHOLD && !thresholdAlertSent) {
    thresholdAlertSent = true;
    // Reset alert flag after window passes
    setTimeout(() => { thresholdAlertSent = false; }, FAILURE_WINDOW_MS);
    return true;
  }

  return false;
}

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

  webhookLogger.info('Sending call data to BuddyHelps Dashboard', {
    callSid: callData.callSid,
    webhookUrl: process.env.WEBHOOK_URL,
    businessName: payload.business_name,
  });

  // Retry loop with exponential backoff
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
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
        attempt: attempt + 1,
      });

      return result;
    } catch (error) {
      const isLastAttempt = attempt === MAX_RETRIES - 1;

      if (isLastAttempt) {
        webhookLogger.error('Failed to send to dashboard after all retries', error, {
          callSid: callData.callSid,
          attempts: MAX_RETRIES,
        });

        // Track failure and check threshold
        const thresholdExceeded = trackFailure();

        // Always alert on individual failure
        const timestamp = new Date().toISOString();
        await notifyPumble(
          `⚠️ *Webhook Failed*\n` +
          `Time: ${timestamp}\n` +
          `Call SID: ${callData.callSid}\n` +
          `From: ${callData.fromNumber || 'Unknown'}\n` +
          `To: ${callData.toNumber || 'Unknown'}\n` +
          `Business: ${userConfig?.business_name || 'Unknown'}\n` +
          `Webhook: ${process.env.WEBHOOK_URL}\n` +
          `Error: ${error.message}\n` +
          `Retries: ${MAX_RETRIES} attempts exhausted\n` +
          `\n` +
          `Debug: \`SELECT * FROM call_events WHERE call_id = (SELECT id FROM calls WHERE call_sid = '${callData.callSid}')\``
        );

        // Additional alert if threshold exceeded
        if (thresholdExceeded) {
          await notifyPumble(
            `🚨 *ALERT: High Webhook Failure Rate*\n` +
            `${FAILURE_THRESHOLD}+ webhook failures in last 15 minutes!\n` +
            `Dashboard may be down or unreachable.\n` +
            `Check: ${process.env.WEBHOOK_URL}`
          );
        }

        // Don't throw - call still succeeded even if webhook failed
        return { error: error.message };
      }

      // Calculate delay with exponential backoff
      const delay = INITIAL_DELAY_MS * Math.pow(2, attempt);
      webhookLogger.warn('Webhook failed, retrying...', {
        callSid: callData.callSid,
        attempt: attempt + 1,
        nextRetryIn: `${delay}ms`,
        error: error.message,
      });

      await new Promise(resolve => setTimeout(resolve, delay));
    }
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
