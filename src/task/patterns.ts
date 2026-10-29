import type { WorkItemPatternsResponse } from '../types.js';

const MAX_BRANCH_LENGTH = 255;
const ALLOWED_FLAGS = new Set(['i', 'm', 's', 'u']);

/** Default do servidor (design 14.2): só `AB#<n>`, para o vínculo de hoje não mudar. */
export const DEFAULT_PATTERNS: WorkItemPatternsResponse = {
  enabled: true,
  updatedAt: null,
  patterns: [
    {
      regex: '(?i)\\QAB#\\E(\\d+)(?!\\d)',
      preset: 'AB_HASH',
      portable: { source: 'AB#(\\d+)(?!\\d)', flags: 'i' },
    },
  ],
};

export interface CompiledPattern {
  preset: string;
  /** null quando o padrão não tem versão portátil: só o servidor decide. */
  regex: RegExp | null;
  /** true: sem conversão segura para JavaScript, o match local pula o padrão. */
  serverOnly: boolean;
}

function compileOne(p: WorkItemPatternsResponse['patterns'][number]): CompiledPattern {
  const preset = typeof p.preset === 'string' ? p.preset : '';
  const pt = p.portable;
  if (!pt || typeof pt.source !== 'string' || typeof pt.flags !== 'string') return { preset, regex: null, serverOnly: true };
  if ([...pt.flags].some((f) => !ALLOWED_FLAGS.has(f))) return { preset, regex: null, serverOnly: true };
  try {
    return { preset, regex: new RegExp(pt.source, pt.flags), serverOnly: false };
  } catch {
    return { preset, regex: null, serverOnly: true };
  }
}

/**
 * Compila a resposta do servidor sem reordenar. `enabled: false` não deixa
 * nenhum padrão local: o passo da branch não roda no servidor.
 */
export function compileServerPatterns(resp: WorkItemPatternsResponse): CompiledPattern[] {
  if (!resp.enabled) return [];
  return (Array.isArray(resp.patterns) ? resp.patterns : []).map(compileOne);
}

/** Referência de tarefa na branch: grupo 1 do primeiro padrão que casa, na ordem recebida. */
export function taskRefFromBranch(branch: string | null, patterns: CompiledPattern[]): string | null {
  if (!branch) return null;
  const b = branch.slice(0, MAX_BRANCH_LENGTH);
  for (const p of patterns) {
    if (p.serverOnly || !p.regex) continue;
    const g = p.regex.exec(b)?.[1];
    if (g) return p.preset === 'AB_HASH' && /^\d+$/.test(g) ? `AB#${g}` : g;
  }
  return null;
}
