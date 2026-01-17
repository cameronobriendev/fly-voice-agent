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
        model: 'nova-2-phonecall',  // Phone-optimized model for better 8kHz audio recognition
        language: 'en-US',
        smart_format: true,
        interim_results: true,   // REQUIRED for utterance_end_ms
        punctuate: true,
        encoding: 'mulaw',
        sample_rate: 8000,
        channels: 1,
        // Utterance boundary detection
        utterance_end_ms: 1000,  // 1 second of silence = end of utterance (fallback)
        endpointing: 400,        // 400ms VAD-based endpoint detection (balance speed vs interruptions)
        // Keyword boosting for plumbing terms (improves transcription accuracy)
        keywords: [
          'clogged:2',
          'clog:2',
          'leak:2',
          'leaking:2',
          'drain:2',
          'toilet:2',
          'faucet:2',
          'pipe:2',
          'pipes:2',
          'water heater:2',
          'sewer:2',
          'backup:2',
          'overflow:2',
          'plumber:2',
          'plumbing:2',
          'emergency:2',
          'burst:2',
          'broken:2',
          'running:1.5',
          'dripping:1.5',
          'flooding:2',
          'flooded:2',
          'garbage disposal:2',
          'sink:1.5',
          'shower:1.5',
          'bathtub:1.5',
          'sprinkler:1.5',
        ],
      });

      // Accumulate transcript segments until speech is complete
      let transcriptSegments = [];

      connection.on(LiveTranscriptionEvents.Open, () => {
        deepgramLogger.info('Deepgram connection opened');
      });

      connection.on(LiveTranscriptionEvents.Transcript, (data) => {
        const transcript = data.channel?.alternatives?.[0]?.transcript;
        const confidence = data.channel?.alternatives?.[0]?.confidence;
        const isFinal = data.is_final;
        const speechFinal = data.speech_final;

        // LOG DEEPGRAM TRANSCRIPT EVENT (VERBOSE)
        deepgramLogger.debug('🎤 DEEPGRAM TRANSCRIPT EVENT', {
          hasTranscript: !!transcript,
          transcriptLength: transcript?.length || 0,
          text: transcript || '(empty)',
          confidence: confidence?.toFixed(3) || 'N/A',
          isFinal,
          speechFinal,
          duration: data.duration,
          start: data.start,
          channelIndex: data.channel_index,
          alternatives: data.channel?.alternatives?.length || 0,
        });

        // Accumulate finalized transcript segments
        if (transcript && transcript.length > 0 && isFinal) {
          transcriptSegments.push(transcript);

          deepgramLogger.debug('📝 ACCUMULATED SEGMENT', {
            segment: transcript,
            totalSegments: transcriptSegments.length,
            speechFinal,
          });
        }

        // When speech is complete, join all segments and process
        if (speechFinal && transcriptSegments.length > 0) {
          const completeUtterance = transcriptSegments.join(' ');

          deepgramLogger.info('✅ STT COMPLETE UTTERANCE', {
            text: completeUtterance,
            segments: transcriptSegments.length,
            confidence: confidence?.toFixed(3) || 'N/A',
            confidencePercent: confidence ? `${(confidence * 100).toFixed(1)}%` : 'N/A',
            duration: `${data.duration}s`,
          });

          onTranscript(completeUtterance);
          transcriptSegments = [];  // Reset for next utterance
        }
      });

      // Fallback: UtteranceEnd event for noisy environments
      connection.on(LiveTranscriptionEvents.UtteranceEnd, (data) => {
        if (transcriptSegments.length > 0) {
          const completeUtterance = transcriptSegments.join(' ');

          deepgramLogger.info('✅ STT UTTERANCE END (fallback)', {
            text: completeUtterance,
            segments: transcriptSegments.length,
            lastWordEnd: data.last_word_end,
          });

          onTranscript(completeUtterance);
          transcriptSegments = [];
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
