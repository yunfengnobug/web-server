const express = require('express')
const crypto = require('crypto')
const { getPool } = require('../db')
const authMiddleware = require('../middleware/auth')

const router = express.Router()

const SQL_UNIT = { hour: 'HOUR', day: 'DAY', month: 'MONTH', year: 'YEAR' }

function generateKeyCode() {
  return crypto.randomBytes(8).toString('hex').toUpperCase().match(/.{4}/g).join('-')
}

function buildListFilter({ type, status, keyword, classId, isSold, activatedFrom, activatedTo, createdFrom, createdTo }) {
  const conditions = []
  const params = []
  if (classId) {
    conditions.push('ck.class_id = ?')
    params.push(classId)
  }
  if (type) {
    conditions.push('ck.type = ?')
    params.push(type)
  }
  if (status) {
    conditions.push('ck.status = ?')
    params.push(status)
  } else {
    conditions.push("ck.status != 'deleted'")
  }
  if (keyword) {
    conditions.push('(ck.key_code LIKE ? OR ck.remark LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`)
  }
  if (isSold !== undefined && isSold !== '') {
    conditions.push('ck.is_sold = ?')
    params.push(Number(isSold))
  }
  if (activatedFrom) {
    conditions.push('ck.activated_at >= ?')
    params.push(activatedFrom)
  }
  if (activatedTo) {
    conditions.push('ck.activated_at <= ?')
    params.push(activatedTo)
  }
  if (createdFrom) {
    conditions.push('ck.created_at >= ?')
    params.push(createdFrom)
  }
  if (createdTo) {
    conditions.push('ck.created_at <= ?')
    params.push(createdTo)
  }
  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  }
}

