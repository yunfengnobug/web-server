const express = require('express')
const { getPool } = require('../db')
const authMiddleware = require('../middleware/auth')

const router = express.Router()

router.post('/', authMiddleware, async (req, res) => {
  const { name, app_code, description } = req.body
  if (!name || !app_code) {
    return res.json({ code: 400, message: '名称和 AppCode 不能为空' })
  }

  const pool = getPool()
  const [existing] = await pool.execute('SELECT id FROM card_categories WHERE app_code = ?', [app_code])
  if (existing.length > 0) {
    return res.json({ code: 400, message: 'AppCode 已存在' })
  }

  await pool.execute(
    'INSERT INTO card_categories (name, app_code, description) VALUES (?, ?, ?)',
    [name, app_code, description || ''],
  )
  res.json({ code: 200, message: '创建成功' })
})

router.get('/', authMiddleware, async (req, res) => {
  const page = parseInt(req.query.page) || 1
  const pageSize = parseInt(req.query.pageSize) || 15
  const offset = (page - 1) * pageSize
  const keyword = req.query.keyword || ''
  const pool = getPool()

  let where = ''
  const params = []
  if (keyword) {
    where = 'WHERE cc.name LIKE ? OR cc.app_code LIKE ?'
    params.push(`%${keyword}%`, `%${keyword}%`)
  }

  const [rows] = await pool.query(
    `SELECT cc.*, uc.name AS bound_user_category_name
     FROM card_categories cc
     LEFT JOIN user_card_categories uc ON cc.bound_user_category_id = uc.id
     ${where}
     ORDER BY cc.created_at DESC
     LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) as total FROM card_categories cc ${where}`,
    params,
  )

  res.json({ code: 200, data: { list: rows, total, page, pageSize } })
})

router.get('/:id', authMiddleware, async (req, res) => {
  const pool = getPool()
  const [rows] = await pool.execute('SELECT * FROM card_categories WHERE id = ?', [req.params.id])
  if (rows.length === 0) {
    return res.json({ code: 404, message: '卡不存在' })
  }
  res.json({ code: 200, data: rows[0] })
})

router.put('/:id', authMiddleware, async (req, res) => {
  const { name, description } = req.body
  if (!name) {
    return res.json({ code: 400, message: '名称不能为空' })
  }

  const pool = getPool()
  await pool.execute('UPDATE card_categories SET name = ?, description = ? WHERE id = ?', [
    name,
    description || '',
    req.params.id,
  ])
  res.json({ code: 200, message: '更新成功' })
})

router.put('/:id/bind-user-category', authMiddleware, async (req, res) => {
  const { userCategoryId } = req.body
  if (!userCategoryId) {
    return res.json({ code: 400, message: '请选择用户卡密分类' })
  }

  const pool = getPool()
  const [[cat]] = await pool.execute('SELECT id FROM user_card_categories WHERE id = ?', [userCategoryId])
  if (!cat) {
    return res.json({ code: 404, message: '用户卡密分类不存在' })
  }

  await pool.execute('UPDATE card_categories SET bound_user_category_id = ? WHERE id = ?', [
    userCategoryId,
    req.params.id,
  ])
  res.json({ code: 200, message: '绑定成功' })
})

router.put('/:id/unbind-user-category', authMiddleware, async (req, res) => {
  const pool = getPool()
  await pool.execute('UPDATE card_categories SET bound_user_category_id = NULL WHERE id = ?', [req.params.id])
  res.json({ code: 200, message: '解绑成功' })
})

router.delete('/:id', authMiddleware, async (req, res) => {
  const pool = getPool()
  const [classes] = await pool.execute(
    'SELECT id FROM card_classes WHERE category_id = ? LIMIT 1',
    [req.params.id],
  )
  if (classes.length > 0) {
    return res.json({ code: 400, message: '该卡种下存在卡类，无法删除' })
  }

  await pool.execute('DELETE FROM card_categories WHERE id = ?', [req.params.id])
  res.json({ code: 200, message: '删除成功' })
})

module.exports = router
