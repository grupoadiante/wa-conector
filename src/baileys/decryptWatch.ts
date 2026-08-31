import P from "pino";

// Não exportado publicamente pelo pacote — replicamos a forma mínima que o
// Baileys espera (ver node_modules/@whiskeysockets/baileys/lib/Utils/logger.d.ts).
interface ILogger {
  level: string;
  child(obj: Record<string, unknown>): ILogger;
  trace(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

const base = P({ level: "error" });

// Quantas falhas seguidas de decriptação pro MESMO contato, dentro dessa
// janela, disparam a renegociação automática (assertSessions com force).
const FAILURE_THRESHOLD = 3;
const WINDOW_MS = 2 * 60 * 1000;

interface FailureState {
  count: number;
  windowStart: number;
}

// Só dispara o callback definido em createDecryptWatchLogger — o cache de
// contadores fica isolado por sessão (Map por instância).
export function createDecryptWatchLogger(
  sessionId: string,
  onRepeatedFailure: (jid: string) => void
): ILogger {
  const failures = new Map<string, FailureState>();

  function noteFailure(obj: unknown) {
    const jid = (obj as any)?.key?.remoteJid;
    if (!jid || typeof jid !== "string") return;

    const now = Date.now();
    const state = failures.get(jid);
    if (!state || now - state.windowStart > WINDOW_MS) {
      failures.set(jid, { count: 1, windowStart: now });
      return;
    }
    state.count += 1;
    if (state.count >= FAILURE_THRESHOLD) {
      failures.delete(jid);
      console.warn(
        `[decrypt-watch:${sessionId}] ${FAILURE_THRESHOLD} falhas de decriptação seguidas com ${jid} — renegociando sessão automaticamente`
      );
      onRepeatedFailure(jid);
    }
  }

  function wrap(pinoLogger: any): ILogger {
    return {
      get level() {
        return pinoLogger.level;
      },
      set level(v: string) {
        pinoLogger.level = v;
      },
      child: (obj: Record<string, unknown>) => wrap(pinoLogger.child(obj)),
      trace: (obj: unknown, msg?: string) => pinoLogger.trace(obj, msg),
      debug: (obj: unknown, msg?: string) => pinoLogger.debug(obj, msg),
      info: (obj: unknown, msg?: string) => pinoLogger.info(obj, msg),
      warn: (obj: unknown, msg?: string) => pinoLogger.warn(obj, msg),
      error: (obj: unknown, msg?: string) => {
        if (msg === "failed to decrypt message") noteFailure(obj);
        pinoLogger.error(obj, msg);
      },
    } as ILogger;
  }

  return wrap(base);
}
