const express = require('express')
const crypto = require('crypto')
const { getPool } = require('../db')
const authMiddleware = require('../middleware/auth')

const router = express.Router()

const SQL_UNIT = { hour: 'HOUR', day: 'DAY', month: 'MONTH', year: 'YEAR' }

function generateKeyCode() {
  return crypto.randomBytes(8).toString('hex').toUpperCase().match(/.{4}/g).join('-')
}

function buildListFilter({ type, status, keyword }) {
  const conditions = []
  const params = []
  if (type) {
    conditions.push('type = ?')
    params.push(type)
  }
  if (status) {
    conditions.push('status = ?')
    params.push(status)
  } else {
    conditions.push("status != 'deleted'")
  }
  if (keyword) {
    conditions.push('(key_code LIKE ? OR name LIKE ? OR remark LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }
  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  }
}

// ========== Batch generate ==========
router.post('/generate', authMiddleware, async (req, res) => {
  const { name, type, maxCount, duration, durationUnit, quantity } = req.body

  if (!name || !type || !quantity || quantity < 1 || quantity > 500) {
    return res.json({ code: 400, message: '参数不合法' })
  }

  const pool = getPool()
  const conn = await pool.getConnection()
  const codes = []

  try {
    await conn.beginTransaction()
    for (let i = 0; i < quantity; i++) {
      const code = generateKeyCode()
      await conn.execute(
        'INSERT INTO card_keys (key_code, name, type, max_count, duration, duration_unit) VALUES (?, ?, ?, ?, ?, ?)',
        [code, name, type, type === 'count' ? maxCount : null, type === 'time' ? duration : null, type === 'time' ? durationUnit : null],
      )
      codes.push(code)
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }

  res.json({ code: 200, message: '生成成功', data: { count: codes.length } })
})

// ========== Sync expired time cards ==========
async function syncExpiredCards(pool) {
  await pool.execute(
    "UPDATE card_keys SET status = 'expired' WHERE type = 'time' AND status = 'active' AND expire_at IS NOT NULL AND expire_at <= NOW()",
  )
}

// ========== List ==========
router.get('/', authMiddleware, async (req, res) => {
  const page = parseInt(req.query.page) || 1
  const pageSize = parseInt(req.query.pageSize) || 20
  const { where, params } = buildListFilter(req.query)
  const offset = (page - 1) * pageSize
  const pool = getPool()

  await syncExpiredCards(pool)

  const [rows] = await pool.query(
    `SELECT * FROM card_keys ${where} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) as total FROM card_keys ${where}`,
    params,
  )

  res.json({ code: 200, data: { list: rows, total, page, pageSize } })
})

// ========== Ban / Unban ==========
router.put('/:id/ban', authMiddleware, async (req, res) => {
  const pool = getPool()
  await pool.execute("UPDATE card_keys SET status = 'banned' WHERE id = ?", [req.params.id])
  res.json({ code: 200, message: '封禁成功' })
})

router.put('/:id/unban', authMiddleware, async (req, res) => {
  const pool = getPool()
  await pool.execute("UPDATE card_keys SET status = 'active' WHERE id = ?", [req.params.id])
  res.json({ code: 200, message: '解封成功' })
})

// ========== Delete ==========
router.delete('/:id', authMiddleware, async (req, res) => {
  const pool = getPool()
  const [rows] = await pool.execute('SELECT status FROM card_keys WHERE id = ?', [req.params.id])
  if (rows.length === 0) {
    return res.json({ code: 404, message: '卡密不存在' })
  }

  if (rows[0].status === 'deleted') {
    await pool.execute('DELETE FROM card_keys WHERE id = ?', [req.params.id])
    return res.json({ code: 200, message: '已彻底删除' })
  }

  await pool.execute("UPDATE card_keys SET status = 'deleted' WHERE id = ?", [req.params.id])
  res.json({ code: 200, message: '已移至回收站' })
})

// ========== Update remark ==========
router.put('/:id/remark', authMiddleware, async (req, res) => {
  const { remark } = req.body
  const pool = getPool()
  await pool.execute('UPDATE card_keys SET remark = ? WHERE id = ?', [remark || '', req.params.id])
  res.json({ code: 200, message: '备注已更新' })
})

// ========== Adjust count / time ==========
router.put('/:id/adjust', authMiddleware, async (req, res) => {
  const { action, value } = req.body
  if (!action || !value || value <= 0) {
    return res.json({ code: 400, message: '参数不合法' })
  }

  const pool = getPool()
  const [rows] = await pool.execute('SELECT * FROM card_keys WHERE id = ?', [req.params.id])
  if (rows.length === 0) {
    return res.json({ code: 404, message: '卡密不存在' })
  }

  const card = rows[0]

  if (card.type === 'count') {
    await adjustCount(pool, card, action, value)
  } else {
    await adjustTime(pool, card, action, value)
  }

  res.json({ code: 200, message: '调整成功' })
})

async function adjustCount(pool, card, action, value) {
  const delta = action === 'add' ? value : -value
  const newMax = card.max_count === -1 ? -1 : Math.max(card.max_count + delta, 0)
  let newStatus = card.status
  if (newMax === -1 || newMax > card.used_count) {
    newStatus = 'active'
  } else if (card.status !== 'banned') {
    newStatus = 'used'
  }
  await pool.execute('UPDATE card_keys SET max_count = ?, status = ? WHERE id = ?', [newMax, newStatus, card.id])
}

async function adjustTime(pool, card, action, value) {
  const unit = SQL_UNIT[card.duration_unit] || 'DAY'

  if (!card.activated_at) {
    const delta = action === 'add' ? value : -value
    const newDuration = Math.max(card.duration + delta, 1)
    await pool.execute('UPDATE card_keys SET duration = ? WHERE id = ?', [newDuration, card.id])
    return
  }

  const fn = action === 'add' ? 'DATE_ADD' : 'DATE_SUB'
  await pool.execute(
    `UPDATE card_keys SET expire_at = ${fn}(expire_at, INTERVAL ? ${unit}) WHERE id = ?`,
    [value, card.id],
  )
  const [[updated]] = await pool.execute('SELECT expire_at FROM card_keys WHERE id = ?', [card.id])
  const newStatus = new Date(updated.expire_at) > new Date() ? 'active' : 'expired'
  if (card.status !== 'banned') {
    await pool.execute('UPDATE card_keys SET status = ? WHERE id = ?', [newStatus, card.id])
  }
}

// ========== Public verify ==========
router.post('/verify', async (req, res) => {
  const { keyCode } = req.body
  if (!keyCode) {
    return res.json({ code: 400, valid: false, message: '卡密不能为空' })
  }

  const pool = getPool()
  const [rows] = await pool.execute('SELECT * FROM card_keys WHERE key_code = ?', [keyCode])
  if (rows.length === 0) {
    return res.json({ code: 200, valid: false, message: '卡密不存在' })
  }

  const card = rows[0]
  if (card.status === 'banned') {
    return res.json({ code: 200, valid: false, message: '卡密已被封禁' })
  }
  if (card.status === 'used') {
    return res.json({ code: 200, valid: false, message: '卡密已用完' })
  }
  if (card.status === 'expired') {
    return res.json({ code: 200, valid: false, message: '卡密已过期' })
  }

  if (card.type === 'count') {
    return res.json(await verifyCountCard(pool, card))
  }
  return res.json(await verifyTimeCard(pool, card))
})

async function verifyCountCard(pool, card) {
  if (card.max_count !== -1 && card.used_count >= card.max_count) {
    await pool.execute("UPDATE card_keys SET status = 'used' WHERE id = ?", [card.id])
    return { code: 200, valid: false, message: '卡密已用完' }
  }

  const newUsed = card.used_count + 1
  const exhausted = card.max_count !== -1 && newUsed >= card.max_count
  await pool.execute('UPDATE card_keys SET used_count = ?, status = ? WHERE id = ?', [
    newUsed,
    exhausted ? 'used' : 'active',
    card.id,
  ])

  return {
    code: 200,
    valid: true,
    message: '验证成功',
    data: { remaining: card.max_count === -1 ? -1 : card.max_count - newUsed },
  }
}

async function verifyTimeCard(pool, card) {
  const now = new Date()

  if (!card.activated_at) {
    const unit = SQL_UNIT[card.duration_unit] || 'DAY'
    await pool.execute(
      `UPDATE card_keys SET activated_at = NOW(), expire_at = DATE_ADD(NOW(), INTERVAL ? ${unit}) WHERE id = ?`,
      [card.duration, card.id],
    )
    const [[updated]] = await pool.execute('SELECT expire_at FROM card_keys WHERE id = ?', [card.id])
    return { code: 200, valid: true, message: '卡密已激活', data: { expireAt: updated.expire_at } }
  }

  if (now >= new Date(card.expire_at)) {
    await pool.execute("UPDATE card_keys SET status = 'expired' WHERE id = ?", [card.id])
    return { code: 200, valid: false, message: '卡密已过期' }
  }

  return { code: 200, valid: true, message: '验证成功', data: { expireAt: card.expire_at } }
}

module.exports = router
