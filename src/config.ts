import type { SessionMode } from "./types";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Env var obrigatória ausente: ${name}`);
  return v;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const mode = String(process.env.DEFAULT_SESSION_MODE ?? "labels").toLowerCase();

export const config = {
  port: Number(process.env.PORT ?? 3000),
  apiKey: required("CONNECTOR_API_KEY"),
  redisUrl: required("REDIS_URL"),
  webhookUrl: required("WEBHOOK_URL"),
  webhookSecret: required("WEBHOOK_SECRET"),

  // Modo usado quando a sessão é criada sem informar o modo. Hoje todas as
  // sessões são linhas de etiquetas, então o padrão é "labels".
  defaultSessionMode: (mode === "full" ? "full" : "labels") as SessionMode,

  // Auto-cura periódica (ver baileys/selfHeal.ts).
  selfHealIntervalMs: num("SELF_HEAL_INTERVAL_MS", 3 * 60_000),
  // Sessão nunca pareada e parada há mais que isso é apagada sozinha.
  orphanTtlHours: num("ORPHAN_TTL_HOURS", 24),
  // Tempo máximo de uma operação de etiqueta antes de devolver erro.
  labelOpTimeoutMs: num("LABEL_OP_TIMEOUT_MS", 20_000),
  // Pausa mínima entre duas operações de etiqueta do MESMO número.
  labelPaceMs: num("LABEL_PACE_MS", 700),
};
