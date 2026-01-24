/**
 * Call Recorder Service
 * Captures audio from WebSocket stream and creates recordings
 *
 * Audio format from Twilio: mulaw 8kHz mono
 * Output: WAV file uploaded to dashboard
 */

import { logger } from '../utils/logger.js';

const recorderLogger = logger.child('RECORDER');

/**
 * Create a new call recorder instance
 * @param {string} callSid - Twilio Call SID
 * @returns {Object} Recorder instance with methods
 */
export function createCallRecorder(callSid) {
  const callerChunks = []; // Incoming audio from caller
  const aiChunks = []; // Outgoing audio from AI
  let recordingEnabled = true;

  return {
    /**
     * Add incoming audio chunk (caller speaking)
     * @param {Buffer} chunk - mulaw audio buffer
     */
    addCallerAudio(chunk) {
      if (recordingEnabled && chunk && chunk.length > 0) {
        callerChunks.push(chunk);
      }
    },

    /**
     * Add outgoing audio chunk (AI speaking)
     * @param {Buffer} chunk - mulaw audio buffer
     */
    addAiAudio(chunk) {
      if (recordingEnabled && chunk && chunk.length > 0) {
        aiChunks.push(chunk);
      }
    },

    /**
     * Get recording stats
     */
    getStats() {
      return {
        callerChunks: callerChunks.length,
        aiChunks: aiChunks.length,
        callerBytes: callerChunks.reduce((sum, c) => sum + c.length, 0),
        aiBytes: aiChunks.reduce((sum, c) => sum + c.length, 0),
      };
    },

    /**
     * Disable recording (e.g., if storage fails)
     */
    disable() {
      recordingEnabled = false;
    },

    /**
     * Finalize and get recording as WAV buffer
     * Combines caller and AI audio into stereo WAV
     * @returns {Buffer|null} WAV file buffer or null if no audio
     */
    finalize() {
      const stats = this.getStats();

      if (stats.callerBytes === 0 && stats.aiBytes === 0) {
        recorderLogger.info('No audio recorded', { callSid });
        return null;
      }

      recorderLogger.info('Finalizing recording', {
        callSid,
        ...stats,
      });

      try {
        // Combine chunks into single buffers
        const callerAudio = Buffer.concat(callerChunks);
        const aiAudio = Buffer.concat(aiChunks);

        // Create WAV file with mulaw audio
        // For simplicity, we'll create a mono WAV with just caller audio
        // (AI audio is already in the transcript, caller audio is what we need for review)
        const wavBuffer = createMulawWav(callerAudio, 8000);

        recorderLogger.info('Recording finalized', {
          callSid,
          wavSize: wavBuffer.length,
          durationSeconds: Math.round(callerAudio.length / 8000),
        });

        return wavBuffer;

      } catch (error) {
        recorderLogger.error('Error finalizing recording', error, { callSid });
        return null;
      }
    },

    /**
     * Clear all recorded data
     */
    clear() {
      callerChunks.length = 0;
      aiChunks.length = 0;
    },
  };
}

/**
 * Create WAV file from mulaw audio data
 * @param {Buffer} mulawData - Raw mulaw audio
 * @param {number} sampleRate - Sample rate (8000 for Twilio)
 * @returns {Buffer} WAV file buffer
 */
function createMulawWav(mulawData, sampleRate = 8000) {
  const numChannels = 1;
  const bitsPerSample = 8; // mulaw is 8-bit
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = mulawData.length;
  const fileSize = 44 + dataSize; // WAV header is 44 bytes

  const buffer = Buffer.alloc(fileSize);
  let offset = 0;

  // RIFF header
  buffer.write('RIFF', offset); offset += 4;
  buffer.writeUInt32LE(fileSize - 8, offset); offset += 4;
  buffer.write('WAVE', offset); offset += 4;

  // fmt chunk
  buffer.write('fmt ', offset); offset += 4;
  buffer.writeUInt32LE(16, offset); offset += 4; // fmt chunk size
  buffer.writeUInt16LE(7, offset); offset += 2; // audio format: 7 = mulaw
  buffer.writeUInt16LE(numChannels, offset); offset += 2;
  buffer.writeUInt32LE(sampleRate, offset); offset += 4;
  buffer.writeUInt32LE(byteRate, offset); offset += 4;
  buffer.writeUInt16LE(blockAlign, offset); offset += 2;
  buffer.writeUInt16LE(bitsPerSample, offset); offset += 2;

  // data chunk
  buffer.write('data', offset); offset += 4;
  buffer.writeUInt32LE(dataSize, offset); offset += 4;

  // Copy audio data
  mulawData.copy(buffer, offset);

  return buffer;
}

/**
 * Upload recording to dashboard
 * @param {string} callId - Dashboard call ID (not Twilio SID)
 * @param {Buffer} wavBuffer - WAV file buffer
 * @param {string} dashboardUrl - Dashboard base URL
 * @returns {Promise<string|null>} Recording URL or null on failure
 */
export async function uploadRecording(callId, wavBuffer, dashboardUrl = 'https://info.buddyhelps.ca') {
  if (!callId || !wavBuffer) {
    recorderLogger.warn('Missing callId or wavBuffer for upload');
    return null;
  }

  try {
    recorderLogger.info('Uploading recording', {
      callId,
      size: wavBuffer.length,
      url: `${dashboardUrl}/api/recording/upload`,
    });

    const response = await fetch(`${dashboardUrl}/api/recording/upload`, {
      method: 'POST',
      headers: {
        'Content-Type': 'audio/wav',
        'X-Call-Id': callId,
      },
      body: wavBuffer,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Upload failed: ${response.status} - ${errorText}`);
    }

    const result = await response.json();

    recorderLogger.info('Recording uploaded', {
      callId,
      recordingUrl: result.url,
    });

    return result.url;

  } catch (error) {
    recorderLogger.error('Error uploading recording', error, { callId });
    return null;
  }
}

export default {
  createCallRecorder,
  uploadRecording,
};
