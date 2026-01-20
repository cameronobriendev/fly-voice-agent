/**
 * Centralized tool registry
 *
 * Tools are organized into sets that can be assigned to different call types.
 * This allows different phone numbers, industries, or customer tiers to have
 * different capabilities.
 */

import { END_CALL, END_CALL_WITH_SUMMARY } from './core.js';
import { UPDATE_SERVICE_REQUEST } from './service-request.js';

// Re-export individual tools for direct access if needed
export { END_CALL, END_CALL_WITH_SUMMARY } from './core.js';
export { UPDATE_SERVICE_REQUEST } from './service-request.js';

/**
 * Tool sets by mode
 *
 * Each set is an array of tools that will be passed to the LLM.
 * The LLM can only call functions that are in its tool set.
 */
export const TOOL_SETS = {
  // Basic - just end call (for IVR, surveys, simple info lines)
  basic: [END_CALL],

  // Standard - data collection + simple end call
  // Used for demo calls and basic service calls
  standard: [UPDATE_SERVICE_REQUEST, END_CALL],

  // Full - data collection + summarized end call
  // Used for production client calls where we want structured summaries
  full: [UPDATE_SERVICE_REQUEST, END_CALL_WITH_SUMMARY],
};

/**
 * Get the appropriate tool set for a phone config
 *
 * This is the single place to add logic for tool selection based on:
 * - config.tool_set (explicit override)
 * - config.industry (different tools per trade)
 * - config.tier (premium features)
 * - config.is_demo (demo vs production)
 *
 * @param {Object} config - Phone configuration from dashboard
 * @returns {Array} Array of tool definitions for the LLM
 */
export function getToolsForConfig(config) {
  // Explicit tool_set override takes precedence
  if (config?.tool_set && TOOL_SETS[config.tool_set]) {
    return TOOL_SETS[config.tool_set];
  }

  // Default: all calls get standard tools (data collection + end_call)
  // This includes demo calls - we want to collect data from demos too
  return TOOL_SETS.standard;
}

/**
 * Get tool set by name
 * Useful for testing or explicit tool set selection
 *
 * @param {string} name - Tool set name (basic, standard, full)
 * @returns {Array} Array of tool definitions
 */
export function getToolSet(name) {
  return TOOL_SETS[name] || TOOL_SETS.standard;
}

export default {
  TOOL_SETS,
  getToolsForConfig,
  getToolSet,
};
