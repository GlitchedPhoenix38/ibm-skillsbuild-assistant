import { accessSync, constants, existsSync } from 'node:fs';
import type { AiProvider } from '../ai/provider.js';
import { logger } from '../utils/logger.js';

export interface BraveLaunchOptions {
  /** Port passed to --remote-debugging-port. */
  readonly port: number;
  /**
   * Optional dedicated user-data-dir. Recommended: keeps your everyday Brave
   * profile untouched. Leave undefined to attach to an already-running Brave
   * that was started with the same debugging port.
   */
  readonly userDataDir?: string;
  /** Start URL(s). */
  readonly urls: readonly string[];
  /** Open a fresh, clean automation profile. */
  readonly fresh: boolean;
}

const CANDIDATE_BINARIES: readonly string[] = [
  '/usr/bin/brave',
  '/usr/bin/brave-browser',
  '/usr/bin/brave-browser-stable',
  '/opt/brave-bin/brave',
  '/opt/brave/brave',
  '/snap/bin/brave',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  `${process.env['HOME'] ?? ''}/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`,
];

/** Locate a Brave/Chromium binary without shelling out. */
export function findBraveBinary(explicit?: string): string | undefined {
  if (explicit !== undefined && explicit !== '') {
    if (!existsSync(explicit)) {
      throw new Error(`BRAVE_PATH is set to "${explicit}" but that file does not exist.`);
    }
    return explicit;
  }
  for (const candidate of CANDIDATE_BINARIES) {
    if (candidate === '' || !existsSync(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not executable, keep looking
    }
  }
  return undefined;
}

/** Print (and optionally run) the command that starts Brave with CDP enabled. */
export function buildLaunchCommand(options: BraveLaunchOptions, binary: string): string {
  const parts: string[] = [shellQuote(binary)];
  if (options.fresh) {
    parts.push(`--user-data-dir=${shellQuote(options.userDataDir ?? './.automation-profile')}`);
    parts.push('--no-first-run');
    parts.push('--no-default-browser-check');
  }
  parts.push(`--remote-debugging-port=${options.port}`);
  parts.push('about:blank');
  for (const url of options.urls) {
    parts[parts.length - 1] = shellQuote(url);
    if (url !== options.urls[options.urls.length - 1]) parts.push('about:blank');
  }
  return parts.join(' ');
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function logLaunchInstructions(options: BraveLaunchOptions, config: {
  cdpPort: number;
  executablePath: string | undefined;
}): void {
  const binary = findBraveBinary(config.executablePath);
  if (binary === undefined) {
    logger.warn('Could not find a Brave/Chromium binary. Set BRAVE_PATH in .env.');
    return;
  }

  const freshCommand = buildLaunchCommand({ ...options, fresh: true }, binary);
  const attachCommand = buildLaunchCommand({ ...options, fresh: false }, binary);

  logger.block([
    '',
    '  Brave is not reachable over the Chrome DevTools Protocol yet.',
    '',
    '  Option A (RECOMMENDED) - separate automation profile, your daily Brave stays untouched:',
    `    ${freshCommand}`,
    '    Then log in to IBM SkillsBuild manually in that window.',
    '',
    '  Option B - attach to the Brave you are already logged in to:',
    '    1. Fully quit Brave (menu -> Quit, or close every window).',
    '    2. Relaaunch from a terminal with:',
    `    ${attachCommand}`,
    '    3. Confirm http://127.0.0.1:' + String(config.cdpPort) + '/json/version lists your browser.',
    '',
    '  Notes:',
    '    - If a Brave instance is already running, new --remote-debugging-port flags are ignored.',
    '      You must quit it first (Option B step 1).',
    '    - This tool never reads, copies or stores cookies, passwords or session data.',
    '',
  ]);
}

export function describeProvider(provider: AiProvider): string {
  return `${provider.name} (${provider.model})`;
}
