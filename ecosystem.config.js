const path = require('path');
const os = require('os');

// PM2's built-in log writer doesn't rotate. Install pm2-logrotate once on
// each server (global, not per-app) and it manages PM2's own stdout/err files.
//
//   pm2 install pm2-logrotate
//   pm2 set pm2-logrotate:max_size 20M
//   pm2 set pm2-logrotate:retain 14
//   pm2 set pm2-logrotate:compress true
//   pm2 set pm2-logrotate:workerInterval 60
//
// The Winston-managed files under ./logs/ already rotate daily (see logger.ts).
module.exports = {
  apps: [{
    name: 'scanflow',
    script: 'dist/index.js',
    cwd: __dirname,
    env: {
      NODE_ENV: 'production',
    },
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '256M',
    error_file: path.join(os.homedir(), 'logs', 'scanflow-error.log'),
    out_file: path.join(os.homedir(), 'logs', 'scanflow-out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    // Flush stdout/err synchronously on SIGINT/SIGTERM so we don't lose the
    // last few lines when pm2 restarts the process during deploy.
    kill_timeout: 5000,
  }],
};
