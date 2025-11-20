/**
 * Update demo phone number configuration with proper Q&A data
 */

import { sql } from '../src/db/neon.js';

const SCHEMA = process.env.DB_SCHEMA || 'public';

const businessQA = {
  "How does it know what to say?": "It learns from your website and past call history so it speaks accurately for your business. Anything else you're curious about?",
  "Does it replace my staff?": "Not at all—your team answers first; we only catch missed or after-hours calls. What else would you like to know?",
  "What's it cost?": "The Free Forever Plan covers 8 real calls a week, completely free, so you can really get a sense for how it can help you in your business.",
  "How do I try it?": "It takes about 2 minutes—create a free account, enter your website, and forward your number. Should I send you the link to start?",
  "What is LeadSaveAI?": "LeadSaveAI is a natural AI receptionist that handles your real inbound calls. You create an account, enter your website so it learns about your business, forward your number, and turn it on. It answers after-hours or when your lines are busy, filters spam, and sends transcripts and summaries instantly.",
  "What can it do?": "It answers calls 24/7 with a human-sounding voice, gives fast responses, filters spam calls, and sends you transcripts via email or SMS right away. It's consistent coverage whenever you need it.",
  "What if I need help?": "We're a small family business, so you'll get personal help any time you need it. We're here for you."
};

async function updateDemoConfig() {
  console.log('Updating demo phone number configuration...\n');

  try {
    // First, get the user_id for the phone number
    const user = await sql(`
      SELECT user_id
      FROM ${SCHEMA}.users
      WHERE twilio_phone_number = $1
    `, [process.env.DEMO_PHONE_NUMBER]);

    if (user.length === 0) {
      console.error('❌ No user found for phone number', process.env.DEMO_PHONE_NUMBER);
      process.exit(1);
    }

    const userId = user[0].user_id;
    console.log('Found user:', userId);

    // Update the business_config table (where the actual data lives)
    const result = await sql(`
      UPDATE ${SCHEMA}.business_config
      SET
        business_name = 'LeadSaveAI',
        industry = 'ai-voice-automation',
        services_offered = '["AI receptionist"]',
        common_faqs = $1
      WHERE user_id = $2
      RETURNING
        business_name,
        industry,
        services_offered,
        common_faqs
    `, [JSON.stringify(businessQA), userId]);

    if (result.length === 0) {
      console.error('❌ No rows updated - business_config not found for user');
      process.exit(1);
    }

    console.log('\n✅ Demo config updated successfully!\n');
    console.log('Business Name:', result[0].business_name);
    console.log('Industry:', result[0].industry);
    console.log('Service Types:', result[0].services_offered);
    console.log('\nBusiness Q&A:');
    console.log(JSON.stringify(JSON.parse(result[0].common_faqs), null, 2));

  } catch (error) {
    console.error('❌ Error updating config:', error.message);
    console.error(error.stack);
    process.exit(1);
  }

  process.exit(0);
}

updateDemoConfig();
