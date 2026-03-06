const express = require('express')
const { getPool } = require('../db')
const authMiddleware = require('../middleware/auth')

const router = express.Router()

router.post('/import', authMiddleware, async (req, res) => {
  const { categoryId, items } = req.body
  if (!categoryId || !items || !Array.isArray(items) || items.length === 0) {
    return res.json({ code: 400, message: '参数不合法' })
  }

  const pool = getPool()

  const [[cat]] = await pool.execute('SELECT id FROM user_card_categories WHERE id = ?', [categoryId])
  if (!cat) {
    return res.json({ code: 404, message: '分类不存在' })
  }

  const unique = [...new Set(items.map((s) => s.trim()).filter(Boolean))]
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
          'INSERT INTO user_cards (category_id, content) VALUES (?, ?)',
          [categoryId, content],
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
  const pageSize = parseInt(req.query.pageSize) || 20
  const offset = (page - 1) * pageSize
  const { categoryId, assignStatus, keyword } = req.query
  const pool = getPool()

  const conditions = []
  const params = []

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

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const [rows] = await pool.query(
    `SELECT uc.*, ck.key_code AS assigned_key_code
     FROM user_cards uc
     LEFT JOIN card_keys ck ON uc.assigned_to_key_id = ck.id
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

router.delete('/:id', authMiddleware, async (req, res) => {
  const pool = getPool()
  const [rows] = await pool.execute('SELECT is_assigned FROM user_cards WHERE id = ?', [req.params.id])
  if (rows.length === 0) {
    return res.json({ code: 404, message: '卡密不存在' })
  }
  if (rows[0].is_assigned) {
    return res.json({ code: 400, message: '该卡密已分配，无法删除' })
  }

  await pool.execute('DELETE FROM user_cards WHERE id = ?', [req.params.id])
  res.json({ code: 200, message: '删除成功' })
})

router.post('/batch-delete', authMiddleware, async (req, res) => {
  const { ids } = req.body
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.json({ code: 400, message: '参数不合法' })
  }

  const pool = getPool()
  const placeholders = ids.map(() => '?').join(',')

  const [assigned] = await pool.query(
    `SELECT id FROM user_cards WHERE id IN (${placeholders}) AND is_assigned = 1`,
    ids,
  )
  if (assigned.length > 0) {
    return res.json({ code: 400, message: `${assigned.length} 条卡密已分配，无法删除` })
  }

  await pool.query(`DELETE FROM user_cards WHERE id IN (${placeholders}) AND is_assigned = 0`, ids)
  res.json({ code: 200, message: `已删除 ${ids.length} 条` })
})

module.exports = router
