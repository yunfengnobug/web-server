const express = require('express')
const router = express.Router()
const { getPool } = require('../db')
const authMiddleware = require('../middleware/auth')
const { getBlockedIps, unblockIp, banIp, unbanIp, getBannedIpList } = require('../middleware/security')
const logger = require('../logger')

router.use(authMiddleware)

function parseDays(query) {
  return Math.min(Math.max(parseInt(query.days) || 7, 1), 90)
}

function localDateStr(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function fillDateRange(rows, days) {
  const dateMap = new Map(
    rows.map(r => [
      r.date instanceof Date ? localDateStr(r.date) : String(r.date),
      Number(r.count),
    ]),
  )
  const dates = []
  const counts = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const key = localDateStr(d)
    dates.push(key)
    counts.push(dateMap.get(key) || 0)
  }
  return { dates, counts }
}

// ==================== Request Stats ====================

router.get('/overview', async (_req, res) => {
  try {
    const pool = getPool()
    const [[row]] = await pool.execute(
      `SELECT
         COUNT(*) AS total,
         SUM(DATE(created_at) = CURDATE()) AS today,
         SUM(status_code >= 200 AND status_code < 400) AS success,
         ROUND(AVG(response_time_ms), 1) AS avg_time
       FROM request_logs`,
    )
    const total = Number(row.total) || 0
    const today = Number(row.today) || 0
    const success = Number(row.success) || 0
    const avgTime = Number(row.avg_time) || 0
    const successRate = total > 0 ? Number(((success / total) * 100).toFixed(1)) : 0
    res.json({ code: 200, data: { total, today, successRate, avgResponseTime: avgTime } })
  } catch (err) {
    logger.error('获取概览数据失败:', err)
    res.status(500).json({ code: 500, message: '获取概览数据失败' })
  }
})

router.get('/trend', async (req, res) => {
  try {
    const days = parseDays(req.query)
    const pool = getPool()
    const [rows] = await pool.execute(
      `SELECT DATE(created_at) AS date, COUNT(*) AS count FROM request_logs
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY DATE(created_at) ORDER BY date ASC`,
      [days],
    )
    res.json({ code: 200, data: fillDateRange(rows, days) })
  } catch (err) {
    logger.error('获取趋势数据失败:', err)
    res.status(500).json({ code: 500, message: '获取趋势数据失败' })
  }
})

router.get('/endpoints', async (req, res) => {
  try {
    const days = parseDays(req.query)
    const pool = getPool()
    const [rows] = await pool.execute(
      `SELECT path, COUNT(*) AS count FROM request_logs
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY path ORDER BY count DESC LIMIT 10`,
      [days],
    )
    res.json({ code: 200, data: { paths: rows.map(r => r.path), counts: rows.map(r => Number(r.count)) } })
  } catch (err) {
    logger.error('获取接口统计失败:', err)
    res.status(500).json({ code: 500, message: '获取接口统计失败' })
  }
})

router.get('/status-codes', async (req, res) => {
  try {
    const days = parseDays(req.query)
    const pool = getPool()
    const [rows] = await pool.execute(
      `SELECT CASE
         WHEN status_code >= 200 AND status_code < 300 THEN '2xx'
         WHEN status_code >= 300 AND status_code < 400 THEN '3xx'
         WHEN status_code >= 400 AND status_code < 500 THEN '4xx'
         WHEN status_code >= 500 THEN '5xx' ELSE 'other'
       END AS category, COUNT(*) AS count
       FROM request_logs WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY category ORDER BY category`,
      [days],
    )
    res.json({ code: 200, data: rows.map(r => ({ name: r.category, value: Number(r.count) })) })
  } catch (err) {
    logger.error('获取状态码统计失败:', err)
    res.status(500).json({ code: 500, message: '获取状态码统计失败' })
  }
})

// ==================== IP Analysis ====================

