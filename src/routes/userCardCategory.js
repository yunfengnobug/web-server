const express = require('express')
const { getPool } = require('../db')
const authMiddleware = require('../middleware/auth')

const router = express.Router()

router.post('/', authMiddleware, async (req, res) => {
  const { name, description, contentHint } = req.body
  if (!name) {
    return res.json({ code: 400, message: '名称不能为空' })
  }

  const pool = getPool()
  await pool.execute(
    'INSERT INTO user_card_categories (name, description, content_hint) VALUES (?, ?, ?)',
    [name, description || '', contentHint || ''],
  )
  res.json({ code: 200, message: '创建成功' })
})

router.get('/', authMiddleware, async (req, res) => {
  const page = parseInt(req.query.page) || 1
  const pageSize = parseInt(req.query.pageSize) || 20
  const offset = (page - 1) * pageSize
  const keyword = req.query.keyword || ''
  const pool = getPool()

  let where = ''
  const params = []
  if (keyword) {
    where = 'WHERE uc.name LIKE ?'
    params.push(`%${keyword}%`)
  }

  const [rows] = await pool.query(
    `SELECT uc.*,
       COUNT(u.id) AS total_cards,
       SUM(CASE WHEN u.is_assigned = 1 THEN 1 ELSE 0 END) AS assigned_cards,
       SUM(CASE WHEN u.is_assigned = 0 THEN 1 ELSE 0 END) AS unassigned_cards
     FROM user_card_categories uc
     LEFT JOIN user_cards u ON uc.id = u.category_id
     ${where}
     GROUP BY uc.id
     ORDER BY uc.created_at DESC
     LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) as total FROM user_card_categories uc ${where}`,
    params,
  )

  res.json({ code: 200, data: { list: rows, total, page, pageSize } })
})

router.get('/all', authMiddleware, async (_req, res) => {
  const pool = getPool()
  const [rows] = await pool.execute(
    'SELECT id, name FROM user_card_categories ORDER BY created_at DESC',
  )
  res.json({ code: 200, data: rows })
})

router.get('/:id', authMiddleware, async (req, res) => {
  const pool = getPool()
  const [rows] = await pool.execute('SELECT * FROM user_card_categories WHERE id = ?', [req.params.id])
  if (rows.length === 0) {
    return res.json({ code: 404, message: '分类不存在' })
  }
  res.json({ code: 200, data: rows[0] })
})

router.put('/:id', authMiddleware, async (req, res) => {
  const { name, description, contentHint } = req.body
  if (!name) {
    return res.json({ code: 400, message: '名称不能为空' })
  }

  const pool = getPool()
  await pool.execute('UPDATE user_card_categories SET name = ?, description = ?, content_hint = ? WHERE id = ?', [
    name,
    description || '',
    contentHint || '',
    req.params.id,
  ])
  res.json({ code: 200, message: '更新成功' })
})

router.delete('/:id', authMiddleware, async (req, res) => {
  const pool = getPool()
  const [cards] = await pool.execute(
    'SELECT id FROM user_cards WHERE category_id = ? LIMIT 1',
    [req.params.id],
  )
  if (cards.length > 0) {
    return res.json({ code: 400, message: '该分类下存在卡密，无法删除' })
  }

  const [bound] = await pool.execute(
    'SELECT id FROM card_categories WHERE bound_user_category_id = ? LIMIT 1',
    [req.params.id],
  )
  if (bound.length > 0) {
    return res.json({ code: 400, message: '该分类已被系统分类绑定，请先解绑' })
  }

  await pool.execute('DELETE FROM user_card_categories WHERE id = ?', [req.params.id])
  res.json({ code: 200, message: '删除成功' })
})

module.exports = router
