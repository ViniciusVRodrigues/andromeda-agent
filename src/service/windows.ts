import { win32 } from 'node:path';
import type { PlanInput, RunResult, ServicePlan, ServiceStatus } from './index.js';

export const TASK_NAME = 'andromeda-agent';

export function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Literal de string do VBScript: aspas dobradas. */
export function vbsQuote(s: string): string {
  return '"' + s.replace(/"/g, '""') + '"';
}

export function buildTaskXml(userId: string, vbsPath: string): string {
  const u = xmlEscape(userId);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Andromeda Agent: envia contagens de tokens das IAs de programação.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${u}</UserId>
    </LogonTrigger>
    <SessionStateChangeTrigger>
      <Enabled>true</Enabled>
      <StateChange>SessionUnlock</StateChange>
      <UserId>${u}</UserId>
    </SessionStateChangeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${u}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>${xmlEscape(`//B //Nologo "${vbsPath}"`)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export const RESTART_DELAY_MS = 60_000;

/**
 * Roda o node com janela oculta e o supervisiona: se ele cai (saída diferente de
 * zero), espera um minuto e sobe de novo. O `RestartOnFailure` do Agendador não
 * serve para isso: no ensaio de 2026-10-29 ele não reiniciou a tarefa depois de
 * o processo morrer, só cobre falha ao iniciar. Saída 0 (parada limpa, ou outra
 * instância já com o `agent.lock`) encerra. Como o wscript fica vivo, o
 * `IgnoreNew` impede uma segunda cópia no logon ou desbloqueio seguinte.
 * Prefere o node gravado no install.
 */
export function buildLaunchVbs(nodePath: string, cliPath: string, restartDelayMs = RESTART_DELAY_MS): string {
  return [
    "' Gerado por andromeda-agent install. Nao edite.",
    'Option Explicit',
    'Dim sh, fso, node, cmd, rc',
    'Set sh = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    `node = ${vbsQuote(nodePath)}`,
    'If Not fso.FileExists(node) Then node = "node"',
    `cmd = """" & node & """ ""${cliPath.replace(/"/g, '""')}"" run"`,
    'Do',
    '  rc = sh.Run(cmd, 0, True)',
    '  If rc = 0 Then Exit Do',
    `  WScript.Sleep ${Math.max(1000, Math.round(restartDelayMs))}`,
    'Loop',
    'WScript.Quit rc',
    '',
  ].join('\r\n');
}

export function planWindows(i: PlanInput): ServicePlan {
  const xmlPath = win32.join(i.stateDir, 'andromeda-agent-task.xml');
  const vbsPath = win32.join(i.stateDir, 'launch.vbs');
  const userId = i.userDomain ? `${i.userDomain}\\${i.username}` : i.username;
  return {
    platform: 'win32',
    files: [
      { path: xmlPath, content: buildTaskXml(userId, vbsPath), encoding: 'utf16le-bom' },
      // UTF-16 com BOM: o WSH leria UTF-8 como ANSI e quebraria pastas com acento.
      { path: vbsPath, content: buildLaunchVbs(i.nodePath, i.cliPath), encoding: 'utf16le-bom' },
    ],
    installCommands: [
      ['schtasks', ['/create', '/tn', TASK_NAME, '/xml', xmlPath, '/f']],
      ['schtasks', ['/run', '/tn', TASK_NAME]],
    ],
    tolerantInstall: [1],
    uninstallCommands: [['schtasks', ['/delete', '/tn', TASK_NAME, '/f']]],
    statusCommand: ['schtasks', ['/query', '/tn', TASK_NAME, '/xml']],
    hints: [],
  };
}

export function parseWindowsStatus(r: RunResult): ServiceStatus {
  if (r.code !== 0) return { exists: false, enabled: null, running: null, lastResult: null };
  // O XML não é localizado; o estado de execução só aparece no /v (localizado), então fica desconhecido.
  const enabled = !/<Settings>[\s\S]*?<Enabled>\s*false\s*<\/Enabled>/i.test(r.stdout);
  return { exists: true, enabled, running: null, lastResult: null };
}
