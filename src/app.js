const express = require("express");
const cors = require("cors");
const ENV = process.env.NODE_ENV || "development";
require("dotenv").config({ path: `.env.${ENV}` });

const logger = require("./logger");
logger.info(`[ENV] ${ENV}`);
const { initDb, getPool } = require("./db");
const {
  helmetMiddleware,
  authLimiter,
  publicApiLimiter,
  writeLimiter,
  readLimiter,
  reportLimiter,
  ipBlockCheck,
  attackDetection,
  setSecurityEventWriter,
} = require("./middleware/security");
const { morganMiddleware, requestStatsMiddleware } = require("./middleware/requestLogger");

const authRoutes = require("./routes/auth");
const cardsRoutes = require("./routes/cards");
const cardKeyRoutes = require("./routes/cardKey");
const cardClassRoutes = require("./routes/cardClass");
const cursorRoutes = require("./routes/cursor");
const verifyRecordRoutes = require("./routes/verifyRecord");
const userCardCategoryRoutes = require("./routes/userCardCategory");
const userCardRoutes = require("./routes/userCard");
const statsRoutes = require("./routes/stats");
const monitorRoutes = require("./routes/monitor");

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

app.use(helmetMiddleware);
app.use(ipBlockCheck);
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : "*",
    credentials: true,
  }),
);
app.use(express.json({ limit: "10mb" }));
app.use(attackDetection);
app.use(morganMiddleware);
app.use(requestStatsMiddleware);

app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/monitor", reportLimiter, monitorRoutes);

app.use("/api/card-keys/verify", publicApiLimiter);
app.use("/api/card-keys/query-content", publicApiLimiter);
app.use("/api/card-keys/batch-query-content", publicApiLimiter);
app.use("/api/cursor", publicApiLimiter, cursorRoutes);

const tieredRouter = (routeHandler) => {
  return (req, res, next) => {
    if (req.method === "GET") return readLimiter(req, res, () => routeHandler(req, res, next));
    return writeLimiter(req, res, () => routeHandler(req, res, next));
  };
};

app.use("/api/cards", tieredRouter(cardsRoutes));
app.use("/api/card-keys", tieredRouter(cardKeyRoutes));
app.use("/api/card-classes", tieredRouter(cardClassRoutes));
app.use("/api/verify-records", tieredRouter(verifyRecordRoutes));
app.use("/api/user-card-categories", tieredRouter(userCardCategoryRoutes));
app.use("/api/user-cards", tieredRouter(userCardRoutes));
app.use("/api/stats", readLimiter, statsRoutes);

app.use((err, _req, res, _next) => {
  logger.error("Unhandled error: %s", err.stack || err.message || err);
  res.status(500).json({ code: 500, message: "服务器内部错误" });
});

initDb()
  .then(() => {
    setSecurityEventWriter(async (event) => {
      const pool = getPool();
      if (!pool) return;
      await pool.execute(
        "INSERT INTO security_events (type, level, ip, path, detail, blocked, params) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          event.type,
          event.level,
          event.ip,
          (event.path || "").substring(0, 255),
          (event.detail || "").substring(0, 1000),
          event.blocked ? 1 : 0,
          (event.params || "").substring(0, 2000),
        ],
      );
    });

    app.listen(PORT, () => {
      logger.info(`Server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    logger.error("Failed to initialize database: %s", err.message || err);
    process.exit(1);
  });
