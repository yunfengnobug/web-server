const express = require("express");
const https = require("https");
const { getPool } = require("../db");
const logger = require("../logger");

const router = express.Router();

async function recordVerify(pool, { cardId, cardKeyCode, sessionToken, success, message }) {
  try {
    await pool.execute(
      "INSERT INTO verify_records (card_id, card_key_code, session_token, action, success, message) VALUES (?, ?, ?, 'upgrade', ?, ?)",
      [cardId, cardKeyCode, sessionToken || "", success ? 1 : 0, message || ""],
    );
  } catch (err) {
    logger.error("[VerifyRecord] insert failed:", err);
  }
}

router.post("/upgrade", async (req, res) => {
  const { sessionToken, cardKey, appCode } = req.body;

  if (!sessionToken || !cardKey) {
    return res.json({ code: 400, message: "缺少必要参数" });
  }

  const pool = getPool();

  let rows;
  if (appCode) {
    [rows] = await pool.execute(
      "SELECT ck.* FROM card_keys ck JOIN card_categories cc ON ck.category_id = cc.id WHERE ck.key_code = ? AND cc.app_code = ?",
      [cardKey, appCode],
    );
  } else {
    [rows] = await pool.execute("SELECT * FROM card_keys WHERE key_code = ?", [cardKey]);
  }
  if (rows.length === 0) {
    await recordVerify(pool, { cardId: 0, cardKeyCode: cardKey, sessionToken, success: false, message: "卡密不存在" });
    return res.json({ code: 400, message: "卡密不存在" });
  }

  const card = rows[0];

  if (card.status === "banned") {
    await recordVerify(pool, { cardId: card.category_id || 0, cardKeyCode: cardKey, sessionToken, success: false, message: "卡密已被封禁" });
    return res.json({ code: 400, message: "卡密已被封禁" });
  }
  if (card.status === "used") {
    await recordVerify(pool, { cardId: card.category_id || 0, cardKeyCode: cardKey, sessionToken, success: false, message: "卡密已用完" });
    return res.json({ code: 400, message: "卡密已用完" });
  }
  if (card.status === "expired") {
    await recordVerify(pool, { cardId: card.category_id || 0, cardKeyCode: cardKey, sessionToken, success: false, message: "卡密已过期" });
    return res.json({ code: 400, message: "卡密已过期" });
  }

  if (card.type === "time" && card.expire_at && new Date() >= new Date(card.expire_at)) {
    await pool.execute("UPDATE card_keys SET status = 'expired' WHERE id = ?", [card.id]);
    await recordVerify(pool, { cardId: card.category_id || 0, cardKeyCode: cardKey, sessionToken, success: false, message: "卡密已过期" });
    return res.json({ code: 400, message: "卡密已过期" });
  }

  const requestBody = JSON.stringify({
    tier: "ultra",
    allowAutomaticPayment: true,
    yearly: false,
  });

  const cookieValue = `WorkosCursorSessionToken=${sessionToken}`;

  try {
    const data = await new Promise((resolve, reject) => {
      const request = https.request(
        {
          hostname: "cursor.com",
          path: "/api/checkout",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(requestBody),
            Cookie: cookieValue,
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          },
        },
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => {
            resolve({ status: response.statusCode, body });
          });
        },
      );

      request.on("error", reject);
      request.write(requestBody);
      request.end();
    });

    let parsedBody = data.body;
    try {
      parsedBody = JSON.parse(data.body);
    } catch {
      // keep as string
    }

    if (data.status === 200) {
      try {
        if (card.type === "count") {
          const newUsed = card.used_count + 1;
          const exhausted = card.max_count !== -1 && newUsed >= card.max_count;
          await pool.execute("UPDATE card_keys SET used_count = ?, status = ? WHERE id = ?", [
            newUsed,
            exhausted ? "used" : "active",
            card.id,
          ]);
        } else if (card.type === "time" && !card.activated_at) {
          const unitMap = { hour: "HOUR", day: "DAY", month: "MONTH", year: "YEAR" };
          const unit = unitMap[card.duration_unit] || "DAY";
          await pool.execute(
            `UPDATE card_keys SET activated_at = NOW(), expire_at = DATE_ADD(NOW(), INTERVAL ? ${unit}) WHERE id = ?`,
            [card.duration, card.id],
          );
        }
      } catch (dbErr) {
        logger.error("[Upgrade] post-process failed:", dbErr);
      }

      await recordVerify(pool, { cardId: card.category_id || 0, cardKeyCode: cardKey, sessionToken, success: true, message: "升级成功" });
      return res.json({ code: 200, message: "升级成功", data: parsedBody });
    }

    await recordVerify(pool, { cardId: card.category_id || 0, cardKeyCode: cardKey, sessionToken, success: false, message: "升级失败" });
    return res.json({
      code: data.status,
      message: "升级失败，请检查session token是否复制完整，或者账号是否符合要求",
      data: parsedBody,
    });
  } catch (err) {
    logger.error("[Cursor Checkout] error:", err);
    await recordVerify(pool, { cardId: card.category_id || 0, cardKeyCode: cardKey, sessionToken, success: false, message: err.message });
    return res.json({ code: 500, message: "调用 Cursor API 失败", error: err.message });
  }
});

module.exports = router;
