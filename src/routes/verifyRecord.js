const express = require('express')
const { getPool } = require('../db')
const authMiddleware = require('../middleware/auth')

const router = express.Router()

router.get('/', authMiddleware, async (req, res) => {
  const page = parseInt(req.query.page) || 1
  const pageSize = parseInt(req.query.pageSize) || 15
  const offset = (page - 1) * pageSize
  const { cardId, success, keyword } = req.query

  const conditions = []
  const params = []

  if (cardId) {
    conditions.push('card_id = ?')
    params.push(cardId)
  }
  if (success !== undefined && success !== '') {
    conditions.push('success = ?')
    params.push(Number(success))
  }
  if (keyword) {
    conditions.push('(card_key_code LIKE ? OR session_token LIKE ? OR message LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }
  conditions.push("status != 'deleted'")

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''

  const pool = getPool()
  const [rows] = await pool.query(
    `SELECT * FROM verify_records ${where} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  )
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) as total FROM verify_records ${where}`,
    params,
  )

  res.json({ code: 200, data: { list: rows, total, page, pageSize } })
})

router.get('/all-ids', authMiddleware, async (req, res) => {
  const { cardId, success, keyword, withTokens } = req.query
  const conditions = []
  const params = []

  if (cardId) {
    conditions.push('card_id = ?')
    params.push(cardId)
  }
  if (success !== undefined && success !== '') {
    conditions.push('success = ?')
    params.push(Number(success))
  }
  if (keyword) {
    conditions.push('(card_key_code LIKE ? OR session_token LIKE ? OR message LIKE ?)')
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`)
  }
  conditions.push("status != 'deleted'")

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const pool = getPool()

  if (withTokens === '1') {
    const [rows] = await pool.query(
      `SELECT id, session_token FROM verify_records ${where} ORDER BY created_at DESC`,
      params,
    )
    return res.json({ code: 200, data: { ids: rows.map(r => r.id), tokens: rows.map(r => r.session_token).filter(Boolean) } })
  }

  const [rows] = await pool.query(`SELECT id FROM verify_records ${where}`, params)
  res.json({ code: 200, data: rows.map(r => r.id) })
})

router.delete('/:id', authMiddleware, async (req, res) => {
  const pool = getPool()
  const [rows] = await pool.execute('SELECT status FROM verify_records WHERE id = ?', [req.params.id])
  if (rows.length === 0) {
    return res.json({ code: 404, message: '记录不存在' })
  }

  if (rows[0].status === 'deleted') {
    await pool.execute('DELETE FROM verify_records WHERE id = ?', [req.params.id])
    return res.json({ code: 200, message: '已彻底删除' })
  }

  await pool.execute("UPDATE verify_records SET status = 'deleted' WHERE id = ?", [req.params.id])
  res.json({ code: 200, message: '已移至回收站' })
})

router.post('/batch-delete', authMiddleware, async (req, res) => {
  const { ids } = req.body
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.json({ code: 400, message: '参数不合法' })
  }

  const pool = getPool()
  const placeholders = ids.map(() => '?').join(',')

  const [rows] = await pool.query(
    `SELECT id, status FROM verify_records WHERE id IN (${placeholders})`,
    ids,
  )

  const softIds = rows.filter((r) => r.status !== 'deleted').map((r) => r.id)
  const hardIds = rows.filter((r) => r.status === 'deleted').map((r) => r.id)

  if (softIds.length > 0) {
    const sp = softIds.map(() => '?').join(',')
    await pool.query(`UPDATE verify_records SET status = 'deleted' WHERE id IN (${sp})`, softIds)
  }
  if (hardIds.length > 0) {
    const hp = hardIds.map(() => '?').join(',')
    await pool.query(`DELETE FROM verify_records WHERE id IN (${hp})`, hardIds)
  }

  res.json({ code: 200, message: `已处理 ${rows.length} 条` })
})

module.exports = router
