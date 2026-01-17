/**
 * Neon Postgres database client
 * Uses @neondatabase/serverless for serverless-optimized connections
 *
 * NOTE: Database is optional for BuddyHelps (uses dashboard API instead)
 */

import { neon } from '@neondatabase/serverless';
import { logger } from '../utils/logger.js';

const dbLogger = logger.child('DB');

// Database is optional - BuddyHelps uses dashboard API instead
export const sql = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

if (!process.env.DATABASE_URL) {
  dbLogger.info('DATABASE_URL not set - database features disabled (using dashboard API)');
}

// Test database connection
export async function testConnection() {
  if (!sql) {
    dbLogger.info('Database not configured, skipping connection test');
    return false;
  }

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
