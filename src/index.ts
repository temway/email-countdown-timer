#!/usr/bin/env node
/**
 * Server entry point.
 *
 * Starts with no environment configured — see `config.ts`.
 */

import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp(config);

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`email-countdown-timer listening on http://${config.host}:${info.port}`);
  console.log(`  builder:  http://localhost:${info.port}/`);
  console.log(`  example:  http://localhost:${info.port}/c.gif?until=${new Date(Date.now() + 864e5).toISOString()}`);
  if (config.signingSecret) console.log('  URL signing: ENABLED');
});
