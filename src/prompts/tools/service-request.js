/**
 * Service request data collection tool
 * Used for collecting caller information during service calls
 */

export const UPDATE_SERVICE_REQUEST = {
  type: 'function',
  function: {
    name: 'update_service_request',
    description:
      'Update the service request with new information as you learn it during the conversation. Call this whenever the caller provides specific data.',
    parameters: {
      type: 'object',
      properties: {
        callerName: {
          type: 'string',
          description: "Caller's name",
        },
        contactPhone: {
          type: 'string',
          description: 'Best phone number to reach them',
        },
        address: {
          type: 'string',
          description: 'Service address or location',
        },
        serviceType: {
          type: 'string',
          description: 'Type of service needed (e.g., plumbing, HVAC, electrical)',
        },
        propertyType: {
          type: 'string',
          enum: ['residential', 'commercial'],
          description: 'Type of property',
        },
        issue: {
          type: 'string',
          description: 'The specific problem or issue described',
        },
        started: {
          type: 'string',
          description: 'When the issue started',
        },
        urgency: {
          type: 'string',
          enum: ['emergency', 'urgent', 'normal'],
          description: 'How urgent is this issue',
        },
        callbackTime: {
          type: 'string',
          description: 'Best time to call back',
        },
        notes: {
          type: 'string',
          description: 'Any additional details or notes',
        },
      },
    },
  },
};
