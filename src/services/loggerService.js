const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Crear directorio de logs si no existe
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Definir niveles personalizados
const customLevels = {
  levels: {
    fatal: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
    trace: 5,
  },
  colors: {
    fatal: 'red',
    error: 'red',
    warn: 'yellow',
    info: 'green',
    debug: 'blue',
    trace: 'gray',
  },
};

// Logger principal
const logger = winston.createLogger({
  levels: customLevels.levels,
  defaultMeta: { service: 'vidalis-backend', env: process.env.NODE_ENV || 'development' },
  transports: [
    // Error logs
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      maxsize: 5242880,
      maxFiles: 5,
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.json()
      ),
    }),

    // Combined logs
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      maxsize: 5242880,
      maxFiles: 10,
      format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.json()
      ),
    }),

    // Console en desarrollo
    ...(process.env.NODE_ENV !== 'production'
      ? [
          new winston.transports.Console({
            format: winston.format.combine(
              winston.format.colorize({ colors: customLevels.colors }),
              winston.format.printf(({ timestamp, level, message, ...meta }) => {
                const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
                return `${timestamp} [${level}]: ${message}${metaStr}`;
              })
            ),
          }),
        ]
      : []),
  ],
  exceptionHandlers: [
    new winston.transports.File({ filename: path.join(logsDir, 'exceptions.log') }),
  ],
  rejectionHandlers: [
    new winston.transports.File({ filename: path.join(logsDir, 'rejections.log') }),
  ],
});

// ── Compatibilidad con la API previa a winston ───────────────────────────────
// El loggerService anterior exponía un único método `log(level, event_type,
// details, agency_id, source)` que además depuraba secretos antes de persistir.
// La migración a winston lo eliminó, dejando llamadas `logger.log(...)` rotas
// (TypeError) en uploadPostService/vidalisService/analyticsService. Restauramos
// el contrato sobre winston, conservando el saneo de secretos.

const SECRET_KEYS = ['password', 'password_hash', 'token', 'secret'];

function sanitizeLogMeta(details) {
  if (!details || typeof details !== 'object') return {};
  const clean = { ...details };
  SECRET_KEYS.forEach((k) => delete clean[k]);
  return clean;
}

// 'success' no es un nivel configurado en winston → se mapea a 'info'.
// Cualquier nivel desconocido cae también a 'info' para no lanzar.
function mapLevel(level) {
  if (level === 'success') return 'info';
  return Object.prototype.hasOwnProperty.call(customLevels.levels, level) ? level : 'info';
}

module.exports = {
  error: (msg, data = {}) => logger.error(msg, data),
  warn: (msg, data = {}) => logger.warn(msg, data),
  info: (msg, data = {}) => logger.info(msg, data),
  debug: (msg, data = {}) => logger.debug(msg, data),
  // API legacy compatible — NO eliminar: hay ~29 call sites que la usan.
  log: (level, event_type, details = {}, agency_id = null, source = 'backend') => {
    const meta = sanitizeLogMeta(details);
    if (agency_id) meta.agency_id = agency_id;
    if (source) meta.source = source;
    logger.log(mapLevel(level), event_type, meta);
  },
  sanitizeLogMeta,
  perf: (action, ms, success = true, data = {}) => {
    logger.info(`[PERF] ${action}`, { action, duration_ms: ms, success, ...data });
  },
  apiCall: (method, path, status, ms, data = {}) => {
    logger.info(`[API] ${method} ${path}`, { method, path, status, duration_ms: ms, ...data });
  },
  aiCost: (service, model, tokens, cost, data = {}) => {
    logger.info('[AI_COST]', { service, model, tokens, cost_usd: cost, ...data });
  },
};
