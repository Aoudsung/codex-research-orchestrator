#!/usr/bin/env node
import { McpStdioServer } from '../core/mcp-server.mjs';
import { registerResearchMemoryTools } from '../core/research-memory-tools.mjs';

const server = new McpStdioServer({ name: 'research-memory', version: '1.0.0',
  instructions: 'Project-local SQLite research records. Search before reading, preserve conditions and provenance, and save meaningful results directly with research_record. Export documents only when needed.' });
if (!registerResearchMemoryTools(server)) {
  process.stderr.write('research-memory: set RESEARCH_MEMORY_PROJECT to the explicitly authorized project directory\n');
  process.exitCode = 1;
} else {
  server.start();
}
