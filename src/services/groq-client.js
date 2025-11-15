/**
 * Groq client for primary LLM
 * Uses Llama 3.3 70B for ultra-fast inference (~200ms)
 */

import Groq from 'groq-sdk';
import { logger } from '../utils/logger.js';

const groqLogger = logger.child('GROQ');

export class GroqClient {
  constructor() {
    if (!process.env.GROQ_API_KEY) {
      throw new Error('GROQ_API_KEY environment variable is required');
    }

    this.client = new Groq({
      apiKey: process.env.GROQ_API_KEY,
    });

    groqLogger.info('Groq client initialized');
  }

  /**
   * Send a chat completion request
   * @param {Array} messages - Array of message objects {role, content}
   * @param {Array} functions - Optional function definitions
   * @returns {Promise<Object>} Response object with content, functionCall, usage
   */
  async chat(messages, functions = null) {
    try {
      const params = {
        model: 'llama-3.3-70b-versatile',
        messages: messages,
        temperature: 0.7,
        max_tokens: 150,
      };

      if (functions) {
        params.functions = functions;
        params.function_call = 'auto';
      }

      groqLogger.debug('Sending request to Groq', {
        messageCount: messages.length,
        hasFunctions: !!functions,
      });

      const response = await this.client.chat.completions.create(params);

      const result = {
        content: response.choices[0].message.content,
        functionCall: response.choices[0].message.function_call || null,
        usage: response.usage,
      };

      groqLogger.debug('Groq response received', {
        hasContent: !!result.content,
        hasFunctionCall: !!result.functionCall,
        tokens: result.usage.total_tokens,
      });

      return result;
    } catch (error) {
      groqLogger.error('Groq API error', error, {
        errorCode: error.code,
        errorStatus: error.status,
      });
      throw error;
    }
  }

  /**
   * Calculate cost for Groq usage
   * @param {Object} usage - Usage object from API response
   * @returns {number} Cost in USD
   */
  calculateCost(usage) {
    const INPUT_COST = 0.00000059; // $0.59 per 1M tokens
    const OUTPUT_COST = 0.00000079; // $0.79 per 1M tokens

    return (
      usage.prompt_tokens * INPUT_COST + usage.completion_tokens * OUTPUT_COST
    );
  }
}

export default GroqClient;