router.get('/ip-ranking', async (req, res) => {
  try {
    const days = parseDays(req.query)
    const pool = getPool()
    const [rows] = await pool.execute(
      `SELECT ip, COUNT(*) AS count FROM request_logs
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) AND ip != ''
       GROUP BY ip ORDER BY count DESC LIMIT 20`,
      [days],
    )
    res.json({ code: 200, data: { ips: rows.map(r => r.ip), counts: rows.map(r => Number(r.count)) } })
  } catch (err) {
    logger.error('获取 IP 排行失败:', err)
    res.status(500).json({ code: 500, message: '获取 IP 排行失败' })
  }
})

router.get('/ip-trend', async (req, res) => {
  try {
    const days = parseDays(req.query)
    const pool = getPool()
    const [rows] = await pool.execute(
      `SELECT DATE(created_at) AS date, COUNT(DISTINCT ip) AS count FROM request_logs
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY) AND ip != ''
       GROUP BY DATE(created_at) ORDER BY date ASC`,
      [days],
    )
    res.json({ code: 200, data: fillDateRange(rows, days) })
  } catch (err) {
    logger.error('获取 IP 趋势失败:', err)
    res.status(500).json({ code: 500, message: '获取 IP 趋势失败' })
  }
})

router.get('/ip-detail', async (req, res) => {
  try {
    const { ip } = req.query
    if (!ip) return res.status(400).json({ code: 400, message: '缺少 ip 参数' })
    const days = parseDays(req.query)
    const pool = getPool()

    const [pathRows] = await pool.execute(
      `SELECT path, COUNT(*) AS count FROM request_logs
       WHERE ip = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY path ORDER BY count DESC LIMIT 10`, [ip, days])

    const [statusRows] = await pool.execute(
      `SELECT CASE WHEN status_code>=200 AND status_code<300 THEN '2xx' WHEN status_code>=300 AND status_code<400 THEN '3xx' WHEN status_code>=400 AND status_code<500 THEN '4xx' WHEN status_code>=500 THEN '5xx' ELSE 'other' END AS category, COUNT(*) AS count
       FROM request_logs WHERE ip=? AND created_at>=DATE_SUB(CURDATE(),INTERVAL ? DAY) GROUP BY category ORDER BY category`, [ip, days])

    const [dailyRows] = await pool.execute(
      `SELECT DATE(created_at) AS date, COUNT(*) AS count FROM request_logs
       WHERE ip=? AND created_at>=DATE_SUB(CURDATE(),INTERVAL ? DAY) GROUP BY DATE(created_at) ORDER BY date ASC`, [ip, days])

    res.json({
      code: 200,
      data: {
        paths: pathRows.map(r => ({ name: r.path, value: Number(r.count) })),
        statusCodes: statusRows.map(r => ({ name: r.category, value: Number(r.count) })),
        daily: fillDateRange(dailyRows, days),
      },
    })
  } catch (err) {
    logger.error('获取 IP 详情失败:', err)
    res.status(500).json({ code: 500, message: '获取 IP 详情失败' })
  }
})

// ==================== Request Logs ====================

router.get('/logs', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1)
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 20, 1), 100)
    const { method, path: pf, statusCode, ip, startDate, endDate } = req.query
    const pool = getPool()

    const conditions = []
    const params = []
    if (method) { conditions.push('method = ?'); params.push(method) }
    if (pf) { conditions.push('path LIKE ?'); params.push(`%${pf}%`) }
    if (statusCode) { conditions.push('status_code = ?'); params.push(Number(statusCode)) }
    if (ip) { conditions.push('ip LIKE ?'); params.push(`%${ip}%`) }
    if (startDate) { conditions.push('created_at >= ?'); params.push(startDate) }
    if (endDate) { conditions.push('created_at <= ?'); params.push(`${endDate} 23:59:59`) }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const [[{ total }]] = await pool.execute(`SELECT COUNT(*) AS total FROM request_logs ${where}`, params)
    const offset = (page - 1) * pageSize
    const [rows] = await pool.execute(
      `SELECT id,method,path,status_code,response_time_ms,ip,user_agent,params,created_at FROM request_logs ${where} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`, params)

    res.json({ code: 200, data: { total: Number(total), page, pageSize, list: rows } })
  } catch (err) {
    logger.error('获取请求日志失败:', err)
    res.status(500).json({ code: 500, message: '获取请求日志失败' })
  }
})

