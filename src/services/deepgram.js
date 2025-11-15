/**
 * Deepgram speech-to-text service
 * Uses Nova-3 model for streaming transcription
 */

import { createClient, LiveTranscriptionEvents } from '@deepgram/sdk';
import { logger } from '../utils/logger.js';

const deepgramLogger = logger.child('DEEPGRAM');

export class DeepgramService {
  constructor() {
    if (!process.env.DEEPGRAM_API_KEY) {
      throw new Error('DEEPGRAM_API_KEY environment variable is required');
    }

    this.client = createClient(process.env.DEEPGRAM_API_KEY);
    deepgramLogger.info('Deepgram service initialized');
  }

  /**
   * Start a live transcription stream
   * @param {Function} onTranscript - Callback for transcript results
   * @param {Function} onError - Callback for errors
   * @returns {Promise<Object>} Deepgram connection object
   */
  async startStream(onTranscript, onError) {
    try {
      const connection = this.client.listen.live({
        model: 'nova-2',
        language: 'en-US',
        smart_format: true,
        interim_results: false,
        punctuate: true,
        encoding: 'mulaw',
        sample_rate: 8000,
        channels: 1,
      });

      connection.on(LiveTranscriptionEvents.Open, () => {
        deepgramLogger.info('Deepgram connection opened');
      });

      connection.on(LiveTranscriptionEvents.Transcript, (data) => {
        const transcript = data.channel?.alternatives?.[0]?.transcript;

        if (transcript && transcript.length > 0) {
          deepgramLogger.debug('Transcript received', {
            text: transcript,
            confidence: data.channel?.alternatives?.[0]?.confidence,
          });
          onTranscript(transcript);
        }
      });

      connection.on(LiveTranscriptionEvents.Error, (error) => {
        deepgramLogger.error('Deepgram error', error);
        onError(error);
      });

      connection.on(LiveTranscriptionEvents.Close, () => {
        deepgramLogger.info('Deepgram connection closed');
      });

      return connection;
    } catch (error) {
      deepgramLogger.error('Failed to start Deepgram stream', error);
      throw error;
    }
  }

  /**
   * Send audio data to the stream
   * @param {Object} connection - Deepgram connection
   * @param {Buffer} audioData - Audio buffer (mulaw, 8kHz)
   */
  sendAudio(connection, audioData) {
    try {
      connection.send(audioData);
    } catch (error) {
      deepgramLogger.error('Error sending audio to Deepgram', error);
    }
  }

  /**
   * Close the transcription stream
   * @param {Object} connection - Deepgram connection
   */
  closeStream(connection) {
    try {
      connection.finish();
      deepgramLogger.info('Deepgram stream closed');
    } catch (error) {
      deepgramLogger.error('Error closing Deepgram stream', error);
    }
  }
}

export default DeepgramService;
