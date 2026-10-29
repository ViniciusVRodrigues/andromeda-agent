export const MAX_PATTERNS = 10;
export const MAX_PATTERN_LENGTH = 200;
const MAX_BRANCH_LENGTH = 255;

/**
 * Padrões default. A ordem difere da listagem do servidor em um ponto: o de
 * chave Jira vem antes do genérico, senão `feat/PROJ-88_foo` casaria `88`.
 */
export const DEFAULT_PATTERNS: string[] = [
  'AB#(\\d+)',
  '([A-Z][A-Z0-9]{1,9}-\\d+)',
  '(?i)(?:^|/)(?:[a-z]+[-_])?(\\d{2,7})(?=[-_/.]|$)',
];

export interface CompiledPattern {
  source: string;
  regex: RegExp;
  /** true no padrão `AB#(\d+)`: o grupo ganha o prefixo `AB#`. */
  abPrefix: boolean;
}

export function compilePatterns(list: string[]): CompiledPattern[] {
  if (list.length > MAX_PATTERNS) {
    throw new Error(`Padrões demais: ${list.length} (máximo ${MAX_PATTERNS})`);
  }
  return list.map((src, i) => {
    if (src.length > MAX_PATTERN_LENGTH) {
      throw new Error(`Padrão ${i} longo demais (máximo ${MAX_PATTERN_LENGTH} caracteres)`);
    }
    let body = src;
    let flags = '';
    if (body.startsWith('(?i)')) {
      body = body.slice(4);
      flags = 'i';
    }
    let regex: RegExp;
    try {
      regex = new RegExp(body, flags);
    } catch (e) {
      throw new Error(`Padrão ${i} inválido: ${(e as Error).message}`);
    }
    const groups = new RegExp(`${body}|`, flags).exec('')?.length ?? 1;
    if (groups < 2) throw new Error(`Padrão ${i} sem grupo de captura`);
    return { source: src, regex, abPrefix: body.startsWith('AB#(') };
  });
}

/** Referência de tarefa na branch: grupo 1 do primeiro padrão que casa. */
export function taskRefFromBranch(branch: string | null, patterns: CompiledPattern[]): string | null {
  if (!branch) return null;
  const b = branch.slice(0, MAX_BRANCH_LENGTH);
  for (const p of patterns) {
    const m = p.regex.exec(b);
    const g = m?.[1];
    if (g) return p.abPrefix && /^\d+$/.test(g) ? `AB#${g}` : g;
  }
  return null;
}
