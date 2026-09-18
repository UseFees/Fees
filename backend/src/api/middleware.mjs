import { log } from '../logger.mjs';
import { config } from '../config.mjs';

// CORS for a browser origin (usefees.com). Only the origins in CORS_ORIGINS are
// allowed; if unset, no CORS headers are sent (server-to-server only, the
// recommended posture — keep API_TOKEN off the browser). Never '*': credentials
// + wildcard is unsafe and pointless here.
const corsOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
export function cors(req, res, next) {
  const origin = req.get('origin');
  if (origin && corsOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'authorization,content-type,x-request-id');
    res.set('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}

// Bearer auth for the frontend/BFF. If API_TOKEN is unset (dev), auth is open
// and a warning is logged once.
let warned = false;
export function auth(req, res, next) {
  if (!config.apiToken) {
    if (!warned) { log.warn('API_TOKEN is unset: API is unauthenticated (dev only)'); warned = true; }
    return next();
  }
  const t = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (t.length !== config.apiToken.length) return res.status(401).json({ error: 'unauthorized' });
  let diff = 0; for (let i = 0; i < t.length; i++) diff |= t.charCodeAt(i) ^ config.apiToken.charCodeAt(i);
  if (diff !== 0) return res.status(401).json({ error: 'unauthorized' });
  next();
}

export function requestId(req, _res, next) {
  req.id = req.get('x-request-id') || cryptoRandom();
  next();
}
function cryptoRandom() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

export function errorHandler(err, req, res, _next) {
  const status = err.status ?? 500;
  if (status >= 500) log.error('request failed', { reqId: req.id, path: req.path, err: err.message, stack: err.stack });
  else log.warn('request rejected', { reqId: req.id, path: req.path, code: err.code, err: err.message });
  res.status(status).json({ error: err.message, code: err.code ?? 'error' });
}

// Async route wrapper so thrown errors reach errorHandler.
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
