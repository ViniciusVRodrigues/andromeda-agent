import { posix } from 'node:path';
import type { PlanInput, RunResult, ServicePlan, ServiceStatus } from './index.js';

export const UNIT = 'andromeda-agent.service';

/** Aspas do systemd: escapa `\`, `"`, e dobra `%` e `$`. */
export function systemdQuote(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$') + '"';
}

export function buildUnit(nodePath: string, cliPath: string): string {
  return `[Unit]
Description=Andromeda Agent (contagens de tokens das IAs de programação)
After=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(nodePath)} ${systemdQuote(cliPath)} run
Restart=on-failure
RestartSec=30

[Install]
WantedBy=default.target
`;
}

export function planLinux(i: PlanInput): ServicePlan {
  const unit = posix.join(i.home, '.config', 'systemd', 'user', UNIT);
  return {
    platform: 'linux',
    files: [{ path: unit, content: buildUnit(i.nodePath, i.cliPath), mode: 0o644 }],
    installCommands: [
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', UNIT]],
    ],
    uninstallCommands: [
      ['systemctl', ['--user', 'disable', '--now', UNIT]],
      ['systemctl', ['--user', 'daemon-reload']],
    ],
    statusCommand: ['systemctl', ['--user', 'is-active', UNIT]],
    hints: [
      `Para o agente rodar mesmo sem sessão aberta, rode você mesma: loginctl enable-linger ${i.username} (o agente não executa isso).`,
    ],
  };
}

export function parseLinuxStatus(r: RunResult): ServiceStatus {
  const out = r.stdout.trim();
  const known = ['active', 'inactive', 'failed', 'activating', 'deactivating'].includes(out);
  if (!known) return { exists: false, enabled: null, running: null, lastResult: null };
  return { exists: true, enabled: null, running: out === 'active', lastResult: out === 'failed' ? 'failed' : null };
}