// ==================== Security Monitor ====================

router.get('/security/overview', async (_req, res) => {
  try {
    const pool = getPool()
    const [[row]] = await pool.execute(
      `SELECT
         COUNT(*) AS total,
         SUM(DATE(created_at) = CURDATE()) AS today,
         SUM(level = 'high' OR level = 'critical') AS high_risk,
         SUM(blocked = 1) AS blocked_count
       FROM security_events`,
    )
    res.json({
      code: 200,
      data: {
        total: Number(row.total) || 0,
        today: Number(row.today) || 0,
        highRisk: Number(row.high_risk) || 0,
        blockedCount: Number(row.blocked_count) || 0,
        currentBlockedIps: getBlockedIps().length,
      },
    })
  } catch (err) {
    logger.error('获取安全概览失败:', err)
    res.status(500).json({ code: 500, message: '获取安全概览失败' })
  }
})

router.get('/security/events', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1)
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 20, 1), 100)
    const days = parseDays(req.query)
    const { type, level } = req.query
    const pool = getPool()

    const conditions = [`created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)`]
    const params = [days]
    if (type) { conditions.push('type = ?'); params.push(type) }
    if (level) { conditions.push('level = ?'); params.push(level) }

    const where = `WHERE ${conditions.join(' AND ')}`
    const [[{ total }]] = await pool.execute(`SELECT COUNT(*) AS total FROM security_events ${where}`, params)
    const offset = (page - 1) * pageSize
    const [rows] = await pool.execute(
      `SELECT * FROM security_events ${where} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`, params)

    res.json({ code: 200, data: { total: Number(total), page, pageSize, list: rows } })
  } catch (err) {
    logger.error('获取安全事件失败:', err)
    res.status(500).json({ code: 500, message: '获取安全事件失败' })
  }
})

router.get('/security/trend', async (req, res) => {
  try {
    const days = parseDays(req.query)
    const pool = getPool()
    const [rows] = await pool.execute(
      `SELECT DATE(created_at) AS date, COUNT(*) AS count FROM security_events
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY DATE(created_at) ORDER BY date ASC`,
      [days],
    )
    res.json({ code: 200, data: fillDateRange(rows, days) })
  } catch (err) {
    logger.error('获取安全趋势失败:', err)
    res.status(500).json({ code: 500, message: '获取安全趋势失败' })
  }
})

router.get('/security/blocked-ips', (_req, res) => {
  res.json({ code: 200, data: getBlockedIps() })
})

router.post('/security/unblock-ip', (req, res) => {
  const { ip } = req.body
  if (!ip) return res.status(400).json({ code: 400, message: '缺少 ip 参数' })
  unblockIp(ip)
  res.json({ code: 200, message: '解封成功' })
})

router.get('/security/banned-ips', async (_req, res) => {
  try {
    const list = await getBannedIpList()
    res.json({ code: 200, data: list })
  } catch (err) {
    logger.error('获取封禁列表失败:', err)
    res.status(500).json({ code: 500, message: '获取封禁列表失败' })
  }
})

router.post('/security/ban-ip', async (req, res) => {
  const { ip, reason } = req.body
  if (!ip) return res.status(400).json({ code: 400, message: '缺少 ip 参数' })
  try {
    const added = await banIp(ip, reason)
    if (!added) return res.json({ code: 200, message: '该 IP 已在封禁列表中' })
    res.json({ code: 200, message: '封禁成功' })
  } catch (err) {
    logger.error('封禁 IP 失败:', err)
    res.status(500).json({ code: 500, message: '封禁失败' })
  }
})

router.post('/security/unban-ip', async (req, res) => {
  const { ip } = req.body
  if (!ip) return res.status(400).json({ code: 400, message: '缺少 ip 参数' })
  try {
    await unbanIp(ip)
    res.json({ code: 200, message: '解封成功' })
  } catch (err) {
    logger.error('解封 IP 失败:', err)
    res.status(500).json({ code: 500, message: '解封失败' })
  }
})

