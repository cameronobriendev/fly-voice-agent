/**
 * Prompt builder service
 * Builds custom prompts using user configuration
 */

import { PROMPT_TEMPLATE } from '../prompts/template.js';
import { logger } from '../utils/logger.js';

const promptLogger = logger.child('PROMPT');

/**
 * Build a custom prompt from template using user configuration
 * @param {Object} userConfig - User configuration from database
 * @returns {string} Customized prompt
 */
export function buildPrompt(userConfig) {
  let prompt = PROMPT_TEMPLATE;

  // Replace business name
  prompt = prompt.replace(
    /{{BUSINESS_NAME}}/g,
    userConfig.business_name || 'our company'
  );

  // Replace industry
  prompt = prompt.replace(/{{INDUSTRY}}/g, userConfig.industry || 'service');

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

  // Build Q&A section
  const qaSection = buildQASection(userConfig.business_qa);
  prompt = prompt.replace(/{{BUSINESS_QA}}/g, qaSection);

  // Note: {{PHONE}} will be replaced during the call with actual caller's number
  // This is done in the conversation handler, not here

  promptLogger.info('Prompt built', {
    businessName: userConfig.business_name,
    industry: userConfig.industry,
    serviceTypesCount: userConfig.service_types?.length || 0,
    qaCount: Object.keys(userConfig.business_qa || {}).length,
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
};
