import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyRateLimit from '@fastify/rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDatabase } from './db.js';
import { registerAuth } from './auth.js';
import publicRoutes from './routes/public.js';
import quoteRoutes from './routes/quote.js';
import adminRoutes from './routes/admin.js';
import cameraRoutes from './routes/camera.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');

async function build() {
  const app = Fastify({
    logger: {
      level: config.isProd ? 'info' : 'debug',
      redact: ['req.headers.cookie', 'req.headers.authorization', 'headers.cookie'],
    },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  openDatabase();

  // logout is submitted as form POST without JSON body; accept any
  // content-type as empty so fastify doesn't reply 415.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, _body, done) => {
    done(null, {});
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (!reply.getHeader('content-security-policy')) {
      reply.header(
        'content-security-policy',
        [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://*.naver.com https://*.pstatic.net",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "img-src 'self' data: blob: https://*.pstatic.net https://*.map.naver.net https://*.naver.com",
          "connect-src 'self' https://cdn.jsdelivr.net https://*.naver.com https://*.pstatic.net https://*.navercorp.com",
          "font-src 'self' https://fonts.gstatic.com",
          "media-src 'self' blob:",
          "worker-src 'self' blob:",
          "frame-ancestors 'self'",
          "object-src 'none'",
          "base-uri 'self'",
        ].join('; '),
      );
    }
    return payload;
  });

  await app.register(fastifyRateLimit, {
    global: false,
    max: 120,
    timeWindow: '1 minute',
  });

  await app.register(fastifyMultipart, {
    limits: {
      fileSize: config.limits.fileSizeBytes,
      files: config.limits.maxFilesPerQuote,
      fields: 100,
    },
  });

  await registerAuth(app);

  await app.register(publicRoutes);
  await app.register(quoteRoutes);
  await app.register(adminRoutes);
  await app.register(cameraRoutes);

  await app.register(fastifyStatic, {
    root: publicDir,
    prefix: '/',
    index: ['index.html'],
    wildcard: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.wasm')) {
        res.setHeader('content-type', 'application/wasm');
      }
    },
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/uploads/') && !req.url.startsWith('/thumbs/') && !req.url.startsWith('/camera/')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not found' });
  });

  return app;
}

build()
  .then((app) => app.listen({ port: config.port, host: '0.0.0.0' }))
  .then((addr) => console.log(`[3d] listening on ${addr}`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
