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
   * @param {Array} functions - Optional function definitions
   * @returns {Promise<Object>} Response with provider info, latency, cost
   */
  async chat(messages, callId, functions = null) {
    const startTime = Date.now();

    // Force specific provider if set
    if (this.provider === 'groq') {
      return await this._callGroq(messages, callId, functions, startTime);
    }

    if (this.provider === 'gemini') {
      return await this._callGemini(messages, callId, functions, startTime);
    }

    // Auto mode: Try Groq first, fallback to Gemini
    try {
      return await this._callGroq(messages, callId, functions, startTime);
    } catch (error) {
      if (this._shouldFallback(error)) {
        routerLogger.warn('Groq failed, falling back to Gemini', {
          callId,
          error: error.message,
        });
        return await this._callGemini(
          messages,
          callId,
          functions,
          startTime,
          true
        );
      }
      throw error;
    }
  }

  /**
   * Call Groq API
   */
  async _callGroq(messages, callId, functions, startTime) {
    try {
      const response = await this.groq.chat(messages, functions);
      const latency = Date.now() - startTime;
      const cost = this.groq.calculateCost(response.usage);

      // Track metrics
      trackLLMUsage('groq', cost, latency, false);

      routerLogger.info('Groq response', {
        callId,
        latency: `${latency}ms`,
        tokens: response.usage.total_tokens,
        cost: `$${cost.toFixed(6)}`,
      });

      return {
        ...response,
        provider: 'groq',
        latency,
        cost,
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
  async _callGemini(messages, callId, functions, startTime, isFallback = false) {
    try {
      const response = await this.gemini.chat(messages, functions);
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
    // Fallback for rate limits and service errors
    const fallbackErrors = [
      'rate_limit',
      'service_unavailable',
      'overloaded',
      '429',
      '503',
      '500',
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
