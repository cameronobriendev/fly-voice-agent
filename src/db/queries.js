/**
 * Database query functions
 */

import { sql } from './neon.js';
import { logger } from '../utils/logger.js';

const dbLogger = logger.child('QUERIES');
const SCHEMA = process.env.DB_SCHEMA || 'public';

/**
 * Get user configuration by Twilio phone number
 * @param {string} twilioNumber - The Twilio phone number (E.164 format)
 * @returns {Promise<Object>} User configuration object
 */
export async function getUserByPhone(twilioNumber) {
  try {
    dbLogger.info('Looking up user by phone', { phone: twilioNumber });

    // Query tables directly instead of broken view
    // The view was aggregating all users' data together
    const result = await sql(`
      SELECT
        u.user_id,
        u.twilio_phone_number,
        bc.business_name,
        bc.industry,
        bc.services_offered AS service_types,
        bc.common_faqs AS business_qa,
        bc.ai_voice_id,
        bc.service_area,
        bc.client_greeting,
        bc.demo_greeting,
        bc.demo_fallback_greeting
      FROM ${SCHEMA}.users u
      JOIN ${SCHEMA}.business_config bc ON u.user_id = bc.user_id
      WHERE u.twilio_phone_number = $1
      LIMIT 1
    `, [twilioNumber]);

    if (result.length === 0) {
      dbLogger.warn('No user found for phone number', { phone: twilioNumber });
      throw new Error(`No user found for number: ${twilioNumber}`);
    }

    const user = result[0];
    dbLogger.info('User found', {
      userId: user.user_id,
      businessName: user.business_name,
      voiceId: user.ai_voice_id,
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

    const result = await sql(`
      INSERT INTO ${SCHEMA}.calls (
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
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
      )
      RETURNING *
    `, [
      callData.user_id,
      callData.twilio_call_sid,
      callData.caller_phone,
      callData.caller_name || null,
      callData.caller_email || null,
      callData.call_started_at,
      callData.call_ended_at || null,
      callData.duration_seconds || 0,
      callData.issue_description || null,
      callData.urgency_level || 'medium',
      callData.transcript || '',
      callData.ai_confidence_score || 0,
      callData.status || 'new',
      callData.notes || ''
    ]);

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

    const result = await sql(`
      UPDATE ${SCHEMA}.calls
      SET recording_url = $1
      WHERE twilio_call_sid = $2
      RETURNING *
    `, [recordingUrl, twilioCallSid]);

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

/**
 * Get demo request by phone number (for dynamic industry lookup)
 * @param {string} phoneNumber - Caller's phone number
 * @returns {Promise<Object|null>} Demo request with industry_slug, or null if not found
 */
export async function getDemoRequestByPhone(phoneNumber) {
  // If database not configured, return null (BuddyHelps uses dashboard API)
  if (!sql) {
    dbLogger.debug('Database not configured, skipping demo request lookup');
    return null;
  }

  try {
    dbLogger.info('Looking up demo request by phone', { phone: phoneNumber });

    const result = await sql(`
      SELECT industry_slug, requested_at
      FROM ${SCHEMA}.demo_requests
      WHERE phone_number = $1
      ORDER BY requested_at DESC
      LIMIT 1
    `, [phoneNumber]);

    if (result.length === 0) {
      dbLogger.info('No demo request found for phone number', { phone: phoneNumber });
      return null;
    }

    const demoRequest = result[0];
    dbLogger.info('Demo request found', {
      phone: phoneNumber,
      industry: demoRequest.industry_slug,
      requestedAt: demoRequest.requested_at,
    });

    return demoRequest;
  } catch (error) {
    dbLogger.error('Error fetching demo request by phone', error, {
      phone: phoneNumber,
    });
    // Return null instead of throwing - demo lookup is optional
    return null;
  }
}
