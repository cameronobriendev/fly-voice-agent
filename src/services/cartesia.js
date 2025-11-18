/**
 * Cartesia text-to-speech service
 * Uses Sonic English model for natural voice synthesis
 * Includes background office ambience mixing for realistic call quality
 */

import Cartesia from '@cartesia/cartesia-js';
import WebSocket from 'ws';
import { logger } from '../utils/logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cartesiaLogger = logger.child('CARTESIA');

// Load background ambience audio (mulaw 8kHz)
let backgroundAmbience = null;
let ambiencePosition = 0;

try {
  const ambiencePath = path.join(__dirname, '../../public/office-ambience.wav');
  const ambienceFile = fs.readFileSync(ambiencePath);
  // Skip WAV header (44 bytes) to get raw audio data
  backgroundAmbience = ambienceFile.slice(44);
  cartesiaLogger.info('Background office ambience loaded', {
    size: backgroundAmbience.length,
    durationSeconds: (backgroundAmbience.length / 8000).toFixed(1)
  });
} catch (error) {
  cartesiaLogger.warn('Failed to load background ambience - continuing without it', error);
}

/**
 * Mix background ambience with TTS audio
 * @param {Buffer} ttsAudio - TTS audio buffer (mulaw 8kHz)
 * @param {number} ambienceVolume - Ambience volume (0.0 to 1.0, default 0.08)
 * @returns {Buffer} Mixed audio buffer
 */
function mixWithAmbience(ttsAudio, ambienceVolume = 0.08) {
  if (!backgroundAmbience || backgroundAmbience.length === 0) {
    return ttsAudio; // Return unmixed if ambience not available
  }

  const mixed = Buffer.alloc(ttsAudio.length);

  for (let i = 0; i < ttsAudio.length; i++) {
    // Get ambience sample (loop if we reach the end)
    const ambienceIndex = (ambiencePosition + i) % backgroundAmbience.length;
    const ambienceSample = backgroundAmbience[ambienceIndex];

    // Convert mulaw to linear PCM (simplified - mulaw is already compressed)
    // For mulaw, we can just mix the values directly with volume scaling
    const ttsSample = ttsAudio[i];

    // Mix: TTS at full volume + ambience at low volume
    // mulaw is 0-255, so we scale ambience contribution
    const mixedValue = Math.min(255, Math.max(0,
      ttsSample + Math.floor(ambienceSample * ambienceVolume)
    ));

    mixed[i] = mixedValue;
  }

  // Update ambience position for next call (continuous background)
  ambiencePosition = (ambiencePosition + ttsAudio.length) % backgroundAmbience.length;

  return mixed;
}

export class CartesiaService {
  constructor() {
    if (!process.env.CARTESIA_API_KEY) {
      throw new Error('CARTESIA_API_KEY environment variable is required');
    }

    this.client = new Cartesia({
      apiKey: process.env.CARTESIA_API_KEY,
      WebSocket: WebSocket, // Provide WebSocket implementation for Node.js
    });

    // Default voice ID - you can customize this per user if needed
    this.defaultVoiceId = 'a0e99841-438c-4a64-b679-ae501e7d6091'; // Barbershop Man

    cartesiaLogger.info('Cartesia service initialized');
  }

