/**
 * DEPRECATED: This file is kept for backwards compatibility.
 *
 * Tools are now centralized in src/prompts/tools/
 * Templates are in src/prompts/templates/
 *
 * Use:
 * - import { getToolsForConfig } from './tools/index.js'
 * - import { CLIENT_TEMPLATE } from './templates/client-template.js'
 * - import { DEMO_TEMPLATE } from './templates/demo-template.js'
 */

import { TOOL_SETS, getToolsForConfig } from './tools/index.js';
import { CLIENT_TEMPLATE } from './templates/client-template.js';

// Re-export for backwards compatibility
export const PROMPT_TEMPLATE = CLIENT_TEMPLATE;
export const TOOLS = TOOL_SETS.standard;

export default {
  PROMPT_TEMPLATE,
  TOOLS,
  getToolsForConfig,
};
