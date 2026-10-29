#!/usr/bin/env node
import { fileURLToPath } from 'node:url';

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 15)) {
  process.stderr.write(`andromeda-agent precisa do Node 22.15 ou mais novo (este é ${process.versions.node}).\n`);
  process.exit(1);
}

// Esconde só o aviso experimental do SQLite; qualquer outro aviso passa.
const originalEmit = process.emitWarning.bind(process) as (...a: unknown[]) => void;
process.emitWarning = ((warning: unknown, ...args: unknown[]): void => {
  const first = args[0];
  const type = typeof first === 'string' ? first : (first as { type?: string } | undefined)?.type;
  const text = typeof warning === 'string' ? warning : ((warning as Error | undefined)?.message ?? '');
  if (type === 'ExperimentalWarning' && /sqlite/i.test(text)) return;
  originalEmit(warning, ...args);
}) as typeof process.emitWarning;

const { runCli } = await import('./agent/commands.js');

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  out: (s) => void process.stdout.write(s),
  err: (s) => void process.stderr.write(s),
  cliPath: fileURLToPath(import.meta.url),
  handleSignals: true,
});
process.exitCode = code;
