/**
 * Twilio WebSocket stream handler
 * Orchestrates the entire conversation flow:
 * 1. Fetch user config from database
 * 2. Build custom prompt
 * 3. Handle Twilio audio stream
 * 4. Coordinate STT → LLM → TTS pipeline
 * 5. Collect data during conversation
 * 6. Send to webhook when call ends
 */

import { getUserByPhone } from '../db/queries.js';
import { buildPrompt, insertPhoneNumber } from './prompt-builder.js';
import { DeepgramService } from './deepgram.js';
import { CartesiaService } from './cartesia.js';
import { LLMRouter } from './llm-router.js';
import { sendToWebhook } from './post-call.js';
import { onCallStart, onCallEnd } from './metrics.js';
import { FUNCTIONS } from '../prompts/template.js';
import { logger } from '../utils/logger.js';

const twilioLogger = logger.child('TWILIO');

/**
 * Handle Twilio WebSocket stream
 * @param {WebSocket} ws - WebSocket connection from Twilio
 */
export async function handleTwilioStream(ws) {
  // Call state
  let userConfig = null;
  let userId = null;
  let callSid = null;
  let streamSid = null;
  let fromNumber = null;
  let toNumber = null;
  let customPrompt = null;
  let startTime = null;
  let endTime = null;

  // Conversation state
  const messages = []; // LLM conversation history
  const transcript = []; // Full conversation transcript
  const collectedData = {
    // Data collected during call
    serviceType: null,
    propertyType: null,
    issue: null,
    started: null,
    emergency: null,
    contactPhone: null,
    callbackTime: null,
    notes: null,
    callerName: null,
    callerEmail: null,
  };

  // Services
  let deepgram = null;
  let deepgramConnection = null;
  let cartesia = null;
  let llmRouter = null;

  // Metrics
  let llmCalls = 0;
  let totalLatency = 0;
  let totalCost = 0;
  let primaryProvider = null;

  /**
   * Initialize services and user config
   */
  async function initialize(twilioNumber, callerNumber) {
    try {
      // Fetch user configuration from database
      userConfig = await getUserByPhone(twilioNumber);
      userId = userConfig.user_id;

      twilioLogger.info('User configuration loaded', {
        userId,
        businessName: userConfig.business_name,
        twilioNumber,
      });

      // Track call start
      onCallStart(userId);

      // Build custom prompt
      customPrompt = buildPrompt(userConfig);
      customPrompt = insertPhoneNumber(customPrompt, callerNumber);

      // Initialize system message
      messages.push({
        role: 'system',
        content: customPrompt,
      });

      // Initialize services
      deepgram = new DeepgramService();
      cartesia = new CartesiaService();
      llmRouter = new LLMRouter();

      // Start Deepgram stream
      deepgramConnection = await deepgram.startStream(
        onTranscript,
        onDeepgramError
      );

      twilioLogger.info('Services initialized', { callSid });

      // Send initial greeting
      await sendAIResponse(
        `Hi! Thanks for calling ${userConfig.business_name}. How can I help you today?`
      );
    } catch (error) {
      twilioLogger.error('Failed to initialize call', error);
      ws.close();
    }
  }

  /**
   * Handle transcript from Deepgram
   */
  async function onTranscript(transcriptText) {
    try {
      twilioLogger.info('User said', { text: transcriptText });

      // Add to transcript
      transcript.push({
        speaker: 'user',
        text: transcriptText,
        timestamp: new Date().toISOString(),
      });

      // Add to conversation history
      messages.push({
        role: 'user',
        content: transcriptText,
      });

      // Get LLM response
      const response = await llmRouter.chat(messages, callSid, FUNCTIONS);

      llmCalls++;
      totalLatency += response.latency;
      totalCost += response.cost;
      primaryProvider = response.provider;

      // Handle function call
      if (response.functionCall) {
        await handleFunctionCall(response.functionCall);
      }

      // Handle text response
      if (response.content) {
        messages.push({
          role: 'assistant',
          content: response.content,
        });

        await sendAIResponse(response.content);
      }
    } catch (error) {
      twilioLogger.error('Error processing transcript', error);
    }
  }

  /**
   * Handle function calls from LLM
   */
  async function handleFunctionCall(functionCall) {
    const functionName = functionCall.name;
    const args = JSON.parse(functionCall.arguments);

    twilioLogger.info('Function called', { function: functionName, args });

    if (functionName === 'update_service_request') {
      // Update collected data
      Object.assign(collectedData, args);
      twilioLogger.debug('Service request updated', collectedData);
    } else if (functionName === 'end_call_with_summary') {
      // Call is ending
      twilioLogger.info('Call ending', { summary: args.summary });

      // Send final message
      await sendAIResponse(
        'Great! Someone will call you back shortly. Have a nice day!'
      );

      // Close the call
      setTimeout(() => {
        ws.close();
      }, 3000); // Give time for final message to play
    }
  }

  /**
   * Send AI response via TTS
   */
  async function sendAIResponse(text) {
    try {
      twilioLogger.info('AI says', { text });

      // Add to transcript
      transcript.push({
        speaker: 'ai',
        text,
        timestamp: new Date().toISOString(),
      });

      // Generate audio
      const audioBuffer = await cartesia.generateAudio(text);

      // Send to Twilio
      const base64Audio = audioBuffer.toString('base64');
      ws.send(
        JSON.stringify({
          event: 'media',
          streamSid: streamSid,
          media: {
            payload: base64Audio,
          },
        })
      );
    } catch (error) {
      twilioLogger.error('Error sending AI response', error);
    }
  }

  /**
   * Handle Deepgram errors
   */
  function onDeepgramError(error) {
    twilioLogger.error('Deepgram error', error);
  }

  /**
   * Send call data to webhook
   */
  async function finalize() {
    try {
      endTime = new Date().toISOString();
      const duration = Math.floor(
        (new Date(endTime) - new Date(startTime)) / 1000
      );

      const callData = {
        callSid,
        fromNumber,
        toNumber,
        startedAt: startTime,
        endedAt: endTime,
        duration,
        transcript,
        collectedData,
        llmProvider: primaryProvider,
        avgLatency: llmCalls > 0 ? Math.round(totalLatency / llmCalls) : 0,
        totalCost,
      };

      twilioLogger.info('Sending call data to webhook', { callSid });

      await sendToWebhook(userId, callData);

      // Track call end
      onCallEnd();

      twilioLogger.info('Call completed', {
        callSid,
        duration,
        llmCalls,
        avgLatency: callData.avgLatency,
        cost: totalCost.toFixed(4),
      });
    } catch (error) {
      twilioLogger.error('Error finalizing call', error);
    }
  }

  // Handle WebSocket messages from Twilio
  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.event === 'start') {
        callSid = msg.start.callSid;
        streamSid = msg.start.streamSid;
        fromNumber = msg.start.customParameters?.From || msg.start.from;
        toNumber = msg.start.customParameters?.To || msg.start.to;
        startTime = new Date().toISOString();

        twilioLogger.info('Call started', {
          callSid,
          from: fromNumber,
          to: toNumber,
        });

        await initialize(toNumber, fromNumber);
      } else if (msg.event === 'media') {
        // Forward audio to Deepgram
        if (deepgramConnection && msg.media?.payload) {
          const audioBuffer = Buffer.from(msg.media.payload, 'base64');
          deepgram.sendAudio(deepgramConnection, audioBuffer);
        }
      } else if (msg.event === 'stop') {
        twilioLogger.info('Call stopped', { callSid });

        // Close Deepgram
        if (deepgramConnection) {
          deepgram.closeStream(deepgramConnection);
        }

        // Finalize call
        await finalize();
      }
    } catch (error) {
      twilioLogger.error('Error handling Twilio message', error);
    }
  });

  ws.on('error', (error) => {
    twilioLogger.error('WebSocket error', error);
  });

  ws.on('close', () => {
    twilioLogger.info('WebSocket closed', { callSid });

    // Clean up
    if (deepgramConnection) {
      deepgram.closeStream(deepgramConnection);
    }
  });
}

export default {
  handleTwilioStream,
};