  /**
   * Generate audio from text
   * @param {string} text - Text to convert to speech
   * @param {string} voiceId - Optional voice ID (defaults to Barbershop Man)
   * @returns {Promise<Buffer>} Audio buffer (mulaw, 8kHz)
   */
  async generateAudio(text, voiceId = null) {
    const startTime = Date.now();

    try {
      const requestParams = {
        model_id: 'sonic-3', // LATEST model (Oct 2025) - high naturalness, industry-leading latency
        transcript: text,
        voice: {
          mode: 'id',
          id: voiceId || this.defaultVoiceId,
        },
        output_format: {
          container: 'raw',
          encoding: 'pcm_mulaw',
          sample_rate: 8000,
        },
      };

      cartesiaLogger.debug('Generating audio - REQUEST DETAILS', {
        textLength: text.length,
        text: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
        requestParams: JSON.stringify(requestParams, null, 2),
      });

      const apiStartTime = Date.now();
      const response = await this.client.tts.bytes(requestParams);
      const apiEndTime = Date.now();

      // LOG CARTESIA RESPONSE STRUCTURE (verbose debugging)
      cartesiaLogger.debug('Cartesia API response structure', {
        responseType: typeof response,
        isBuffer: Buffer.isBuffer(response),
        hasAudioProp: response?.audio !== undefined,
        hasDataProp: response?.data !== undefined,
        responseKeys: response && typeof response === 'object' ? Object.keys(response) : [],
        responseConstructor: response?.constructor?.name,
      });

      // Extract audio buffer from response (handle multiple API response formats)
      const extractStartTime = Date.now();
      let audioBuffer;
      let responseFormat = 'unknown';

      if (Buffer.isBuffer(response)) {
        // Format 1: Response is already a Buffer (older SDK version)
        audioBuffer = response;
        responseFormat = 'direct-buffer';
      } else if (response && Buffer.isBuffer(response.audio)) {
        // Format 2: Response has .audio property
        audioBuffer = response.audio;
        responseFormat = 'response.audio';
      } else if (response && Buffer.isBuffer(response.data)) {
        // Format 3: Response has .data property
        audioBuffer = response.data;
        responseFormat = 'response.data';
      } else if (response) {
        // Format 4: Try to convert to Buffer (ArrayBuffer, Uint8Array, etc.)
        audioBuffer = Buffer.from(response);
        responseFormat = 'buffer-conversion';
      } else {
        throw new Error('Cartesia response is empty or invalid format');
      }
      const extractEndTime = Date.now();

      cartesiaLogger.debug('Audio buffer extracted', {
        responseFormat,
        bufferLength: audioBuffer.length,
        extractionTime: `${extractEndTime - extractStartTime}ms`,
      });

      const totalTime = Date.now() - startTime;
      const apiLatency = apiEndTime - apiStartTime;
      const msPerChar = totalTime / text.length;

      // sonic-3 expected TTFB: 40-90ms, total should be <500ms for short text
      const expectedMaxLatency = 500;
      const isSlow = apiLatency > expectedMaxLatency;

      cartesiaLogger.info('Audio generated - detailed timing', {
        textLength: text.length,
        bufferSize: audioBuffer.length,
        apiLatency: `${apiLatency}ms`,
        extractionLatency: `${extractEndTime - extractStartTime}ms`,
        totalLatency: `${totalTime}ms`,
        msPerCharacter: msPerChar.toFixed(1),
        expectedMaxLatency: `${expectedMaxLatency}ms`,
        isSlow: isSlow,
        slowBy: isSlow ? `${apiLatency - expectedMaxLatency}ms` : '0ms',
        audioFormat: 'mulaw 8kHz',
        audioSeconds: (audioBuffer.length / 8000).toFixed(1),
      });

      // Return pure TTS audio (background ambience disabled due to quality issues)
      return audioBuffer;
    } catch (error) {
      cartesiaLogger.error('Error generating audio', error, {
        text: text.substring(0, 50) + '...',
      });
      throw error;
    }
  }

  /**
   * Generate high-quality audio for web previews
   * @param {string} text - Text to convert to speech
   * @param {string} voiceId - Optional voice ID (defaults to Barbershop Man)
   * @returns {Promise<Buffer>} Audio buffer (pcm_s16le, 44.1kHz)
   */
  async generatePreviewAudio(text, voiceId = null) {
    try {
      cartesiaLogger.debug('Generating high-quality preview audio', {
        textLength: text.length,
        voiceId: voiceId || this.defaultVoiceId,
      });

      const response = await this.client.tts.bytes({
        model_id: 'sonic-3', // LATEST model (Oct 2025) - high naturalness, industry-leading latency
        transcript: text,
        voice: {
          mode: 'id',
          id: voiceId || this.defaultVoiceId,
        },
        output_format: {
          container: 'raw',
          encoding: 'pcm_s16le',  // 16-bit signed PCM (uncompressed)
          sample_rate: 44100,      // CD quality (44.1kHz)
        },
      });

      // Extract audio buffer from response (handle multiple API response formats)
      let audioBuffer;
      if (Buffer.isBuffer(response)) {
        audioBuffer = response;
      } else if (response && Buffer.isBuffer(response.audio)) {
        audioBuffer = response.audio;
      } else if (response && Buffer.isBuffer(response.data)) {
        audioBuffer = response.data;
      } else if (response) {
        audioBuffer = Buffer.from(response);
      } else {
        throw new Error('Cartesia response is empty or invalid format');
      }

      cartesiaLogger.debug('High-quality preview audio generated successfully', {
        textLength: text.length,
        sampleRate: 44100,
        encoding: 'pcm_s16le',
        bufferSize: audioBuffer.length,
      });

      return audioBuffer;
    } catch (error) {
      cartesiaLogger.error('Error generating preview audio', error, {
        text: text.substring(0, 50) + '...',
      });
      throw error;
    }
  }

