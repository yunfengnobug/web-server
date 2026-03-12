const winston = require("winston");
const DailyRotateFile = require("winston-daily-rotate-file");
const path = require("path");
const fs = require("fs");

const logsDir = path.join(__dirname, "..", "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const MAX_TOTAL_SIZE = 15 * 1024 * 1024 * 1024;

function cleanLogsBySize() {
  try {
    const files = fs
      .readdirSync(logsDir)
      .map((f) => {
        const fp = path.join(logsDir, f);
        const stat = fs.statSync(fp);
        return { name: f, path: fp, size: stat.size, mtime: stat.mtimeMs };
      })
      .filter((f) => f.name.endsWith(".log"))
      .sort((a, b) => a.mtime - b.mtime);

    let totalSize = files.reduce((sum, f) => sum + f.size, 0);

    while (totalSize > MAX_TOTAL_SIZE && files.length > 1) {
      const oldest = files.shift();
      fs.unlinkSync(oldest.path);
      totalSize -= oldest.size;
    }
  } catch {
    // silently ignore cleanup errors
  }
}

cleanLogsBySize();

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
    return `${timestamp} [${level.toUpperCase()}] ${stack || message}${metaStr}`;
  }),
);

const appTransport = new DailyRotateFile({
  dirname: logsDir,
  filename: "app-%DATE%.log",
  datePattern: "YYYY-MM-DD",
  maxFiles: "7d",
  zippedArchive: false,
});

const errorTransport = new DailyRotateFile({
  dirname: logsDir,
  filename: "error-%DATE%.log",
  datePattern: "YYYY-MM-DD",
  level: "error",
  maxFiles: "7d",
  zippedArchive: false,
});

appTransport.on("rotate", () => cleanLogsBySize());
errorTransport.on("rotate", () => cleanLogsBySize());

const transports = [appTransport, errorTransport];

if (process.env.NODE_ENV !== "production") {
  transports.push(
    new winston.transports.Console({
      format: winston.format.combine(winston.format.colorize(), logFormat),
    }),
  );
}

const logger = winston.createLogger({
  level: process.env.NODE_ENV === "production" ? "http" : "debug",
  format: logFormat,
  transports,
  exitOnError: false,
});

module.exports = logger;
