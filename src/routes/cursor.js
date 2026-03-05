const express = require("express");
const { getPool } = require("../db");

const router = express.Router();

router.post("/upgrade", async (req, res) => {
  const { sessionToken, cardKey } = req.body;

  if (!sessionToken || !cardKey) {
    return res.json({ code: 400, message: "缺少必要参数" });
  }

  const pool = getPool();

  // 验证卡密
  const [rows] = await pool.execute("SELECT * FROM card_keys WHERE key_code = ?", [cardKey]);
  if (rows.length === 0) {
    return res.json({ code: 400, message: "卡密不存在" });
  }

  const card = rows[0];
  if (card.status === "banned") {
    return res.json({ code: 400, message: "卡密已被封禁" });
  }
  if (card.status === "used") {
    return res.json({ code: 400, message: "卡密已用完" });
  }
  if (card.status === "expired") {
    return res.json({ code: 400, message: "卡密已过期" });
  }

  if (card.type === "time" && card.expire_at && new Date() >= new Date(card.expire_at)) {
    await pool.execute("UPDATE card_keys SET status = 'expired' WHERE id = ?", [card.id]);
    return res.json({ code: 400, message: "卡密已过期" });
  }

  // 调用 Cursor checkout API（使用 https 模块，避免 fetch 的 Cookie 限制）
  const https = require("https");
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
      return res.json({ code: 200, message: "升级成功", data: parsedBody });
    }
    return res.json({
      code: data.status,
      message: "升级失败，请检查session token是否复制完整，或者账号是否符合要求",
      data: parsedBody,
    });
  } catch (err) {
    console.error("[Cursor Checkout] error:", err);
    return res.json({ code: 500, message: "调用 Cursor API 失败", error: err.message });
  }
});

module.exports = router;
