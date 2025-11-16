/**
 * Admin API for managing voice options
 * Lookup Cartesia voice metadata and generate preview audio
 */

import { logger } from '../../utils/logger.js';
import { CartesiaService } from '../../services/cartesia.js';

const voicesLogger = logger.child('ADMIN_VOICES');

/**
 * GET /api/admin/voices/lookup?voiceId=xxx
 * Fetch voice metadata from Cartesia API
 */
export async function lookupVoice(req, res) {
  try {
    const { voiceId } = req.query;

    if (!voiceId) {
      return res.status(400).json({ error: 'voiceId parameter is required' });
    }

    voicesLogger.info('Looking up voice metadata', { voiceId });

    // Test the voice by generating a short audio sample
    // Cartesia doesn't have a dedicated metadata endpoint, so we validate by attempting to use it
    const cartesia = new CartesiaService();

    try {
      // Generate a test audio to verify the voice ID exists
      await cartesia.generateAudio('Test', voiceId);

      // If successful, return basic metadata
      // Note: Cartesia API doesn't expose voice name/metadata directly
      // You'll need to maintain a mapping or let admin provide the name
      voicesLogger.info('Voice ID validated', { voiceId });

      res.json({
        voice_id: voiceId,
        is_valid: true,
        message: 'Voice ID is valid. Please provide a name and description.'
      });
    } catch (error) {
      voicesLogger.error('Invalid voice ID', error, { voiceId });
      res.status(404).json({
        error: 'Invalid voice ID',
        voice_id: voiceId,
        is_valid: false
      });
    }
  } catch (error) {
    voicesLogger.error('Error looking up voice', error);
    res.status(500).json({ error: 'Failed to lookup voice' });
  }
}

/**
 * POST /api/admin/voices/preview
 * Generate preview audio with custom business name
 * Body: { voiceId, businessName }
 */
export async function previewVoice(req, res) {
  try {
    const { voiceId, businessName } = req.body;

    if (!voiceId) {
      return res.status(400).json({ error: 'voiceId is required' });
    }

    const businessNameText = businessName || 'Leed Save A.I.';
    const previewText = `Thank you for calling ${businessNameText}, how can I help you today?`;

    voicesLogger.info('Generating voice preview', {
      voiceId,
      businessName: businessNameText,
    });

    const cartesia = new CartesiaService();
    const audioResponse = await cartesia.generateAudio(previewText, voiceId);

    // Convert Cartesia response to Buffer
    let audioBuffer;
    if (Buffer.isBuffer(audioResponse)) {
      audioBuffer = audioResponse;
    } else if (audioResponse instanceof ArrayBuffer) {
      audioBuffer = Buffer.from(audioResponse);
    } else if (audioResponse.audio) {
      // Response might have .audio property
      audioBuffer = Buffer.isBuffer(audioResponse.audio)
        ? audioResponse.audio
        : Buffer.from(audioResponse.audio);
    } else {
      voicesLogger.error('Unexpected audio format', { type: typeof audioResponse });
      throw new Error('Unexpected audio format from Cartesia');
    }

    // Return audio as base64 for easy embedding in browser
    const base64Audio = audioBuffer.toString('base64');

    voicesLogger.info('Voice preview generated', {
      voiceId,
      audioSize: audioBuffer.length,
      base64Size: base64Audio.length,
    });

    res.json({
      audio: base64Audio,
      text: previewText,
      voice_id: voiceId,
      format: 'pcm_mulaw',
      sample_rate: 8000,
    });
  } catch (error) {
    voicesLogger.error('Error generating voice preview', error);
    res.status(500).json({ error: 'Failed to generate preview' });
  }
}
