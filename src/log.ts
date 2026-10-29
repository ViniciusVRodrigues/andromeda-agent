import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const MAX_LOG_BYTES = 1024 * 1024;

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Log operacional local (`agent.log`). Só eventos do próprio agente: nunca
 * token, prompt nem conteúdo de log. Passou de 1 MB, vira `agent.log.1`.
 */
export function createLogger(dir: string, now: () => number = Date.now): Logger {
  const file = join(dir, 'agent.log');
  const write = (level: string, msg: string): void => {
    try {
      mkdirSync(dir, { recursive: true });
      try {
        if (statSync(file).size > MAX_LOG_BYTES) {
          rmSync(`${file}.1`, { force: true });
          renameSync(file, `${file}.1`);
        }
      } catch {
        /* sem arquivo ainda */
      }
      appendFileSync(file, `${new Date(now()).toISOString()} ${level} ${msg.replace(/[\r\n]+/g, ' ')}\n`, { mode: 0o600 });
    } catch {
      /* log nunca derruba o agente */
    }
  };
  return {
    info: (m) => write('INFO', m),
    warn: (m) => write('WARN', m),
    error: (m) => write('ERRO', m),
  };
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {} };
