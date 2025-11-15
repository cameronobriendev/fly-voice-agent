/**
 * Simple logger utility with structured logging
 */

const LOG_LEVELS = {
  ERROR: 'ERROR',
  WARN: 'WARN',
  INFO: 'INFO',
  DEBUG: 'DEBUG',
};

class Logger {
  constructor(context = 'APP') {
    this.context = context;
    this.isDevelopment = process.env.NODE_ENV !== 'production';
  }

  _formatMessage(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      context: this.context,
      message,
      ...meta,
    };

    return this.isDevelopment
      ? this._prettyFormat(logEntry)
      : JSON.stringify(logEntry);
  }

  _prettyFormat(entry) {
    const emoji = {
      ERROR: '❌',
      WARN: '⚠️',
      INFO: 'ℹ️',
      DEBUG: '🔍',
    };

    const meta = Object.keys(entry)
      .filter(k => !['timestamp', 'level', 'context', 'message'].includes(k))
      .map(k => `${k}=${JSON.stringify(entry[k])}`)
      .join(' ');

    return `${emoji[entry.level] || ''} [${entry.context}] ${entry.message}${meta ? ' ' + meta : ''}`;
  }

  error(message, error = null, meta = {}) {
    const errorMeta = error
      ? {
          error: error.message,
          stack: error.stack,
          ...meta,
        }
      : meta;

    console.error(this._formatMessage(LOG_LEVELS.ERROR, message, errorMeta));
  }

  warn(message, meta = {}) {
    console.warn(this._formatMessage(LOG_LEVELS.WARN, message, meta));
  }

  info(message, meta = {}) {
    console.log(this._formatMessage(LOG_LEVELS.INFO, message, meta));
  }

  debug(message, meta = {}) {
    if (this.isDevelopment) {
      console.log(this._formatMessage(LOG_LEVELS.DEBUG, message, meta));
    }
  }

  child(childContext) {
    return new Logger(`${this.context}:${childContext}`);
  }
}

export const logger = new Logger();
export default Logger;
