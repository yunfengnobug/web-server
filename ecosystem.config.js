module.exports = {
  apps: [
    {
      name: 'web-server',
      script: './src/app.js',
      instances: 1,
      autorestart: true,
      watch: ['src'],
      watch_delay: 1000,
      ignore_watch: ['node_modules', 'logs'],
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
    },
  ],
}
