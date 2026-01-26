/**
 * Telnyx WebSocket stream handler
 *
 * Adapts the Twilio handler for Telnyx Media Streaming format.
 * The voice AI pipeline stays the same (Deepgram STT -> Groq LLM -> Cartesia TTS).
 *
 * Key differences from Twilio:
 * - Event format: {event: 'media', media: {track: 'inbound', payload}} for incoming audio
 * - Outgoing format (RTP mode): {event: 'media', media: {payload}}
 * - Call info passed via client_state (base64 JSON) instead of customParameters
 * - stream_id instead of streamSid
 * - call_control_id instead of callSid
 *
 * Audio format is the same: PCMU (mulaw) 8kHz mono, base64 encoded
 */

import { getConfigFromDashboard } from './config-api.js';
import { buildPrompt, insertPhoneNumber } from './prompt-builder.js';
import { DeepgramService } from './deepgram.js';
import { CartesiaService } from './cartesia.js';
import { LLMRouter } from './llm-router.js';
import { sendToWebhook } from './post-call.js';
import { onCallStart, onCallEnd } from './metrics.js';
import { getToolsForConfig } from '../prompts/tools/index.js';
import { logger } from '../utils/logger.js';
import {
  initCallEvents,
  addEvent,
  addTurnEvent,
  addErrorEvent,
  finishAndGetEvents,
  sendEventsToDashboard,
} from './call-events.js';
import { createCallRecorder, uploadRecording } from './call-recorder.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const telnyxLogger = logger.child('TELNYX_STREAM');

// Load ringback audio at module level (PCM 16-bit 8kHz WAV, needs conversion to mulaw)
let ringbackAudioRaw = null;
try {
  const ringbackPath = path.join(__dirname, '../../public/ringback-pattern.wav');
  ringbackAudioRaw = fs.readFileSync(ringbackPath);
  telnyxLogger.info('Ringback audio loaded', {
    path: ringbackPath,
    size: ringbackAudioRaw.length,
  });
} catch (error) {
  telnyxLogger.error('Failed to load ringback audio', error);
}

/**
 * Handle Telnyx WebSocket stream
 * @param {WebSocket} ws - WebSocket connection from Telnyx
 */
