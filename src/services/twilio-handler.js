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

import { getConfigFromDashboard } from './config-api.js';
import { buildPrompt, insertPhoneNumber } from './prompt-builder.js';
import { DeepgramService } from './deepgram.js';
import { CartesiaService } from './cartesia.js';
import { LLMRouter } from './llm-router.js';
import { sendToWebhook } from './post-call.js';
import { onCallStart, onCallEnd } from './metrics.js';
import { TOOLS } from '../prompts/template.js';
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

  // Half-duplex state: block user audio while AI is speaking
  let isSpeaking = false;

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
   * Initialize services and user config
   * NEW FLOW: Plays ringback FIRST, initializes Deepgram during ringback,
   * then connects Cartesia AFTER ringback completes (prevents WebSocket idle timeout)
   * HALF-DUPLEX: Blocks user audio during entire init phase (ringback + greeting)
   */
  async function initialize(twilioNumber, callerNumber) {
    // HALF-DUPLEX: Block user audio during entire initialization
    // This protects ringback + greeting from interruptions
    // sendAIResponse will reset this after greeting completes
    isSpeaking = true;

    try {
      const initStartTime = Date.now();

      twilioLogger.info('Starting initialization with ringback (audio blocked)', {
        callSid,
        twilioNumber,
        callerNumber,
      });

      // STEP 1: Send ringback audio immediately (non-blocking, plays for ~8 seconds)
      const ringbackPromise = sendRingbackAudio();

      // STEP 2: Initialize NON-TTS services while ringback plays
      // (Deepgram can handle idle time, Cartesia cannot)
      twilioLogger.info('Initializing database and Deepgram while ringback plays', { callSid });

      // Fetch user configuration from BuddyHelps Dashboard API
      userConfig = await getConfigFromDashboard(twilioNumber);
      userId = userConfig.user_id; // Will be null for BuddyHelps

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

      // STEP 5: Generate greeting via LLM (so it has full context)
      twilioLogger.info('Generating greeting via LLM', { callSid });

      const greetingResponse = await llmRouter.chat(messages, callSid, null);
      const greeting = stripFunctionCalls(greetingResponse.content || '');

      // Add greeting to conversation history so LLM has context
      messages.push({
        role: 'assistant',
        content: greeting,
      });

      // Add to transcript
      transcript.push({
        turn: 1,
        speaker: 'ai',
        text: greeting,
        timestamp: new Date().toISOString(),
      });

      // Send to TTS
      await sendAIResponse(greeting);

      twilioLogger.info('✅ Call initialization complete', {
        callSid,
        totalTime: `${Date.now() - initStartTime}ms`,
        greetingLength: greeting.length,
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
   * Correct commonly misheard plumbing terms from STT
   * Phone audio quality causes words like "clogged" to be heard as "quogged", "quarked", etc.
   */
  function correctPlumbingTerms(text) {
    // Map of misheard words → correct word (case-insensitive)
    const corrections = {
      // "clogged" mishearings
      'quogged': 'clogged',
      'quarked': 'clogged',
      'corked': 'clogged',
      'clocked': 'clogged',
      'cloged': 'clogged',
      'clagged': 'clogged',
      'cogged': 'clogged',
      'quoged': 'clogged',
      'clogt': 'clogged',
      // "leak" mishearings
      'leek': 'leak',
      'leke': 'leak',
      // "drain" mishearings
      'drane': 'drain',
      'drayne': 'drain',
      // "faucet" mishearings
      'fossit': 'faucet',
      'fausit': 'faucet',
      'fosset': 'faucet',
      // "toilet" mishearings
      'toylet': 'toilet',
      'tolet': 'toilet',
      // "plumber" mishearings
      'plumer': 'plumber',
      'plummer': 'plumber',
    };

    let corrected = text;
    let madeCorrections = false;

    for (const [wrong, right] of Object.entries(corrections)) {
      const regex = new RegExp(`\\b${wrong}\\b`, 'gi');
      if (regex.test(corrected)) {
        corrected = corrected.replace(regex, right);
        madeCorrections = true;
      }
    }

    if (madeCorrections) {
      twilioLogger.info('🔧 STT CORRECTION APPLIED', {
        callSid,
        original: text,
        corrected: corrected,
      });
    }

    return corrected;
  }

  /**
   * Handle transcript from Deepgram
   * HALF-DUPLEX: Discards transcripts received while AI is speaking
   */
  async function onTranscript(transcriptText) {
    const transcriptReceivedAt = Date.now();

    // HALF-DUPLEX: Discard any transcripts that arrive while AI is speaking
    // This catches edge cases where audio was already in Deepgram's pipeline
    if (isSpeaking) {
      twilioLogger.debug('🔇 HALF-DUPLEX: Discarding transcript (AI still speaking)', {
        callSid,
        discardedText: transcriptText,
      });
      return;
    }

    // Correct commonly misheard plumbing terms
    const correctedText = correctPlumbingTerms(transcriptText);

    try {
      // LOG TRANSCRIPT ENTRY (VERBOSE)
      twilioLogger.info('📞 USER TRANSCRIPT', {
        callSid,
        speaker: 'user',
        text: correctedText,
        textLength: correctedText.length,
        timestamp: new Date().toISOString(),
        turnNumber: Math.floor(transcript.length / 2) + 1,
      });

      // Add to transcript (use corrected text)
      const transcriptEntry = {
        speaker: 'user',
        text: correctedText,
        timestamp: new Date().toISOString(),
      };
      transcript.push(transcriptEntry);

      // Add to conversation history (use corrected text for LLM)
      messages.push({
        role: 'user',
        content: correctedText,
      });

      // Get LLM response with timing
      // Demo calls don't use tools (faster response, no data capture needed)
      const isDemoCall = userConfig.is_demo;
      const llmStartTime = Date.now();
      const response = await llmRouter.chat(messages, callSid, isDemoCall ? null : TOOLS);
      const llmEndTime = Date.now();

      llmCalls++;
      totalLatency += response.latency;
      totalCost += response.cost;
      primaryProvider = response.provider;

      // LOG RAW LLM RESPONSE
      twilioLogger.debug('🤖 LLM RAW RESPONSE', {
        callSid,
        provider: response.provider,
        hasContent: !!response.content,
        hasToolCalls: !!(response.toolCalls && response.toolCalls.length > 0),
        toolCallCount: response.toolCalls?.length || 0,
        contentLength: response.content?.length || 0,
        rawContent: response.content || '(no content)',
        tokens: response.tokens,
        latency: `${response.latency}ms`,
        cost: `$${response.cost.toFixed(6)}`,
      });

      // TWO-STAGE RESPONSE PATTERN
      // Check for tool calls FIRST - execute silently, then get natural response
      if (response.toolCalls && response.toolCalls.length > 0) {
        twilioLogger.info('🔧 TOOL CALLS DETECTED', {
          callSid,
          toolCount: response.toolCalls.length,
          tools: response.toolCalls.map(tc => tc.function.name),
        });

        // Add assistant's tool call message to history
        messages.push({
          role: 'assistant',
          content: null,
          tool_calls: response.toolCalls,
        });

        // Execute each tool SILENTLY and collect results
        for (const toolCall of response.toolCalls) {
          const result = await executeToolCall(toolCall);

          // Add tool result to conversation history
          messages.push({
            tool_call_id: toolCall.id,
            role: 'tool',
            name: toolCall.function.name,
            content: JSON.stringify(result),
          });

          twilioLogger.debug('🔧 TOOL EXECUTED', {
            callSid,
            toolName: toolCall.function.name,
            toolCallId: toolCall.id,
            result,
          });
        }

        // SECOND API CALL - Get natural language response after tool execution
        const followUpStartTime = Date.now();
        const finalResponse = await llmRouter.chatWithToolResults(messages, callSid);
        const followUpEndTime = Date.now();

        // Track additional metrics
        llmCalls++;
        totalLatency += finalResponse.latency;
        totalCost += finalResponse.cost;

        twilioLogger.debug('🤖 FOLLOW-UP RESPONSE (after tools)', {
          callSid,
          hasContent: !!finalResponse.content,
          contentLength: finalResponse.content?.length || 0,
          latency: `${finalResponse.latency}ms`,
        });

        // Send the natural language response to TTS
        if (finalResponse.content) {
          // Safety sanitization - strip any leaked syntax
          const cleanContent = stripFunctionCalls(finalResponse.content);

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
          twilioLogger.info('⏱️ RESPONSE TIMING BREAKDOWN (two-stage)', {
            callSid,
            firstLlmLatency: `${llmEndTime - llmStartTime}ms`,
            secondLlmLatency: `${followUpEndTime - followUpStartTime}ms`,
            ttsLatency: `${ttsEndTime - ttsStartTime}ms`,
            totalPipelineLatency: `${ttsEndTime - transcriptReceivedAt}ms`,
            responseLength: cleanContent.length,
            toolsExecuted: response.toolCalls.length,
            provider: response.provider,
          });
        }
      } else if (response.content) {
        // No tool calls - just a regular text response
        // Safety sanitization as fallback
        const cleanContent = stripFunctionCalls(response.content);

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
            provider: response.provider,
          });
        }
      }
    } catch (error) {
      twilioLogger.error('Error processing transcript', error);

      // Provide user feedback on error instead of silence
      try {
        const errorResponse = "Sorry, I didn't catch that. Could you repeat what you said?";
        messages.push({
          role: 'assistant',
          content: errorResponse,
        });
        await sendAIResponse(errorResponse);
      } catch (ttsError) {
        twilioLogger.error('Failed to send error response', ttsError);
      }
    }
  }

  /**
   * Execute a tool call silently and return the result
   * @param {Object} toolCall - Tool call object from LLM
   * @returns {Object} Result of tool execution
   */
  async function executeToolCall(toolCall) {
    const functionName = toolCall.function.name;
    const args = JSON.parse(toolCall.function.arguments);

    twilioLogger.info('Executing tool', {
      tool: functionName,
      toolCallId: toolCall.id,
      args
    });

    if (functionName === 'update_service_request') {
      // Update collected data silently
      Object.assign(collectedData, args);
      twilioLogger.debug('Service request updated', collectedData);
      return { success: true, updated: Object.keys(args) };
    } else if (functionName === 'end_call_with_summary') {
      // Call is ending - schedule close after response is spoken
      twilioLogger.info('Call ending', { summary: args.summary, priority: args.priority });

      // Schedule call close after TTS completes
      setTimeout(() => {
        ws.close();
      }, 5000); // Give time for final message to play

      return { success: true, callEnding: true, summary: args.summary };
    }

    return { success: false, error: 'Unknown tool' };
  }

  /**
   * Send AI response via TTS (WebSocket streaming with automatic retry)
   * v2.x: Includes idle connection refresh check
   * HALF-DUPLEX: Sets isSpeaking flag to block user audio during playback
   */
  async function sendAIResponse(text) {
    // HALF-DUPLEX: Block user audio while AI is speaking
    isSpeaking = true;
    twilioLogger.debug('🔇 HALF-DUPLEX: Blocking user audio (AI speaking)', { callSid });

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

      // Queue TTS request to prevent concurrent connections hitting rate limits
      // v2.x: audioChunk is already a Buffer from cartesia.js
      const ttsResult = await cartesia.queueSpeakText(text, (audioChunk) => {
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
      });

      // HALF-DUPLEX: Wait for audio to actually play on caller's phone
      // Cartesia "done" means audio SENT, not audio HEARD by caller
      // Playback started when FIRST chunk was sent, not when streaming completed
      // So remaining playback = audioMs - streamingDurationMs
      const playbackBuffer = 300; // Extra buffer for Twilio latency
      const remainingPlaybackMs = Math.max(0, ttsResult.audioMs - ttsResult.streamingDurationMs);
      const playbackWaitMs = remainingPlaybackMs + playbackBuffer;

      twilioLogger.debug('🔇 HALF-DUPLEX: Waiting for playback to complete', {
        callSid,
        audioMs: ttsResult.audioMs,
        streamingMs: ttsResult.streamingDurationMs,
        remainingMs: remainingPlaybackMs,
        bufferMs: playbackBuffer,
        totalWaitMs: playbackWaitMs,
      });

      await new Promise(resolve => setTimeout(resolve, playbackWaitMs));

    } catch (error) {
      twilioLogger.error('Error in sendAIResponse', error);
      throw error;
    } finally {
      // HALF-DUPLEX: Resume listening after playback completes (or fails)
      isSpeaking = false;
      twilioLogger.debug('🔊 HALF-DUPLEX: Resuming user audio (playback complete)', { callSid });
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
        // Include userConfig for webhook to use
        userConfig,
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
        // ALWAYS forward audio to Deepgram to keep connection alive
        // The onTranscript guard will discard any speech detected while AI is speaking
        // (Blocking audio here causes Deepgram to timeout and close)
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
