// O libsignal (usado por baixo do Baileys) escreve alguns erros DIRETO no
// console.error, sem passar pelo logger que a gente passa pro makeWASocket
// (ver node_modules/libsignal/src/session_cipher.js linhas 157/159). Isso
// significa que o decrypt-watch (que só escuta o logger) nunca vê esse
// caso específico — quando TODAS as sessões conhecidas com um contato
// falham ("Failed to decrypt message with any known session..."). Como
// esse log não vem com o contato identificado (não dá pra saber qual JID),
// a única resposta possível é: se virar uma rajada grande, é sinal de que
// o estado de sessão do processo inteiro está degradado — reinicia a
// sessão toda.

const WINDOW_MS = 10_000;
const THRESHOLD = 20;
const COOLDOWN_MS = 2 * 60 * 1000;

let hits: number[] = [];
let lastRestart = 0;
let installed = false;

export function installRawSignalErrorWatch(onThresholdExceeded: () => void): void {
  if (installed) return;
  installed = true;

  const originalError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    originalError(...args);

    const text = args.map((a) => (typeof a === "string" ? a : "")).join(" ");
    const isRawSignalError =
      text.includes("Failed to decrypt message with any known session") ||
      text.startsWith("Session error:");
    if (!isRawSignalError) return;

    const now = Date.now();
    hits.push(now);
    hits = hits.filter((t) => now - t <= WINDOW_MS);

    if (hits.length >= THRESHOLD && now - lastRestart > COOLDOWN_MS) {
      lastRestart = now;
      hits = [];
      originalError(
        `[raw-signal-watch] ${THRESHOLD}+ erros crus de decriptação em ${WINDOW_MS / 1000}s — reiniciando sessão automaticamente`
      );
      onThresholdExceeded();
    }
  };
}
