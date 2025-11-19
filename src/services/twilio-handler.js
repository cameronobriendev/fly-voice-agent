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

import { getUserByPhone, getDemoRequestByPhone } from '../db/queries.js';
import { buildPrompt, insertPhoneNumber, substituteVariables } from './prompt-builder.js';
import { DeepgramService } from './deepgram.js';
import { CartesiaService } from './cartesia.js';
import { LLMRouter } from './llm-router.js';
import { sendToWebhook } from './post-call.js';
import { onCallStart, onCallEnd } from './metrics.js';
import { FUNCTIONS } from '../prompts/template.js';
import { logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const twilioLogger = logger.child('TWILIO');

// Load ringback audio at module level (PCM 16-bit 8kHz WAV, needs conversion to mulaw)
let ringbackAudioRaw = null;
try {
  const ringbackPath = path.join(__dirname, '../../public/ringback-pattern.wav');
  ringbackAudioRaw = fs.readFileSync(ringbackPath);
  twilioLogger.info('Ringback audio loaded', {
    path: ringbackPath,
    size: ringbackAudioRaw.length,
  });
} catch (error) {
  twilioLogger.error('Failed to load ringback audio', error);
}

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
  let cartesiaConnection = null;
  let llmRouter = null;

  // Metrics
  let llmCalls = 0;
  let totalLatency = 0;
  let totalCost = 0;
  let primaryProvider = null;

  /**
   * Convert 16-bit PCM sample to 8-bit mulaw
   * Mulaw is logarithmic compression used by Twilio Media Streams
   */
  function pcmToMulaw(pcm) {
    const MULAW_MAX = 0x1FFF;
    const MULAW_BIAS = 33;
    let mask = 0x1000;
    let sign = 0;
    let position = 12;
    let lsb = 0;

    // Get sign and absolute value
    if (pcm < 0) {
      pcm = -pcm;
      sign = 0x80;
    }

    // Add bias
    pcm += MULAW_BIAS;
    if (pcm > MULAW_MAX) pcm = MULAW_MAX;

    // Convert to mulaw
    for (; position >= 5; position--, mask >>= 1) {
      if (pcm & mask) break;
    }

    lsb = (pcm >> (position - 4)) & 0x0F;
    return ~(sign | ((position - 5) << 4) | lsb);
  }

  /**
   * Send ringback audio through WebSocket to Twilio
   * Plays while services initialize in parallel
   */
  async function sendRingbackAudio() {
    if (!ringbackAudioRaw || !streamSid) {
      twilioLogger.warn('Cannot send ringback - audio or streamSid missing');
      return;
    }

    try {
      twilioLogger.info('Sending ringback audio through WebSocket', {
        callSid,
        audioSize: ringbackAudioRaw.length,
      });

      // Skip WAV header (44 bytes) and get PCM data
      const pcmData = ringbackAudioRaw.slice(44);
      const mulawData = Buffer.alloc(pcmData.length / 2); // 16-bit PCM to 8-bit mulaw

      // Convert PCM 16-bit to mulaw 8-bit
      for (let i = 0; i < pcmData.length; i += 2) {
        const pcmSample = pcmData.readInt16LE(i);
        mulawData[i / 2] = pcmToMulaw(pcmSample);
      }

      // Send audio in chunks (Twilio expects 20ms chunks = 160 bytes at 8kHz mulaw)
      const CHUNK_SIZE = 160; // 20ms of 8kHz mulaw audio
      for (let offset = 0; offset < mulawData.length; offset += CHUNK_SIZE) {
        const chunk = mulawData.slice(offset, offset + CHUNK_SIZE);
        const base64Audio = chunk.toString('base64');

        ws.send(
          JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: {
              payload: base64Audio,
            },
          })
        );

        // Wait 20ms between chunks to match real-time playback
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      twilioLogger.info('Ringback audio sent successfully', {
        callSid,
        chunks: Math.ceil(mulawData.length / CHUNK_SIZE),
        duration: `${(mulawData.length / 8000).toFixed(1)}s`,
      });
    } catch (error) {
      twilioLogger.error('Error sending ringback audio', error);
    }
  }

  /**
   * Get initial greeting based on call type and demo request lookup
   * @param {Object} userConfig - User configuration from database
   * @param {string} callerNumber - Caller's phone number
   * @returns {Promise<string>} Initial greeting text
   */
  async function getInitialGreeting(userConfig, callerNumber) {
    const DEMO_PHONE_NUMBER = '+17753767929';
    const isDemoCall = userConfig.twilio_phone_number === DEMO_PHONE_NUMBER;

    if (isDemoCall) {
      // Check if caller has demo request (for industry lookup)
      const demoRequest = await getDemoRequestByPhone(callerNumber);

      if (demoRequest && demoRequest.industry_slug) {
        // Caller has industry - use demo greeting
        if (userConfig.demo_greeting) {
          twilioLogger.info('Using custom demo greeting (with industry)', {
            callSid,
            callerNumber,
            industry: demoRequest.industry_slug
          });
          return substituteVariables(userConfig.demo_greeting, userConfig);
        }
      } else {
        // Caller has no industry - use demo fallback greeting
        if (userConfig.demo_fallback_greeting) {
          twilioLogger.info('Using custom demo fallback greeting (no industry)', {
            callSid,
            callerNumber
          });
          return substituteVariables(userConfig.demo_fallback_greeting, userConfig);
        }
      }

      // Ultimate fallback for demo calls
      twilioLogger.info('Using default demo greeting', { callSid, callerNumber });
      return substituteVariables(
        `Thanks for calling our {{BUSINESS_NAME}} demo! How can I help you today?`,
        userConfig
      );
    } else {
      // Client call - use client greeting
      if (userConfig.client_greeting) {
        twilioLogger.info('Using custom client greeting', { callSid });
        return substituteVariables(userConfig.client_greeting, userConfig);
      }

      // Fallback for client calls
      twilioLogger.info('Using default client greeting', { callSid });
      return substituteVariables(
        `Hi! Thanks for calling {{BUSINESS_NAME}}. How can I help you today?`,
        userConfig
      );
    }
  }

  /**
   * Initialize services and user config
   * NEW FLOW: Plays ringback FIRST, initializes Deepgram during ringback,
   * then connects Cartesia AFTER ringback completes (prevents WebSocket idle timeout)
   */
  async function initialize(twilioNumber, callerNumber) {
    try {
      const initStartTime = Date.now();

      twilioLogger.info('Starting initialization with ringback', {
        callSid,
        twilioNumber,
        callerNumber,
      });

      // STEP 1: Send ringback audio immediately (non-blocking, plays for ~8 seconds)
      const ringbackPromise = sendRingbackAudio();

      // STEP 2: Initialize NON-TTS services while ringback plays
      // (Deepgram can handle idle time, Cartesia cannot)
      twilioLogger.info('Initializing database and Deepgram while ringback plays', { callSid });

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

      // Build custom prompt (async - looks up demo caller's industry if applicable)
      customPrompt = await buildPrompt(userConfig, null, callerNumber);
      customPrompt = insertPhoneNumber(customPrompt, callerNumber);

      // Initialize system message
      messages.push({
        role: 'system',
        content: customPrompt,
      });

      // Initialize Deepgram and LLM router (can be idle without issues)
      deepgram = new DeepgramService();
      llmRouter = new LLMRouter();

      // Start Deepgram stream (STT) - can start listening early
      deepgramConnection = await deepgram.startStream(
        onTranscript,
        onDeepgramError
      );

      const preRingbackEndTime = Date.now();
      const preRingbackDuration = preRingbackEndTime - initStartTime;

      twilioLogger.info('Non-TTS services initialized', {
        callSid,
        sttProvider: 'Deepgram',
        duration: `${preRingbackDuration}ms`,
      });

      // STEP 3: Wait for ringback to finish
      await ringbackPromise;

      twilioLogger.info('Ringback complete, NOW connecting Cartesia (fresh connection)', {
        callSid,
        ringbackDuration: `${Date.now() - initStartTime}ms`,
      });

      // STEP 4: Connect to Cartesia WebSocket NOW (fresh connection, used immediately)
      // v2.x: No delay needed - lazy connection works on first send()
      const voiceId = userConfig?.ai_voice_id || null;
      cartesia = new CartesiaService();
      cartesiaConnection = await cartesia.connect(voiceId);

      const cartesiaConnectedTime = Date.now();
      twilioLogger.info('Cartesia connected and ready (v2.x)', {
        callSid,
        ttsProvider: 'Cartesia WebSocket v2.x',
        ttsVoiceId: voiceId || 'default',
        connectionTime: `${cartesiaConnectedTime - preRingbackEndTime}ms`,
        totalInitTime: `${cartesiaConnectedTime - initStartTime}ms`,
      });

      // STEP 5: Immediately send greeting (no idle time!)
      const greeting = await getInitialGreeting(userConfig, callerNumber);
      await sendAIResponse(greeting);

      twilioLogger.info('✅ Call initialization complete', {
        callSid,
        totalTime: `${Date.now() - initStartTime}ms`,
      });
    } catch (error) {
      twilioLogger.error('Failed to initialize call', error);
      ws.close();
    }
  }

  /**
   * Strip function call syntax from LLM response
   * Removes <function=...>...</function> tags that should not be spoken
   */
  function stripFunctionCalls(text) {
    // Remove function call syntax: <function=name>{...}</function>
    return text.replace(/<function=[^>]+>.*?<\/function>/g, '').trim();
  }

  /**
   * Handle transcript from Deepgram
   */
  async function onTranscript(transcriptText) {
    const transcriptReceivedAt = Date.now();

    try {
      // LOG TRANSCRIPT ENTRY (VERBOSE)
      twilioLogger.info('📞 USER TRANSCRIPT', {
        callSid,
        speaker: 'user',
        text: transcriptText,
        textLength: transcriptText.length,
        timestamp: new Date().toISOString(),
        turnNumber: Math.floor(transcript.length / 2) + 1,
      });

      // Add to transcript
      const transcriptEntry = {
        speaker: 'user',
        text: transcriptText,
        timestamp: new Date().toISOString(),
      };
      transcript.push(transcriptEntry);

      // Add to conversation history
      messages.push({
        role: 'user',
        content: transcriptText,
      });

      // Get LLM response with timing
      const llmStartTime = Date.now();
      const response = await llmRouter.chat(messages, callSid, FUNCTIONS);
      const llmEndTime = Date.now();

      llmCalls++;
      totalLatency += response.latency;
      totalCost += response.cost;
      primaryProvider = response.provider;

      // LOG RAW LLM RESPONSE (BEFORE FUNCTION STRIPPING)
      twilioLogger.debug('🤖 LLM RAW RESPONSE', {
        callSid,
        provider: response.provider,
        hasContent: !!response.content,
        hasFunctionCall: !!response.functionCall,
        contentLength: response.content?.length || 0,
        rawContent: response.content || '(no content)',
        functionCallName: response.functionCall?.name || null,
        tokens: response.tokens,
        latency: `${response.latency}ms`,
        cost: `$${response.cost.toFixed(6)}`,
      });

      // Handle function call
      if (response.functionCall) {
        twilioLogger.info('🔧 FUNCTION CALL DETECTED', {
          callSid,
          functionName: response.functionCall.name,
          arguments: response.functionCall.arguments,
        });
        await handleFunctionCall(response.functionCall);
      }

      // Handle text response with timing
      if (response.content) {
        // Strip function call syntax before storing and speaking
        const cleanContent = stripFunctionCalls(response.content);

        // LOG FUNCTION CALL STRIPPING RESULTS
        if (cleanContent.length !== response.content.length) {
          const stripped = response.content.length - cleanContent.length;
          twilioLogger.debug('✂️ STRIPPED FUNCTION CALLS FROM RESPONSE', {
            callSid,
            originalLength: response.content.length,
            cleanLength: cleanContent.length,
            strippedChars: stripped,
            hadFunctionSyntax: true,
          });
        }

        if (cleanContent.length > 0) {
          messages.push({
            role: 'assistant',
            content: cleanContent,
          });

          // LOG AI RESPONSE BEFORE TTS
          twilioLogger.info('🤖 AI TRANSCRIPT', {
            callSid,
            speaker: 'ai',
            text: cleanContent,
            textLength: cleanContent.length,
            timestamp: new Date().toISOString(),
            turnNumber: Math.floor(transcript.length / 2) + 1,
          });

          const ttsStartTime = Date.now();
          await sendAIResponse(cleanContent);
          const ttsEndTime = Date.now();

          // Log detailed latency breakdown
          twilioLogger.info('⏱️ RESPONSE TIMING BREAKDOWN', {
            callSid,
            llmLatency: `${llmEndTime - llmStartTime}ms`,
            ttsLatency: `${ttsEndTime - ttsStartTime}ms`,
            totalPipelineLatency: `${ttsEndTime - transcriptReceivedAt}ms`,
            responseLength: cleanContent.length,
            hadFunctionCalls: cleanContent.length !== response.content.length,
            provider: response.provider,
          });
        } else {
          twilioLogger.debug('Response contained only function calls, no text to speak', {
            callSid,
          });
        }
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
   * Send AI response via TTS (WebSocket streaming with automatic retry)
   * v2.x: Includes idle connection refresh check
   */
  async function sendAIResponse(text) {
    try {
      // Check if connection needs refresh (5-min idle timeout)
      if (cartesia.needsRefresh()) {
        twilioLogger.warn('Refreshing Cartesia before 5-min idle timeout', {
          callSid,
        });
        await cartesia.disconnect();
        await cartesia.connect(userConfig?.ai_voice_id);
      }

      // LOG TTS REQUEST
      twilioLogger.debug('🔊 TTS STREAMING REQUEST (v2.x)', {
        callSid,
        text: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
        textLength: text.length,
        voiceId: userConfig?.ai_voice_id || 'default',
        method: 'websocket-streaming-with-retry-v2',
      });

      // Add to transcript
      transcript.push({
        speaker: 'ai',
        text,
        timestamp: new Date().toISOString(),
      });

      // Speak text with automatic retry if timeout occurs
      // v2.x: audioChunk is already a Buffer from cartesia.js
      await cartesia.speakTextWithRetry(text, (audioChunk) => {
        // Convert Buffer to Base64 for Twilio
        const base64Audio = audioChunk.toString('base64');
        ws.send(
          JSON.stringify({
            event: 'media',
            streamSid: streamSid,
            media: {
              payload: base64Audio,
            },
          })
        );
      }, 1, 10000); // maxRetries=1, timeout=10000ms
    } catch (error) {
      twilioLogger.error('Error in sendAIResponse', error);
      throw error;
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

      // LOG FULL CALL TRANSCRIPT (VERBOSE)
      twilioLogger.info('📋 FULL CALL TRANSCRIPT', {
        callSid,
        fromNumber,
        toNumber,
        duration: `${duration}s`,
        turns: transcript.length,
        transcript: transcript.map((entry, idx) => ({
          turn: idx + 1,
          speaker: entry.speaker,
          text: entry.text,
          timestamp: entry.timestamp,
        })),
      });

      // LOG CALL SUMMARY STATS
      twilioLogger.info('📊 CALL SUMMARY STATS', {
        callSid,
        duration: `${duration}s`,
        totalTurns: transcript.length,
        userTurns: transcript.filter((t) => t.speaker === 'user').length,
        aiTurns: transcript.filter((t) => t.speaker === 'ai').length,
        llmCalls,
        avgLlmLatency: llmCalls > 0 ? Math.round(totalLatency / llmCalls) : 0,
        totalCost: `$${totalCost.toFixed(4)}`,
        provider: primaryProvider,
        collectedData: JSON.stringify(collectedData, null, 2),
      });

      twilioLogger.info('Sending call data to webhook', { callSid });

      await sendToWebhook(userId, callData);

      // Track call end
      onCallEnd();

      twilioLogger.info('✅ Call completed successfully', {
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

        // Extract phone numbers from custom parameters (sent via Stream TwiML)
        fromNumber = msg.start.customParameters?.From;
        toNumber = msg.start.customParameters?.To;

        startTime = new Date().toISOString();

        twilioLogger.info('Call started', {
          callSid,
          from: fromNumber,
          to: toNumber,
          customParameters: msg.start.customParameters,
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

        // Close Cartesia WebSocket
        if (cartesia) {
          await cartesia.disconnect();
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

    if (cartesia) {
      cartesia.disconnect();
    }
  });
}

export default {
  handleTwilioStream,
};
