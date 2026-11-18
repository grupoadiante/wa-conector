// O libsignal (usado por baixo do Baileys) escreve direto no console, sem
// passar pelo logger, e em alguns casos imprime o objeto da sessão INTEIRO —
// incluindo chaves privadas (privKey, rootKey). Além de vazar segredo no log
// do painel, isso custa CPU e esconde as linhas que importam.
//
// Aqui a gente descarta essas linhas e só conta quantas foram, para o total
// aparecer na linha [stats] do minuto.

const NOISY_PREFIXES = [
  "Closing session",
  "Opening session",
  "Removing old closed session",
  "Closing open session in favor of incoming prekey bundle",
  "Closing stale open session",
  "Session already closed",
  "Session already open",
  "Migrating session to",
  "Decrypted message with closed session",
  "Failed to decrypt message with any known session",
  "Session error:",
];

let dropped = 0;
let installed = false;

export function takeDroppedNoiseCount(): number {
  const n = dropped;
  dropped = 0;
  return n;
}

function isNoise(args: unknown[]): boolean {
  const first = args[0];
  if (typeof first !== "string") return false;
  return NOISY_PREFIXES.some((p) => first.startsWith(p));
}

export function installConsoleNoiseFilter(): void {
  if (installed) return;
  installed = true;
  for (const method of ["log", "info", "warn", "error"] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      if (isNoise(args)) {
        dropped++;
        return;
      }
      original(...args);
    };
  }
}
