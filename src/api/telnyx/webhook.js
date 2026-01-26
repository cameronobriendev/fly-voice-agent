/**
 * Telnyx Call Control Webhook Handler
 *
 * Handles incoming Telnyx Call Control events:
 * - call.initiated: Answer the call and start media streaming
 * - streaming.started: Log confirmation
 * - call.hangup: Log call end
 *
 * Unlike Twilio (which uses TwiML XML responses), Telnyx uses REST API commands.
 * We respond with 200 OK immediately, then send commands asynchronously.
 */

import { logger } from '../../utils/logger.js';
import crypto from 'crypto';

const telnyxLogger = logger.child('TELNYX_WEBHOOK');

// Environment variables
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;
const TELNYX_PUBLIC_KEY = process.env.TELNYX_PUBLIC_KEY;
const TELNYX_CONNECTION_ID = process.env.TELNYX_CONNECTION_ID;

// WebSocket stream URL for voice agent
const STREAM_URL = process.env.FLY_TELNYX_STREAM_URL || process.env.FLY_STREAM_URL?.replace('/stream', '/telnyx-stream');

// Blocked number (optional)
const BLOCKED_NUMBER = process.env.BLOCKED_NUMBER || '';

/**
 * Verify Telnyx webhook signature
 * @param {string} payload - Raw request body
 * @param {string} signature - X-Telnyx-Signature header
 * @param {string} timestamp - X-Telnyx-Timestamp header
 * @returns {boolean} Whether signature is valid
 */
function verifySignature(payload, signature, timestamp) {
  if (!TELNYX_PUBLIC_KEY) {
    telnyxLogger.warn('TELNYX_PUBLIC_KEY not set, skipping signature verification');
    return true;
  }

  try {
    const signedPayload = `${timestamp}|${payload}`;
    const verifier = crypto.createVerify('SHA256');
    verifier.update(signedPayload);
    verifier.end();

    // Telnyx signature is base64 encoded
    return verifier.verify(TELNYX_PUBLIC_KEY, signature, 'base64');
  } catch (error) {
    telnyxLogger.error('Signature verification failed', error);
    return false;
  }
}

/**
 * Send a Call Control command to Telnyx API
 * @param {string} callControlId - The call control ID
 * @param {string} action - The action to perform (answer, streaming_start, hangup)
 * @param {object} params - Additional parameters for the action
 */
async function sendCommand(callControlId, action, params = {}) {
  const url = `https://api.telnyx.com/v2/calls/${callControlId}/actions/${action}`;

  telnyxLogger.info('Sending Telnyx command', {
    callControlId,
    action,
    params,
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Telnyx API error: ${response.status} - ${error}`);
    }

    const result = await response.json();
    telnyxLogger.info('Telnyx command successful', {
      callControlId,
      action,
      result: result.data,
    });

    return result;
  } catch (error) {
    telnyxLogger.error('Telnyx command failed', error);
    throw error;
  }
}

/**
 * Handle call.initiated event - Answer and start streaming
 */
async function handleCallInitiated(payload) {
  const { call_control_id, from, to, call_leg_id, connection_id } = payload;

  telnyxLogger.info('Call initiated', {
    callControlId: call_control_id,
    from,
    to,
    callLegId: call_leg_id,
    connectionId: connection_id,
  });

  // Check if this is a blocked number
  if (BLOCKED_NUMBER && to === BLOCKED_NUMBER) {
    telnyxLogger.info('Blocked number called - rejecting', {
      number: to,
      callControlId: call_control_id,
    });

    await sendCommand(call_control_id, 'hangup', {
      cause: 'CALL_REJECTED',
    });
    return;
  }

  // Step 1: Answer the call
  await sendCommand(call_control_id, 'answer', {});

  // Step 2: Start bidirectional media streaming
  // CRITICAL: Must use stream_bidirectional_mode: 'rtp' for real-time voice AI
  // MP3 mode has a 1 payload/second rate limit which breaks voice
  await sendCommand(call_control_id, 'streaming_start', {
    stream_url: STREAM_URL,
    stream_bidirectional_mode: 'rtp',
    // Pass caller info to WebSocket via client_state (base64 encoded)
    client_state: Buffer.from(JSON.stringify({
      to,
      from,
      call_control_id,
      call_leg_id,
    })).toString('base64'),
  });

  telnyxLogger.info('Call answered and streaming started', {
    callControlId: call_control_id,
    streamUrl: STREAM_URL,
  });
}

/**
 * Handle streaming.started event
 */
async function handleStreamingStarted(payload) {
  const { call_control_id, stream_id } = payload;

  telnyxLogger.info('Streaming started', {
    callControlId: call_control_id,
    streamId: stream_id,
  });
}

/**
 * Handle streaming.stopped event
 */
async function handleStreamingStopped(payload) {
  const { call_control_id, stream_id } = payload;

  telnyxLogger.info('Streaming stopped', {
    callControlId: call_control_id,
    streamId: stream_id,
  });
}

/**
 * Handle call.hangup event
 */
async function handleCallHangup(payload) {
  const { call_control_id, hangup_cause, hangup_source } = payload;

  telnyxLogger.info('Call hangup', {
    callControlId: call_control_id,
    cause: hangup_cause,
    source: hangup_source,
  });
}

/**
 * Handle call.answered event (confirmation our answer was processed)
 */
async function handleCallAnswered(payload) {
  const { call_control_id, from, to } = payload;

  telnyxLogger.info('Call answered confirmation', {
    callControlId: call_control_id,
    from,
    to,
  });
}

/**
 * Main webhook handler
 * Responds with 200 OK immediately, processes events asynchronously
 */
export function handleTelnyxWebhook(req, res) {
  // Respond immediately to prevent timeout
  res.status(200).json({ status: 'ok' });

  // Process event asynchronously
  (async () => {
    try {
      const event = req.body?.data;

      if (!event) {
        telnyxLogger.warn('Empty webhook payload received');
        return;
      }

      const eventType = event.event_type;
      const payload = event.payload;

      telnyxLogger.debug('Webhook received', {
        eventType,
        callControlId: payload?.call_control_id,
      });

      switch (eventType) {
        case 'call.initiated':
          await handleCallInitiated(payload);
          break;

        case 'call.answered':
          await handleCallAnswered(payload);
          break;

        case 'streaming.started':
          await handleStreamingStarted(payload);
          break;

        case 'streaming.stopped':
          await handleStreamingStopped(payload);
          break;

        case 'call.hangup':
          await handleCallHangup(payload);
          break;

        default:
          telnyxLogger.debug('Unhandled event type', { eventType });
      }
    } catch (error) {
      telnyxLogger.error('Error processing webhook', error);
    }
  })();
}

export default {
  handleTelnyxWebhook,
  verifySignature,
};
