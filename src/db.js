const mysql = require("mysql2/promise");

let pool = null;

async function initDb() {
  const config = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  };

  const connection = await mysql.createConnection(config);
  await connection.execute(
    `CREATE DATABASE IF NOT EXISTS \`${process.env.DB_NAME}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await connection.end();

  pool = mysql.createPool({
    ...config,
    database: process.env.DB_NAME,
    timezone: '+08:00',
    waitForConnections: true,
    connectionLimit: 10,
  });

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
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS card_categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      code VARCHAR(50) NOT NULL UNIQUE,
      description VARCHAR(255) DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

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
      status ENUM('active', 'banned', 'used', 'expired', 'deleted') DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS verify_records (
      id INT AUTO_INCREMENT PRIMARY KEY,
      card_id INT NOT NULL,
      card_key_code VARCHAR(19) NOT NULL,
      session_token TEXT,
      action VARCHAR(50) NOT NULL DEFAULT 'upgrade',
      success TINYINT(1) NOT NULL DEFAULT 0,
      message VARCHAR(255) DEFAULT '',
      status ENUM('active', 'deleted') DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS card_contents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      card_key_id INT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      content_type ENUM('text', 'json') NOT NULL DEFAULT 'text',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS card_classes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      category_id INT NOT NULL,
      type ENUM('count', 'time') NOT NULL,
      max_count INT DEFAULT NULL,
      duration INT DEFAULT NULL,
      duration_unit ENUM('hour', 'day', 'month', 'year') DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS user_card_categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      description VARCHAR(255) DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS user_cards (
      id INT AUTO_INCREMENT PRIMARY KEY,
      category_id INT NOT NULL,
      content TEXT NOT NULL,
      is_assigned TINYINT(1) DEFAULT 0,
      assigned_to_key_id INT DEFAULT NULL,
      assigned_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS request_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      method VARCHAR(10) NOT NULL,
      path VARCHAR(255) NOT NULL,
      status_code INT NOT NULL,
      response_time_ms INT DEFAULT 0,
      ip VARCHAR(45) DEFAULT '',
      user_agent VARCHAR(500) DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created_at (created_at),
      INDEX idx_path (path),
      INDEX idx_ip (ip)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS security_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type VARCHAR(50) NOT NULL,
      level ENUM('low','medium','high','critical') DEFAULT 'medium',
      ip VARCHAR(45) DEFAULT '',
      path VARCHAR(255) DEFAULT '',
      detail VARCHAR(1000) DEFAULT '',
      blocked TINYINT(1) DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created_at (created_at),
      INDEX idx_ip (ip),
      INDEX idx_type (type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS client_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type ENUM('error','performance','environment') NOT NULL,
      payload JSON NOT NULL,
      ip VARCHAR(45) DEFAULT '',
      user_agent VARCHAR(500) DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_created_at (created_at),
      INDEX idx_type (type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const migrations = [
    "ALTER TABLE card_keys ADD COLUMN remark VARCHAR(255) DEFAULT ''",
    "ALTER TABLE card_keys MODIFY COLUMN status ENUM('active', 'banned', 'used', 'expired', 'deleted') DEFAULT 'active'",
    "ALTER TABLE card_keys ADD COLUMN category_id INT DEFAULT NULL",
    "ALTER TABLE card_keys MODIFY COLUMN name VARCHAR(100) DEFAULT ''",
    "ALTER TABLE card_categories ADD COLUMN bound_user_category_id INT DEFAULT NULL",
    "ALTER TABLE card_keys ADD COLUMN bound_user_card_id INT DEFAULT NULL",
    "ALTER TABLE card_keys ADD COLUMN class_id INT DEFAULT NULL",
    "ALTER TABLE card_keys ADD COLUMN is_sold TINYINT(1) DEFAULT 0",
    "UPDATE card_keys SET is_sold = 1 WHERE used_count > 0 OR activated_at IS NOT NULL",
    "ALTER TABLE user_card_categories ADD COLUMN content_hint VARCHAR(255) DEFAULT ''",
    "ALTER TABLE card_classes ADD COLUMN bound_user_category_id INT DEFAULT NULL",
    "UPDATE card_classes cl JOIN card_categories cc ON cl.category_id = cc.id SET cl.bound_user_category_id = cc.bound_user_category_id WHERE cc.bound_user_category_id IS NOT NULL",
    "UPDATE card_categories cc SET cc.bound_user_category_id = (SELECT cl.bound_user_category_id FROM card_classes cl WHERE cl.category_id = cc.id AND cl.bound_user_category_id IS NOT NULL LIMIT 1) WHERE cc.bound_user_category_id IS NULL AND EXISTS (SELECT 1 FROM card_classes cl WHERE cl.category_id = cc.id AND cl.bound_user_category_id IS NOT NULL)",
    "ALTER TABLE user_cards ADD COLUMN priority TINYINT(1) DEFAULT 0",
    "ALTER TABLE request_logs ADD COLUMN params TEXT DEFAULT ''",
    "ALTER TABLE security_events ADD COLUMN params TEXT DEFAULT ''",
  ];

  for (const sql of migrations) {
    try { await pool.execute(sql); } catch { /* already applied */ }
  }

  const logger = require('./logger');
  logger.info("Database initialized");
}

function getPool() {
  return pool;
}

module.exports = { initDb, getPool };
