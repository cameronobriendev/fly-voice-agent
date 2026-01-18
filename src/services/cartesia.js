/**
 * Cartesia text-to-speech service using DIRECT WebSocket (bypassing SDK)
 *
 * The @cartesia/cartesia-js SDK v2.2.9 has issues with WebSocket connections
 * hanging at send(). This implementation uses raw WebSocket ('ws' package)
 * to connect directly to Cartesia's WebSocket API.
 *
 * TESTED AND WORKING on Fly.io (Nov 19, 2025)
 */

import WebSocket from 'ws';
import { logger } from '../utils/logger.js';

const cartesiaLogger = logger.child('CARTESIA');

/**
 * Normalize text for better TTS pronunciation
 * Fixes domain extensions, abbreviations, etc.
 */
function normalizeTextForTTS(text) {
  return text
    // Domain extensions - spell out for clarity
    .replace(/\.ca\b/gi, ' dot C A')
    .replace(/\.com\b/gi, ' dot com')
    .replace(/\.org\b/gi, ' dot org')
    .replace(/\.net\b/gi, ' dot net');
}

export class CartesiaService {
  constructor() {
    if (!process.env.CARTESIA_API_KEY) {
      throw new Error('CARTESIA_API_KEY environment variable is required');
    }

    this.apiKey = process.env.CARTESIA_API_KEY;
    this.defaultVoiceId = 'a167e0f3-df7e-4d52-a9c3-f949145efdab'; // Custom voice
    this.currentVoiceId = null;
    this.websocket = null;
    this.lastActivity = Date.now();
    this.contextCounter = 0;

    // TTS request queue to prevent concurrent requests hitting rate limits
    this.ttsQueue = [];
    this.isProcessingQueue = false;

    cartesiaLogger.info('Cartesia service initialized (Direct WebSocket)');
  }

  /**
   * Add TTS request to queue and process sequentially
   * Prevents Cartesia concurrency limit errors
   * @param {string} text - Text to synthesize
   * @param {Function} onAudioChunk - Callback for each audio chunk
   * @returns {Promise<{totalBytes: number, audioSeconds: number, audioMs: number}>} Audio duration info
   */
  async queueSpeakText(text, onAudioChunk) {
    return new Promise((resolve, reject) => {
      // Add to queue
      this.ttsQueue.push({
        text,
        onAudioChunk,
        resolve,
        reject,
      });

      cartesiaLogger.debug('TTS request queued', {
        queueLength: this.ttsQueue.length,
        textLength: text.length,
      });

      // Start processing if not already running
      this.processQueue();
    });
  }