// ==================== Client Monitor ====================

router.get('/client/overview', async (_req, res) => {
  try {
    const pool = getPool()
    const [[row]] = await pool.execute(
      `SELECT
         SUM(type='error' AND DATE(created_at)=CURDATE()) AS today_errors,
         SUM(type='error') AS total_errors,
         COUNT(DISTINCT ip) AS unique_users
       FROM client_events`,
    )
    const [[perf]] = await pool.execute(
      `SELECT ROUND(AVG(JSON_EXTRACT(payload,'$.loadTime')),0) AS avg_load
       FROM client_events WHERE type='performance' AND JSON_EXTRACT(payload,'$.loadTime') IS NOT NULL`,
    )
    res.json({
      code: 200,
      data: {
        todayErrors: Number(row.today_errors) || 0,
        totalErrors: Number(row.total_errors) || 0,
        uniqueUsers: Number(row.unique_users) || 0,
        avgLoadTime: Number(perf.avg_load) || 0,
      },
    })
  } catch (err) {
    logger.error('获取客户端概览失败:', err)
    res.status(500).json({ code: 500, message: '获取客户端概览失败' })
  }
})

router.get('/client/errors', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1)
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize) || 20, 1), 100)
    const pool = getPool()

    const [[{ total }]] = await pool.execute(`SELECT COUNT(*) AS total FROM client_events WHERE type='error'`)
    const offset = (page - 1) * pageSize
    const [rows] = await pool.execute(
      `SELECT id,payload,ip,user_agent,created_at FROM client_events WHERE type='error' ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`)

    res.json({ code: 200, data: { total: Number(total), page, pageSize, list: rows } })
  } catch (err) {
    logger.error('获取客户端错误失败:', err)
    res.status(500).json({ code: 500, message: '获取客户端错误失败' })
  }
})

router.get('/client/performance', async (req, res) => {
  try {
    const days = parseDays(req.query)
    const pool = getPool()
    const [rows] = await pool.execute(
      `SELECT DATE(created_at) AS date,
              ROUND(AVG(JSON_EXTRACT(payload,'$.loadTime')),0) AS avg_load,
              ROUND(AVG(JSON_EXTRACT(payload,'$.domReady')),0) AS avg_dom
       FROM client_events
       WHERE type='performance' AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
       GROUP BY DATE(created_at) ORDER BY date ASC`,
      [days],
    )
    const dateMap = new Map(rows.map(r => {
      const key = r.date instanceof Date ? localDateStr(r.date) : String(r.date)
      return [key, { load: Number(r.avg_load) || 0, dom: Number(r.avg_dom) || 0 }]
    }))
    const dates = []; const loadTimes = []; const domTimes = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i)
      const key = localDateStr(d)
      dates.push(key)
      const v = dateMap.get(key)
      loadTimes.push(v?.load || 0)
      domTimes.push(v?.dom || 0)
    }
    res.json({ code: 200, data: { dates, loadTimes, domTimes } })
  } catch (err) {
    logger.error('获取客户端性能失败:', err)
    res.status(500).json({ code: 500, message: '获取客户端性能失败' })
  }
})

router.get('/client/environments', async (_req, res) => {
  try {
    const pool = getPool()
    const [rows] = await pool.execute(
      `SELECT payload FROM client_events WHERE type='environment' ORDER BY created_at DESC LIMIT 500`)

    const browsers = {}; const oses = {}
    for (const r of rows) {
      const p = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload
      if (p.browser) browsers[p.browser] = (browsers[p.browser] || 0) + 1
      if (p.os) oses[p.os] = (oses[p.os] || 0) + 1
    }

    const toArr = obj => Object.entries(obj).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value)
    res.json({ code: 200, data: { browsers: toArr(browsers), os: toArr(oses) } })
  } catch (err) {
    logger.error('获取客户端环境失败:', err)
    res.status(500).json({ code: 500, message: '获取客户端环境失败' })
  }
})

module.exports = router
