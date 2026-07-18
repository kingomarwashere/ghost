module.exports = {
  apps: [{
    name:        'radar-waze',
    script:      'index.mjs',
    cwd:         '/Users/maverick/radar/scraper',
    interpreter: 'node',
    restart_delay: 10000,
    max_restarts:  20,
    env: {
      NODE_ENV: 'production',
    },
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    error_file:  '/Users/maverick/radar/scraper/logs/error.log',
    out_file:    '/Users/maverick/radar/scraper/logs/out.log',
  }],
};
