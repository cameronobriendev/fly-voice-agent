/**
 * Fix demo user's business_qa directly in users table
 */

import { sql } from '../src/db/neon.js';

const SCHEMA = process.env.DB_SCHEMA || 'public';
const DEMO_PHONE = process.env.DEMO_PHONE_NUMBER || '+17753767929';

const businessQA = {
  "What is LeadSaveAI?": "LeadSaveAI is a natural AI receptionist that handles your real inbound calls. You create an account, enter your website so it learns about your business, forward your number, and turn it on. It answers after-hours or when your lines are busy, filters spam, and sends transcripts and summaries instantly.",
  "How does it know what to say?": "It learns from your website and past call history so it speaks accurately for your business.",
  "Does it replace my staff?": "Not at all - your team answers first; we only catch missed or after-hours calls.",
  "What's it cost?": "The Free Forever Plan covers 8 real calls a week, completely free.",
  "How do I try it?": "It takes about 2 minutes - create a free account, enter your website, and forward your number.",
  "What can it do?": "It answers calls 24/7 with a human-sounding voice, filters spam, and sends you transcripts via email or SMS right away.",
  "What if I need help?": "We're a small family business, so you'll get personal help any time you need it."
};

async function fixDemoQA() {
  console.log('Fixing demo user business_qa...\n');
  console.log('Phone:', DEMO_PHONE);
  console.log('Schema:', SCHEMA);

  try {
    // First get the user_id for the phone number
    const user = await sql(`
      SELECT user_id FROM ${SCHEMA}.users
      WHERE twilio_phone_number = $1
    `, [DEMO_PHONE]);

    if (user.length === 0) {
      console.error('❌ No user found for phone number:', DEMO_PHONE);
      process.exit(1);
    }

    const userId = user[0].user_id;
    console.log('Found user:', userId);

    // Update common_faqs in business_config table
    const result = await sql(`
      UPDATE ${SCHEMA}.business_config
      SET common_faqs = $1
      WHERE user_id = $2
      RETURNING user_id
    `, [JSON.stringify(businessQA), userId]);

    if (result.length === 0) {
      console.error('❌ No business_config found for user');
      process.exit(1);
    }

    console.log('\n✅ Updated successfully!');
    console.log('User ID:', result[0].user_id);
    console.log('Q&A entries:', Object.keys(businessQA).length);

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }

  process.exit(0);
}

fixDemoQA();
