import type { LogParser } from '../types.js';
import { claudeParser } from './claude.js';
import { codexParser } from './codex.js';

export const parsers: LogParser[] = [claudeParser, codexParser];
