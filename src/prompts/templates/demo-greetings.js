/**
 * Demo Greetings for LeadSaveAI Demo Number (775-376-7929)
 * These are global greetings used for ALL demo calls
 *
 * DEMO_GREETING: Used when caller's phone number is in demo_requests table
 * - Has {{BUSINESS_NAME}} and {{INDUSTRY}} variables available
 *
 * DEMO_FALLBACK_GREETING: Used when caller's phone number is NOT in demo_requests
 * - Only {{BUSINESS_NAME}} variable available (no industry data)
 */

export const DEMO_GREETING = `Thanks for calling {{BUSINESS_NAME}}! I understand you're interested in learning more about our {{INDUSTRY}} platform. How can I help you today?`;

export const DEMO_FALLBACK_GREETING = `Thanks for calling {{BUSINESS_NAME}}! How can I help you today?`;
