/**
 * Neon Postgres database client
 * Uses @neondatabase/serverless for serverless-optimized connections
 */

import { neon } from '@neondatabase/serverless';
import { logger } from '../utils/logger.js';

const dbLogger = logger.child('DB');

if (!process.env.DATABASE_URL) {
  dbLogger.error('DATABASE_URL environment variable is not set');
  throw new Error('DATABASE_URL is required');
}

// Create SQL query function
export const sql = neon(process.env.DATABASE_URL);

// Test database connection
export async function testConnection() {
  try {
    const result = await sql`SELECT NOW() as current_time`;
    dbLogger.info('Database connection successful', {
      timestamp: result[0].current_time,
    });
    return true;
  } catch (error) {
    dbLogger.error('Database connection failed', error);
    throw error;
  }
}
