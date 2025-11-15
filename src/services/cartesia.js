/**
 * Cartesia text-to-speech service
 * Uses Sonic English model for natural voice synthesis
 */

import Cartesia from '@cartesia/cartesia-js';
import { logger } from '../utils/logger.js';

const cartesiaLogger = logger.child('CARTESIA');

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

      cartesiaLogger.debug('Audio generated successfully', {
        textLength: text.length,
      });

      return response;
    } catch (error) {
      cartesiaLogger.error('Error generating audio', error, {
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
