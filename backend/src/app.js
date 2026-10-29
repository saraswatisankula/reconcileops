import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { logger } from './logger.js';
import { demo, meta } from './db.js';
import { errorHandler, requireToken } from './middleware.js';
import projects from './routes/projects.js';
import misc from './routes/misc.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(cors({
    origin: config.CORS_ORIGIN.split(',').map((s) => s.trim()),
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Actor'],
  }));
  app.use(express.json({ limit: '256kb' }));
  if (config.NODE_ENV !== 'test') app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/api/health' } }));

  app.use('/api', rateLimit({
    windowMs: 60_000,
    limit: config.NODE_ENV === 'test' ? 10_000 : 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  }));

  app.get('/api/health', async (_req, res) => {
    try {
      await Promise.all([meta.query('SELECT 1'), demo.query('SELECT 1')]);
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(503).json({ status: 'degraded', error: err.message });
    }
  });

  app.use('/api', requireToken);
  app.use('/api/projects', projects);
  app.use('/api', misc);

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(errorHandler);
  return app;
}
