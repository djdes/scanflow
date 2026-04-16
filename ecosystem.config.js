const path = require('path');
const os = require('os');

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
  }],
};