export async function handleTelnyxStream(ws) {
  // Call state
  let userConfig = null;
  let userId = null;
  let callControlId = null;
  let streamId = null;
  let fromNumber = null;
  let toNumber = null;
  let customPrompt = null;
  let startTime = null;
  let endTime = null;

  // Conversation state
  const messages = []; // LLM conversation history
  const transcript = []; // Full conversation transcript

  // Half-duplex state: block user audio while AI is speaking
  let isSpeaking = false;

  // Prevent double-finalize if both 'stop' and 'close' fire
  let finalized = false;

  // Call recorder for backup audio storage
  let callRecorder = null;

  const collectedData = {
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

  /**
   * Check if AI response contains a goodbye phrase
   */
  function isGoodbyePhrase(text) {
    const lowerText = text.toLowerCase();
    const goodbyePhrases = [
      'have a great day',
      'have a good day',
      'have a nice day',
      'goodbye',
      'bye bye',
      'take care',
    ];
    return goodbyePhrases.some(phrase => lowerText.includes(phrase));
  }

  // Services
  let deepgram = null;
  let deepgramConnection = null;
  let cartesia = null;
  let cartesiaConnection = null;
  let llmRouter = null;

  // Metrics
  let llmCalls = 0;
  let totalLatency = 0;
  let totalCost = 0;
  let primaryProvider = null;

  /**
   * Convert 16-bit PCM sample to 8-bit mulaw
   */
  function pcmToMulaw(pcm) {
    const MULAW_MAX = 0x1FFF;
    const MULAW_BIAS = 33;
    let mask = 0x1000;
    let sign = 0;
    let position = 12;
    let lsb = 0;

    if (pcm < 0) {
      pcm = -pcm;
      sign = 0x80;
    }

    pcm += MULAW_BIAS;
    if (pcm > MULAW_MAX) pcm = MULAW_MAX;

    for (; position >= 5; position--, mask >>= 1) {
      if (pcm & mask) break;
    }

    lsb = (pcm >> (position - 4)) & 0x0F;
    return ~(sign | ((position - 5) << 4) | lsb);
  }

  /**
   * Send ringback audio through WebSocket to Telnyx
   */
  async function sendRingbackAudio() {
    if (!ringbackAudioRaw || !streamId) {
      telnyxLogger.warn('Cannot send ringback - audio or streamId missing');
      return;
    }

    try {
      telnyxLogger.info('Sending ringback audio through WebSocket', {
        callControlId,
        audioSize: ringbackAudioRaw.length,
      });

      // Skip WAV header (44 bytes) and get PCM data
      const pcmData = ringbackAudioRaw.slice(44);
      const mulawData = Buffer.alloc(pcmData.length / 2);

      // Convert PCM 16-bit to mulaw 8-bit
      for (let i = 0; i < pcmData.length; i += 2) {
        const pcmSample = pcmData.readInt16LE(i);
        mulawData[i / 2] = pcmToMulaw(pcmSample);
      }

      // Send audio in chunks (Telnyx expects 20ms chunks = 160 bytes at 8kHz mulaw)
      const CHUNK_SIZE = 160;
      for (let offset = 0; offset < mulawData.length; offset += CHUNK_SIZE) {
        const chunk = mulawData.slice(offset, offset + CHUNK_SIZE);
        const base64Audio = chunk.toString('base64');

        // Telnyx bidirectional RTP format: media.payload (not top-level payload)
        ws.send(
          JSON.stringify({
            event: 'media',
            media: {
              payload: base64Audio,
            },
          })
        );

        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      telnyxLogger.info('Ringback audio sent successfully', {
        callControlId,
        chunks: Math.ceil(mulawData.length / CHUNK_SIZE),
        duration: `${(mulawData.length / 8000).toFixed(1)}s`,
      });
    } catch (error) {
      telnyxLogger.error('Error sending ringback audio', error);
    }
  }

  /**
   * Initialize services and user config
   */
  async function initialize(telnyxNumber, callerNumber) {
    isSpeaking = true;

    try {
      const initStartTime = Date.now();

      telnyxLogger.info('Starting initialization with ringback (audio blocked)', {
        callControlId,
        telnyxNumber,
        callerNumber,
      });

      // STEP 1: Send ringback audio immediately
      const ringbackPromise = sendRingbackAudio();

      // STEP 2: Initialize NON-TTS services while ringback plays
      telnyxLogger.info('Initializing database and Deepgram while ringback plays', { callControlId });

      // Fetch user configuration from BuddyHelps Dashboard API
      const configStartTime = Date.now();
      userConfig = await getConfigFromDashboard(telnyxNumber);

      // Validate required config fields
      if (!userConfig._configError && (!userConfig.business_name || !userConfig.greeting_name)) {
        telnyxLogger.error('Invalid config - missing required fields', {
          telnyxNumber,
          hasBusinessName: !!userConfig.business_name,
          hasGreetingName: !!userConfig.greeting_name,
        });
        userConfig._configError = true;
        userConfig._errorReason = 'invalid config (missing fields)';
      }

      // Handle config error
      if (userConfig._configError) {
        addEvent(callControlId, 'config_error', {
          latency_ms: Date.now() - configStartTime,
          reason: userConfig._errorReason,
          telnyx_number: telnyxNumber,
        });

        telnyxLogger.warn('Config error - playing error message', {
          callControlId,
          telnyxNumber,
          reason: userConfig._errorReason,
        });

        // Initialize Cartesia just for error message
        cartesia = new CartesiaService();
        cartesiaConnection = await cartesia.connect(null);

        const errorMessage = "We're sorry, we're experiencing technical difficulties. Please try your call again later. Goodbye.";

        await cartesia.queueSpeakText(errorMessage, (audioChunk) => {
          if (ws && ws.readyState === 1) {
            // Telnyx bidirectional RTP format: media.payload (not top-level payload)
            ws.send(JSON.stringify({
              event: 'media',
              media: {
                payload: audioChunk.toString('base64'),
              },
            }));
          }
        });

        await new Promise(resolve => setTimeout(resolve, 4000));

        telnyxLogger.info('Error message complete, ending call', { callControlId });
        if (cartesia) cartesia.close();
        if (ws && ws.readyState === 1) {
          ws.close();
        }
        return;
      }

      userId = userConfig.user_id;

      addEvent(callControlId, 'config_fetched', {
        latency_ms: Date.now() - configStartTime,
        business_name: userConfig.business_name,
        is_demo: userConfig.is_demo,
      });

      telnyxLogger.info('User configuration loaded', {
        userId,
        businessName: userConfig.business_name,
        telnyxNumber,
      });

      onCallStart(userId);

      // Build custom prompt
      customPrompt = await buildPrompt(userConfig, null, callerNumber);
      customPrompt = insertPhoneNumber(customPrompt, callerNumber);

      messages.push({
        role: 'system',
        content: customPrompt,
      });

      // Initialize Deepgram and LLM router
      deepgram = new DeepgramService();
      llmRouter = new LLMRouter();

      const deepgramStartTime = Date.now();
      deepgramConnection = await deepgram.startStream(
        onTranscript,
        onDeepgramError
      );

      addEvent(callControlId, 'deepgram_connected', {
        latency_ms: Date.now() - deepgramStartTime,
      });

      // Wait for ringback to finish
      await ringbackPromise;

      telnyxLogger.info('Ringback complete, NOW connecting Cartesia', {
        callControlId,
        ringbackDuration: `${Date.now() - initStartTime}ms`,
      });

      // STEP 4: Connect to Cartesia WebSocket
      const voiceId = userConfig?.ai_voice_id || null;
      cartesia = new CartesiaService();
      const cartesiaStartTime = Date.now();
      cartesiaConnection = await cartesia.connect(voiceId);

      addEvent(callControlId, 'cartesia_connected', {
        latency_ms: Date.now() - cartesiaStartTime,
        voice_id: voiceId || 'default',
      });

      telnyxLogger.info('Cartesia connected and ready', {
        callControlId,
        ttsVoiceId: voiceId || 'default',
        totalInitTime: `${Date.now() - initStartTime}ms`,
      });

      // STEP 5: Generate greeting via LLM
      telnyxLogger.info('Generating greeting via LLM', { callControlId });

      const greetingLlmStart = Date.now();
      const greetingResponse = await llmRouter.chat(messages, callControlId, null);
      const greetingLlmEnd = Date.now();
      const greeting = stripFunctionCalls(greetingResponse.content || '');

      addEvent(callControlId, 'greeting_generated', {
        llm_latency_ms: greetingLlmEnd - greetingLlmStart,
        llm_provider: greetingResponse.provider,
        greeting_length: greeting.length,
        greeting_preview: greeting.substring(0, 100),
      });

      messages.push({
        role: 'assistant',
        content: greeting,
      });

      await sendAIResponse(greeting);

      telnyxLogger.info('Call initialization complete', {
        callControlId,
        totalTime: `${Date.now() - initStartTime}ms`,
        greetingLength: greeting.length,
      });
    } catch (error) {
      telnyxLogger.error('Failed to initialize call', error);
      ws.close();
    }
  }

  /**
   * Strip internal LLM syntax from response before TTS
   */
  function stripFunctionCalls(text) {
    if (!text) return '';

    let cleaned = text;
    cleaned = cleaned.replace(/<function=[^>]+>.*?<\/function>/gs, '');
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
    cleaned = cleaned.replace(/<think>[\s\S]*/gi, '');

    return cleaned.trim();
  }

  /**
   * Correct commonly misheard plumbing terms from STT
   */
  function correctPlumbingTerms(text) {
    const corrections = {
      'quogged': 'clogged', 'quarked': 'clogged', 'corked': 'clogged',
      'clocked': 'clogged', 'cloged': 'clogged', 'clagged': 'clogged',
      'cogged': 'clogged', 'quoged': 'clogged', 'clogt': 'clogged',
      'leek': 'leak', 'leke': 'leak', 'drane': 'drain', 'drayne': 'drain',
      'fossit': 'faucet', 'fausit': 'faucet', 'fosset': 'faucet',
      'toylet': 'toilet', 'tolet': 'toilet', 'plumer': 'plumber', 'plummer': 'plumber',
    };

    let corrected = text;

    for (const [wrong, right] of Object.entries(corrections)) {
      const regex = new RegExp(`\\b${wrong}\\b`, 'gi');
      if (regex.test(corrected)) {
        corrected = corrected.replace(regex, right);
      }
    }

    return corrected;
  }

  /**
   * Handle transcript from Deepgram
   */
  async function onTranscript(transcriptText) {
    if (isSpeaking) {
      telnyxLogger.debug('Discarding transcript (AI still speaking)', {
        callControlId,
        discardedText: transcriptText,
      });
      return;
    }

    const rawTranscript = transcriptText;
    const correctedText = correctPlumbingTerms(transcriptText);

    const appliedCorrections = {};
    if (rawTranscript !== correctedText) {
      const corrections = {
        'quogged': 'clogged', 'quarked': 'clogged', 'corked': 'clogged',
        'clocked': 'clogged', 'cloged': 'clogged', 'clagged': 'clogged',
        'cogged': 'clogged', 'quoged': 'clogged', 'clogt': 'clogged',
        'leek': 'leak', 'leke': 'leak', 'drane': 'drain', 'drayne': 'drain',
        'fossit': 'faucet', 'fausit': 'faucet', 'fosset': 'faucet',
        'toylet': 'toilet', 'tolet': 'toilet', 'plumer': 'plumber', 'plummer': 'plumber',
      };
      for (const [wrong, right] of Object.entries(corrections)) {
        if (rawTranscript.toLowerCase().includes(wrong)) {
          appliedCorrections[wrong] = right;
        }
      }
    }

    try {
      telnyxLogger.info('USER TRANSCRIPT', {
        callControlId,
        text: correctedText,
        textLength: correctedText.length,
        turnNumber: Math.floor(transcript.length / 2) + 1,
      });

      transcript.push({
        speaker: 'user',
        text: correctedText,
        timestamp: new Date().toISOString(),
      });

      messages.push({
        role: 'user',
        content: correctedText,
      });

      // Get LLM response
      const tools = getToolsForConfig(userConfig);
      const llmStartTime = Date.now();
      const response = await llmRouter.chat(messages, callControlId, tools);
      const llmEndTime = Date.now();

      llmCalls++;
      totalLatency += response.latency;
      totalCost += response.cost;
      primaryProvider = response.provider;

      // Handle tool calls
      if (response.toolCalls && response.toolCalls.length > 0) {
        telnyxLogger.info('TOOL CALLS DETECTED', {
          callControlId,
          toolCount: response.toolCalls.length,
          tools: response.toolCalls.map(tc => tc.function.name),
        });

        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: response.toolCalls,
        });

        for (const toolCall of response.toolCalls) {
          const result = await executeToolCall(toolCall);

          messages.push({
            tool_call_id: toolCall.id,
            role: 'tool',
            name: toolCall.function.name,
            content: JSON.stringify(result),
          });
        }

        const followUpStartTime = Date.now();
        const finalResponse = await llmRouter.chatWithToolResults(messages, callControlId);
        const followUpEndTime = Date.now();

        llmCalls++;
        totalLatency += finalResponse.latency;
        totalCost += finalResponse.cost;

        if (finalResponse.content) {
          const cleanContent = stripFunctionCalls(finalResponse.content);

          messages.push({
            role: 'assistant',
            content: cleanContent,
          });

          telnyxLogger.info('AI TRANSCRIPT', {
            callControlId,
            text: cleanContent,
            textLength: cleanContent.length,
            turnNumber: Math.floor(transcript.length / 2) + 1,
          });

          const ttsResult = await sendAIResponse(cleanContent);

          addTurnEvent(callControlId, {
            transcriptRaw: rawTranscript,
            transcript: correctedText,
            corrections: Object.keys(appliedCorrections).length > 0 ? appliedCorrections : null,
            aiResponse: cleanContent,
            llmProvider: response.provider,
            llmModel: response.model,
            tokensIn: response.tokens?.input || null,
            tokensOut: response.tokens?.output || null,
            llmLatency: (llmEndTime - llmStartTime) + (followUpEndTime - followUpStartTime),
            ttsLatency: ttsResult?.ttfb || null,
            ttsAudioMs: ttsResult?.audioMs || null,
            ttsStreamingMs: ttsResult?.streamingMs || null,
            pipelineLatency: (llmEndTime - llmStartTime) + (followUpEndTime - followUpStartTime) + (ttsResult?.ttfb || 0),
          });

          if (isGoodbyePhrase(cleanContent)) {
            const closeDelay = (ttsResult?.audioMs || 2000) + 1000;
            telnyxLogger.info('Goodbye detected, ending call', { callControlId, closeDelayMs: closeDelay });
            setTimeout(() => ws.close(), closeDelay);
          }
        }
      } else if (response.content) {
        const cleanContent = stripFunctionCalls(response.content);

        if (cleanContent.length > 0) {
          messages.push({
            role: 'assistant',
            content: cleanContent,
          });

          telnyxLogger.info('AI TRANSCRIPT', {
            callControlId,
            text: cleanContent,
            textLength: cleanContent.length,
            turnNumber: Math.floor(transcript.length / 2) + 1,
          });

          const ttsResult = await sendAIResponse(cleanContent);

          addTurnEvent(callControlId, {
            transcriptRaw: rawTranscript,
            transcript: correctedText,
            corrections: Object.keys(appliedCorrections).length > 0 ? appliedCorrections : null,
            aiResponse: cleanContent,
            llmProvider: response.provider,
            llmModel: response.model,
            tokensIn: response.tokens?.input || null,
            tokensOut: response.tokens?.output || null,
            llmLatency: llmEndTime - llmStartTime,
            ttsLatency: ttsResult?.ttfb || null,
            ttsAudioMs: ttsResult?.audioMs || null,
            ttsStreamingMs: ttsResult?.streamingMs || null,
            pipelineLatency: (llmEndTime - llmStartTime) + (ttsResult?.ttfb || 0),
          });

          if (isGoodbyePhrase(cleanContent)) {
            const closeDelay = (ttsResult?.audioMs || 2000) + 1000;
            telnyxLogger.info('Goodbye detected, ending call', { callControlId, closeDelayMs: closeDelay });
            setTimeout(() => ws.close(), closeDelay);
          }
        }
      }
    } catch (error) {
      telnyxLogger.error('Error processing transcript', error);
      addErrorEvent(callControlId, 'transcript_processing', error, {
        transcript: correctedText,
      });

      try {
        const errorResponse = "Sorry, I didn't catch that. Could you repeat what you said?";
        messages.push({
          role: 'assistant',
          content: errorResponse,
        });
        await sendAIResponse(errorResponse);
      } catch (ttsError) {
        telnyxLogger.error('Failed to send error response', ttsError);
      }
    }
  }

  /**
   * Execute a tool call
   */
  async function executeToolCall(toolCall) {
    const functionName = toolCall.function.name;
    const args = JSON.parse(toolCall.function.arguments);

    telnyxLogger.info('Executing tool', {
      tool: functionName,
      toolCallId: toolCall.id,
      args
    });

    if (functionName === 'update_service_request') {
      Object.assign(collectedData, args);
      return { success: true, updated: Object.keys(args) };
    } else if (functionName === 'end_call_with_summary') {
      telnyxLogger.info('Call ending', { summary: args.summary, priority: args.priority });
      setTimeout(() => ws.close(), 5000);
      return { success: true, callEnding: true, summary: args.summary };
    } else if (functionName === 'end_call') {
      telnyxLogger.info('Call ending (simple)', { callControlId });
      setTimeout(() => ws.close(), 5000);
      return { success: true, callEnding: true };
    }

    return { success: false, error: 'Unknown tool' };
  }

  /**
   * Send AI response via TTS
   */
  async function sendAIResponse(text) {
    isSpeaking = true;
    telnyxLogger.debug('Blocking user audio (AI speaking)', { callControlId });

    try {
      if (cartesia.needsRefresh()) {
        telnyxLogger.warn('Refreshing Cartesia before idle timeout', { callControlId });
        await cartesia.disconnect();
        await cartesia.connect(userConfig?.ai_voice_id);
      }

      transcript.push({
        speaker: 'ai',
        text,
        timestamp: new Date().toISOString(),
      });

      // Queue TTS - Telnyx uses same mulaw format
      const ttsResult = await cartesia.queueSpeakText(text, (audioChunk) => {
        // Convert Buffer to Base64 for Telnyx
        const base64Audio = audioChunk.toString('base64');

        // Telnyx bidirectional RTP format: media.payload (not top-level payload)
        ws.send(
          JSON.stringify({
            event: 'media',
            media: {
              payload: base64Audio,
            },
          })
        );

        if (callRecorder) {
          callRecorder.addAiAudio(audioChunk);
        }
      });

      // Wait for playback
      const playbackBuffer = 300;
      const remainingPlaybackMs = Math.max(0, ttsResult.audioMs - ttsResult.streamingDurationMs);
      const playbackWaitMs = remainingPlaybackMs + playbackBuffer;

      telnyxLogger.debug('Waiting for playback to complete', {
        callControlId,
        audioMs: ttsResult.audioMs,
        streamingMs: ttsResult.streamingDurationMs,
        totalWaitMs: playbackWaitMs,
      });

      await new Promise(resolve => setTimeout(resolve, playbackWaitMs));

      return {
        ttfb: ttsResult.ttfb,
        audioMs: ttsResult.audioMs,
        streamingMs: ttsResult.streamingDurationMs,
      };
    } catch (error) {
      telnyxLogger.error('Error in sendAIResponse', error);
      throw error;
    } finally {
      isSpeaking = false;
      telnyxLogger.debug('Resuming user audio (playback complete)', { callControlId });
    }
  }

  /**
   * Handle Deepgram errors
   */
  function onDeepgramError(error) {
    telnyxLogger.error('Deepgram error', error);
  }

  /**
   * Send call data to webhook
   */
  async function finalize() {
    if (finalized) {
      telnyxLogger.info('Call already finalized, skipping', { callControlId });
      return;
    }
    finalized = true;

    try {
      endTime = new Date().toISOString();
      const duration = Math.floor(
        (new Date(endTime) - new Date(startTime)) / 1000
      );

      const callData = {
        callSid: callControlId, // Use callControlId as the call identifier
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
        userConfig,
        telephonyProvider: 'telnyx', // Mark as Telnyx call
      };

      telnyxLogger.info('CALL SUMMARY STATS', {
        callControlId,
        duration: `${duration}s`,
        totalTurns: transcript.length,
        userTurns: transcript.filter((t) => t.speaker === 'user').length,
        aiTurns: transcript.filter((t) => t.speaker === 'ai').length,
        llmCalls,
        avgLlmLatency: llmCalls > 0 ? Math.round(totalLatency / llmCalls) : 0,
        totalCost: `$${totalCost.toFixed(4)}`,
        provider: primaryProvider,
      });

      telnyxLogger.info('Sending call data to webhook', { callControlId });

      const webhookResult = await sendToWebhook(userId, callData);
      const events = finishAndGetEvents(callControlId);

      if (webhookResult?.callId && events.length > 0) {
        await sendEventsToDashboard(webhookResult.callId, events);
        telnyxLogger.info('Call events sent to dashboard', {
          callControlId,
          callId: webhookResult.callId,
          eventCount: events.length,
        });
      }

      // Upload recording
      if (callRecorder && webhookResult?.callId) {
        (async () => {
          try {
            const wavBuffer = callRecorder.finalize();
            if (wavBuffer) {
              const recordingUrl = await uploadRecording(
                webhookResult.callId,
                wavBuffer,
                'https://info.buddyhelps.ca'
              );
              if (recordingUrl) {
                telnyxLogger.info('Recording uploaded successfully', {
                  callControlId,
                  callId: webhookResult.callId,
                  recordingUrl,
                });
              }
            }
          } catch (err) {
            telnyxLogger.error('Recording upload failed', err, { callControlId });
          } finally {
            callRecorder.clear();
          }
        })();
      }

      onCallEnd();

      telnyxLogger.info('Call completed successfully', {
        callControlId,
        duration,
        llmCalls,
        avgLatency: callData.avgLatency,
        cost: totalCost.toFixed(4),
        events: events.length,
      });
    } catch (error) {
      telnyxLogger.error('Error finalizing call', error);
      addErrorEvent(callControlId, 'finalize', error);
    }
  }

  // Handle WebSocket messages from Telnyx
  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.event === 'connected') {
        // Initial WebSocket connection confirmation
        telnyxLogger.info('WebSocket connected', {
          connection_id: msg.connection_id,
        });
      } else if (msg.event === 'start') {
        // Stream started - extract call info
        streamId = msg.start.stream_id;

        // Decode client_state to get call info (set in webhook.js)
        if (msg.start.client_state) {
          try {
            const clientState = JSON.parse(
              Buffer.from(msg.start.client_state, 'base64').toString('utf-8')
            );
            fromNumber = clientState.from;
            toNumber = clientState.to;
            callControlId = clientState.call_control_id;
          } catch (e) {
            telnyxLogger.warn('Failed to parse client_state', e);
          }
        }

        // Fallback to start payload if client_state missing
        if (!callControlId) {
          callControlId = msg.start.call_control_id || 'unknown';
        }

        startTime = new Date().toISOString();

        telnyxLogger.info('Call started', {
          callControlId,
          from: fromNumber,
          to: toNumber,
          streamId,
        });

        initCallEvents(callControlId);

        callRecorder = createCallRecorder(callControlId);
        telnyxLogger.info('Call recorder initialized', { callControlId });

        await initialize(toNumber, fromNumber);

      } else if (msg.event === 'media') {
        // Incoming audio from caller
        // Telnyx format: {event: 'media', media: {track: 'inbound', payload}}
        if (deepgramConnection && msg.media?.payload) {
          // Only process inbound audio (from caller)
          if (msg.media.track === 'inbound') {
            const audioBuffer = Buffer.from(msg.media.payload, 'base64');
            deepgram.sendAudio(deepgramConnection, audioBuffer);

            if (callRecorder) {
              callRecorder.addCallerAudio(audioBuffer);
            }
          }
        }
      } else if (msg.event === 'stop') {
        telnyxLogger.info('Call stopped', { callControlId });

        if (deepgramConnection) {
          deepgram.closeStream(deepgramConnection);
        }

        if (cartesia) {
          await cartesia.disconnect();
        }

        await finalize();
      }
    } catch (error) {
      telnyxLogger.error('Error handling Telnyx message', error);
    }
  });

  ws.on('error', (error) => {
    telnyxLogger.error('WebSocket error', error);
  });

  ws.on('close', async () => {
    telnyxLogger.info('WebSocket closed', { callControlId });

    if (deepgramConnection) {
      deepgram.closeStream(deepgramConnection);
    }

    if (cartesia) {
      cartesia.disconnect();
    }

    await finalize();
  });
}

export default {
  handleTelnyxStream,
};
