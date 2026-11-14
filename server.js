// PIG TANKS: сервер аккаунтов и рейтинга. Без зависимостей, нужен Node.js 18+.
// Запуск: node server.js   (порт берётся из переменной PORT, по умолчанию 8080)
// Данные хранятся в data.json рядом с файлом (путь можно задать через DATA_FILE).
'use strict';
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT, 10) || 8080;
// Версии: LATEST_BUILD — номер сборки (versionCode) последней версии игры. Как только хоть один игрок
// с этой сборкой зайдёт в игру, все более старые версии начнут показывать «версия недействительна».
const LATEST_BUILD = parseInt(process.env.LATEST_BUILD, 10) || 5;
const DOWNLOAD_URL = process.env.DOWNLOAD_URL || '';
// Промокоды: PROMOS="КОД:активаций:награда,..." (по умолчанию KAKTUS на 3 активации — шапка-кактус)
const PROMO_CFG = (process.env.PROMOS || 'KAKTUS:3:cactus').split(',').map(x => x.trim().split(':')).filter(a => a[0]);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');

// ------------------------------------------------------------ хранилище
let db = { users: {}, tokens: {}, promos: {}, seen: {} };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch (e) { /* первый запуск */ }
db.promos = db.promos || {}; db.seen = db.seen || {};
for (const [code, max, reward] of PROMO_CFG) {
  const k = code.toUpperCase(), p = db.promos[k] || (db.promos[k] = { devs: [] });
  p.max = parseInt(max, 10) || 1; p.reward = reward || 'cactus';
}
let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = DATA_FILE + '.tmp';
    try { fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DATA_FILE); } catch (e) { console.error('save error', e.message); }
  }, 300);
}

// ------------------------------------------------------------ утилиты
const NAME_RE = /^[\p{L}\p{N}_ .\-]{3,16}$/u;
const STAT_LIMITS = { kills: 1e7, bestKills: 1e6, bestTime: 1e6, games: 1e6, aidaWins: 1e5, aidaBest: 5, aidaRuns: 1e6, potatoes: 1e9, playTime: 1e8 };
const MONOTONIC = Object.keys(STAT_LIMITS); // все поля только растут: берём максимум
const num = (v, max) => { v = Math.floor(Number(v)); return Number.isFinite(v) && v > 0 ? Math.min(v, max) : 0; };
const keyOf = n => n.trim().toLowerCase();
const hashPass = (clientHash, salt) => crypto.scryptSync(String(clientHash), salt, 32).toString('hex');
const newStats = () => Object.fromEntries(MONOTONIC.map(k => [k, 0]));
const publicUser = u => ({ name: u.name, avatar: u.avatar, stats: u.stats, created: u.created });

const hits = new Map(); // простая защита от перебора и спама
function limited(ip, bucket, max, windowMs) {
  const k = bucket + '|' + ip, now = Date.now();
  const h = (hits.get(k) || []).filter(t => now - t < windowMs);
  h.push(now); hits.set(k, h);
  return h.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 20000) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
function authUser(req) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const k = db.tokens[m[1]];
  return k && db.users[k] ? { key: k, user: db.users[k] } : null;
}
function makeToken(key) { const t = crypto.randomBytes(32).toString('hex'); db.tokens[t] = key; return t; }
function rankOf(field, user) { let r = 1; for (const o of Object.values(db.users)) if (o.stats[field] > user.stats[field]) r++; return r; }

const TOPS = { kills: 'bestKills', wins: 'aidaWins', potatoes: 'potatoes', wave: 'aidaBest' };

