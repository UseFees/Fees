import { log } from '../logger.mjs';
import { config } from '../config.mjs';

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
