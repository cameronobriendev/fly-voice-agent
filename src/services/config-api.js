/**
 * Fetch phone configuration from BuddyHelps Dashboard API
 * This replaces the Neon database lookup for BuddyHelps integration
 */

import { logger } from '../utils/logger.js';

const configLogger = logger.child('CONFIG-API');

// Dashboard API base URL
const DASHBOARD_API = process.env.DASHBOARD_API_URL || 'https://info.buddyhelps.ca';

// Pumble API for alerts
const PUMBLE_API = process.env.PUMBLE_API;

/**
 * Send alert to Pumble when config error occurs
 */
async function notifyPumble(message) {
  if (!PUMBLE_API) {
    configLogger.warn('PUMBLE_API not configured, skipping notification');
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
    configLogger.info('Pumble alert sent');
  } catch (err) {
    configLogger.error('Pumble notification failed', err);
  }
}

/**
 * Fetch user configuration from dashboard API by Twilio phone number
 * @param {string} twilioNumber - The Twilio phone number (E.164 format)
 * @returns {Promise<Object>} User configuration object
 */
export async function getConfigFromDashboard(twilioNumber) {
  try {
    configLogger.info('Fetching config from dashboard', { phone: twilioNumber });

    const url = `${DASHBOARD_API}/api/config/${encodeURIComponent(twilioNumber)}`;
    const response = await fetch(url);

    if (!response.ok) {
      if (response.status === 404 || response.status === 403) {
        const reason = response.status === 404 ? 'not configured' : 'not active';
        configLogger.warn(`Config error: ${twilioNumber} is ${reason}`, { status: response.status });

        // Notify Pumble about unconfigured call
        notifyPumble(`⚠️ *BuddyHelps Alert*\nCall to unconfigured number: ${twilioNumber}\nReason: ${reason}\nCaller heard error message and was asked to call back.`);

        // Return error config - twilio-handler will play error message
        return {
          _configError: true,
          _errorReason: reason,
          twilio_phone_number: twilioNumber,
        };
      }
      throw new Error(`Dashboard API error: ${response.status}`);
    }

    const config = await response.json();

    configLogger.info('Config loaded from dashboard', {
      businessName: config.business_name,
      greetingName: config.greeting_name,
      isDemo: config.is_demo,
    });

    // Map dashboard config to format expected by voice agent
    return {
      // Dashboard fields
      business_name: config.business_name,
      greeting_name: config.greeting_name || 'Buddy',
      plumber_phone: config.plumber_phone,
      plumber_email: config.plumber_email,
      system_prompt: config.system_prompt,
      is_demo: config.is_demo,
      is_active: config.is_active,

      // Fields expected by voice agent (mapped/defaulted)
      twilio_phone_number: twilioNumber,
      user_id: null, // Not needed for BuddyHelps
      industry: 'plumbing', // BuddyHelps is plumbing-focused
      ai_voice_id: config.voice_id || null, // Custom Cartesia voice or null for default
      service_area: null,

      // Generate greetings based on config
      client_greeting: config.is_demo
        ? null
        : `Hi, thanks for calling ${config.business_name || 'us'}! This is ${config.greeting_name || 'Buddy'}. How can I help you today?`,
      demo_greeting: config.is_demo
        ? `Hi, this is the BuddyHelps demo line. I answer calls for plumbers. Want to hear what your customers will experience? Tell me about a plumbing problem, real or made up, and I'll show you how I handle it. Go ahead.`
        : null,
      demo_fallback_greeting: `Hi, this is the BuddyHelps demo line. I answer calls for plumbers. Tell me about a plumbing problem and I'll show you how I handle it.`,
    };
  } catch (error) {
    configLogger.error('Error fetching config from dashboard', error, {
      phone: twilioNumber,
    });
    throw error;
  }
}

export default {
  getConfigFromDashboard,
};
