const express = require('express')
const { getPool } = require('../db')
const authMiddleware = require('../middleware/auth')

const router = express.Router()

router.post('/import', authMiddleware, async (req, res) => {
  const { categoryId, items, priority } = req.body
  if (!categoryId || !items || !Array.isArray(items) || items.length === 0) {
    return res.json({ code: 400, message: '参数不合法' })
  }

  const pool = getPool()

  const [[cat]] = await pool.execute('SELECT id FROM user_card_categories WHERE id = ?', [categoryId])
  if (!cat) {
    return res.json({ code: 404, message: '分类不存在' })
  }

  const unique = [...new Set(items.map((s) => String(s).trim()).filter(Boolean))]
  if (unique.length === 0) {
    return res.json({ code: 400, message: '没有有效内容' })
  }

  const conn = await pool.getConnection()
  let inserted = 0
  try {
    await conn.beginTransaction()
    for (const content of unique) {
      const [existing] = await conn.execute(
        'SELECT id FROM user_cards WHERE category_id = ? AND content = ?',
        [categoryId, content],
      )
      if (existing.length === 0) {
        await conn.execute(
          'INSERT INTO user_cards (category_id, content, priority) VALUES (?, ?, ?)',
          [categoryId, content, priority ? 1 : 0],
        )
        inserted++
      }
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }

  res.json({ code: 200, message: `成功导入 ${inserted} 条（去重后）` })
})

router.get('/', authMiddleware, async (req, res) => {
  const page = parseInt(req.query.page) || 1
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 15, 1), 100)
  const offset = (page - 1) * pageSize
  const { categoryId, assignStatus, keyword } = req.query
  const pool = getPool()

  const conditions = []
  const params = []

  conditions.push('uc.deleted_at IS NULL')

  if (categoryId) {
    conditions.push('uc.category_id = ?')
    params.push(categoryId)
  }
  if (assignStatus === 'assigned') {
    conditions.push('uc.is_assigned = 1')
  } else if (assignStatus === 'unassigned') {
    conditions.push('uc.is_assigned = 0')
  }
  if (keyword) {
    conditions.push('uc.content LIKE ?')
    params.push(`%${keyword}%`)
  }

  const where = `WHERE ${conditions.join(' AND ')}`

  const [rows] = await pool.query(
    `SELECT uc.*, ck.key_code AS assigned_key_code
     FROM user_cards uc
     LEFT JOIN card_keys ck ON uc.assigned_to_key_id = ck.id AND uc.is_assigned = 1
     ${where}
     ORDER BY uc.created_at DESC
     LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) as total FROM user_cards uc ${where}`,
    params,
  )

  res.json({ code: 200, data: { list: rows, total, page, pageSize } })
})

router.get('/all-ids', authMiddleware, async (req, res) => {
  const { categoryId, assignStatus, keyword } = req.query
  const pool = getPool()
  const conditions = ['deleted_at IS NULL']
  const params = []

  if (categoryId) {
    conditions.push('category_id = ?')
    params.push(categoryId)
  }
  if (assignStatus === 'assigned') {
    conditions.push('is_assigned = 1')
  } else if (assignStatus === 'unassigned') {
    conditions.push('is_assigned = 0')
  }
  if (keyword) {
    conditions.push('content LIKE ?')
    params.push(`%${keyword}%`)
  }

  const where = `WHERE ${conditions.join(' AND ')}`
  const [rows] = await pool.query(`SELECT id FROM user_cards ${where}`, params)
  res.json({ code: 200, data: rows.map(r => r.id) })
})

router.put('/:id/unassign', authMiddleware, async (req, res) => {
  const pool = getPool()
  const [rows] = await pool.execute(
    'SELECT id, is_assigned, assigned_to_key_id FROM user_cards WHERE id = ?',
    [req.params.id],
  )
  if (rows.length === 0) {
    return res.json({ code: 404, message: '卡密不存在' })
  }
  if (!rows[0].is_assigned) {
    return res.json({ code: 400, message: '该卡密未分配' })
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await conn.execute(
      'UPDATE user_cards SET is_assigned = 0, assigned_at = NULL, assigned_to_key_id = NULL WHERE id = ?',
      [req.params.id],
    )
    if (rows[0].assigned_to_key_id) {
      await conn.execute(
        "UPDATE card_keys SET bound_user_card_id = NULL, status = 'banned' WHERE id = ?",
        [rows[0].assigned_to_key_id],
      )
    }
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }

  res.json({ code: 200, message: '已取消分配，系统卡密已封禁' })
})

