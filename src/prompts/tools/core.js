/**
 * Core tools shared across all call types
 */

/**
 * Simple end_call - just ends the call
 * Used for demo calls and simple flows
 */
export const END_CALL = {
  type: 'function',
  function: {
    name: 'end_call',
    description: 'End the call when the caller says goodbye or indicates they are done',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
};

/**
 * end_call_with_summary - ends call with structured summary
 * Used for client calls where we want to capture call outcome
 */
export const END_CALL_WITH_SUMMARY = {
  type: 'function',
  function: {
    name: 'end_call_with_summary',
    description: 'End the call when you have all necessary information',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Brief summary of the call',
        },
        priority: {
          type: 'string',
          enum: ['emergency', 'urgent', 'normal'],
          description: 'Priority level of this request',
        },
      },
      required: ['summary', 'priority'],
    },
  },
};
