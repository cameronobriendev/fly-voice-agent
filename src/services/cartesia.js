/**
 * Cartesia text-to-speech service (SDK v2.x)
 * Uses Sonic English model for natural voice synthesis
 * WebSocket streaming with proper v2.x event handling
 */

import { CartesiaClient } from '@cartesia/cartesia-js';
import { logger } from '../utils/logger.js';

const cartesiaLogger = logger.child('CARTESIA');

export class CartesiaService {
  constructor() {
    if (!process.env.CARTESIA_API_KEY) {
      throw new Error('CARTESIA_API_KEY environment variable is required');
    }

    this.client = new CartesiaClient({
      apiKey: process.env.CARTESIA_API_KEY,
    });

    // Default voice ID
    this.defaultVoiceId = 'a0e99841-438c-4a64-b679-ae501e7d6091'; // Barbershop Man

    // Track current voice ID for reconnection
    this.currentVoiceId = null;

    // WebSocket instance
    this.websocket = null;

    // Track last activity for idle timeout management
    this.lastActivity = Date.now();

    cartesiaLogger.info('Cartesia service initialized (SDK v2.2.9)');
  }

  /**
   * Initialize WebSocket connection (v2.x pattern)
   * Connection is lazy - actual connection happens on first send()
   * @param {string} voiceId - Voice ID to use (null = default)
   * @returns {Promise<Object>} WebSocket instance
   */
  async connect(voiceId) {
    try {
      // Track voice ID for potential reconnection
      this.currentVoiceId = voiceId || this.defaultVoiceId;

      // v2.x: Create WebSocket with simplified config structure
      // Note: container, encoding, sampleRate are top-level params now (not output_format)
      this.websocket = this.client.tts.websocket({
        container: 'raw',
        encoding: 'pcm_mulaw',
        sampleRate: 8000,
        // WebSocket param not needed in v2.x - SDK auto-detects Node.js environment
      });

      this.lastActivity = Date.now();

      cartesiaLogger.info('Cartesia WebSocket created (v2.x)', {
        voiceId: this.currentVoiceId,
        model: 'sonic-3',
        encoding: 'pcm_mulaw',
        sampleRate: 8000,
      });

      return this.websocket;
    } catch (error) {
      cartesiaLogger.error('Failed to create Cartesia WebSocket', error);
      throw error;
    }
  }

