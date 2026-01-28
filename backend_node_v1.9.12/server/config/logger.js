const pino = require('pino');
const { env, isProduction } = require('./env');
const { getRequestContext } = require('./requestContext');

const usePretty = env.logPretty || !isProduction;

const summarizeValue = (value) => {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.length > 800 ? `${trimmed.slice(0, 800)}…` : trimmed;
  }
  if (Array.isArray(value)) {
    return { type: 'array', length: value.length };
  }
  if (typeof value === 'object') {
    return { type: 'object', keys: Object.keys(value).slice(0, 25) };
  }
  return undefined;
};

const serializeError = (error) => {
  if (!error || typeof error !== 'object') {
    return error;
  }

  const status = Number.isFinite(error.status) ? error.status : error.response?.status;
  const code = error.code || error.cause?.code;

  const serialized = {
    type: error.name || error.constructor?.name || 'Error',
    message: error.message || String(error),
    status: Number.isFinite(status) ? status : undefined,
    code: code ? String(code) : undefined,
    stack: typeof error.stack === 'string' ? error.stack : undefined,
  };

  if (error.isAxiosError || error.config) {
    serialized.http = {
      method: error.config?.method ? String(error.config.method).toUpperCase() : undefined,
      url: error.config?.url ? String(error.config.url) : undefined,
      baseURL: error.config?.baseURL ? String(error.config.baseURL) : undefined,
      timeout: Number.isFinite(error.config?.timeout) ? error.config.timeout : undefined,
      params: summarizeValue(error.config?.params),
      responseStatus: Number.isFinite(error.response?.status) ? error.response.status : undefined,
      responseData: summarizeValue(error.response?.data),
    };
  }

  if (error.details !== undefined) {
    serialized.details = summarizeValue(error.details) ?? error.details;
  }

  if (error.cause && error.cause !== error) {
    serialized.cause = serializeError(error.cause);
  }

  return serialized;
};

const logger = pino({
  name: 'peppro-backend',
  level: env.logLevel,
  mixin() {
    const context = getRequestContext();
    return context?.requestId ? { requestId: context.requestId } : {};
  },
  redact: {
    // Avoid leaking secrets into logs (axios errors can include headers/auth).
    paths: [
      '*.authorization',
      '*.cookie',
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      'headers.cookie',
      'config.headers.authorization',
      'config.headers.Authorization',
      'config.headers["API-Key"]',
      'config.headers["api-key"]',
      'config.headers["stripe-signature"]',
      'config.auth.password',
      'auth.password',
    ],
    censor: '[REDACTED]',
  },
  serializers: {
    err: serializeError,
  },
  transport: usePretty
    ? {
      target: 'pino-pretty',
      options: {
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    }
    : undefined,
});

module.exports = { logger };
