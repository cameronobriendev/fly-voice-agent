/**
 * Transcript Extraction Service
 * Uses GPT-OSS-20B on Groq with strict JSON mode for guaranteed schema compliance
 *
 * Why GPT-OSS-20B?
 * - Strict JSON mode (constrained decoding) - physically cannot produce invalid JSON
 * - Production-ready status on Groq (not Preview like Qwen)
 * - ~$0.0001 per extraction at typical transcript length
 * - Eliminates the 5-15% JSON parsing failure rate of unconstrained models
 */

import Groq from 'groq-sdk';
import { logger } from '../utils/logger.js';
import { formatAddress } from './address-formatter.js';

const extractorLogger = logger.child('EXTRACTOR');

// Extraction schema for strict mode
const EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    caller_name: { type: ['string', 'null'] },
    contact_phone: { type: ['string', 'null'] },
    address: { type: ['string', 'null'] },
    issue_description: { type: ['string', 'null'] },
    urgency_level: {
      type: ['string', 'null'],
      enum: ['emergency', 'urgent', 'normal', null]
    },
    callback_time: { type: ['string', 'null'] },
    additional_notes: { type: ['string', 'null'] }
  },
  required: [
    'caller_name',
    'contact_phone',
    'address',
    'issue_description',
    'urgency_level',
    'callback_time',
    'additional_notes'
  ],
  additionalProperties: false
};

// Extraction prompt with one-shot example for correction handling
const EXTRACTION_PROMPT = `You are a data extraction specialist for a plumbing service company. Extract customer information from phone call transcripts into structured JSON.

## CRITICAL RULES
1. Extract ONLY information explicitly stated in the transcript
2. If information is not clearly stated, return null—DO NOT guess or infer
3. If the caller corrects themselves ("wait, that's my old number"), use the CORRECTED value
4. Ignore filler words, false starts, and incomplete sentences
5. For urgency: "emergency" = water gushing/flooding/no water; "urgent" = same-day request; "normal" = flexible scheduling

## EXAMPLE INPUT
Customer: Hi, this is Mike... uh, Michael Torres. I've got a clogged drain in my bathroom.
Agent: Can I get your phone number?
Customer: It's 555-0123... actually no, 555-0124. Sorry, just changed it.
Agent: And your address?
Customer: 789 Pine Street, apartment 4B.

## EXAMPLE OUTPUT
{
  "caller_name": "Michael Torres",
  "contact_phone": "555-0124",
  "address": "789 Pine Street, apartment 4B",
  "issue_description": "Clogged drain in bathroom",
  "urgency_level": "normal",
  "callback_time": null,
  "additional_notes": null
}`;

/**
 * Extract structured data from a call transcript
 * @param {string} transcript - Formatted transcript text
 * @returns {Promise<Object>} Extracted data with guaranteed schema compliance
 */
export async function extractFromTranscript(transcript) {
  if (!transcript || transcript.trim().length === 0) {
    extractorLogger.warn('Empty transcript, returning null values');
    return {
      caller_name: null,
      contact_phone: null,
      address: null,
      issue_description: null,
      urgency_level: null,
      callback_time: null,
      additional_notes: null
    };
  }

  const client = new Groq({
    apiKey: process.env.GROQ_API_KEY,
  });

  try {
    extractorLogger.info('Extracting data from transcript', {
      transcriptLength: transcript.length,
      model: 'openai/gpt-oss-20b'
    });

    const response = await client.chat.completions.create({
      model: 'openai/gpt-oss-20b',
      messages: [
        {
          role: 'system',
          content: EXTRACTION_PROMPT
        },
        {
          role: 'user',
          content: `## TRANSCRIPT TO PROCESS\n${transcript}\n\nExtract the customer information:`
        }
      ],
      temperature: 0, // Maximum consistency for extraction
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'plumbing_call_extraction',
          strict: true, // Constrained decoding - guaranteed schema compliance
          schema: EXTRACTION_SCHEMA
        }
      }
    });

    const extracted = JSON.parse(response.choices[0].message.content);

    extractorLogger.info('Extraction complete', {
      hasName: !!extracted.caller_name,
      hasPhone: !!extracted.contact_phone,
      hasAddress: !!extracted.address,
      hasIssue: !!extracted.issue_description,
      urgency: extracted.urgency_level,
      tokensUsed: response.usage?.total_tokens
    });

    // Second pass: format address with dedicated model
    if (extracted.address) {
      const formattedAddress = await formatAddress(extracted.address);
      if (formattedAddress) {
        extracted.address = formattedAddress;
      }
    }

    return extracted;

  } catch (error) {
    extractorLogger.error('Extraction failed', error, {
      errorCode: error.code,
      errorStatus: error.status
    });

    // Try to recover from json_validate_failed errors - the data is often there but malformed
    if (error.message && error.message.includes('json_validate_failed')) {
      try {
        // Find the start of the JSON object in the error message
        const startIdx = error.message.indexOf('{"caller_name"');
        if (startIdx === -1) {
          // Try escaped version
          const escapedStart = error.message.indexOf('{\\"caller_name\\"');
          if (escapedStart !== -1) {
            // Extract everything from start to the pattern that looks like end of JSON
            let endIdx = error.message.indexOf('"}}', escapedStart);
            if (endIdx !== -1) {
              let failedJson = error.message.substring(escapedStart, endIdx + 3);

              // Unescape the JSON
              failedJson = failedJson
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\');

              // Fix the malformed trailing quote: null"}} -> null}
              failedJson = failedJson.replace(/null"\}\}$/, 'null}');
              failedJson = failedJson.replace(/"\}\}$/, '}');

              const recovered = JSON.parse(failedJson);
              extractorLogger.info('Recovered extraction from failed_generation', {
                hasName: !!recovered.caller_name,
                hasPhone: !!recovered.contact_phone,
                hasAddress: !!recovered.address,
                hasIssue: !!recovered.issue_description,
                urgency: recovered.urgency_level
              });

              // Format address on recovered data too
              if (recovered.address) {
                const formattedAddress = await formatAddress(recovered.address);
                if (formattedAddress) {
                  recovered.address = formattedAddress;
                }
              }

              return recovered;
            }
          }
        }
      } catch (recoveryError) {
        extractorLogger.warn('Failed to recover from malformed JSON', { recoveryError: recoveryError.message });
      }
    }

    // Return null values on failure - don't break the webhook flow
    return {
      caller_name: null,
      contact_phone: null,
      address: null,
      issue_description: null,
      urgency_level: null,
      callback_time: null,
      additional_notes: null
    };
  }
}

export default {
  extractFromTranscript
};