  /**
   * Connect to Cartesia WebSocket (call once per session)
   * @param {string} voiceId - Voice ID to use (null = default)
   * @returns {Promise<Object>} Connected Cartesia WebSocket
   */
  async connect(voiceId) {
    try {
      this.websocket = this.client.tts.websocket({
        model_id: 'sonic-3', // LATEST model (Oct 2025) - high naturalness, industry-leading latency
        voice: {
          mode: 'id',
          id: voiceId || this.defaultVoiceId,
        },
        output_format: {
          container: 'raw',
          encoding: 'pcm_mulaw',
          sample_rate: 8000,
        },
      });

      // Provide WebSocket implementation to connect() for partysocket (Node.js requirement)
      await this.websocket.connect({ WebSocket: WebSocket });

      cartesiaLogger.info('Cartesia WebSocket connected', {
        voiceId: voiceId || this.defaultVoiceId,
        model: 'sonic-3',
        encoding: 'pcm_mulaw',
        sampleRate: 8000,
      });

      return this.websocket;
    } catch (error) {
      cartesiaLogger.error('Failed to connect to Cartesia', error);
      throw error;
    }
  }

  /**
   * Speak text via TTS (creates a new stream for this utterance)
   * @param {string} text - Text to synthesize
   * @param {Function} onAudioChunk - Callback for each audio chunk
   * @returns {Promise<void>} Resolves when audio is complete
   */
  async speakText(text, onAudioChunk) {
    return new Promise((resolve, reject) => {
      try {
        const startTime = Date.now();

        cartesiaLogger.debug('🔊 Sending text to Cartesia WebSocket', {
          textLength: text.length,
          text: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
          websocketState: this.websocket ? 'exists' : 'null',
        });

        // Send text and get back a stream object for THIS utterance
        const stream = this.websocket.send({
          transcript: text,
        });

        cartesiaLogger.debug('📡 Stream object created', {
          streamType: typeof stream,
          hasOn: typeof stream.on === 'function',
        });

        let chunkCount = 0;
        let totalBytes = 0;
        let firstChunkTime = null;

        // Timeout warning if no chunks received after 2 seconds
        const noChunksTimeout = setTimeout(() => {
          if (chunkCount === 0) {
            cartesiaLogger.warn('⚠️ NO AUDIO CHUNKS RECEIVED AFTER 2 SECONDS', {
              textLength: text.length,
              elapsedTime: `${Date.now() - startTime}ms`,
              possibleCause: 'WebSocket not ready or connection issue',
            });
          }
        }, 2000);

        // Handle audio chunks from this stream
        stream.on('message', (message) => {
          if (message.type === 'chunk') {
            if (chunkCount === 0) {
              clearTimeout(noChunksTimeout); // Clear warning timeout
              firstChunkTime = Date.now();
              const ttfb = firstChunkTime - startTime;
              cartesiaLogger.info('🎵 TTS FIRST CHUNK (TTFB)', {
                ttfb: `${ttfb}ms`,
                textLength: text.length,
              });
            }

            chunkCount++;
            totalBytes += message.data.length;

            // Send audio chunk to caller (e.g., Twilio)
            onAudioChunk(message.data);

            cartesiaLogger.debug('📡 AUDIO CHUNK', {
              chunkNumber: chunkCount,
              chunkSize: message.data.length,
              totalBytes,
            });
          } else if (message.type === 'done') {
            clearTimeout(noChunksTimeout); // Clear warning timeout
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

            resolve();
          }
        });

        // Handle errors
        stream.on('error', (error) => {
          clearTimeout(noChunksTimeout); // Clear warning timeout
          cartesiaLogger.error('❌ Cartesia stream error', error);
          reject(error);
        });
      } catch (error) {
        cartesiaLogger.error('Error speaking text', error);
        reject(error);
      }
    });
  }

  /**
   * Speak text with timeout protection (fail fast if TTS hangs)
   * @param {string} text - Text to synthesize
   * @param {Function} onAudioChunk - Callback for each audio chunk
   * @param {number} timeoutMs - Timeout in milliseconds (default 10000 = 10 seconds)
   * @returns {Promise<void>} Resolves when audio is complete or rejects on timeout
   */
  async speakTextWithTimeout(text, onAudioChunk, timeoutMs = 10000) {
    return Promise.race([
      this.speakText(text, onAudioChunk),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`TTS timeout: No audio received after ${timeoutMs}ms. Text: "${text.substring(0, 50)}...". Possible cause: WebSocket not ready or connection issue.`));
        }, timeoutMs);
      })
    ]);
  }

  /**
   * Close the WebSocket connection
   */
  async disconnect() {
    try {
      if (this.websocket) {
        await this.websocket.disconnect();
        cartesiaLogger.info('Cartesia WebSocket disconnected');
      }
    } catch (error) {
      cartesiaLogger.error('Error disconnecting from Cartesia', error);
    }
  }
}

export default CartesiaService;
