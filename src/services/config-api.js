/**
 * Fetch phone configuration from BuddyHelps Dashboard API
 * This replaces the Neon database lookup for BuddyHelps integration
 */

import { logger } from '../utils/logger.js';

const configLogger = logger.child('CONFIG-API');

// Dashboard API base URL
const DASHBOARD_API = process.env.DASHBOARD_API_URL || 'https://info.buddyhelps.ca';

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
      if (response.status === 404) {
        throw new Error(`No config found for number: ${twilioNumber}`);
      }
      if (response.status === 403) {
        throw new Error(`Phone number is not active: ${twilioNumber}`);
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
      ai_voice_id: null, // Use default Cartesia voice
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
