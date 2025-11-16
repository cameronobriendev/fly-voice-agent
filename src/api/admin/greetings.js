/**
 * Admin API for managing demo greetings
 * Allows viewing and editing demo greetings for (775) 376-7929
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const greetingsLogger = logger.child('ADMIN_GREETINGS');

const GREETINGS_PATH = path.join(__dirname, '../../prompts/templates/demo-greetings.js');

/**
 * GET /api/admin/greetings
 * Get both demo greetings
 */
export async function getGreetings(req, res) {
  try {
    const content = await fs.readFile(GREETINGS_PATH, 'utf-8');

    // Extract greeting strings from the file
    const demoMatch = content.match(/export const DEMO_GREETING = `([\s\S]*?)`;/);
    const fallbackMatch = content.match(/export const DEMO_FALLBACK_GREETING = `([\s\S]*?)`;/);

    if (!demoMatch || !fallbackMatch) {
      throw new Error('Failed to parse greetings file');
    }

    res.json({
      demo_greeting: demoMatch[1],
      demo_fallback_greeting: fallbackMatch[1],
    });

    greetingsLogger.info('Greetings retrieved');
  } catch (error) {
    greetingsLogger.error('Error retrieving greetings', error);
    res.status(500).json({ error: 'Failed to retrieve greetings' });
  }
}

/**
 * PUT /api/admin/greetings
 * Update both demo greetings
 */
export async function updateGreetings(req, res) {
  try {
    const { demo_greeting, demo_fallback_greeting } = req.body;

    if (!demo_greeting || typeof demo_greeting !== 'string') {
      return res.status(400).json({ error: 'demo_greeting is required' });
    }

    if (!demo_fallback_greeting || typeof demo_fallback_greeting !== 'string') {
      return res.status(400).json({ error: 'demo_fallback_greeting is required' });
    }

    // Read current file
    const currentContent = await fs.readFile(GREETINGS_PATH, 'utf-8');

    // Replace both greetings while preserving the file structure
    let newContent = currentContent.replace(
      /export const DEMO_GREETING = `[\s\S]*?`;/,
      `export const DEMO_GREETING = \`${demo_greeting}\`;`
    );

    newContent = newContent.replace(
      /export const DEMO_FALLBACK_GREETING = `[\s\S]*?`;/,
      `export const DEMO_FALLBACK_GREETING = \`${demo_fallback_greeting}\`;`
    );

    // Write updated content
    await fs.writeFile(GREETINGS_PATH, newContent, 'utf-8');

    greetingsLogger.info('Demo greetings updated');

    res.json({ success: true, message: 'Demo greetings updated' });
  } catch (error) {
    greetingsLogger.error('Error updating demo greetings', error);
    res.status(500).json({ error: 'Failed to update demo greetings' });
  }
}
