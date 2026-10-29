import { homedir } from 'node:os';
import { join } from 'node:path';

/** Pasta de estado do agente, só do usuário. */
export function stateDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.ANDROMEDA_AGENT_HOME) return env.ANDROMEDA_AGENT_HOME;
  const home = env.HOME ?? env.USERPROFILE ?? homedir();
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'andromeda-agent');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'andromeda-agent');
  return join(env.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'andromeda-agent');
}
