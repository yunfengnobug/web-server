const express = require("express");
const router = express.Router();
const { getPool } = require("../db");

router.post("/report", async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) return res.status(503).json({ code: 503, message: "服务不可用" });

    const events = Array.isArray(req.body) ? req.body : [req.body];
    const ip = req.ip || req.socket?.remoteAddress || "";
    const ua = (req.headers["user-agent"] || "").substring(0, 500);

    const validTypes = ["error", "performance", "environment"];

    for (const evt of events.slice(0, 50)) {
      if (!evt.type || !validTypes.includes(evt.type) || !evt.payload) continue;
      const payload = typeof evt.payload === "string" ? evt.payload : JSON.stringify(evt.payload);
      await pool
        .execute("INSERT INTO client_events (type, payload, ip, user_agent) VALUES (?, ?, ?, ?)", [
          evt.type,
          payload,
          ip,
          ua,
        ])
        .catch(() => {});
    }

    res.json({ code: 200, message: "ok" });
  } catch {
    res.status(500).json({ code: 500, message: "上报失败" });
  }
});

module.exports = router;