  /**
   * Process TTS queue sequentially
   */
  async processQueue() {
    // If already processing, let the current processor handle the queue
    if (this.isProcessingQueue) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.ttsQueue.length > 0) {
      const request = this.ttsQueue.shift();

      cartesiaLogger.debug('Processing TTS request from queue', {
        remainingInQueue: this.ttsQueue.length,
        textLength: request.text.length,
      });

      try {
        const result = await this.speakTextWithRetry(request.text, request.onAudioChunk);
        request.resolve(result);  // Pass through audio duration info
      } catch (error) {
        request.reject(error);
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Initialize WebSocket connection to Cartesia
   * @param {string} voiceId - Voice ID to use (null = default)
   * @returns {Promise<WebSocket>} WebSocket instance
   */
  async connect(voiceId) {
    return new Promise((resolve, reject) => {
      this.currentVoiceId = voiceId || this.defaultVoiceId;

      // Build WebSocket URL with API key
      const wsUrl = `wss://api.cartesia.ai/tts/websocket?api_key=${this.apiKey}&cartesia_version=2025-04-16`;

      cartesiaLogger.debug('Connecting to Cartesia WebSocket...');

      this.websocket = new WebSocket(wsUrl);

      // Timeout if connection takes too long
      const timeout = setTimeout(() => {
        cartesiaLogger.error('WebSocket connection timeout');
        this.websocket.close();
        reject(new Error('WebSocket connection timeout'));
      }, 5000);

      this.websocket.on('open', () => {
        clearTimeout(timeout);
        this.lastActivity = Date.now();

        cartesiaLogger.info('Cartesia WebSocket connected', {
          voiceId: this.currentVoiceId,
          encoding: 'pcm_mulaw',
          sampleRate: 8000,
        });

        resolve(this.websocket);
      });

      this.websocket.on('error', (error) => {
        clearTimeout(timeout);
        cartesiaLogger.error('WebSocket error during connection', error);
        reject(error);
      });

      this.websocket.on('close', (code, reason) => {
        clearTimeout(timeout);
        if (!this.websocket || this.websocket.readyState === WebSocket.OPEN) {
          // Already handled
          return;
        }
        cartesiaLogger.error('WebSocket closed before connection', {
          code,
          reason: reason.toString(),
        });
        reject(new Error(`WebSocket closed: ${code} ${reason}`));
      });
    });
  }

  /**
   * Generate speech via WebSocket streaming
   * @param {string} text - Text to convert to speech
   * @param {Function} onAudioChunk - Callback for each audio chunk (receives Buffer)
   * @returns {Promise<{totalBytes: number, audioSeconds: number, audioMs: number}>} Audio duration info
   */
  async speakText(text, onAudioChunk) {
    return new Promise((resolve, reject) => {
      if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected - call connect() first'));
        return;
      }

      const startTime = Date.now();
      let chunkCount = 0;
      let totalBytes = 0;
      let firstChunkTime = null;

      // Generate unique context ID
      this.contextCounter++;
      const contextId = `tts-${Date.now()}-${this.contextCounter}`;

      // Normalize text for better pronunciation
      const normalizedText = normalizeTextForTTS(text);

      cartesiaLogger.debug('🔊 Sending TTS request', {
        contextId,
        textLength: normalizedText.length,
        text: normalizedText.substring(0, 100) + (normalizedText.length > 100 ? '...' : ''),
      });

      // Build request (WebSocket API uses snake_case!)
      const request = {
        context_id: contextId,
        model_id: 'sonic-3',
        voice: {
          mode: 'id',
          id: this.currentVoiceId,
        },
        transcript: normalizedText,
        language: 'en',
        output_format: {
          container: 'raw',
          encoding: 'pcm_mulaw',
          sample_rate: 8000,
        },
      };

      // Timeout warning if no chunks after 2 seconds
      const warningTimeout = setTimeout(() => {
        if (chunkCount === 0) {
          cartesiaLogger.warn('⚠️ NO AUDIO CHUNKS RECEIVED AFTER 2 SECONDS', {
            contextId,
            textLength: text.length,
            elapsedTime: '2000ms',
          });
        }
      }, 2000);

      // Hard timeout if no completion after 10 seconds
      const hardTimeout = setTimeout(() => {
        if (chunkCount === 0) {
          cartesiaLogger.error('❌ TIMEOUT: No chunks after 10 seconds', {
            contextId,
          });
          cleanup();
          reject(new Error(
            `TTS timeout: No audio chunks received after 10000ms. ` +
            `Text: "${text.substring(0, 50)}..."`
          ));
        }
      }, 10000);

      // Message handler
      const onMessage = (data) => {
        try {
          const message = JSON.parse(data.toString());

          if (message.type === 'chunk') {
            if (chunkCount === 0) {
              clearTimeout(warningTimeout);
              firstChunkTime = Date.now();
              const ttfb = firstChunkTime - startTime;

              cartesiaLogger.info('🎵 TTS FIRST CHUNK (TTFB)', {
                contextId,
                ttfb: `${ttfb}ms`,
                textLength: text.length,
              });
            }

            chunkCount++;
            this.lastChunkTime = Date.now(); // Track for playback timing

            // Decode Base64 audio data
            const audioBuffer = Buffer.from(message.data, 'base64');
            totalBytes += audioBuffer.length;

            // Send Buffer to callback
            onAudioChunk(audioBuffer);

            cartesiaLogger.debug('📡 AUDIO CHUNK', {
              contextId,
              chunkNumber: chunkCount,
              chunkSize: audioBuffer.length,
              totalBytes,
            });

          } else if (message.type === 'done') {
            clearTimeout(warningTimeout);
            clearTimeout(hardTimeout);
            const endTime = Date.now();
            const totalLatency = endTime - startTime;
            const ttfb = firstChunkTime ? firstChunkTime - startTime : null;

            cartesiaLogger.info('✅ TTS STREAMING COMPLETE', {
              contextId,
              textLength: text.length,
              chunks: chunkCount,
              totalBytes,
              audioSeconds: (totalBytes / 8000).toFixed(1),
              ttfb: ttfb ? `${ttfb}ms` : 'N/A',
              totalLatency: `${totalLatency}ms`,
              msPerChar: (totalLatency / text.length).toFixed(1),
            });

            this.lastActivity = Date.now();
            cleanup();

            // Return audio duration info for half-duplex playback timing
            const audioSeconds = totalBytes / 8000;
            const streamingDurationMs = firstChunkTime ? (endTime - firstChunkTime) : 0;
            resolve({
              totalBytes,
              audioSeconds,
              audioMs: Math.ceil(audioSeconds * 1000),
              streamingDurationMs, // Time from first chunk to last chunk
            });

          } else if (message.type === 'error') {
            clearTimeout(warningTimeout);
            clearTimeout(hardTimeout);

            cartesiaLogger.error('❌ Cartesia error message', {
              contextId,
              error: message.error,
              statusCode: message.status_code,
            });
            cleanup();
            reject(new Error(`Cartesia error: ${message.error}`));
          }
        } catch (parseError) {
          cartesiaLogger.error('Failed to parse WebSocket message', parseError);
        }
      };

      // Error handler
      const onError = (error) => {
        clearTimeout(warningTimeout);
        clearTimeout(hardTimeout);
        cartesiaLogger.error('❌ WebSocket error during TTS', error);
        cleanup();
        reject(error);
      };

      // Cleanup handlers
      const cleanup = () => {
        this.websocket.removeListener('message', onMessage);
        this.websocket.removeListener('error', onError);
      };

      // Attach handlers
      this.websocket.on('message', onMessage);
      this.websocket.on('error', onError);

      // Send request
      this.websocket.send(JSON.stringify(request));

      this.lastActivity = Date.now();
    });
  }

  /**
   * Speak text with automatic retry on failure
   * If TTS times out, reconnects WebSocket and tries once more
   * @param {string} text - Text to synthesize
   * @param {Function} onAudioChunk - Callback for each audio chunk
   * @param {number} maxRetries - Maximum number of retry attempts (default 1)
   * @param {number} timeoutMs - Timeout in milliseconds (default 10000 = 10 seconds)
   * @returns {Promise<{totalBytes: number, audioSeconds: number, audioMs: number}>} Audio duration info
   */
  async speakTextWithRetry(text, onAudioChunk, maxRetries = 1, timeoutMs = 10000) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        cartesiaLogger.debug('TTS attempt', {
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1,
          textLength: text.length,
        });

        return await this.speakText(text, onAudioChunk);

      } catch (error) {
        const isTimeout = error.message.includes('TTS timeout');
        const shouldRetry = attempt < maxRetries && isTimeout;

        if (shouldRetry) {
          cartesiaLogger.warn('🔄 TTS TIMEOUT - RECONNECTING AND RETRYING', {
            attempt: attempt + 1,
            maxRetries,
            error: error.message,
            textPreview: text.substring(0, 50) + '...',
          });

          try {
            // Reconnect WebSocket
            await this.disconnect();
            await new Promise(resolve => setTimeout(resolve, 100)); // Brief pause
            await this.connect(this.currentVoiceId);

            cartesiaLogger.info('✅ Cartesia reconnected successfully, retrying TTS', {
              attempt: attempt + 2,
            });

            continue; // Try again
          } catch (reconnectError) {
            cartesiaLogger.error('❌ Failed to reconnect Cartesia', reconnectError);
            throw reconnectError; // Give up if reconnection fails
          }
        }

        // No more retries or non-timeout error
        cartesiaLogger.error('❌ TTS FAILED - NO MORE RETRIES', {
          attempt: attempt + 1,
          error: error.message,
          isTimeout,
        });
        throw error;
      }
    }
  }

  /**
   * Check if connection needs refresh due to idle timeout
   * Cartesia closes WebSocket after 5 minutes of inactivity
   * @returns {boolean} True if should reconnect before next use
   */
  needsRefresh() {
    const IDLE_THRESHOLD = 270000; // 4.5 minutes (before 5-min timeout)
    const idleTime = Date.now() - this.lastActivity;
    return idleTime > IDLE_THRESHOLD;
  }

  /**
   * Close the WebSocket connection
   */
  async disconnect() {
    try {
      if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
        this.websocket.close();
      }
      this.websocket = null;

      cartesiaLogger.info('Cartesia WebSocket disconnected');
    } catch (error) {
      cartesiaLogger.error('Error disconnecting from Cartesia', error);
    }
  }
}

export default CartesiaService;
