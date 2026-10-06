// The website's server log (L-1, L-10): one JSON line per event on stdout, in the shape the other apps'
// logger writes, so Loki reads them alike. Only server code calls it. The console runs in the browser
// and logs nothing on the server, so a master key can't reach a log.

const levels = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
export type LogLevelName = keyof typeof levels;

export interface LogOptions {
  // LOG_LEVEL, as the other apps read it (L-11). Default: info.
  readonly env?: Readonly<Record<string, string | undefined>>;
  // Default: stdout
  readonly write?: (line: string) => void;
}

const thresholdOf = (env: Readonly<Record<string, string | undefined>>): number => {
  const name = env['LOG_LEVEL']?.trim().toLowerCase();
  if (name === 'silent')
    return Number.POSITIVE_INFINITY;

  return name !== undefined && name in levels ? levels[name as LogLevelName] : levels.info;
};

const writeStdout = (line: string): void => {
  process.stdout.write(line);
};

/** Writes one line, unless LOG_LEVEL is above its level. Fields hold metadata only: never a body, a key, or a URL's query. */
export const writeLogLine = (level: LogLevelName, msg: string, fields: Readonly<Record<string, unknown>>, { env = process.env, write = writeStdout }: LogOptions = {}): void => {
  if (levels[level] < thresholdOf(env))
    return;

  write(`${JSON.stringify({ level: levels[level], time: Date.now(), name: 'web', ...fields, msg })}\n`);
};
