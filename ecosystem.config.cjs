const path = require("path");

module.exports = {
  apps: [{
    name: "meteorabot-v3",
    script: "src/index.js",
    cwd: path.resolve(__dirname),
    watch: false,
    max_memory_restart: "500M",
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    error_file: "./logs/v3-error.log",
    out_file: "./logs/v3-out.log",
    merge_logs: true,
    autorestart: true,
  }]
}
