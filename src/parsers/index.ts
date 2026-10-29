import type { LogParser } from '../types.js';
import { claudeParser } from './claude.js';
import { clineParser } from './cline.js';
import { codexParser } from './codex.js';
import { geminiParser } from './gemini.js';
import { kiloParser, opencodeParser } from './opencode.js';

export const parsers: LogParser[] = [claudeParser, codexParser, geminiParser, opencodeParser, kiloParser, clineParser];
