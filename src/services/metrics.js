/**
 * Metrics tracking service
 * Tracks in-memory metrics for calls and system performance
 */

import { logger } from '../utils/logger.js';

const metricsLogger = logger.child('METRICS');

// In-memory metrics storage
const metrics = {
  totalCalls: 0,
  activeCalls: 0,
  peakConcurrency: 0,
  callsByUser: {}, // user_id → call count
  callsByProvider: { groq: 0, gemini: 0 }, // LLM provider usage
  fallbackCount: 0, // How many times we fell back to Gemini
  totalCost: 0, // Total cost in USD
  totalLatency: 0, // Total LLM latency in ms
  startTime: Date.now(),
  lastCallAt: null,
};

/**
 * Track when a call starts
 * @param {string} userId - User ID
 */
export function onCallStart(userId) {
  metrics.totalCalls++;
  metrics.activeCalls++;
  metrics.lastCallAt = new Date().toISOString();

  // Track peak concurrency
  if (metrics.activeCalls > metrics.peakConcurrency) {
    metrics.peakConcurrency = metrics.activeCalls;
  }

  // Track per-user calls
  if (!metrics.callsByUser[userId]) {
    metrics.callsByUser[userId] = 0;
  }
  metrics.callsByUser[userId]++;

  metricsLogger.info('Call started', {
    userId,
    totalCalls: metrics.totalCalls,
    activeCalls: metrics.activeCalls,
  });
}

/**
 * Track when a call ends
 */
export function onCallEnd() {
  metrics.activeCalls--;

  metricsLogger.info('Call ended', {
    activeCalls: metrics.activeCalls,
  });
}

/**
 * Track LLM usage
 * @param {string} provider - 'groq' or 'gemini'
 * @param {number} cost - Cost in USD
 * @param {number} latency - Latency in ms
 * @param {boolean} isFallback - Whether this was a fallback request
 */
export function trackLLMUsage(provider, cost, latency, isFallback = false) {
  metrics.callsByProvider[provider]++;
  metrics.totalCost += cost;
  metrics.totalLatency += latency;

  if (isFallback) {
    metrics.fallbackCount++;
  }

  metricsLogger.debug('LLM usage tracked', {
    provider,
    cost: `$${cost.toFixed(6)}`,
    latency: `${latency}ms`,
    isFallback,
  });
}

/**
 * Get current metrics
 * @returns {Object} Metrics object
 */
export function getMetrics() {
  const uptime = Date.now() - metrics.startTime;
  const avgLatency =
    metrics.totalCalls > 0 ? metrics.totalLatency / metrics.totalCalls : 0;

  return {
    status: 'up',
    uptime: {
      milliseconds: uptime,
      seconds: Math.floor(uptime / 1000),
      minutes: Math.floor(uptime / 60000),
      hours: Math.floor(uptime / 3600000),
    },
    calls: {
      total: metrics.totalCalls,
      active: metrics.activeCalls,
      peak_concurrency: metrics.peakConcurrency,
      last_call_at: metrics.lastCallAt,
    },
    llm: {
      by_provider: metrics.callsByProvider,
      fallback_count: metrics.fallbackCount,
      fallback_rate:
        metrics.totalCalls > 0
          ? (metrics.fallbackCount / metrics.totalCalls) * 100
          : 0,
      avg_latency_ms: Math.round(avgLatency),
      total_cost_usd: parseFloat(metrics.totalCost.toFixed(4)),
    },
    by_user: metrics.callsByUser,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Reset metrics (for testing)
 */
export function resetMetrics() {
  metrics.totalCalls = 0;
  metrics.activeCalls = 0;
  metrics.peakConcurrency = 0;
  metrics.callsByUser = {};
  metrics.callsByProvider = { groq: 0, gemini: 0 };
  metrics.fallbackCount = 0;
  metrics.totalCost = 0;
  metrics.totalLatency = 0;
  metrics.startTime = Date.now();
  metrics.lastCallAt = null;

  metricsLogger.info('Metrics reset');
}

export default {
  onCallStart,
  onCallEnd,
  trackLLMUsage,
  getMetrics,
  resetMetrics,
};
