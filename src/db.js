const mysql = require('mysql2/promise')

let pool = null

async function initDb() {
  const config = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  }

  const connection = await mysql.createConnection(config)
  await connection.execute(
    `CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  )
  await connection.end()

  pool = mysql.createPool({
    ...config,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
  })

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(50) NOT NULL,
      avatar VARCHAR(255) DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS card_keys (
      id INT AUTO_INCREMENT PRIMARY KEY,
      key_code VARCHAR(19) NOT NULL UNIQUE,
      name VARCHAR(100) NOT NULL,
      type ENUM('count', 'time') NOT NULL,
      max_count INT DEFAULT NULL,
      used_count INT DEFAULT 0,
      duration INT DEFAULT NULL,
      duration_unit ENUM('hour', 'day', 'month', 'year') DEFAULT NULL,
      expire_at DATETIME DEFAULT NULL,
      activated_at DATETIME DEFAULT NULL,
      remark VARCHAR(255) DEFAULT '',
      status ENUM('active', 'banned', 'used', 'expired') DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `)

  try {
    await pool.execute("ALTER TABLE card_keys ADD COLUMN remark VARCHAR(255) DEFAULT ''")
  } catch {
    // Column already exists
  }

  console.log('Database initialized')
}

function getPool() {
  return pool
}

module.exports = { initDb, getPool }
