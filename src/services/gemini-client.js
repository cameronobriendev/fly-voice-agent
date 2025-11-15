/**
 * Gemini client for fallback LLM
 * Uses Gemini 2.5 Flash-Lite for reliable backup
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../utils/logger.js';

const geminiLogger = logger.child('GEMINI');

export class GeminiClient {
  constructor() {
    if (!process.env.GOOGLE_API_KEY) {
      throw new Error('GOOGLE_API_KEY environment variable is required');
    }

    this.client = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
    this.model = this.client.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
    });

    geminiLogger.info('Gemini client initialized');
  }

  /**
   * Send a chat completion request
   * @param {Array} messages - Array of message objects {role, content}
   * @param {Array} functions - Optional function definitions
   * @returns {Promise<Object>} Response object with content, functionCall, usage
   */
  async chat(messages, functions = null) {
    try {
      // Convert OpenAI format to Gemini format
      const geminiMessages = this._convertMessages(messages);

      const params = {
        contents: geminiMessages,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 150,
        },
      };

      if (functions) {
        params.tools = this._convertFunctions(functions);
      }

      geminiLogger.debug('Sending request to Gemini', {
        messageCount: messages.length,
        hasFunctions: !!functions,
      });

      const response = await this.model.generateContent(params);

      // Extract function call if present
      const functionCall = this._extractFunctionCall(response);

      const result = {
        content: functionCall ? null : response.response.text(),
        functionCall: functionCall,
        usage: {
          prompt_tokens:
            response.response.usageMetadata?.promptTokenCount || 0,
          completion_tokens:
            response.response.usageMetadata?.candidatesTokenCount || 0,
          total_tokens: response.response.usageMetadata?.totalTokenCount || 0,
        },
      };

      geminiLogger.debug('Gemini response received', {
        hasContent: !!result.content,
        hasFunctionCall: !!result.functionCall,
        tokens: result.usage.total_tokens,
      });

      return result;
    } catch (error) {
      geminiLogger.error('Gemini API error', error, {
        errorMessage: error.message,
      });
      throw error;
    }
  }

  /**
   * Convert OpenAI message format to Gemini format
   * @param {Array} messages - OpenAI format messages
   * @returns {Array} Gemini format messages
   */
  _convertMessages(messages) {
    // Gemini doesn't have a "system" role, so we'll combine system message with first user message
    const converted = [];
    let systemMessage = null;

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemMessage = msg.content;
      } else if (msg.role === 'user') {
        const content = systemMessage
          ? `${systemMessage}\n\n${msg.content}`
          : msg.content;
        converted.push({
          role: 'user',
          parts: [{ text: content }],
        });
        systemMessage = null; // Only prepend system message once
      } else if (msg.role === 'assistant') {
        converted.push({
          role: 'model',
          parts: [{ text: msg.content }],
        });
      }
    }

    return converted;
  }

  /**
   * Convert OpenAI function format to Gemini tools format
   * @param {Array} functions - OpenAI format functions
   * @returns {Array} Gemini format tools
   */
  _convertFunctions(functions) {
    return [
      {
        functionDeclarations: functions.map((fn) => ({
          name: fn.name,
          description: fn.description,
          parameters: fn.parameters,
        })),
      },
    ];
  }

  /**
   * Extract function call from Gemini response
   * @param {Object} response - Gemini API response
   * @returns {Object|null} Function call object or null
   */
  _extractFunctionCall(response) {
    const functionCall =
      response.response.candidates?.[0]?.content?.parts?.[0]?.functionCall;

    if (!functionCall) return null;

    return {
      name: functionCall.name,
      arguments: JSON.stringify(functionCall.args),
    };
  }

  /**
   * Calculate cost for Gemini usage
   * @param {Object} usage - Usage object from API response
   * @returns {number} Cost in USD
   */
  calculateCost(usage) {
    const INPUT_COST = 0.0000001; // $0.10 per 1M tokens
    const OUTPUT_COST = 0.0000004; // $0.40 per 1M tokens

    return (
      usage.prompt_tokens * INPUT_COST + usage.completion_tokens * OUTPUT_COST
    );
  }
}

export default GeminiClient;
