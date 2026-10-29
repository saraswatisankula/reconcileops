import crypto from 'node:crypto';
import { ZodError } from 'zod';
import { config } from './config.js';
import { logger } from './logger.js';
import { HttpError } from './utils/errors.js';

export function validateBody(schema) {
  return (req, _res, next) => {
    req.body = schema.parse(req.body ?? {});
    next();
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// When API_TOKEN is set, every write request needs "Authorization: Bearer <token>".
// Reads stay open so the dashboard can be viewed without logging in.
export function requireToken(req, _res, next) {
  if (!config.API_TOKEN || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !safeEqual(token, config.API_TOKEN)) {
    return next(new HttpError(401, 'Missing or invalid API token'));
  }
  req.actor = 'token-user';
  next();
}

export function actor(req) {
  const name = (req.get('x-actor') || '').replace(/[^\w .@-]/g, '').slice(0, 60);
  return name || req.actor || 'operator';
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: 'Validation failed',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, ...(err.details || {}) });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  if (err.code === '23505') {
    return res.status(409).json({ error: 'Duplicate value', detail: err.detail });
  }
  if (err.code === '23503') {
    return res.status(409).json({ error: 'Record is still referenced', detail: err.detail });
  }
  if (err.code === '23514') {
    return res.status(400).json({ error: 'Value violates a database rule', detail: err.detail });
  }
  logger.error({ err, url: req.originalUrl }, 'unhandled error');
  res.status(500).json({ error: 'Internal server error' });
}
