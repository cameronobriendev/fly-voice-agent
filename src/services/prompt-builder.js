/**
 * Prompt builder service
 * Builds custom prompts using user configuration
 */

import { DEMO_TEMPLATE } from '../prompts/templates/demo-template.js';
import { CLIENT_TEMPLATE } from '../prompts/templates/client-template.js';
import { logger } from '../utils/logger.js';
import { getDemoRequestByPhone } from '../db/queries.js';

const promptLogger = logger.child('PROMPT');

// Demo phone numbers (comma-separated for multiple demo lines)
const DEMO_PHONE_NUMBERS = (process.env.DEMO_PHONE_NUMBERS || process.env.DEMO_PHONE_NUMBER || '')
  .split(',')
  .map(n => n.trim())
  .filter(n => n);

/**
 * Check if a phone number is a demo line
 */
export function isDemoNumber(phoneNumber) {
  return DEMO_PHONE_NUMBERS.includes(phoneNumber);
}

/**
 * Derive assistant name from business name
 * BuddyHelps -> Buddy, BennyHelps -> Benny, etc.
 */
function getAssistantName(businessName) {
  if (!businessName) return 'the assistant';
  // Remove "Helps" suffix if present
  const name = businessName.replace(/Helps$/i, '').trim();
  return name || 'the assistant';
}

/**
 * Build a custom prompt from template using user configuration
 * @param {Object} userConfig - User configuration from database
 * @param {string} templateType - 'demo' or 'client' (optional, auto-detects from phone)
 * @param {string} callerNumber - Caller's phone number (optional, for demo industry lookup)
 * @returns {Promise<string>} Customized prompt
 */
export async function buildPrompt(userConfig, templateType = null, callerNumber = null) {
  // If custom system_prompt is provided, use it directly (with variable substitution)
  if (userConfig.system_prompt) {
    promptLogger.info('Using custom system prompt from config', {
      businessName: userConfig.business_name,
      promptLength: userConfig.system_prompt.length,
    });
    let prompt = userConfig.system_prompt;
    // Still do variable substitution on custom prompts
    prompt = prompt.replace(/{{BUSINESS_NAME}}/g, userConfig.business_name || 'our company');
    prompt = prompt.replace(/{{GREETING_NAME}}/g, userConfig.greeting_name || 'the assistant');
    prompt = prompt.replace(/{{INDUSTRY}}/g, userConfig.industry || 'service');
    return prompt;
  }

  // Auto-detect template type if not specified
  if (!templateType) {
    templateType = userConfig.is_demo ? 'demo' : 'client';
  }

  // Select appropriate template
  let prompt = templateType === 'demo' ? DEMO_TEMPLATE : CLIENT_TEMPLATE;

  // Replace business name
  prompt = prompt.replace(
    /{{BUSINESS_NAME}}/g,
    userConfig.business_name || 'our company'
  );

  // Replace assistant name (derived from business name: BuddyHelps -> Buddy)
  const assistantName = getAssistantName(userConfig.business_name);
  prompt = prompt.replace(/{{ASSISTANT_NAME}}/g, assistantName);

  // Replace service name (the full business name for branding)
  prompt = prompt.replace(/{{SERVICE_NAME}}/g, userConfig.business_name || 'our service');

  // Replace service area (geographic region served)
  prompt = prompt.replace(/{{SERVICE_AREA}}/g, userConfig.service_area || 'the area');

  // Replace industry - for demo calls, look up from database
  let industry = userConfig.industry || 'service';

  if (templateType === 'demo' && callerNumber) {
    promptLogger.info('Looking up industry for demo caller', { callerNumber });
    const demoRequest = await getDemoRequestByPhone(callerNumber);

    if (demoRequest && demoRequest.industry_slug) {
      industry = demoRequest.industry_slug;
      promptLogger.info('Using caller-specific industry', {
        callerNumber,
        industry
      });
    } else {
      promptLogger.info('No demo request found, using default industry', {
        callerNumber,
        defaultIndustry: industry
      });
    }
  }

  prompt = prompt.replace(/{{INDUSTRY}}/g, industry);

  // Replace service types (format as list)
  const serviceTypesList = Array.isArray(userConfig.service_types)
    ? userConfig.service_types.join(', ')
    : 'general services';
  prompt = prompt.replace(/{{SERVICE_TYPES}}/g, serviceTypesList);

  // Replace callback window
  prompt = prompt.replace(
    /{{CALLBACK_WINDOW}}/g,
    userConfig.callback_window || 'soon'
  );

  // Parse business_qa if it's a string (JSON from database)
  let businessQA = userConfig.business_qa;
  if (typeof businessQA === 'string') {
    try {
      businessQA = JSON.parse(businessQA);
    } catch (e) {
      promptLogger.warn('Failed to parse business_qa JSON', { error: e.message });
      businessQA = {};
    }
  }

  // Build Q&A section
  const qaSection = buildQASection(businessQA);
  prompt = prompt.replace(/{{BUSINESS_QA}}/g, qaSection);

  // Note: {{PHONE}} will be replaced during the call with actual caller's number
  // This is done in the conversation handler, not here

  promptLogger.info('Prompt built', {
    templateType,
    businessName: userConfig.business_name,
    industry: userConfig.industry,
    serviceTypesCount: userConfig.service_types?.length || 0,
    qaCount: Object.keys(businessQA || {}).length,
  });

  return prompt;
}

/**
 * Build the Q&A section from business_qa JSON
 * @param {Object} businessQA - Key-value pairs of questions and answers
 * @returns {string} Formatted Q&A section
 */
function buildQASection(businessQA) {
  if (!businessQA || Object.keys(businessQA).length === 0) {
    return 'Answer common questions about services, pricing, and availability honestly. If you don\'t know something, say "Let me have someone call you back with that information."';
  }

  const qaLines = Object.entries(businessQA).map(([question, answer]) => {
    return `Q: "${question}"\nA: "${answer}"`;
  });

  return qaLines.join('\n\n');
}

/**
 * Substitute template variables with actual values
 * Used for custom greetings and other user-facing text
 * @param {string} text - Text with {{VARIABLES}}
 * @param {Object} userConfig - User configuration from database
 * @returns {string} Text with variables replaced
 */
export function substituteVariables(text, userConfig) {
  if (!text) return text;

  let result = text;

  // Replace {{BUSINESS_NAME}}
  result = result.replace(/{{BUSINESS_NAME}}/g, userConfig.business_name || 'our company');

  // Replace {{INDUSTRY}}
  result = result.replace(/{{INDUSTRY}}/g, userConfig.industry || 'service');

  return result;
}

/**
 * Replace phone number placeholder in prompt
 * @param {string} prompt - Prompt with {{PHONE}} placeholder
 * @param {string} phoneNumber - Phone number to insert
 * @returns {string} Prompt with phone number
 */
export function insertPhoneNumber(prompt, phoneNumber) {
  return prompt.replace(/{{PHONE}}/g, phoneNumber);
}

export default {
  buildPrompt,
  insertPhoneNumber,
  substituteVariables,
};
