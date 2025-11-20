/**
 * Admin API for managing user configurations
 * Allows viewing and editing user prompt variables
 */

import { sql } from '../../db/neon.js';
import { logger } from '../../utils/logger.js';
import { buildPrompt, insertPhoneNumber } from '../../services/prompt-builder.js';

const usersLogger = logger.child('ADMIN_USERS');
const SCHEMA = process.env.DB_SCHEMA || 'public';

/**
 * GET /api/admin/users
 * List all users with their prompt configurations
 */
export async function getUsers(req, res) {
  try {
    const users = await sql(`
      SELECT
        user_id,
        twilio_phone_number,
        business_name,
        industry,
        service_types,
        business_qa,
        callback_window,
        notification_phone,
        notification_email,
        created_at
      FROM ${SCHEMA}.user_voice_config
      WHERE twilio_phone_number IS NOT NULL
      ORDER BY created_at DESC
    `);

    usersLogger.info('Users retrieved', { count: users.length });

    res.json({ users });
  } catch (error) {
    usersLogger.error('Error retrieving users', error);
    res.status(500).json({ error: 'Failed to retrieve users' });
  }
}

/**
 * GET /api/admin/users/:userId
 * Get single user configuration
 */
export async function getUser(req, res) {
  try {
    const { userId } = req.params;

    const users = await sql(`
      SELECT
        user_id,
        twilio_phone_number,
        business_name,
        industry,
        service_types,
        business_qa,
        callback_window,
        notification_phone,
        notification_email,
        created_at
      FROM ${SCHEMA}.user_voice_config
      WHERE user_id = $1
    `, [userId]);

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    usersLogger.info('User retrieved', { userId });

    res.json({ user: users[0] });
  } catch (error) {
    usersLogger.error('Error retrieving user', error);
    res.status(500).json({ error: 'Failed to retrieve user' });
  }
}

/**
 * PUT /api/admin/users/:userId
 * Update user prompt variables
 */
export async function updateUser(req, res) {
  try {
    const { userId } = req.params;
    const {
      business_name,
      industry,
      service_types,
      business_qa,
      callback_window,
      notification_phone,
      notification_email,
    } = req.body;

    // Validate required fields
    if (!business_name || !industry) {
      return res.status(400).json({ error: 'business_name and industry are required' });
    }

    // Validate JSON fields
    if (service_types && !Array.isArray(service_types)) {
      return res.status(400).json({ error: 'service_types must be an array' });
    }

    if (business_qa && typeof business_qa !== 'object') {
      return res.status(400).json({ error: 'business_qa must be an object' });
    }

    // Upsert business_config table (source of truth)
    const result = await sql(`
      INSERT INTO ${SCHEMA}.business_config (
        user_id, business_name, industry, services_offered,
        common_faqs, special_instructions, updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, NOW()
      )
      ON CONFLICT (user_id)
      DO UPDATE SET
        business_name = EXCLUDED.business_name,
        industry = EXCLUDED.industry,
        services_offered = EXCLUDED.services_offered,
        common_faqs = EXCLUDED.common_faqs,
        special_instructions = EXCLUDED.special_instructions,
        updated_at = NOW()
      RETURNING *
    `, [
      userId,
      business_name,
      industry,
      JSON.stringify(service_types || []),
      JSON.stringify(business_qa || {}),
      callback_window || 'soon'
    ]);

    if (result.length === 0) {
      return res.status(500).json({ error: 'Failed to save configuration' });
    }

    // Handle notification contacts (phone and email)
    if (notification_phone) {
      await sql(`
        INSERT INTO ${SCHEMA}.notification_contacts (user_id, contact_type, contact_value, is_primary)
        VALUES ($1, 'phone', $2, true)
        ON CONFLICT (user_id, contact_type, contact_value)
        DO UPDATE SET is_primary = true, updated_at = NOW()
      `, [userId, notification_phone]);
    }

    if (notification_email) {
      await sql(`
        INSERT INTO ${SCHEMA}.notification_contacts (user_id, contact_type, contact_value, is_primary)
        VALUES ($1, 'email', $2, true)
        ON CONFLICT (user_id, contact_type, contact_value)
        DO UPDATE SET is_primary = true, updated_at = NOW()
      `, [userId, notification_email]);
    }

    usersLogger.info('User updated', { userId, business_name });

    res.json({ user: result[0], message: 'User updated successfully' });
  } catch (error) {
    usersLogger.error('Error updating user', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
}

/**
 * GET /api/admin/users/:userId/preview
 * Preview final prompt with user's variables filled in
 */
export async function previewPrompt(req, res) {
  try {
    const { userId } = req.params;
    const { templateType = 'client' } = req.query; // 'demo' or 'client'

    // Get user config
    const users = await sql(`
      SELECT
        twilio_phone_number,
        business_name,
        industry,
        service_types,
        business_qa,
        callback_window
      FROM ${SCHEMA}.user_voice_config
      WHERE user_id = $1
    `, [userId]);

    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const userConfig = users[0];

    // Build prompt with user data
    const prompt = buildPrompt(userConfig, templateType);

    // Insert example phone number for preview
    const finalPrompt = insertPhoneNumber(prompt, userConfig.twilio_phone_number || '+15555555555');

    usersLogger.info('Prompt preview generated', { userId, templateType });

    res.json({
      prompt: finalPrompt,
      template_type: templateType,
      user_config: userConfig,
    });
  } catch (error) {
    usersLogger.error('Error generating prompt preview', error);
    res.status(500).json({ error: 'Failed to generate preview' });
  }
}
