/**
 * Main WebSocket server for voice agent
 * Handles:
 * 1. WebSocket connections from Twilio
 * 2. Health checks
 * 3. Metrics API
 */

import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { handleTwilioStream } from './services/twilio-handler.js';
import { getMetrics } from './services/metrics.js';
import { testConnection } from './db/neon.js';
import { logger } from './utils/logger.js';
import { handleTwilioRouter } from './api/twilio/router.js';
import { requireAdminApiKey } from './api/admin/middleware.js';
import { getPrompts, updateDemoTemplate, updateClientTemplate, updateDemoFallbackTemplate } from './api/admin/prompts.js';
import { getGreetings, updateGreetings } from './api/admin/greetings.js';
import { getUsers, getUser, updateUser, previewPrompt } from './api/admin/users.js';
import { lookupVoice, previewVoice } from './api/admin/voices.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serverLogger = logger.child('SERVER');

const app = express();
const PORT = process.env.PORT || 8080;

// CORS Configuration - configurable via environment variable
// Set CORS_ORIGINS as comma-separated list: "https://app.example.com,https://example.com"
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : ['http://localhost:3000'];

app.use(cors({
  origin: corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // For Twilio form data

// Serve static files from public directory (audio files for ringback, ambience, etc.)
app.use('/public', express.static(path.join(__dirname, '../public')));

// Request logging middleware
app.use((req, res, next) => {
  serverLogger.debug('Request received', {
    method: req.method,
    path: req.path,
    ip: req.ip,
  });
  next();
});

/**
 * Health check endpoint
 * Used by Fly.io and monitoring tools
 */
app.get('/health', (req, res) => {
  const metrics = getMetrics();

  res.json({
    status: 'up',
    active_calls: metrics.calls.active,
    uptime_seconds: metrics.uptime.seconds,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Detailed health check with database test
 */
app.get('/health/detailed', async (req, res) => {
  const checks = {
    server: 'up',
    database: 'checking',
  };

  // Test database connection
  try {
    await testConnection();
    checks.database = 'up';
  } catch (error) {
    checks.database = 'down';
    serverLogger.error('Database health check failed', error);
  }

  const isHealthy = Object.values(checks).every((status) => status === 'up');

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'healthy' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Metrics API endpoint (protected)
 * For admin dashboard to query system metrics
 */
app.get('/metrics', requireAdminApiKey, (req, res) => {
  const metrics = getMetrics();
  res.json(metrics);
});

/**
 * Twilio Router endpoint
 * Smart router that handles all incoming Twilio calls
 * - +14374282102: Hangs up immediately
 * - All other numbers: Routes to voice agent stream
 */
app.post('/api/twilio/router', handleTwilioRouter);

/**
 * Admin API endpoints (protected with API key)
 */
// Prompts management
app.get('/api/admin/prompts', requireAdminApiKey, getPrompts);
app.put('/api/admin/prompts/demo', requireAdminApiKey, updateDemoTemplate);
app.put('/api/admin/prompts/demo-fallback', requireAdminApiKey, updateDemoFallbackTemplate);
app.put('/api/admin/prompts/client', requireAdminApiKey, updateClientTemplate);

// Greetings management
app.get('/api/admin/greetings', requireAdminApiKey, getGreetings);
app.put('/api/admin/greetings', requireAdminApiKey, updateGreetings);

// Users management
app.get('/api/admin/users', requireAdminApiKey, getUsers);
app.get('/api/admin/users/:userId', requireAdminApiKey, getUser);
app.put('/api/admin/users/:userId', requireAdminApiKey, updateUser);
app.get('/api/admin/users/:userId/preview', requireAdminApiKey, previewPrompt);

// Voice management
app.get('/api/admin/voices/lookup', requireAdminApiKey, lookupVoice);
app.post('/api/admin/voices/preview', requireAdminApiKey, previewVoice);

/**
 * Root endpoint - Serve demo page
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/demo.html'));
});

/**
 * API info endpoint (for reference)
 */
app.get('/api', (req, res) => {
  res.json({
    name: 'Voice Agent - Fly.io',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      health_detailed: '/health/detailed',
      metrics: '/metrics (requires API key)',
      twilio_router: '/api/twilio/router',
      websocket: 'wss://[your-app].fly.dev/stream',
      admin_prompts: '/api/admin/prompts (requires API key)',
      admin_users: '/api/admin/users (requires API key)',
    },
  });
});

// Start HTTP server
const server = app.listen(PORT, async () => {
  serverLogger.info(`Server started on port ${PORT}`);

  // Test database connection on startup
  try {
    await testConnection();
    serverLogger.info('Database connection verified');
  } catch (error) {
    serverLogger.error('Database connection failed on startup', error);
    serverLogger.warn('Server will continue, but calls may fail');
  }
});

// WebSocket server for Twilio streams
const wss = new WebSocketServer({
  server,
  path: '/stream',
});

wss.on('connection', async (ws, req) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

  serverLogger.info('New WebSocket connection', {
    ip: clientIp,
    path: req.url,
  });

  try {
    await handleTwilioStream(ws);
  } catch (error) {
    serverLogger.error('Error handling WebSocket connection', error);
    ws.close();
  }
});

wss.on('error', (error) => {
  serverLogger.error('WebSocket server error', error);
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  serverLogger.info(`${signal} received, starting graceful shutdown...`);

  // Close WebSocket server (stops accepting new connections)
  wss.close(() => {
    serverLogger.info('WebSocket server closed');
  });

  // Close HTTP server
  server.close(() => {
    serverLogger.info('HTTP server closed');
    process.exit(0);
  });

  // Force exit after 30 seconds
  setTimeout(() => {
    serverLogger.error('Graceful shutdown timeout, forcing exit');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  serverLogger.error('Uncaught exception', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  serverLogger.error('Unhandled rejection', new Error(String(reason)));
});

serverLogger.info('Voice Agent server initialized', {
  port: PORT,
  nodeEnv: process.env.NODE_ENV,
});
