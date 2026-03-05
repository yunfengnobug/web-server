const express = require('express')
const { getPool } = require('../db')
const authMiddleware = require('../middleware/auth')

const router = express.Router()

router.get('/', authMiddleware, async (req, res) => {
  const page = parseInt(req.query.page) || 1
  const pageSize = parseInt(req.query.pageSize) || 20
  const offset = (page - 1) * pageSize
  const keyword = req.query.keyword || ''

  const pool = getPool()
  let where = ''
  const params = []

  if (keyword) {
    where = 'WHERE session_token LIKE ? OR card_key_code LIKE ? OR card_key_name LIKE ?'
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }

  const [rows] = await pool.query(
    `SELECT * FROM upgrade_records ${where} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) as total FROM upgrade_records ${where}`,
    params,
  )

  res.json({ code: 200, data: { list: rows, total, page, pageSize } })
})

router.delete('/:id', authMiddleware, async (req, res) => {
  const pool = getPool()
  await pool.execute('DELETE FROM upgrade_records WHERE id = ?', [req.params.id])
  res.json({ code: 200, message: '删除成功' })
})

module.exports = router
