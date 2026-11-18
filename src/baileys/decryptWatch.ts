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

// ---------------------------------------------------------------------------
// Renegociação automática por contato (SÓ no modo "full")
// ---------------------------------------------------------------------------
// Regras, depois do incidente de 18/11:
//  - Só conta falha de mensagem RECEBIDA de um lead. Falha em mensagem
//    "fromMe" (cópia do que o próprio número enviou por outro aparelho) não
//    tem nada a ver com o lead: quem falhou foi o outro aparelho da conta, e
//    renegociar com o lead só gera consulta inútil no WhatsApp.
//  - Existe um teto de renegociações por sessão por minuto. Sem teto, uma
//    instabilidade vira centenas de buscas de chave em poucos segundos.
//  - Nunca bloqueia contato. Bloquear lead por erro de criptografia fazia o
//    lead não conseguir mais mandar mensagem (nem o comprovante).
const FAILURE_THRESHOLD = 3;
const WINDOW_MS = 2 * 60 * 1000;
const COOLDOWN_MS = 10 * 60 * 1000;
const MAX_RENEGOTIATIONS_PER_MINUTE = 4;

interface FailureState {
  count: number;
  windowStart: number;
}

export interface FailureTracker {
  noteFailure(jid: string | undefined | null, reason: string): void;
}

// Fora da closure, de propósito: uma reconexão cria um tracker novo e não
// pode apagar a memória do cooldown.
const globalLastTrigger = new Map<string, number>();
const renegotiationsBySession = new Map<string, number[]>();

function budgetAvailable(sessionId: string, now: number): boolean {
  const hits = (renegotiationsBySession.get(sessionId) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= MAX_RENEGOTIATIONS_PER_MINUTE) {
    renegotiationsBySession.set(sessionId, hits);
    return false;
  }
  hits.push(now);
  renegotiationsBySession.set(sessionId, hits);
  return true;
}

export function createFailureTracker(
  sessionId: string,
  onRepeatedFailure: (jid: string) => void
): FailureTracker {
  const failures = new Map<string, FailureState>();

  return {
    noteFailure(jid, reason) {
      if (!jid || typeof jid !== "string") return;

      const now = Date.now();
      const cooldownKey = `${sessionId}:${jid}`;
      const last = globalLastTrigger.get(cooldownKey);
      if (last && now - last < COOLDOWN_MS) return;

      const state = failures.get(jid);
      if (!state || now - state.windowStart > WINDOW_MS) {
        failures.set(jid, { count: 1, windowStart: now });
        return;
      }
      state.count += 1;
      if (state.count < FAILURE_THRESHOLD) return;

      failures.delete(jid);
      globalLastTrigger.set(cooldownKey, now);
      if (!budgetAvailable(sessionId, now)) return; // teto por minuto atingido
      console.warn(
        `[decrypt-watch:${sessionId}] ${FAILURE_THRESHOLD} falhas (${reason}) seguidas com ${jid} — renegociando sessão desse contato`
      );
      onRepeatedFailure(jid);
    },
  };
}

// ---------------------------------------------------------------------------
// Contadores de falha de decriptação (viram um número na linha [stats])
// ---------------------------------------------------------------------------
let decryptFailures = 0;
export function takeDecryptFailureCount(): number {
  const n = decryptFailures;
  decryptFailures = 0;
  return n;
}

// No máximo algumas linhas por minuto por sessão — o resto só é contado.
const MAX_DECRYPT_LINES_PER_MINUTE = 5;
const decryptLines = new Map<string, number[]>();
function mayPrintDecryptLine(sessionId: string): boolean {
  const now = Date.now();
  const hits = (decryptLines.get(sessionId) ?? []).filter((t) => now - t < 60_000);
  if (hits.length >= MAX_DECRYPT_LINES_PER_MINUTE) {
    decryptLines.set(sessionId, hits);
    return false;
  }
  hits.push(now);
  decryptLines.set(sessionId, hits);
  return true;
}

// ---------------------------------------------------------------------------
// "Socket zumbi"
// ---------------------------------------------------------------------------
// O WebSocket morreu de um jeito que o Baileys NUNCA emite connection
// "close" — então a reconexão automática não dispara. O sintoma é "error in
// validating connection" repetindo sem parar. Esse watcher detecta a rajada
// e força um restart da sessão.
const ZOMBIE_THRESHOLD = 8;
const ZOMBIE_WINDOW_MS = 20_000;
const ZOMBIE_COOLDOWN_MS = 2 * 60 * 1000;

export interface ZombieSocketWatch {
  noteConnectionError(): void;
}

export function createZombieSocketWatch(
  sessionId: string,
  onZombieDetected: () => void
): ZombieSocketWatch {
  let hits: number[] = [];
  let lastTrigger = 0;

  return {
    noteConnectionError() {
      const now = Date.now();
      if (lastTrigger && now - lastTrigger < ZOMBIE_COOLDOWN_MS) return;

      hits.push(now);
      hits = hits.filter((t) => now - t <= ZOMBIE_WINDOW_MS);

      if (hits.length >= ZOMBIE_THRESHOLD) {
        hits = [];
        lastTrigger = now;
        console.warn(
          `[zombie-watch:${sessionId}] ${ZOMBIE_THRESHOLD}+ erros de "Connection Closed" em ${ZOMBIE_WINDOW_MS / 1000}s sem reconexão automática — forçando reinício da sessão`
        );
        onZombieDetected();
      }
    },
  };
}

// Logger passado pro Baileys. `decryptTracker` é null no modo "labels" (lá
// as mensagens nem são decifradas, então não há o que renegociar).
export function createConnectionWatchLogger(
  sessionId: string,
  decryptTracker: FailureTracker | null,
  zombieWatch: ZombieSocketWatch
): ILogger {
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
          decryptFailures++;
          const key = (obj as any)?.key;
          if (decryptTracker && key?.fromMe !== true) {
            decryptTracker.noteFailure(key?.remoteJid, "decrypt");
          }
          // Uma linha curta (sem stack), e só algumas por minuto.
          if (mayPrintDecryptLine(sessionId)) {
            // O remetente real (usuário.aparelho) só aparece no stack do
            // libsignal. ".0" é o celular principal; outro número é um
            // aparelho vinculado (WAHA, WhatsApp Web).
            const stack = String((obj as any)?.err?.stack ?? "");
            const sender = stack.match(/at (?:async )?(\d+\.\d+) \[as awaitable\]/)?.[1] ?? "?";
            console.warn(
              `[decrypt:${sessionId}] falha ao decifrar (${(obj as any)?.err?.message ?? "?"}) — remetente ${sender} chat ${key?.remoteJid ?? "?"} fromMe=${key?.fromMe === true}`
            );
          }
          return;
        }
        if (msg === "error in validating connection") {
          zombieWatch.noteConnectionError();
        }
        pinoLogger.error(obj, msg);
      },
    } as ILogger;
  }

  return wrap(base.child({ sessionId }));
}
