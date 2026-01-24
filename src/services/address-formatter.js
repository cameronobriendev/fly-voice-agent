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

## ALBERTA ADDRESS SYSTEMS (Critical - Most Calls Are Alberta)

### Edmonton Numbered Grid System
Edmonton uses NUMBERED streets and avenues with quadrants (NW, NE, SW, SE):
- Streets run north-south, numbers increase westward
- Avenues run east-west, numbers increase northward
- ~90% of Edmonton is NW quadrant
- Format: [house number] [street number] Street/Avenue [quadrant]
- Example: "5120 122 Street NW" = house 5120 on 122nd Street in northwest quadrant

CRITICAL: When you hear a long number followed by another number, split them:
- "5120122 Street" → "5120 122 Street" (house 5120, street 122)
- "1234556 Avenue" → "12345 56 Avenue" (house 12345, avenue 56)
- House numbers are typically 3-5 digits, street/avenue numbers are 1-3 digits

### Calgary Numbered Grid System
Same pattern as Edmonton:
- Streets run north-south, Avenues run east-west
- All addresses have quadrants: NW, NE, SW, SE
- Format: [house number] [street number] Street/Avenue [quadrant]

### Quadrant Conversions
- "Northwest" or "north west" → "NW"
- "Northeast" or "north east" → "NE"
- "Southwest" or "south west" → "SW"
- "Southeast" or "south east" → "SE"

### Rural Alberta Addresses
- Township Road (Twp Rd): runs east-west, e.g., "21133 Township Road 512"
- Range Road (Rge Rd): runs north-south, e.g., "45678 Range Road 224"
- Keep these as-is, they're valid rural addresses

## General Rules
- Remove filler words (um, uh, like, located at, my address is, it's at, we're at)
- Add commas between street, city, province
- Use province abbreviations (Alberta→AB, British Columbia→BC, etc.)
- Keep apartment/unit numbers
- NEVER invent or guess a city/province if not mentioned
- If address is too incomplete to be useful, output: INCOMPLETE

## Examples

Input: 5120122 Street Northwest Edmonton
Output: 5120 122 Street NW, Edmonton, AB

Input: uh it's 1045678 Avenue Southwest in Calgary
Output: 10456 78 Avenue SW, Calgary, AB

Input: my address is um 456 Oak Avenue Vancouver British Columbia
Output: 456 Oak Avenue, Vancouver, BC

Input: located at 21133 Township Road 512
Output: 21133 Township Road 512

Input: it's 123 Main Street apartment 4B Edmonton
Output: 123 Main Street, Apartment 4B, Edmonton, AB

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
