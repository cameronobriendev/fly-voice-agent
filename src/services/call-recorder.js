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
  const callerChunks = []; // Incoming audio from caller with timestamps
  const aiChunks = []; // Outgoing audio from AI with timestamps
  let recordingEnabled = true;
  let callStartTime = Date.now(); // Track when recording started

  return {
    /**
     * Add incoming audio chunk (caller speaking)
     * @param {Buffer} chunk - mulaw audio buffer
     */
    addCallerAudio(chunk) {
      if (recordingEnabled && chunk && chunk.length > 0) {
        callerChunks.push({
          data: chunk,
          timestamp: Date.now() - callStartTime, // ms since call start
        });
      }
    },

    /**
     * Add outgoing audio chunk (AI speaking)
     * @param {Buffer} chunk - mulaw audio buffer
     */
    addAiAudio(chunk) {
      if (recordingEnabled && chunk && chunk.length > 0) {
        aiChunks.push({
          data: chunk,
          timestamp: Date.now() - callStartTime, // ms since call start
        });
      }
    },

    /**
     * Get recording stats
     */
    getStats() {
      return {
        callerChunks: callerChunks.length,
        aiChunks: aiChunks.length,
        callerBytes: callerChunks.reduce((sum, c) => sum + c.data.length, 0),
        aiBytes: aiChunks.reduce((sum, c) => sum + c.data.length, 0),
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
     * Mixes caller and AI audio into a single mono WAV using timestamps
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
        // Find total duration based on last timestamp + audio length
        let maxDurationMs = 0;
        for (const chunk of callerChunks) {
          const endMs = chunk.timestamp + (chunk.data.length / 8); // 8 samples per ms at 8kHz
          if (endMs > maxDurationMs) maxDurationMs = endMs;
        }
        for (const chunk of aiChunks) {
          const endMs = chunk.timestamp + (chunk.data.length / 8);
          if (endMs > maxDurationMs) maxDurationMs = endMs;
        }

        // Create output buffer (8 samples per ms at 8kHz mulaw)
        const totalSamples = Math.ceil(maxDurationMs * 8);
        const mixedAudio = Buffer.alloc(totalSamples, 0xFF); // 0xFF = silence in mulaw

        // Place caller audio at correct timestamps
        for (const chunk of callerChunks) {
          const startSample = Math.floor(chunk.timestamp * 8);
          for (let i = 0; i < chunk.data.length && (startSample + i) < totalSamples; i++) {
            const pos = startSample + i;
            // Mix with existing audio
            const existing = mulawToLinear(mixedAudio[pos]);
            const incoming = mulawToLinear(chunk.data[i]);
            const mixed = Math.max(-32768, Math.min(32767, existing + incoming));
            mixedAudio[pos] = linearToMulaw(mixed);
          }
        }

        // Place AI audio at correct timestamps
        for (const chunk of aiChunks) {
          const startSample = Math.floor(chunk.timestamp * 8);
          for (let i = 0; i < chunk.data.length && (startSample + i) < totalSamples; i++) {
            const pos = startSample + i;
            // Mix with existing audio
            const existing = mulawToLinear(mixedAudio[pos]);
            const incoming = mulawToLinear(chunk.data[i]);
            const mixed = Math.max(-32768, Math.min(32767, existing + incoming));
            mixedAudio[pos] = linearToMulaw(mixed);
          }
        }

        // Create WAV file
        const wavBuffer = createMulawWav(mixedAudio, 8000);

        recorderLogger.info('Recording finalized', {
          callSid,
          wavSize: wavBuffer.length,
          durationSeconds: Math.round(totalSamples / 8000),
          callerChunks: callerChunks.length,
          aiChunks: aiChunks.length,
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
 * Convert mulaw byte to linear PCM (16-bit signed)
 * @param {number} mulaw - mulaw byte (0-255)
 * @returns {number} Linear PCM value (-32768 to 32767)
 */
function mulawToLinear(mulaw) {
  // Invert all bits
  mulaw = ~mulaw & 0xFF;

  const sign = (mulaw & 0x80) ? -1 : 1;
  const exponent = (mulaw >> 4) & 0x07;
  const mantissa = mulaw & 0x0F;

  // Decode
  let magnitude = ((mantissa << 3) + 0x84) << exponent;
  magnitude -= 0x84;

  return sign * magnitude;
}

/**
 * Convert linear PCM (16-bit signed) to mulaw byte
 * @param {number} pcm - Linear PCM value
 * @returns {number} mulaw byte (0-255)
 */
function linearToMulaw(pcm) {
  const MULAW_MAX = 0x1FFF;
  const MULAW_BIAS = 33;

  // Get sign
  let sign = 0;
  if (pcm < 0) {
    sign = 0x80;
    pcm = -pcm;
  }

  // Add bias and clamp
  pcm += MULAW_BIAS;
  if (pcm > MULAW_MAX) pcm = MULAW_MAX;

  // Find exponent and mantissa
  let exponent = 7;
  for (let mask = 0x1000; exponent > 0; exponent--, mask >>= 1) {
    if (pcm & mask) break;
  }

  const mantissa = (pcm >> (exponent + 3)) & 0x0F;

  // Combine and invert
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

/**
 * Mix two mulaw audio streams together
 * Converts to linear PCM, mixes, then converts back to mulaw
 * @param {Buffer} audio1 - First mulaw audio buffer
 * @param {Buffer} audio2 - Second mulaw audio buffer
 * @returns {Buffer} Mixed mulaw audio buffer
 */
function mixMulawAudio(audio1, audio2) {
  // Use the longer audio as the base length
  const maxLength = Math.max(audio1.length, audio2.length);
  const mixed = Buffer.alloc(maxLength);

  for (let i = 0; i < maxLength; i++) {
    // Get samples (silence = 0xFF in mulaw, which is 0 in linear)
    const sample1 = i < audio1.length ? mulawToLinear(audio1[i]) : 0;
    const sample2 = i < audio2.length ? mulawToLinear(audio2[i]) : 0;

    // Mix by adding (with clipping to prevent overflow)
    let mixedSample = sample1 + sample2;
    mixedSample = Math.max(-32768, Math.min(32767, mixedSample));

    // Convert back to mulaw
    mixed[i] = linearToMulaw(mixedSample);
  }

  return mixed;
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
