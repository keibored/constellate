type Level = 'debug' | 'info' | 'warn' | 'error';
// Deliberately no payload, headers, URLs, tokens, SDP or arbitrary Error objects.
type Fields = Partial<{ code: string; signal: string; requestId: string; method: string; route: string;
  status: number; durationMs: number; port: number; pid: number; operation: string; count: number }>;
const levels = { debug: 10, info: 20, warn: 30, error: 40 };

export function log(level: Level, event: string, message: string, fields: Fields = {}) {
  const configured = process.env.LOG_LEVEL as Level | undefined;
  if (levels[level] < (levels[configured ?? 'info'] ?? levels.info)) return;
  const output = process.env.NODE_ENV === 'production'
    ? JSON.stringify({ time: new Date().toISOString(), level, event, message, ...fields })
    : `${message}${Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : ''}`;
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.log(output);
}
