/**
 * Admin API for managing prompt templates
 * Allows viewing and editing demo + client templates
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const promptsLogger = logger.child('ADMIN_PROMPTS');

const DEMO_TEMPLATE_PATH = path.join(__dirname, '../../prompts/templates/demo-template.js');
const DEMO_FALLBACK_TEMPLATE_PATH = path.join(__dirname, '../../prompts/templates/demo-fallback-template.js');
const CLIENT_TEMPLATE_PATH = path.join(__dirname, '../../prompts/templates/client-template.js');

/**
 * GET /api/admin/prompts
 * Get demo, demo-fallback, and client templates
 */
export async function getPrompts(req, res) {
  try {
    const [demoContent, demoFallbackContent, clientContent] = await Promise.all([
      fs.readFile(DEMO_TEMPLATE_PATH, 'utf-8'),
      fs.readFile(DEMO_FALLBACK_TEMPLATE_PATH, 'utf-8'),
      fs.readFile(CLIENT_TEMPLATE_PATH, 'utf-8'),
    ]);

    // Extract template strings from the files
    const demoMatch = demoContent.match(/export const DEMO_TEMPLATE = `([\s\S]*?)`;/);
    const demoFallbackMatch = demoFallbackContent.match(/export const DEMO_FALLBACK_TEMPLATE = `([\s\S]*?)`;/);
    const clientMatch = clientContent.match(/export const CLIENT_TEMPLATE = `([\s\S]*?)`;/);

    if (!demoMatch || !demoFallbackMatch || !clientMatch) {
      throw new Error('Failed to parse template files');
    }

    res.json({
      demo: demoMatch[1],
      demoFallback: demoFallbackMatch[1],
      client: clientMatch[1],
    });

    promptsLogger.info('Templates retrieved');
  } catch (error) {
    promptsLogger.error('Error retrieving templates', error);
    res.status(500).json({ error: 'Failed to retrieve templates' });
  }
}

/**
 * PUT /api/admin/prompts/demo
 * Update demo template
 */
export async function updateDemoTemplate(req, res) {
  try {
    const { template } = req.body;

    if (!template || typeof template !== 'string') {
      return res.status(400).json({ error: 'Template content is required' });
    }

    // Read current file
    const currentContent = await fs.readFile(DEMO_TEMPLATE_PATH, 'utf-8');

    // Replace the template content while preserving the file structure
    const newContent = currentContent.replace(
      /export const DEMO_TEMPLATE = `[\s\S]*?`;/,
      `export const DEMO_TEMPLATE = \`${template}\`;`
    );

    // Write updated content
    await fs.writeFile(DEMO_TEMPLATE_PATH, newContent, 'utf-8');

    promptsLogger.info('Demo template updated');

    res.json({ success: true, message: 'Demo template updated' });
  } catch (error) {
    promptsLogger.error('Error updating demo template', error);
    res.status(500).json({ error: 'Failed to update demo template' });
  }
}

/**
 * PUT /api/admin/prompts/client
 * Update client template
 */
export async function updateClientTemplate(req, res) {
  try {
    const { template } = req.body;

    if (!template || typeof template !== 'string') {
      return res.status(400).json({ error: 'Template content is required' });
    }

    // Read current file
    const currentContent = await fs.readFile(CLIENT_TEMPLATE_PATH, 'utf-8');

    // Replace the template content while preserving the file structure
    const newContent = currentContent.replace(
      /export const CLIENT_TEMPLATE = `[\s\S]*?`;/,
      `export const CLIENT_TEMPLATE = \`${template}\`;`
    );

    // Write updated content
    await fs.writeFile(CLIENT_TEMPLATE_PATH, newContent, 'utf-8');

    promptsLogger.info('Client template updated');

    res.json({ success: true, message: 'Client template updated' });
  } catch (error) {
    promptsLogger.error('Error updating client template', error);
    res.status(500).json({ error: 'Failed to update client template' });
  }
}

/**
 * PUT /api/admin/prompts/demo-fallback
 * Update demo fallback template
 */
export async function updateDemoFallbackTemplate(req, res) {
  try {
    const { template } = req.body;

    if (!template || typeof template !== 'string') {
      return res.status(400).json({ error: 'Template content is required' });
    }

    // Read current file
    const currentContent = await fs.readFile(DEMO_FALLBACK_TEMPLATE_PATH, 'utf-8');

    // Replace the template content while preserving the file structure
    const newContent = currentContent.replace(
      /export const DEMO_FALLBACK_TEMPLATE = `[\s\S]*?`;/,
      `export const DEMO_FALLBACK_TEMPLATE = \`${template}\`;`
    );

    // Write updated content
    await fs.writeFile(DEMO_FALLBACK_TEMPLATE_PATH, newContent, 'utf-8');

    promptsLogger.info('Demo fallback template updated');

    res.json({ success: true, message: 'Demo fallback template updated' });
  } catch (error) {
    promptsLogger.error('Error updating demo fallback template', error);
    res.status(500).json({ error: 'Failed to update demo fallback template' });
  }
}
