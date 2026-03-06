const express = require('express')
const { getPool } = require('../db')
const authMiddleware = require('../middleware/auth')

const router = express.Router()

router.post('/', authMiddleware, async (req, res) => {
  const { category_id, type, max_count, duration, duration_unit } = req.body
  if (!category_id || !type || !['count', 'time'].includes(type)) {
    return res.json({ code: 400, message: '参数不合法' })
  }
  if (type === 'count' && (max_count === undefined || max_count === null)) {
    return res.json({ code: 400, message: '次卡必须设置最大次数' })
  }
  if (type === 'time') {
    if (!duration || !duration_unit) {
      return res.json({ code: 400, message: '时效卡必须设置时长和时长单位' })
    }
    if (!['hour', 'day', 'month', 'year'].includes(duration_unit)) {
      return res.json({ code: 400, message: '时长单位不合法' })
    }
  }

  const pool = getPool()
  const [[cat]] = await pool.execute('SELECT id FROM card_categories WHERE id = ?', [category_id])
  if (!cat) {
    return res.json({ code: 404, message: '卡种不存在' })
  }

  await pool.execute(
    'INSERT INTO card_classes (category_id, type, max_count, duration, duration_unit) VALUES (?, ?, ?, ?, ?)',
    [
      category_id, type,
      type === 'count' ? max_count : null,
      type === 'time' ? duration : null,
      type === 'time' ? duration_unit : null,
    ],
  )
  res.json({ code: 200, message: '创建成功' })
})

router.get('/', authMiddleware, async (req, res) => {
  const page = parseInt(req.query.page) || 1
  const pageSize = parseInt(req.query.pageSize) || 20
  const offset = (page - 1) * pageSize
  const categoryId = req.query.categoryId
  const pool = getPool()

  if (!categoryId) {
    return res.json({ code: 400, message: '缺少 categoryId' })
  }

  const [rows] = await pool.query(
    `SELECT cl.*,
       (SELECT COUNT(*) FROM card_keys ck WHERE ck.class_id = cl.id AND ck.status != 'deleted') AS total_keys,
       (SELECT COUNT(*) FROM card_keys ck WHERE ck.class_id = cl.id AND ck.status != 'deleted' AND ck.is_sold = 0) AS remaining_keys
     FROM card_classes cl
     WHERE cl.category_id = ?
     ORDER BY cl.created_at DESC
     LIMIT ${pageSize} OFFSET ${offset}`,
    [categoryId],
  )
  const [[{ total }]] = await pool.query(
    'SELECT COUNT(*) as total FROM card_classes WHERE category_id = ?',
    [categoryId],
  )

  res.json({ code: 200, data: { list: rows, total, page, pageSize } })
})

router.get('/:id', authMiddleware, async (req, res) => {
  const pool = getPool()
  const [rows] = await pool.execute(
    `SELECT cl.*,
       (SELECT COUNT(*) FROM card_keys ck WHERE ck.class_id = cl.id AND ck.status != 'deleted') AS total_keys,
       (SELECT COUNT(*) FROM card_keys ck WHERE ck.class_id = cl.id AND ck.status != 'deleted' AND ck.is_sold = 0) AS remaining_keys
     FROM card_classes cl WHERE cl.id = ?`,
    [req.params.id],
  )
  if (rows.length === 0) {
    return res.json({ code: 404, message: '卡类不存在' })
  }
  res.json({ code: 200, data: rows[0] })
})

router.put('/:id', authMiddleware, async (req, res) => {
  const { type, max_count, duration, duration_unit } = req.body
  if (!type || !['count', 'time'].includes(type)) {
    return res.json({ code: 400, message: '请选择卡类型' })
  }
  if (type === 'count' && (max_count === undefined || max_count === null)) {
    return res.json({ code: 400, message: '次卡必须设置最大次数' })
  }
  if (type === 'time') {
    if (!duration || !duration_unit) {
      return res.json({ code: 400, message: '时效卡必须设置时长和时长单位' })
    }
    if (!['hour', 'day', 'month', 'year'].includes(duration_unit)) {
      return res.json({ code: 400, message: '时长单位不合法' })
    }
  }

  const pool = getPool()
  await pool.execute(
    'UPDATE card_classes SET type = ?, max_count = ?, duration = ?, duration_unit = ? WHERE id = ?',
    [
      type,
      type === 'count' ? max_count : null,
      type === 'time' ? duration : null,
      type === 'time' ? duration_unit : null,
      req.params.id,
    ],
  )
  res.json({ code: 200, message: '更新成功' })
})

router.delete('/:id', authMiddleware, async (req, res) => {
  const pool = getPool()
  const [keys] = await pool.execute(
    "SELECT id FROM card_keys WHERE class_id = ? AND status != 'deleted' LIMIT 1",
    [req.params.id],
  )
  if (keys.length > 0) {
    return res.json({ code: 400, message: '该卡类下存在卡密，无法删除' })
  }

  await pool.execute('DELETE FROM card_classes WHERE id = ?', [req.params.id])
  res.json({ code: 200, message: '删除成功' })
})

module.exports = router
