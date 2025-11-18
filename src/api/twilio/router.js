/**
 * Twilio Smart Router
 *
 * Routes incoming calls based on the number called:
 * - +14374282102: Hangs up immediately (dead number)
 * - All other numbers: Connects to Fly.io WebSocket voice agent
 *
 * Usage:
 * Point ALL Twilio numbers to this single URL:
 * https://fly-voice-agent-red-darkness-2650.fly.dev/api/twilio/router
 */

import { logger } from '../../utils/logger.js';

const routerLogger = logger.child('TWILIO_ROUTER');

// Number that should hang up immediately
const BLOCKED_NUMBER = '+14374282102';

// WebSocket stream URL for voice agent
const STREAM_URL = process.env.FLY_STREAM_URL || 'wss://fly-voice-agent-red-darkness-2650.fly.dev/stream';

/**
 * Escape XML special characters
 */
function xmlEscape(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate TwiML for hanging up
 */
function generateHangupTwiML() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`;
}

/**
 * Generate TwiML for connecting to voice agent stream
 */
function generateStreamTwiML(to, from) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${STREAM_URL}">
      <Parameter name="To" value="${xmlEscape(to)}" />
      <Parameter name="From" value="${xmlEscape(from)}" />
    </Stream>
  </Connect>
  <Pause length="60"/>
</Response>`;
}

/**
 * Router endpoint handler
 * Immediately connects all calls to voice agent WebSocket stream
 * Ringback is played through the stream during initialization
 */
export function handleTwilioRouter(req, res) {
  const { To, From, CallSid } = req.body;

  routerLogger.info('Incoming call received', {
    to: To,
    from: From,
    callSid: CallSid,
  });

  // Check if this is the blocked number
  if (To === BLOCKED_NUMBER) {
    routerLogger.info('Blocked number called - hanging up', {
      number: To,
      callSid: CallSid,
    });

    res.type('text/xml');
    return res.send(generateHangupTwiML());
  }

  // Connect to voice agent stream immediately
  routerLogger.info('Connecting to voice agent stream', {
    to: To,
    from: From,
    callSid: CallSid,
    streamUrl: STREAM_URL,
  });

  res.type('text/xml');
  return res.send(generateStreamTwiML(To, From));
}