router.delete('/:id', authMiddleware, async (req, res) => {
  const pool = getPool()
  const [rows] = await pool.execute(
    'SELECT id, is_assigned, assigned_to_key_id FROM user_cards WHERE id = ? AND deleted_at IS NULL',
    [req.params.id],
  )
  if (rows.length === 0) {
    return res.json({ code: 404, message: '卡密不存在' })
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    if (rows[0].is_assigned && rows[0].assigned_to_key_id) {
      await conn.execute(
        "UPDATE card_keys SET bound_user_card_id = NULL, status = 'banned' WHERE id = ?",
        [rows[0].assigned_to_key_id],
      )
    }
    await conn.execute('UPDATE user_cards SET deleted_at = NOW() WHERE id = ?', [req.params.id])
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  res.json({ code: 200, message: '删除成功' })
})

router.post('/batch-delete', authMiddleware, async (req, res) => {
  const { ids } = req.body
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.json({ code: 400, message: '参数不合法' })
  }

  const pool = getPool()
  const placeholders = ids.map(() => '?').join(',')

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    const [assignedRows] = await conn.query(
      `SELECT assigned_to_key_id FROM user_cards WHERE id IN (${placeholders}) AND is_assigned = 1 AND assigned_to_key_id IS NOT NULL AND deleted_at IS NULL`,
      ids,
    )
    if (assignedRows.length > 0) {
      const keyIds = assignedRows.map(r => r.assigned_to_key_id)
      const keyPh = keyIds.map(() => '?').join(',')
      await conn.query(
        `UPDATE card_keys SET bound_user_card_id = NULL, status = 'banned' WHERE id IN (${keyPh})`,
        keyIds,
      )
    }
    await conn.query(
      `UPDATE user_cards SET deleted_at = NOW() WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
      ids,
    )
    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
  res.json({ code: 200, message: `已删除 ${ids.length} 条` })
})

router.post('/export', authMiddleware, async (req, res) => {
  const { ids } = req.body
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.json({ code: 400, message: '参数不合法' })
  }

  const pool = getPool()
  const placeholders = ids.map(() => '?').join(',')
  const [rows] = await pool.query(
    `SELECT content FROM user_cards WHERE id IN (${placeholders}) AND deleted_at IS NULL`,
    ids,
  )
  res.json({ code: 200, data: rows.map(r => r.content) })
})

router.get('/trash', authMiddleware, async (req, res) => {
  const page = parseInt(req.query.page) || 1
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 20, 1), 100)
  const offset = (page - 1) * pageSize
  const { categoryId } = req.query
  const pool = getPool()

  const conditions = ['deleted_at IS NOT NULL']
  const params = []
  if (categoryId) {
    conditions.push('category_id = ?')
    params.push(categoryId)
  }

  const where = `WHERE ${conditions.join(' AND ')}`
  const [rows] = await pool.query(
    `SELECT id, content, deleted_at FROM user_cards ${where} ORDER BY deleted_at DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) as total FROM user_cards ${where}`,
    params,
  )
  res.json({ code: 200, data: { list: rows, total, page, pageSize } })
})

router.post('/batch-restore', authMiddleware, async (req, res) => {
  const { ids } = req.body
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.json({ code: 400, message: '参数不合法' })
  }

  const pool = getPool()
  const placeholders = ids.map(() => '?').join(',')
  await pool.query(
    `UPDATE user_cards SET deleted_at = NULL WHERE id IN (${placeholders}) AND deleted_at IS NOT NULL`,
    ids,
  )
  res.json({ code: 200, message: `已还原 ${ids.length} 条` })
})

router.post('/batch-permanent-delete', authMiddleware, async (req, res) => {
  const { ids } = req.body
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.json({ code: 400, message: '参数不合法' })
  }

  const pool = getPool()
  const placeholders = ids.map(() => '?').join(',')
  await pool.query(
    `DELETE FROM user_cards WHERE id IN (${placeholders}) AND deleted_at IS NOT NULL`,
    ids,
  )
  res.json({ code: 200, message: `已彻底删除 ${ids.length} 条` })
})

module.exports = router
