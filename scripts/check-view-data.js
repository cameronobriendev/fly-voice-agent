/**
 * Diagnostic script to check user_voice_config view data
 */

import { sql } from '../src/db/neon.js';

const SCHEMA = process.env.DB_SCHEMA || 'public';
const DEMO_PHONE = process.env.DEMO_PHONE_NUMBER || '+17753767929';

async function checkViewData() {
  console.log('=== CHECKING USER_VOICE_CONFIG VIEW ===\n');
  console.log('Schema:', SCHEMA);
  console.log('Demo Phone:', DEMO_PHONE);

  try {
    // Get demo user data from view
    const userData = await sql(`
      SELECT *
      FROM ${SCHEMA}.user_voice_config
      WHERE twilio_phone_number = $1
    `, [DEMO_PHONE]);

    if (userData.length === 0) {
      console.error('\n❌ No user found for demo phone number');
      process.exit(1);
    }

    const user = userData[0];

    console.log('\n=== DEMO USER DATA ===');
    console.log('User ID:', user.user_id);
    console.log('Business Name:', user.business_name);
    console.log('Industry:', user.industry);
    console.log('Callback Window:', user.callback_window);

    // Check service_types
    const serviceTypes = user.service_types;
    console.log('\n=== SERVICE TYPES ===');
    console.log('Raw value:', JSON.stringify(serviceTypes));
    console.log('Type:', typeof serviceTypes);
    if (Array.isArray(serviceTypes)) {
      console.log('Count:', serviceTypes.length);
      console.log('Items:', serviceTypes);
    } else if (typeof serviceTypes === 'string') {
      try {
        const parsed = JSON.parse(serviceTypes);
        console.log('Parsed count:', Array.isArray(parsed) ? parsed.length : 'N/A');
        console.log('Parsed items:', parsed);
      } catch (e) {
        console.log('Not valid JSON');
      }
    }

    // Check business_qa
    const businessQA = user.business_qa;
    console.log('\n=== BUSINESS Q&A ===');
    console.log('Type:', typeof businessQA);
    if (typeof businessQA === 'object' && businessQA !== null) {
      const qaKeys = Object.keys(businessQA);
      console.log('Q&A Count:', qaKeys.length);
      console.log('Questions:', qaKeys);
    } else if (typeof businessQA === 'string') {
      try {
        const parsed = JSON.parse(businessQA);
        const qaKeys = Object.keys(parsed);
        console.log('Parsed Q&A Count:', qaKeys.length);
        console.log('Questions:', qaKeys);
      } catch (e) {
        console.log('Not valid JSON');
      }
    } else {
      console.log('Value:', businessQA);
    }

    // Also check what's in business_config directly
    console.log('\n=== DIRECT BUSINESS_CONFIG CHECK ===');
    const configData = await sql(`
      SELECT
        bc.user_id,
        bc.business_name,
        bc.industry,
        bc.services_offered,
        bc.common_faqs
      FROM ${SCHEMA}.business_config bc
      JOIN ${SCHEMA}.users u ON bc.user_id = u.user_id
      WHERE u.twilio_phone_number = $1
    `, [DEMO_PHONE]);

    if (configData.length > 0) {
      const config = configData[0];
      console.log('Business Name:', config.business_name);
      console.log('Industry:', config.industry);
      console.log('Services Offered:', config.services_offered);

      const faqs = config.common_faqs;
      if (typeof faqs === 'object' && faqs !== null) {
        console.log('FAQ Count:', Object.keys(faqs).length);
      } else if (typeof faqs === 'string') {
        try {
          const parsed = JSON.parse(faqs);
          console.log('FAQ Count:', Object.keys(parsed).length);
        } catch (e) {
          console.log('FAQ parsing error');
        }
      }
    } else {
      console.log('No business_config found');
    }

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }

  process.exit(0);
}

checkViewData();
