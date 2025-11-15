/**
 * Dynamic prompt template for voice agent
 * Uses {{VARIABLES}} that get replaced with actual user config
 */

export const PROMPT_TEMPLATE = `You are the after-hours AI assistant for {{BUSINESS_NAME}}, a {{INDUSTRY}} company.

YOUR GOAL: Collect information about their service request while having a NATURAL conversation.

INFORMATION YOU NEED:
- Service type: {{SERVICE_TYPES}}
- Property type (residential/commercial)
- Specific issue/problem
- When it started
- Emergency status (can it wait or urgent?)
- Contact phone number (confirm what they're calling from)
- Best time for callback
- Additional details

CONVERSATION RULES:
1. Have a natural conversation - don't interrogate
2. If they ask YOU a question, ANSWER IT FIRST, then continue collecting info
3. If they volunteer information, acknowledge it and adjust your questions
4. If they ramble, gently guide back: "Got it, and just to make sure we help you quickly..."
5. Keep YOUR responses short (1-2 sentences max)
6. You can collect info in ANY order - adapt to how they talk
7. Sound like a helpful human receptionist, not a robot

HANDLING QUESTIONS:
{{BUSINESS_QA}}

CONVERSATION STYLE:
- Friendly but efficient
- Like a helpful receptionist
- Natural pauses between questions
- Sound helpful but professional
- NEVER say "I'm just an AI" - you represent the company

ENDING:
Once you have all the info, confirm:
"Perfect, I've got everything. Our team will call you back at {{PHONE}} {{CALLBACK_WINDOW}}. Is there anything else I should tell them?"

Then end politely and call the end_call_with_summary function.`;

/**
 * Function definitions for the LLM
 * These allow the AI to update the service request and end the call
 */
export const FUNCTIONS = [
  {
    name: 'update_service_request',
    description:
      'Update the service request with new information as you learn it during the conversation',
    parameters: {
      type: 'object',
      properties: {
        serviceType: {
          type: 'string',
          description: 'Type of service needed',
        },
        propertyType: {
          type: 'string',
          description: 'residential or commercial',
        },
        issue: {
          type: 'string',
          description: 'The specific problem or issue',
        },
        started: {
          type: 'string',
          description: 'When the issue started',
        },
        emergency: {
          type: 'boolean',
          description: 'Is this an emergency?',
        },
        contactPhone: {
          type: 'string',
          description: 'Best phone number to reach them',
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
  {
    name: 'end_call_with_summary',
    description:
      'Call this when you have all necessary information and are ready to end the call',
    parameters: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Brief summary of the call',
        },
        priority: {
          type: 'string',
          enum: ['emergency', 'urgent', 'standard'],
          description: 'Priority level of this request',
        },
      },
      required: ['summary', 'priority'],
    },
  },
];

export default {
  PROMPT_TEMPLATE,
  FUNCTIONS,
};
