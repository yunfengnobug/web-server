const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const logger = require('../logger')
const { collectParams } = require('./requestLogger')

const helmetMiddleware = helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
})

const rateLimitMsg = { code: 429, message: '请求过于频繁，请稍后再试' }

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 429, message: '登录尝试过于频繁，请稍后再试' },
})

const publicApiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitMsg,
})

const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitMsg,
})

const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitMsg,
})

const reportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitMsg,
})

// --- Attack detection ---

const ipRequestCounts = new Map()
const blockedIps = new Map()
const BLOCK_THRESHOLD = 100
const BLOCK_WINDOW_MS = 60 * 1000
const BLOCK_DURATION_MS = 10 * 60 * 1000

setInterval(() => {
  const now = Date.now()
  for (const [ip, expiresAt] of blockedIps) {
    if (now >= expiresAt) blockedIps.delete(ip)
  }
  for (const [ip, data] of ipRequestCounts) {
    if (now - data.windowStart > BLOCK_WINDOW_MS) ipRequestCounts.delete(ip)
  }
}, 30_000)

const TRAVERSAL_RE = /(\.\.[/\\]|%2e%2e)/i
const SQLI_RE = /('.*(--)|(union\s+(all\s+)?select)|(\bor\b\s+\d+\s*=\s*\d+)|(drop\s+table)|(insert\s+into)|(select\s+.*from))/i
const XSS_RE = /(<script|javascript:|onerror\s*=|onload\s*=|eval\s*\(|document\.(cookie|location))/i
const SCANNER_UA_RE = /(sqlmap|nikto|dirbuster|nmap|masscan|wpscan|acunetix|nessus|openvas|burpsuite|hydra|medusa)/i

let _securityEventWriter = null

function setSecurityEventWriter(fn) {
  _securityEventWriter = fn
}

function writeSecurityEvent(event) {
  if (_securityEventWriter) {
    _securityEventWriter(event).catch(() => {})
  }
  logger.warn(`[SECURITY] ${event.type} from ${event.ip}: ${event.detail}`)
}

function getBlockedIps() {
  const result = []
  const now = Date.now()
  for (const [ip, expiresAt] of blockedIps) {
    if (now < expiresAt) {
      result.push({ ip, expiresAt: new Date(expiresAt).toISOString(), remainingMs: expiresAt - now })
    }
  }
  return result
}

function unblockIp(ip) {
  blockedIps.delete(ip)
  writeSecurityEvent({ type: 'ip_unblocked', level: 'low', ip, path: '', detail: `手动解封 IP: ${ip}`, blocked: 0 })
}

function ipBlockCheck(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || ''
  if (blockedIps.has(ip) && Date.now() < blockedIps.get(ip)) {
    return res.status(403).json({ code: 403, message: '您的 IP 已被临时封禁' })
  }
  next()
}

function attackDetection(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || ''
  const url = decodeURIComponent(req.originalUrl || req.url || '')
  const ua = req.headers['user-agent'] || ''
  const now = Date.now()
  const params = collectParams(req)

  // Frequency tracking
  let data = ipRequestCounts.get(ip)
  if (!data || now - data.windowStart > BLOCK_WINDOW_MS) {
    data = { count: 0, windowStart: now }
    ipRequestCounts.set(ip, data)
  }
  data.count++

  if (data.count > BLOCK_THRESHOLD && !blockedIps.has(ip)) {
    blockedIps.set(ip, now + BLOCK_DURATION_MS)
    writeSecurityEvent({ type: 'ip_blocked', level: 'critical', ip, path: url, detail: `1分钟内请求 ${data.count} 次，自动封禁 10 分钟`, blocked: 1, params })
    return res.status(403).json({ code: 403, message: '您的 IP 已被临时封禁' })
  }

  // Pattern detection
  if (TRAVERSAL_RE.test(url)) {
    writeSecurityEvent({ type: 'path_traversal', level: 'high', ip, path: url, detail: `路径遍历攻击: ${url.substring(0, 200)}`, blocked: 0, params })
  }

  if (SQLI_RE.test(url)) {
    writeSecurityEvent({ type: 'sql_injection', level: 'critical', ip, path: url, detail: `SQL注入探测: ${url.substring(0, 200)}`, blocked: 1, params })
    return res.status(403).json({ code: 403, message: '非法请求' })
  }

  if (XSS_RE.test(url)) {
    writeSecurityEvent({ type: 'xss_probe', level: 'high', ip, path: url, detail: `XSS探测: ${url.substring(0, 200)}`, blocked: 1, params })
    return res.status(403).json({ code: 403, message: '非法请求' })
  }

  if (SCANNER_UA_RE.test(ua)) {
    writeSecurityEvent({ type: 'scanner', level: 'medium', ip, path: url, detail: `扫描器UA: ${ua.substring(0, 200)}`, blocked: 1, params })
    return res.status(403).json({ code: 403, message: '非法请求' })
  }

  next()
}

module.exports = {
  helmetMiddleware,
  authLimiter,
  publicApiLimiter,
  writeLimiter,
  readLimiter,
  reportLimiter,
  ipBlockCheck,
  attackDetection,
  setSecurityEventWriter,
  getBlockedIps,
  unblockIp,
}
