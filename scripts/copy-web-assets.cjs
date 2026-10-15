const { cpSync } = require('node:fs');
const { resolve } = require('node:path');

cpSync(resolve(__dirname, '../src/web'), resolve(__dirname, '../dist/web'), { recursive: true });
