import { existsSync, mkdirSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import type { LogLevel } from '../config.js';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const RESET = '[0m';
const BOLD = '[1m';
const DIM = '[2m';
const GREEN = '[32m';
const RED = '[31m';
const YELLOW = '[33m';
const CYAN = '[36m';
const MAGENTA = '[35m';

let currentLevel: LogLevel = 'info';
let logFilePath: string | null = null;
let logFileReady = false;
const useColor = process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined;

function paint(text: string, color: string): string {
  return useColor ? `${color}${text}${RESET}` : text;
}

function ensureLogFile(): void {
  if (logFileReady || logFilePath === null) return;
  logFileReady = true;
  try {
    mkdirSync(path.dirname(logFilePath), { recursive: true });
  } catch {
    logFilePath = null;
  }
}

function writeToFile(line: string): void {
  if (logFilePath === null) return;
  ensureLogFile();
  if (logFilePath === null) return;
  try {
    appendFileSync(logFilePath, `${line}\n`, 'utf8');
  } catch {
    // Logging to disk must never crash the run.
  }
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '');
}

function emit(level: LogLevel, args: unknown[]): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel]) return;
  const timestamp = new Date().toISOString();
  const message = args.map((arg) => stringify(arg)).join(' ');
  const plain = `[${timestamp}] ${level.toUpperCase().padEnd(5)} ${message}`;
  writeToFile(plain);
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${plain}\n`);
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export const logger = {
  setLevel(level: LogLevel): void {
    currentLevel = level;
  },
  getLevel(): LogLevel {
    return currentLevel;
  },
  setLogFile(filePath: string): void {
    logFilePath = filePath;
    logFileReady = false;
  },
  debug(...args: unknown[]): void {
    emit('debug', args);
  },
  info(...args: unknown[]): void {
    emit('info', args);
  },
  warn(...args: unknown[]): void {
    emit('warn', args);
  },
  error(...args: unknown[]): void {
    emit('error', args);
  },
  success(message: string): void {
    emit('info', [paint(`✓ ${message}`, GREEN)]);
  },
  fail(message: string): void {
    emit('info', [paint(`✗ ${message}`, RED)]);
  },
  step(message: string): void {
    emit('info', [paint(`→ ${message}`, CYAN)]);
  },
  warnLine(message: string): void {
    emit('info', [paint(`! ${message}`, YELLOW)]);
  },
  banner(title: string): void {
    const line = '─'.repeat(Math.max(title.length + 4, 40));
    emit('info', [paint(line, DIM)]);
    emit('info', [paint(`  ${title}`, BOLD)]);
    emit('info', [paint(line, DIM)]);
  },
  section(title: string): void {
    emit('info', [paint(`\n${title}`, BOLD + MAGENTA)]);
  },
  kv(key: string, value: unknown): void {
    emit('info', [`  ${paint(key.padEnd(14), DIM)} ${stringify(value)}`]);
  },
  raw(message: string): void {
    process.stdout.write(`${stripAnsi(message)}\n`);
  },
  /** Raw text without color, also mirrored to the log file. */
  block(lines: readonly string[]): void {
    for (const line of lines) {
      process.stdout.write(`${stripAnsi(line)}\n`);
      writeToFile(line);
    }
  },
};

export function logFileExists(filePath: string): boolean {
  return existsSync(filePath);
}
