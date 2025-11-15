/**
 * Main WebSocket server for voice agent
 * Handles:
 * 1. WebSocket connections from Twilio
 * 2. Health checks
 * 3. Metrics API
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import { handleTwilioStream } from './services/twilio-handler.js';
import { getMetrics } from './services/metrics.js';
import { testConnection } from './db/neon.js';
import { logger } from './utils/logger.js';

const serverLogger = logger.child('SERVER');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(express.json());

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
app.get('/metrics', (req, res) => {
  // Verify API key
  const apiKey = req.headers['x-api-key'];

  if (!process.env.METRICS_API_KEY) {
    serverLogger.warn('METRICS_API_KEY not set - metrics endpoint disabled');
    return res.status(503).json({
      error: 'Metrics endpoint not configured',
    });
  }

  if (apiKey !== process.env.METRICS_API_KEY) {
    serverLogger.warn('Unauthorized metrics access attempt', {
      ip: req.ip,
    });
    return res.status(401).json({
      error: 'Unauthorized',
    });
  }

  const metrics = getMetrics();
  res.json(metrics);
});

/**
 * Root endpoint
 */
app.get('/', (req, res) => {
  res.json({
    name: 'Voice Agent - Fly.io',
    version: '1.0.0',
    status: 'running',
    endpoints: {
      health: '/health',
      health_detailed: '/health/detailed',
      metrics: '/metrics (requires API key)',
      websocket: 'wss://[your-app].fly.dev/stream',
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
