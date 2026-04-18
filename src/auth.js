import fastifyOauth2 from '@fastify/oauth2';
import secureSession from '@fastify/secure-session';
import { ulid } from 'ulid';
import crypto from 'node:crypto';
import { config } from './config.js';
import { openDatabase } from './db.js';

const SAFE_PATH = /^\/(quote|my|admin)(\/|$)|^\/$/;

function deriveSessionKey(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

export async function registerAuth(app) {
  app.register(secureSession, {
    cookieName: 's3d',
    key: deriveSessionKey(config.sessionSecret),
    cookie: {
      path: '/',
      httpOnly: true,
      secure: config.isProd,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
    },
  });

  app.register(fastifyOauth2, {
    name: 'googleOAuth2',
    scope: ['openid', 'email', 'profile'],
    credentials: {
      client: {
        id: config.google.clientId,
        secret: config.google.clientSecret,
      },
      auth: fastifyOauth2.GOOGLE_CONFIGURATION,
    },
    startRedirectPath: '/oauth2/login',
    callbackUri: config.google.redirectUrl,
    generateStateFunction: (req) => {
      const state = crypto.randomBytes(16).toString('hex');
      const ret = req.query?.return_to;
      const target = typeof ret === 'string' && SAFE_PATH.test(ret) ? ret : '/';
      req.session.set('oauth_state', state);
      req.session.set('oauth_return', target);
      return state;
    },
    checkStateFunction: (req, cb) => {
      const expected = req.session.get('oauth_state');
      const got = req.query?.state;
      // Single-use: clear immediately so a failed callback cannot reuse the same state.
      req.session.set('oauth_state', undefined);
      if (!expected || expected !== got) return cb(new Error('invalid oauth state'));
      cb();
    },
  });

  app.get('/oauth2/callback', async (req, reply) => {
    try {
      const result = await app.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(req);
      const accessToken = result?.token?.access_token ?? result?.access_token;
      if (!accessToken) {
        req.log.warn('oauth token missing access_token');
        return reply.code(502).send('oauth token invalid');
      }
      const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        req.log.warn({ status: res.status }, 'userinfo fetch failed');
        return reply.code(502).send('oauth userinfo failed');
      }
      const info = await res.json();
      const email = String(info.email || '').toLowerCase();
      if (!email || info.email_verified === false) {
        return reply.code(403).send('email not verified');
      }

      const db = openDatabase();
      // Active rows only (withdrawn rows have their email mangled to `w:<id>`).
      const existing = db.prepare('SELECT id, email FROM users WHERE email = ?').get(email);
      let userId;
      if (existing) {
        userId = existing.id;
        db.prepare('UPDATE users SET name = COALESCE(?, name) WHERE id = ?').run(info.name ?? null, userId);
      } else {
        userId = ulid();
        db.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)').run(
          userId,
          email,
          info.name ?? null,
          Date.now(),
        );
      }

      const ret = req.session.get('oauth_return');
      req.session.set('user_id', userId);
      req.session.set('email', email);
      req.session.set('oauth_state', undefined);
      req.session.set('oauth_return', undefined);

      const safe = typeof ret === 'string' && SAFE_PATH.test(ret) ? ret : '/';
      return reply.redirect(safe);
    } catch (err) {
      req.log.error({ err }, 'oauth callback failed');
      return reply.code(400).send('oauth callback failed');
    }
  });

  app.post('/oauth2/logout', { preHandler: requireCsrfHeader }, async (req, reply) => {
    req.session.delete();
    return reply.redirect('/');
  });
}

export function currentSession(req) {
  const email = req.session.get('email');
  const userId = req.session.get('user_id');
  if (!email || !userId) return null;
  return { email, userId, isAdmin: email === config.adminEmail };
}

export function requireAuth(req, reply, done) {
  const s = currentSession(req);
  if (!s) return reply.code(401).send({ error: 'unauthorized' });
  req.auth = s;
  done();
}

export function requireAdmin(req, reply, done) {
  const s = currentSession(req);
  if (!s) return reply.code(401).send({ error: 'unauthorized' });
  if (!s.isAdmin) return reply.code(403).send({ error: 'forbidden' });
  req.auth = s;
  done();
}

export function requireCsrfHeader(req, reply, done) {
  if (req.headers['x-requested-with'] !== 'fetch') {
    return reply.code(403).send({ error: 'missing X-Requested-With' });
  }
  done();
}
