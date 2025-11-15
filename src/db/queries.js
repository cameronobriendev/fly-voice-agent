/**
 * Database query functions
 */

import { sql } from './neon.js';
import { logger } from '../utils/logger.js';

const dbLogger = logger.child('QUERIES');

/**
 * Get user configuration by Twilio phone number
 * @param {string} twilioNumber - The Twilio phone number (E.164 format)
 * @returns {Promise<Object>} User configuration object
 */
export async function getUserByPhone(twilioNumber) {
  try {
    dbLogger.info('Looking up user by phone', { phone: twilioNumber });

    const result = await sql`
      SELECT * FROM leadsaveai.users
      WHERE twilio_phone_number = ${twilioNumber}
      LIMIT 1
    `;

    if (result.length === 0) {
      dbLogger.warn('No user found for phone number', { phone: twilioNumber });
      throw new Error(`No user found for number: ${twilioNumber}`);
    }

    const user = result[0];
    dbLogger.info('User found', {
      userId: user.user_id,
      businessName: user.business_name,
    });

    return user;
  } catch (error) {
    dbLogger.error('Error fetching user by phone', error, {
      phone: twilioNumber,
    });
    throw error;
  }
}

/**
 * Create a new call record
 * @param {Object} callData - Call data to insert
 * @returns {Promise<Object>} Created call record
 */
export async function createCall(callData) {
  try {
    dbLogger.info('Creating call record', {
      userId: callData.user_id,
      callSid: callData.twilio_call_sid,
    });

    const result = await sql`
      INSERT INTO leadsaveai.calls (
        user_id,
        twilio_call_sid,
        caller_phone,
        caller_name,
        caller_email,
        call_started_at,
        call_ended_at,
        duration_seconds,
        issue_description,
        urgency_level,
        transcript,
        ai_confidence_score,
        status,
        notes
      )
      VALUES (
        ${callData.user_id},
        ${callData.twilio_call_sid},
        ${callData.caller_phone},
        ${callData.caller_name || null},
        ${callData.caller_email || null},
        ${callData.call_started_at},
        ${callData.call_ended_at || null},
        ${callData.duration_seconds || 0},
        ${callData.issue_description || null},
        ${callData.urgency_level || 'medium'},
        ${callData.transcript || ''},
        ${callData.ai_confidence_score || 0},
        ${callData.status || 'new'},
        ${callData.notes || ''}
      )
      RETURNING *
    `;

    dbLogger.info('Call record created', {
      callId: result[0].call_id,
    });

    return result[0];
  } catch (error) {
    dbLogger.error('Error creating call record', error, {
      callSid: callData.twilio_call_sid,
    });
    throw error;
  }
}

/**
 * Update recording URL for a call
 * @param {string} twilioCallSid - Twilio call SID
 * @param {string} recordingUrl - Recording URL from Twilio
 * @returns {Promise<Object>} Updated call record
 */
export async function updateRecordingUrl(twilioCallSid, recordingUrl) {
  try {
    dbLogger.info('Updating recording URL', { callSid: twilioCallSid });

    const result = await sql`
      UPDATE leadsaveai.calls
      SET recording_url = ${recordingUrl}
      WHERE twilio_call_sid = ${twilioCallSid}
      RETURNING *
    `;

    if (result.length === 0) {
      dbLogger.warn('No call found for recording update', {
        callSid: twilioCallSid,
      });
      throw new Error(`No call found for SID: ${twilioCallSid}`);
    }

    dbLogger.info('Recording URL updated', {
      callId: result[0].call_id,
    });

    return result[0];
  } catch (error) {
    dbLogger.error('Error updating recording URL', error, {
      callSid: twilioCallSid,
    });
    throw error;
  }
}
