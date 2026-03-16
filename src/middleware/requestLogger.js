const morgan = require("morgan");
const logger = require("../logger");
const { getPool } = require("../db");

const SENSITIVE_KEYS = /^(password|token|secret|authorization|cookie|session)$/i;

function sanitizeParams(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.test(key)) {
      result[key] = "***";
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = sanitizeParams(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function collectParams(req) {
  const hasQuery = req.query && Object.keys(req.query).length > 0;
  const hasBody = req.body && typeof req.body === "object" && Object.keys(req.body).length > 0;
  if (!hasQuery && !hasBody) return "";
  const data = {};
  if (hasQuery) data.query = req.query;
  if (hasBody) data.body = sanitizeParams(req.body);
  return JSON.stringify(data).substring(0, 2000);
}

const morganStream = {
  write: (message) => logger.http(message.trim()),
};

const morganMiddleware = morgan(
  ":remote-addr :method :url :status :res[content-length] - :response-time ms",
  { stream: morganStream },
);

function requestStatsMiddleware(req, res, next) {
  const start = Date.now();
  const params = collectParams(req);

  const originalEnd = res.end;
  res.end = function (...args) {
    const duration = Date.now() - start;
    originalEnd.apply(res, args);

    const pool = getPool();
    if (!pool) return;

    const record = {
      method: req.method,
      path: (req.originalUrl || req.url || "").substring(0, 255),
      status_code: res.statusCode,
      response_time_ms: duration,
      ip: req.ip || req.socket?.remoteAddress || "",
      user_agent: (req.headers["user-agent"] || "").substring(0, 500),
      params,
    };

    pool
      .execute(
        "INSERT INTO request_logs (method, path, status_code, response_time_ms, ip, user_agent, params) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          record.method,
          record.path,
          record.status_code,
          record.response_time_ms,
          record.ip,
          record.user_agent,
          record.params,
        ],
      )
      .catch(() => {});
  };

  next();
}

module.exports = { morganMiddleware, requestStatsMiddleware, collectParams };
