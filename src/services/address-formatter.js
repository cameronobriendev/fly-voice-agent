/**
 * Address Formatter Service
 * Uses Llama 3.1 8B on Groq for fast, cheap address cleanup
 *
 * Purpose: Second LLM pass to clean messy addresses from voice transcripts
 * - Removes filler words (um, uh, like, located at, my address is)
 * - Adds proper punctuation/commas
 * - Standardizes province names (Alberta → AB)
 * - Handles incomplete addresses gracefully
 */

import Groq from 'groq-sdk';
import { logger } from '../utils/logger.js';

const addressLogger = logger.child('ADDRESS');

const SYSTEM_PROMPT = `You format messy Canadian addresses into clean, standardized format. Output ONLY the formatted address, nothing else.

Rules:
- Remove filler words (um, uh, like, located at, my address is, it's at, we're at)
- Add commas between street, city, province
- Use province abbreviations (Alberta→AB, British Columbia→BC, Ontario→ON, Saskatchewan→SK, Manitoba→MB, Quebec→QC, Nova Scotia→NS, New Brunswick→NB, Newfoundland→NL, Prince Edward Island→PE, Northwest Territories→NT, Yukon→YT, Nunavut→NU)
- Keep apartment/unit numbers
- If address is too incomplete to be useful, output: INCOMPLETE

Examples:

Input: uh 789 Birch Lane in Calgary Alberta
Output: 789 Birch Lane, Calgary, AB

Input: my address is um 456 Oak Avenue Vancouver British Columbia
Output: 456 Oak Avenue, Vancouver, BC

Input: it's 123 Main Street apartment 4B Edmonton
Output: 123 Main Street, Apartment 4B, Edmonton, AB

Input: located at 555 Pine Road in the southeast
Output: 555 Pine Road, Southeast

Input: um somewhere in Calgary I think
Output: INCOMPLETE`;

/**
 * Format a messy address string into clean standardized format
 * @param {string} rawAddress - Messy address from transcript extraction
 * @returns {Promise<string>} Formatted address or "INCOMPLETE"
 */
export async function formatAddress(rawAddress) {
  if (!rawAddress || rawAddress.trim().length === 0) {
    return null;
  }

  const client = new Groq({
    apiKey: process.env.GROQ_API_KEY,
  });

  try {
    addressLogger.info('Formatting address', {
      inputLength: rawAddress.length,
      model: 'llama-3.1-8b-instant'
    });

    const response = await client.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        {
          role: 'system',
          content: SYSTEM_PROMPT
        },
        {
          role: 'user',
          content: rawAddress
        }
      ],
      temperature: 0,
      max_tokens: 50
    });

    const formatted = response.choices[0].message.content.trim();

    addressLogger.info('Address formatted', {
      input: rawAddress,
      output: formatted,
      tokensUsed: response.usage?.total_tokens
    });

    // Return null if incomplete
    if (formatted === 'INCOMPLETE') {
      return null;
    }

    return formatted;

  } catch (error) {
    addressLogger.error('Address formatting failed', error);
    // Return original on failure rather than blocking
    return rawAddress;
  }
}

export default {
  formatAddress
};
