module.exports = {
  apps: [{
    name: 'scan-magday',
    script: 'dist/index.js',
    cwd: '/var/www/magday/data/www/scan.magday.ru/app',
    env: {
      NODE_ENV: 'production',
    },
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    error_file: '/var/www/magday/data/logs/scan-magday-error.log',
    out_file: '/var/www/magday/data/logs/scan-magday-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }],
};
