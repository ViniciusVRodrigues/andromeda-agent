import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const CHUNK = 256 * 1024;
const NL = 0x0a;

export interface LinesResult {
  lines: string[];
  nextOffset: number;
  /** true quando o offset passou do tamanho e a leitura recomeçou do zero. */
  restarted: boolean;
}

/** Separa um buffer em linhas completas; devolve quantos bytes foram consumidos. */
export function splitCompleteLines(buf: Buffer): { lines: string[]; consumed: number } {
  const last = buf.lastIndexOf(NL);
  if (last < 0) return { lines: [], consumed: 0 };
  const lines = buf
    .subarray(0, last)
    .toString('utf8')
    .split('\n')
    .map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
    .filter((l) => l.length > 0);
  return { lines, consumed: last + 1 };
}

/**
 * Lê só os bytes a partir de `offset`, em blocos, e consome até a última `\n`.
 * Se o arquivo encolheu (offset maior que o tamanho), recomeça do zero.
 */
export async function readLinesFrom(file: string, offset: number): Promise<LinesResult> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = offset > size || offset < 0 ? 0 : offset;
    const lines: string[] = [];
    let pos = start;
    let leftover: Buffer = Buffer.alloc(0);
    let consumedTotal = 0;
    const chunk = Buffer.alloc(CHUNK);
    while (pos < size) {
      const { bytesRead } = await fh.read(chunk, 0, CHUNK, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
      const piece = chunk.subarray(0, bytesRead);
      const joined = leftover.length ? Buffer.concat([leftover, piece]) : Buffer.from(piece);
      const { lines: got, consumed } = splitCompleteLines(joined);
      lines.push(...got);
      consumedTotal += consumed;
      leftover = joined.subarray(consumed);
    }
    return { lines, nextOffset: start + consumedTotal, restarted: start !== offset };
  } finally {
    await fh.close();
  }
}

/** Lista recursivamente os arquivos de `root` cujo nome passa em `match`. Pasta ausente = vazio. */
export async function walkFiles(root: string, match: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && match(e.name)) out.push(p);
    }
  }
  await walk(root);
  return out.sort();
}

/** JSON.parse que devolve null em vez de lançar, e só objetos. */
export function parseObject(line: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

export function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