// ========== Batch generate ==========
router.post('/generate', authMiddleware, async (req, res) => {
  const { quantity, classId } = req.body

  if (!quantity || quantity < 1 || quantity > 500 || !classId) {
    return res.json({ code: 400, message: '参数不合法' })
  }

  const pool = getPool()

  const [[cardClass]] = await pool.execute(
    'SELECT cl.*, cc.name AS category_name FROM card_classes cl JOIN card_categories cc ON cl.category_id = cc.id WHERE cl.id = ?',
    [classId],
  )
  if (!cardClass) {
    return res.json({ code: 404, message: '卡类不存在' })
  }

  const { category_id, category_name, type, max_count, duration, duration_unit } = cardClass

  const conn = await pool.getConnection()
  const codes = []

  try {
    await conn.beginTransaction()
    for (let i = 0; i < quantity; i++) {
      const code = generateKeyCode()
      await conn.execute(
        'INSERT INTO card_keys (key_code, name, type, max_count, duration, duration_unit, category_id, class_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [code, category_name, type, max_count, duration, duration_unit, category_id, classId],
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

  const sortOrder = req.query.sortOrder === 'ASC' ? 'ASC' : 'DESC'
  const [rows] = await pool.query(
    `SELECT ck.*, IF(ck.bound_user_card_id IS NOT NULL OR cc.id IS NOT NULL, 1, 0) AS has_content
     FROM card_keys ck
     LEFT JOIN card_contents cc ON ck.id = cc.card_key_id
     ${where} ORDER BY ck.created_at ${sortOrder} LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) as total FROM card_keys ck ${where}`,
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

// ========== Batch delete ==========
router.post('/batch-delete', authMiddleware, async (req, res) => {
  const { ids } = req.body
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.json({ code: 400, message: '参数不合法' })
  }

  const pool = getPool()
  const placeholders = ids.map(() => '?').join(',')

  const [rows] = await pool.query(
    `SELECT id, status FROM card_keys WHERE id IN (${placeholders})`,
    ids,
  )

  const softIds = rows.filter((r) => r.status !== 'deleted').map((r) => r.id)
  const hardIds = rows.filter((r) => r.status === 'deleted').map((r) => r.id)

  if (softIds.length > 0) {
    const sp = softIds.map(() => '?').join(',')
    await pool.query(`UPDATE card_keys SET status = 'deleted' WHERE id IN (${sp})`, softIds)
  }
  if (hardIds.length > 0) {
    const hp = hardIds.map(() => '?').join(',')
    await pool.query(`DELETE FROM card_keys WHERE id IN (${hp})`, hardIds)
  }

  res.json({ code: 200, message: `已处理 ${rows.length} 条` })
})

// ========== Update sold status ==========
router.put('/:id/sold', authMiddleware, async (req, res) => {
  const { isSold } = req.body
  if (isSold === undefined || ![0, 1].includes(Number(isSold))) {
    return res.json({ code: 400, message: '参数不合法' })
  }
  const pool = getPool()
  await pool.execute('UPDATE card_keys SET is_sold = ? WHERE id = ?', [Number(isSold), req.params.id])
  res.json({ code: 200, message: isSold ? '已标记为售出' : '已标记为未售' })
})

// ========== Batch update sold status ==========
router.post('/batch-sold', authMiddleware, async (req, res) => {
  const { ids, isSold } = req.body
  if (!ids || !Array.isArray(ids) || ids.length === 0 || ![0, 1].includes(Number(isSold))) {
    return res.json({ code: 400, message: '参数不合法' })
  }
  const pool = getPool()
  const placeholders = ids.map(() => '?').join(',')
  await pool.query(`UPDATE card_keys SET is_sold = ? WHERE id IN (${placeholders})`, [Number(isSold), ...ids])
  res.json({ code: 200, message: `已更新 ${ids.length} 条卡密` })
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

// ========== Extract (提卡) ==========
router.post('/extract', authMiddleware, async (req, res) => {
  const { classId, quantity, markSold = true } = req.body
  if (!classId || !quantity || quantity < 1 || quantity > 500) {
    return res.json({ code: 400, message: '参数不合法' })
  }

  const pool = getPool()
  const [rows] = await pool.query(
    "SELECT id, key_code FROM card_keys WHERE class_id = ? AND is_sold = 0 AND status != 'deleted' ORDER BY created_at ASC LIMIT ?",
    [classId, quantity],
  )

  if (rows.length === 0) {
    return res.json({ code: 400, message: '没有可提取的未售出卡密' })
  }

  if (markSold) {
    const ids = rows.map((r) => r.id)
    const placeholders = ids.map(() => '?').join(',')
    await pool.query(`UPDATE card_keys SET is_sold = 1 WHERE id IN (${placeholders})`, ids)
  }

  res.json({
    code: 200,
    message: `成功提取 ${rows.length} 个卡密`,
    data: { keys: rows.map((r) => r.key_code), count: rows.length },
  })
})

// ========== Batch adjust ==========
router.post('/batch-adjust', authMiddleware, async (req, res) => {
  const { ids, action, value } = req.body
  if (!ids || !Array.isArray(ids) || ids.length === 0 || !action || !value || value <= 0) {
    return res.json({ code: 400, message: '参数不合法' })
  }

  const pool = getPool()
  const placeholders = ids.map(() => '?').join(',')
  const [rows] = await pool.query(
    `SELECT * FROM card_keys WHERE id IN (${placeholders})`,
    ids,
  )

  let successCount = 0
  for (const card of rows) {
    try {
      if (card.type === 'count') {
        await adjustCount(pool, card, action, value)
      } else {
        await adjustTime(pool, card, action, value)
      }
      successCount++
    } catch { /* skip failed */ }
  }

  res.json({ code: 200, message: `成功调整 ${successCount} 条卡密` })
})

// ========== Public verify ==========
router.post('/verify', async (req, res) => {
  const { keyCode, categoryCode } = req.body
  if (!keyCode) {
    return res.json({ code: 400, valid: false, message: '卡密不能为空' })
  }

  const pool = getPool()

  let rows
  if (categoryCode) {
    ;[rows] = await pool.execute(
      `SELECT ck.* FROM card_keys ck
       JOIN card_classes cl ON ck.class_id = cl.id
       JOIN card_categories cc ON cl.category_id = cc.id
       WHERE ck.key_code = ? AND cc.code = ?`,
      [keyCode, categoryCode],
    )
  } else {
    ;[rows] = await pool.execute('SELECT * FROM card_keys WHERE key_code = ?', [keyCode])
  }
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
  await pool.execute('UPDATE card_keys SET used_count = ?, status = ?, is_sold = 1 WHERE id = ?', [
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
      `UPDATE card_keys SET activated_at = NOW(), expire_at = DATE_ADD(NOW(), INTERVAL ? ${unit}), is_sold = 1 WHERE id = ?`,
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

// ========== Public query content ==========
router.post('/query-content', async (req, res) => {
  const { keyCode, categoryCode } = req.body
  if (!keyCode) {
    return res.json({ code: 400, message: '卡密不能为空' })
  }

  const pool = getPool()

  let rows
  if (categoryCode) {
    ;[rows] = await pool.execute(
      `SELECT ck.*, cat.bound_user_category_id FROM card_keys ck
       JOIN card_classes cl ON ck.class_id = cl.id
       JOIN card_categories cat ON cl.category_id = cat.id
       WHERE ck.key_code = ? AND cat.code = ?`,
      [keyCode, categoryCode],
    )
  } else {
    ;[rows] = await pool.execute(
      `SELECT ck.*, cat.bound_user_category_id FROM card_keys ck
       LEFT JOIN card_classes cl ON ck.class_id = cl.id
       LEFT JOIN card_categories cat ON cl.category_id = cat.id
       WHERE ck.key_code = ?`,
      [keyCode],
    )
  }

  if (rows.length === 0) {
    return res.json({ code: 400, message: '卡密不存在' })
  }

  const card = rows[0]
  if (card.status === 'banned') {
    return res.json({ code: 400, message: '卡密已被封禁' })
  }
  if (card.status === 'used') {
    if (!card.bound_user_card_id) {
      return res.json({ code: 400, message: '卡密已使用' })
    }
  }
  if (card.status === 'expired') {
    return res.json({ code: 400, message: '卡密已过期' })
  }
  if (card.type !== 'count') {
    return res.json({ code: 400, message: '仅次卡支持查询内容' })
  }

  if (card.bound_user_card_id) {
    const [uc] = await pool.execute(
      `SELECT u.content, c.content_hint FROM user_cards u
       LEFT JOIN user_card_categories c ON u.category_id = c.id
       WHERE u.id = ?`,
      [card.bound_user_card_id],
    )
    if (uc.length === 0) {
      return res.json({ code: 400, message: '绑定的用户卡密已被移除' })
    }
    return res.json({ code: 200, message: '查询成功', data: { content: uc[0].content, contentType: 'text', contentHint: uc[0].content_hint || '' } })
  }

  if (!card.bound_user_category_id) {
    const [legacy] = await pool.execute(
      'SELECT content, content_type FROM card_contents WHERE card_key_id = ?',
      [card.id],
    )
    if (legacy.length > 0) {
      return res.json({ code: 200, message: '查询成功', data: { content: legacy[0].content, contentType: legacy[0].content_type } })
    }
    return res.json({ code: 400, message: '该分类未绑定用户卡密分类' })
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [available] = await conn.execute(
      'SELECT id, content FROM user_cards WHERE category_id = ? AND is_assigned = 0 LIMIT 1 FOR UPDATE',
      [card.bound_user_category_id],
    )
    if (available.length === 0) {
      await conn.rollback()
      return res.json({ code: 400, message: '库存不足，该分类下已无可用的用户卡密' })
    }

    const userCard = available[0]
    await conn.execute(
      'UPDATE user_cards SET is_assigned = 1, assigned_to_key_id = ?, assigned_at = NOW() WHERE id = ?',
      [card.id, userCard.id],
    )
    await conn.execute(
      'UPDATE card_keys SET bound_user_card_id = ?, used_count = used_count + 1, is_sold = 1, status = ? WHERE id = ?',
      [userCard.id, (card.max_count !== -1 && card.used_count + 1 >= card.max_count) ? 'used' : 'active', card.id],
    )
    await conn.commit()

    const [hintRow] = await pool.execute('SELECT content_hint FROM user_card_categories WHERE id = ?', [card.bound_user_category_id])
    const contentHint = hintRow.length > 0 ? (hintRow[0].content_hint || '') : ''
    return res.json({ code: 200, message: '查询成功', data: { content: userCard.content, contentType: 'text', contentHint } })
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
})

module.exports = router
