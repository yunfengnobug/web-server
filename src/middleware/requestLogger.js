const morgan = require("morgan");
const logger = require("../logger");
const { getPool } = require("../db");

const morganStream = {
  write: (message) => logger.http(message.trim()),
};

const morganMiddleware = morgan(
  ":remote-addr :method :url :status :res[content-length] - :response-time ms",
  { stream: morganStream },
);

function requestStatsMiddleware(req, res, next) {
  const start = Date.now();

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
    };

    pool
      .execute(
        "INSERT INTO request_logs (method, path, status_code, response_time_ms, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)",
        [
          record.method,
          record.path,
          record.status_code,
          record.response_time_ms,
          record.ip,
          record.user_agent,
        ],
      )
      .catch(() => {});
  };

  next();
}

module.exports = { morganMiddleware, requestStatsMiddleware };
