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

// Quantas falhas seguidas de decriptação/mensagem vazia pro MESMO contato,
// dentro dessa janela, disparam a renegociação automática (assertSessions
// com force).
const FAILURE_THRESHOLD = 3;
const WINDOW_MS = 2 * 60 * 1000;

interface FailureState {
  count: number;
  windowStart: number;
}

export interface FailureTracker {
  noteFailure(jid: string | undefined | null, reason: string): void;
}

// Cobre dois casos bem diferentes, que precisam contar pro mesmo limite:
// 1) Falha de decriptação Signal de verdade (erro no log do Baileys,
//    "failed to decrypt message" — Bad MAC, No session record, etc).
// 2) Mensagem "stub" vazia (messageStubType 2 / CIPHERTEXT — o WhatsApp
//    entrega um envelope sem conteúdo, "Message absent from node"). Esse
//    caso NUNCA gera um erro de log — precisa ser detectado direto no
//    messages.upsert (ver session.ts), não dá pra pegar só ouvindo o logger.
export function createFailureTracker(
  sessionId: string,
  onRepeatedFailure: (jid: string) => void
): FailureTracker {
  const failures = new Map<string, FailureState>();

  return {
    noteFailure(jid, reason) {
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
          `[decrypt-watch:${sessionId}] ${FAILURE_THRESHOLD} falhas (${reason}) seguidas com ${jid} — renegociando sessão automaticamente`
        );
        onRepeatedFailure(jid);
      }
    },
  };
}

export function createDecryptWatchLogger(sessionId: string, tracker: FailureTracker): ILogger {
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
        if (msg === "failed to decrypt message") {
          tracker.noteFailure((obj as any)?.key?.remoteJid, "decrypt");
        }
        pinoLogger.error(obj, msg);
      },
    } as ILogger;
  }

  return wrap(base);
}
