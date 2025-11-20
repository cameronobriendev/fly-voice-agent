/**
 * LLM Router with automatic fallback
 * Tries Groq first, falls back to Gemini on failure
 */

import { GroqClient } from './groq-client.js';
import { GeminiClient } from './gemini-client.js';
import { trackLLMUsage } from './metrics.js';
import { logger } from '../utils/logger.js';

const routerLogger = logger.child('LLM-ROUTER');

export class LLMRouter {
  constructor() {
    this.groq = new GroqClient();
    this.gemini = new GeminiClient();
    this.provider = process.env.LLM_PROVIDER || 'auto'; // 'auto', 'groq', or 'gemini'

    routerLogger.info('LLM Router initialized', { provider: this.provider });
  }

  /**
   * Send a chat completion request with automatic fallback
   * @param {Array} messages - Array of message objects
   * @param {string} callId - Call ID for logging
   * @param {Array} tools - Optional tool definitions
   * @returns {Promise<Object>} Response with provider info, latency, cost
   */
  async chat(messages, callId, tools = null) {
    const startTime = Date.now();

    // Force specific provider if set
    if (this.provider === 'groq') {
      return await this._callGroq(messages, callId, tools, startTime);
    }

    if (this.provider === 'gemini') {
      return await this._callGemini(messages, callId, tools, startTime);
    }

    // Auto mode: Try Groq first, fallback to Gemini
    try {
      return await this._callGroq(messages, callId, tools, startTime);
    } catch (error) {
      if (this._shouldFallback(error)) {
        routerLogger.warn('Groq failed, falling back to Gemini', {
          callId,
          error: error.message,
        });
        return await this._callGemini(
          messages,
          callId,
          tools,
          startTime,
          true
        );
      }
      throw error;
    }
  }

  /**
   * Send follow-up chat after tool execution
   * @param {Array} messages - Messages including tool results
   * @param {string} callId - Call ID for logging
   * @returns {Promise<Object>} Response with natural language content
   */
  async chatWithToolResults(messages, callId) {
    const startTime = Date.now();

    try {
      const response = await this.groq.chatWithToolResults(messages);
      const latency = Date.now() - startTime;
      const cost = this.groq.calculateCost(response.usage);

      // Track metrics
      trackLLMUsage('groq', cost, latency, false);

      routerLogger.info('Groq follow-up response', {
        callId,
        latency: `${latency}ms`,
        tokens: response.usage.total_tokens,
        cost: `$${cost.toFixed(6)}`,
      });

      return {
        content: response.content,
        provider: 'groq',
        latency,
        cost,
        tokens: response.usage.total_tokens,
      };
    } catch (error) {
      routerLogger.error('Follow-up chat error', error, { callId });
      throw error;
    }
  }

  /**
   * Call Groq API
   */
  async _callGroq(messages, callId, tools, startTime) {
    try {
      const response = await this.groq.chat(messages, tools);
      const latency = Date.now() - startTime;
      const cost = this.groq.calculateCost(response.usage);

      // Track metrics
      trackLLMUsage('groq', cost, latency, false);

      routerLogger.info('Groq response', {
        callId,
        latency: `${latency}ms`,
        tokens: response.usage.total_tokens,
        cost: `$${cost.toFixed(6)}`,
        hasToolCalls: !!(response.toolCalls && response.toolCalls.length > 0),
      });

      return {
        ...response,
        provider: 'groq',
        latency,
        cost,
        tokens: response.usage.total_tokens,
        isFallback: false,
      };
    } catch (error) {
      routerLogger.error('Groq error', error, {
        callId,
        errorCode: error.code,
        errorStatus: error.status,
      });
      throw error;
    }
  }

  /**
   * Call Gemini API
   */
  async _callGemini(messages, callId, tools, startTime, isFallback = false) {
    try {
      const response = await this.gemini.chat(messages, tools);
      const latency = Date.now() - startTime;
      const cost = this.gemini.calculateCost(response.usage);

      // Track metrics
      trackLLMUsage('gemini', cost, latency, isFallback);

      routerLogger.info('Gemini response', {
        callId,
        latency: `${latency}ms`,
        tokens: response.usage.total_tokens,
        cost: `$${cost.toFixed(6)}`,
        isFallback,
      });

      return {
        ...response,
        provider: 'gemini',
        latency,
        cost,
        tokens: response.usage.total_tokens,
        isFallback,
      };
    } catch (error) {
      routerLogger.error('Gemini error', error, {
        callId,
        errorMessage: error.message,
      });
      throw error;
    }
  }

  /**
   * Determine if we should fallback based on error
   * @param {Error} error - Error from Groq
   * @returns {boolean} True if should fallback
   */
  _shouldFallback(error) {
    // Fallback for rate limits, service errors, and tool validation failures
    const fallbackErrors = [
      'rate_limit',
      'service_unavailable',
      'overloaded',
      'tool_use_failed',
      '429',
      '503',
      '500',
      '400',
    ];

    const errorString = (
      error.message +
      ' ' +
      (error.code || '') +
      ' ' +
      (error.status || '')
    ).toLowerCase();

    return fallbackErrors.some((err) => errorString.includes(err));
  }
}

export default LLMRouter;
