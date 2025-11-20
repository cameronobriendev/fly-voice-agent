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
   * @param {Array} tools - Optional tool definitions (OpenAI tools format)
   * @returns {Promise<Object>} Response object with content, toolCalls, usage
   */
  async chat(messages, tools = null) {
    try {
      const params = {
        model: 'llama-3.3-70b-versatile',
        messages: messages,
        temperature: 0.7,
        max_tokens: 150,
      };

      if (tools) {
        params.tools = tools;
        params.tool_choice = 'auto';
      }

      groqLogger.debug('Sending request to Groq', {
        messageCount: messages.length,
        hasTools: !!tools,
      });

      const response = await this.client.chat.completions.create(params);
      const message = response.choices[0].message;

      const result = {
        content: message.content,
        toolCalls: message.tool_calls || null,
        finishReason: response.choices[0].finish_reason,
        usage: response.usage,
        rawMessage: message,
      };

      groqLogger.debug('Groq response received', {
        hasContent: !!result.content,
        hasToolCalls: !!(result.toolCalls && result.toolCalls.length > 0),
        toolCallCount: result.toolCalls?.length || 0,
        finishReason: result.finishReason,
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
   * Send follow-up chat after tool execution
   * @param {Array} messages - Messages including tool results
   * @returns {Promise<Object>} Response with natural language content
   */
  async chatWithToolResults(messages) {
    try {
      groqLogger.debug('Sending follow-up request with tool results', {
        messageCount: messages.length,
      });

      const response = await this.client.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: messages,
        temperature: 0.7,
        max_tokens: 150,
        // No tools - just get natural response
      });

      const result = {
        content: response.choices[0].message.content,
        usage: response.usage,
      };

      groqLogger.debug('Groq follow-up response received', {
        hasContent: !!result.content,
        contentLength: result.content?.length || 0,
        tokens: result.usage.total_tokens,
      });

      return result;
    } catch (error) {
      groqLogger.error('Groq follow-up API error', error, {
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
