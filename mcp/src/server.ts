#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './tools.js';

await buildServer(process.env.CHIRON_RPC_URL).connect(new StdioServerTransport());
