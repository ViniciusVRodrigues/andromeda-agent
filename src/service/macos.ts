import { posix } from 'node:path';
import type { PlanInput, RunResult, ServicePlan, ServiceStatus } from './index.js';

export const LABEL = 'dev.andromeda.agent';

export function plistEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function buildPlist(nodePath: string, cliPath: string, stateDir: string): string {
  const s = (v: string) => `<string>${plistEscape(v)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${s(LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${s(nodePath)}
    ${s(cliPath)}
    ${s('run')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  ${s('Background')}
  <key>StandardOutPath</key>
  ${s(posix.join(stateDir, 'agent.out.log'))}
  <key>StandardErrorPath</key>
  ${s(posix.join(stateDir, 'agent.err.log'))}
</dict>
</plist>
`;
}

export function planMacos(i: PlanInput): ServicePlan {
  const plist = posix.join(i.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  if (i.uid === undefined) throw new Error('uid do usuário ausente: o LaunchAgent precisa do uid real (process.getuid)');
  const domain = `gui/${i.uid}`;
  return {
    platform: 'darwin',
    files: [{ path: plist, content: buildPlist(i.nodePath, i.cliPath, i.stateDir), mode: 0o644 }],
    // O primeiro bootout limpa uma instalação anterior; falhar ali é normal.
    installCommands: [
      ['launchctl', ['bootout', `${domain}/${LABEL}`]],
      ['launchctl', ['bootstrap', domain, plist]],
    ],
    tolerantInstall: [0],
    uninstallCommands: [['launchctl', ['bootout', `${domain}/${LABEL}`]]],
    statusCommand: ['launchctl', ['print', `${domain}/${LABEL}`]],
    hints: [],
  };
}

export function parseMacosStatus(r: RunResult): ServiceStatus {
  if (r.code !== 0) return { exists: false, enabled: null, running: null, lastResult: null };
  const state = /^\s*state = (\S+)/m.exec(r.stdout)?.[1];
  const exit = /^\s*last exit code = (\S+)/m.exec(r.stdout)?.[1];
  return { exists: true, enabled: true, running: state ? state === 'running' : null, lastResult: exit ?? null };
}
