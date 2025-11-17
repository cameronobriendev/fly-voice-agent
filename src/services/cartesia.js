/**
 * Cartesia text-to-speech service
 * Uses Sonic English model for natural voice synthesis
 * Includes background office ambience mixing for realistic call quality
 */

import Cartesia from '@cartesia/cartesia-js';
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
    try {
      cartesiaLogger.debug('Generating audio', {
        textLength: text.length,
        voiceId: voiceId || this.defaultVoiceId,
      });

      const response = await this.client.tts.bytes({
        model_id: 'sonic-english',
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
      });

      // Extract audio buffer from response (handle multiple API response formats)
      let audioBuffer;
      if (Buffer.isBuffer(response)) {
        // Format 1: Response is already a Buffer (older SDK version)
        audioBuffer = response;
      } else if (response && Buffer.isBuffer(response.audio)) {
        // Format 2: Response has .audio property
        audioBuffer = response.audio;
      } else if (response && Buffer.isBuffer(response.data)) {
        // Format 3: Response has .data property
        audioBuffer = response.data;
      } else if (response) {
        // Format 4: Try to convert to Buffer (ArrayBuffer, Uint8Array, etc.)
        audioBuffer = Buffer.from(response);
      } else {
        throw new Error('Cartesia response is empty or invalid format');
      }

      cartesiaLogger.debug('Audio generated successfully', {
        textLength: text.length,
        bufferSize: audioBuffer.length,
      });

      // Mix with background office ambience
      const mixedAudio = mixWithAmbience(audioBuffer, 0.08);

      return mixedAudio;
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
        model_id: 'sonic-english',
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
   * Start a WebSocket stream for streaming TTS
   * @param {Function} onAudio - Callback for audio chunks
   * @param {Function} onError - Callback for errors
   * @returns {Promise<Object>} Cartesia WebSocket connection
   */
  async startStream(onAudio, onError) {
    try {
      const websocket = this.client.tts.websocket({
        model_id: 'sonic-english',
        voice: {
          mode: 'id',
          id: this.defaultVoiceId,
        },
        output_format: {
          container: 'raw',
          encoding: 'pcm_mulaw',
          sample_rate: 8000,
        },
      });

      await websocket.connect();

      websocket.on('message', (message) => {
        if (message.type === 'chunk') {
          onAudio(message.data);
        } else if (message.type === 'done') {
          cartesiaLogger.debug('TTS stream completed');
        }
      });

      websocket.on('error', (error) => {
        cartesiaLogger.error('Cartesia WebSocket error', error);
        onError(error);
      });

      cartesiaLogger.info('Cartesia WebSocket stream started');

      return websocket;
    } catch (error) {
      cartesiaLogger.error('Failed to start Cartesia stream', error);
      throw error;
    }
  }

  /**
   * Send text to streaming TTS
   * @param {Object} websocket - Cartesia WebSocket connection
   * @param {string} text - Text to synthesize
   */
  async sendText(websocket, text) {
    try {
      await websocket.send(text);
      cartesiaLogger.debug('Text sent to TTS stream', {
        textLength: text.length,
      });
    } catch (error) {
      cartesiaLogger.error('Error sending text to TTS stream', error);
    }
  }

  /**
   * Close the TTS stream
   * @param {Object} websocket - Cartesia WebSocket connection
   */
  async closeStream(websocket) {
    try {
      await websocket.disconnect();
      cartesiaLogger.info('Cartesia stream closed');
    } catch (error) {
      cartesiaLogger.error('Error closing Cartesia stream', error);
    }
  }
}

export default CartesiaService;