  /**
   * Generate speech via WebSocket streaming (v2.x pattern)
   * CRITICAL: Events emit from RESPONSE object, not websocket object
   * @param {string} text - Text to convert to speech
   * @param {Function} onAudioChunk - Callback for each audio chunk (receives Buffer)
   * @returns {Promise<void>} Resolves when complete
   */
  async speakText(text, onAudioChunk) {
    return new Promise(async (resolve, reject) => {
      try {
        if (!this.websocket) {
          throw new Error('WebSocket not initialized - call connect() first');
        }

        const startTime = Date.now();
        let chunkCount = 0;
        let totalBytes = 0;
        let firstChunkTime = null;

        cartesiaLogger.debug('🔊 Sending TTS request (v2.x)', {
          textLength: text.length,
          text: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
        });

        // v2.x: send() returns RESPONSE object with working event emitter
        // CRITICAL: Use camelCase params (modelId not model_id)
        const response = await this.websocket.send({
          modelId: 'sonic-3',           // camelCase!
          voice: {
            mode: 'id',
            id: this.currentVoiceId,
          },
          transcript: text,
          language: 'en',                // Required in v2.x
        });

        cartesiaLogger.debug('📡 Response object received', {
          hasOn: typeof response.on === 'function',
          hasEvents: typeof response.events === 'function',
        });

        // Timeout warning if no chunks after 2 seconds
        const warningTimeout = setTimeout(() => {
          if (chunkCount === 0) {
            cartesiaLogger.warn('⚠️ NO AUDIO CHUNKS RECEIVED AFTER 2 SECONDS', {
              textLength: text.length,
              elapsedTime: '2000ms',
            });
          }
        }, 2000);

        // Hard timeout if no completion after 10 seconds
        const hardTimeout = setTimeout(() => {
          if (chunkCount === 0) {
            cartesiaLogger.error('❌ TIMEOUT: No chunks after 10 seconds');
            reject(new Error(
              `TTS timeout: No audio chunks received after 10000ms. ` +
              `Text: "${text.substring(0, 50)}..."`
            ));
          }
        }, 10000);

        // v2.x: Listen on RESPONSE object, not websocket
        // This is the critical difference from v1.x!
        response.on('message', (message) => {
          if (message.type === 'chunk') {
            if (chunkCount === 0) {
              clearTimeout(warningTimeout);
              firstChunkTime = Date.now();
              const ttfb = firstChunkTime - startTime;

              cartesiaLogger.info('🎵 TTS FIRST CHUNK (TTFB)', {
                ttfb: `${ttfb}ms`,
                textLength: text.length,
              });
            }

            chunkCount++;

            // v2.x: message.data is Base64 string
            const audioBuffer = Buffer.from(message.data, 'base64');
            totalBytes += audioBuffer.length;

            // Send Buffer to callback
            onAudioChunk(audioBuffer);

            cartesiaLogger.debug('📡 AUDIO CHUNK', {
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
              textLength: text.length,
              chunks: chunkCount,
              totalBytes,
              audioSeconds: (totalBytes / 8000).toFixed(1),
              ttfb: ttfb ? `${ttfb}ms` : 'N/A',
              totalLatency: `${totalLatency}ms`,
              msPerChar: (totalLatency / text.length).toFixed(1),
            });

            this.lastActivity = Date.now();
            resolve();

          } else if (message.type === 'error') {
            clearTimeout(warningTimeout);
            clearTimeout(hardTimeout);

            cartesiaLogger.error('❌ Cartesia error message', {
              error: message.error,
            });
            reject(new Error(`Cartesia error: ${message.error}`));
          }
        });

        // Also handle errors on response object
        response.on('error', (error) => {
          clearTimeout(warningTimeout);
          clearTimeout(hardTimeout);
          cartesiaLogger.error('❌ Response object error', error);
          reject(error);
        });

        this.lastActivity = Date.now();

      } catch (error) {
        cartesiaLogger.error('Error in speakText', error);
        reject(error);
      }
    });
  }

  /**
   * Speak text with timeout protection
   * @param {string} text - Text to synthesize
   * @param {Function} onAudioChunk - Callback for each audio chunk
   * @param {number} timeoutMs - Timeout in milliseconds (default 10000 = 10 seconds)
   * @returns {Promise<void>} Resolves when complete or rejects on timeout
   */
  async speakTextWithTimeout(text, onAudioChunk, timeoutMs = 10000) {
    return Promise.race([
      this.speakText(text, onAudioChunk),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(
            `TTS timeout: No completion after ${timeoutMs}ms. ` +
            `Text: "${text.substring(0, 50)}..."`
          ));
        }, timeoutMs);
      }),
    ]);
  }

  /**
   * Speak text with automatic retry on failure
   * If TTS times out, reconnects WebSocket and tries once more
   * @param {string} text - Text to synthesize
   * @param {Function} onAudioChunk - Callback for each audio chunk
   * @param {number} maxRetries - Maximum number of retry attempts (default 1)
   * @param {number} timeoutMs - Timeout in milliseconds (default 10000 = 10 seconds)
   * @returns {Promise<void>} Resolves when complete or rejects after all retries fail
   */
  async speakTextWithRetry(text, onAudioChunk, maxRetries = 1, timeoutMs = 10000) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        cartesiaLogger.debug('TTS attempt', {
          attempt: attempt + 1,
          maxAttempts: maxRetries + 1,
          textLength: text.length,
        });

        return await this.speakTextWithTimeout(text, onAudioChunk, timeoutMs);

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
      // v2.x SDK handles cleanup automatically
      // Just null out our reference
      this.websocket = null;

      cartesiaLogger.info('Cartesia WebSocket disconnected');
    } catch (error) {
      cartesiaLogger.error('Error disconnecting from Cartesia', error);
    }
  }
}

export default CartesiaService;
