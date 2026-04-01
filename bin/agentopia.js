#!/usr/bin/env node

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) process.env.AGENTOPIA_PORT = args[++i];
  else if (args[i] === '--host' && args[i + 1]) process.env.AGENTOPIA_HOST = args[++i];
  else if (args[i] === '--db' && args[i + 1]) process.env.AGENTOPIA_DB_PATH = args[++i];
  else if (args[i] === '--no-auth') process.env.AGENTOPIA_NO_AUTH = 'true';
  else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Agentopia - Multi-Agent Collaboration Platform

Usage: agentopia [options]

Options:
  --port <port>    Server port (default: 4567)
  --host <host>    Bind address (default: 0.0.0.0)
  --db <path>      SQLite database path (default: ./agentopia.db)
  --no-auth        Disable authentication
  -h, --help       Show this help message
`);
    process.exit(0);
  }
}

require('../dist/index.js');