// ------------------------------------------------------------ маршруты
async function handle(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/' || p === '/health') return send(res, 200, { ok: true, game: 'PIG TANKS', players: Object.keys(db.users).length });
  if (limited(ip, 'all', 240, 60e3)) return send(res, 429, { error: 'Слишком много запросов, подожди минутку' });

  if (req.method === 'GET' && p === '/api/top') {
    const field = TOPS[url.searchParams.get('type')] || TOPS.kills;
    const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit'), 10) || 50));
    const users = Object.values(db.users).filter(u => u.stats[field] > 0);
    users.sort((a, b) => b.stats[field] - a.stats[field] || b.stats.aidaWins - a.stats.aidaWins || a.created - b.created);
    return send(res, 200, {
      type: url.searchParams.get('type') || 'kills',
      total: users.length,
      list: users.slice(0, limit).map((u, i) => ({ rank: i + 1, name: u.name, avatar: u.avatar, value: u.stats[field], wins: u.stats.aidaWins })),
    });
  }

  if (req.method === 'GET' && p === '/api/version') {
    const b = parseInt(url.searchParams.get('b'), 10) || 0;
    if (b === LATEST_BUILD && !db.seen[b]) { db.seen[b] = true; persist(); }
    return send(res, 200, { latest: LATEST_BUILD, block: b < LATEST_BUILD && !!db.seen[LATEST_BUILD], url: DOWNLOAD_URL });
  }

  if (req.method === 'GET' && p === '/api/me') {
    const a = authUser(req); if (!a) return send(res, 401, { error: 'Нужно войти' });
    return send(res, 200, { profile: publicUser(a.user), ranks: { kills: rankOf('bestKills', a.user), wins: rankOf('aidaWins', a.user), potatoes: rankOf('potatoes', a.user), wave: rankOf('aidaBest', a.user) } });
  }

  if (req.method !== 'POST') return send(res, 404, { error: 'Не найдено' });
  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'Неверный запрос' }); }

  if (p === '/api/promo') {
    if (limited(ip, 'promo', 12, 600e3)) return send(res, 429, { error: 'Слишком много попыток, подожди' });
    const code = String(body.code || '').trim().toUpperCase().slice(0, 24), dev = String(body.dev || '');
    if (!/^[a-f0-9]{24}$/.test(dev)) return send(res, 400, { error: 'Неверный запрос' });
    const pr = db.promos[code];
    if (!pr) return send(res, 404, { error: 'Такого промокода нет' });
    if (!pr.devs.includes(dev)) {
      if (pr.devs.length >= pr.max) return send(res, 410, { error: 'Промокод закончился' });
      pr.devs.push(dev); persist();
    }
    return send(res, 200, { ok: true, reward: pr.reward, left: pr.max - pr.devs.length });
  }

  if (p === '/api/register') {
    if (limited(ip, 'reg', 6, 3600e3)) return send(res, 429, { error: 'Слишком много регистраций с этого адреса' });
    const name = String(body.name || '').trim().replace(/\s+/g, ' ');
    if (!NAME_RE.test(name)) return send(res, 400, { error: 'Ник: 3–16 символов, буквы, цифры, _ . -' });
    if (!/^[a-f0-9]{64}$/.test(String(body.pass || ''))) return send(res, 400, { error: 'Неверный пароль' });
    const key = keyOf(name);
    if (db.users[key]) return send(res, 409, { error: 'Этот ник уже занят' });
    const salt = crypto.randomBytes(16).toString('hex');
    const user = { name, avatar: num(body.avatar, 63), salt, hash: hashPass(body.pass, salt), created: Date.now(), stats: newStats() };
    mergeStats(user, body.stats);
    db.users[key] = user; persist();
    return send(res, 200, { token: makeToken(key), profile: publicUser(user) });
  }

  if (p === '/api/login') {
    if (limited(ip, 'login', 20, 600e3)) return send(res, 429, { error: 'Слишком много попыток входа, подожди' });
    const key = keyOf(String(body.name || '')), user = db.users[key];
    if (!user || !/^[a-f0-9]{64}$/.test(String(body.pass || ''))) return send(res, 401, { error: 'Неверный ник или пароль' });
    const a = Buffer.from(hashPass(body.pass, user.salt), 'hex'), b = Buffer.from(user.hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send(res, 401, { error: 'Неверный ник или пароль' });
    mergeStats(user, body.stats); persist();
    return send(res, 200, { token: makeToken(key), profile: publicUser(user) });
  }

  if (p === '/api/stats') {
    const a = authUser(req); if (!a) return send(res, 401, { error: 'Нужно войти' });
    if (limited(ip, 'stats', 60, 600e3)) return send(res, 429, { error: 'Слишком часто' });
    if (body.avatar !== undefined) a.user.avatar = num(body.avatar, 63);
    mergeStats(a.user, body.stats); persist();
    return send(res, 200, { profile: publicUser(a.user), ranks: { kills: rankOf('bestKills', a.user), wins: rankOf('aidaWins', a.user), potatoes: rankOf('potatoes', a.user), wave: rankOf('aidaBest', a.user) } });
  }

  if (p === '/api/logout') {
    const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
    if (m) { delete db.tokens[m[1]]; persist(); }
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Не найдено' });
}

function mergeStats(user, s) {
  if (!s || typeof s !== 'object') return;
  for (const k of MONOTONIC) user.stats[k] = Math.max(user.stats[k] || 0, num(s[k], STAT_LIMITS[k]));
  if (user.stats.aidaWins > user.stats.aidaRuns) user.stats.aidaRuns = user.stats.aidaWins;
}

http.createServer((req, res) => handle(req, res).catch(e => { console.error(e); send(res, 500, { error: 'Ошибка сервера' }); }))
  .listen(PORT, () => console.log(`PIG TANKS server: порт ${PORT}, игроков: ${Object.keys(db.users).length}`));
