// Auto-cura periódica.
//
// A cada SELF_HEAL_INTERVAL_MS (padrão 3 min) passa por todas as sessões e
// corrige sozinha o que encontrar fora do lugar:
//
//  1. Sessão pareada que deveria estar de pé mas não tem socket (o timer de
//     reconexão se perdeu, o start falhou)            -> religa.
//  2. Sessão presa "conectando" há mais de 2 minutos  -> reinicia.
//  3. Socket aberto mas status gravado diferente      -> corrige o status e
//     avisa o CRM.
//  4. Sessão conectada com a lista de etiquetas vazia -> relê as etiquetas do
//     WhatsApp (no máximo uma vez por hora por sessão).
//  5. Sessão que nunca foi pareada e está parada há mais de ORPHAN_TTL_HOURS
//     (padrão 24 h)                                   -> apaga do Redis. São
//     os restos de números excluídos no CRM.
//
// É de propósito conservadora: no máximo MAX_RESTARTS_PER_RUN reinícios por
// rodada e uma pausa entre uma ação e outra, para a cura nunca virar a
// própria causa de instabilidade.

import { getLabelBlock } from "./labels";
import { config } from "../config";
import { redis } from "../redis";
import { SessionRecord } from "../types";
import { isSessionPaired, clearRedisAuthState } from "./authState";
import { clearLabelStore, countLabelsInStore } from "./labelStore";
import { sendWebhookEvent } from "../webhook";
import {
  getLastLabelResync,
  getLiveInfo,
  getLiveSocket,
  getReconnectAttempts,
  getSessionRecord,
  hasPendingReconnect,
  listSessionIds,
  restartSession,
  resyncLabels,
  startSession,
} from "./session";

const MAX_RESTARTS_PER_RUN = 4;
const STUCK_CONNECTING_MS = 2 * 60_000;
const LABEL_RESYNC_EVERY_MS = 60 * 60_000;
const STEP_PAUSE_MS = 1200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SessionHealth {
  id: string;
  // número do WhatsApp pareado nesta sessão (só quando conectada)
  phone: string | null;
  status: string;
  mode: string;
  paired: boolean;
  live: boolean;
  ws_open: boolean;
  labels: number;
  // true quando a linha tem as chaves de sincronização (sem elas não etiqueta)
  sync_keys: boolean;
  // true quando o WhatsApp recusa (403) o estado de etiquetas: nada grava
  // nessa linha até ela ser pareada de novo.
  labels_blocked: boolean;
  reconnect_attempts: number;
  pending_reconnect: boolean;
  updated_at: string | null;
}

export async function describeSession(id: string, rec?: SessionRecord | null): Promise<SessionHealth> {
  const record = rec === undefined ? await getSessionRecord(id) : rec;
  const info = getLiveInfo(id);
  const meId = getLiveSocket(id)?.user?.id ?? "";
  return {
    id,
    phone: meId ? meId.split("@")[0].split(":")[0] : null,
    status: record?.status ?? "missing",
    mode: info?.mode ?? record?.mode ?? config.defaultSessionMode,
    paired: record?.paired ?? (await isSessionPaired(id)),
    live: !!info,
    ws_open: !!info?.wsOpen,
    labels: await countLabelsInStore(id).catch(() => 0),
    sync_keys: !!getLiveSocket(id)?.authState?.creds?.myAppStateKeyId,
    labels_blocked: !!getLabelBlock(id),
    reconnect_attempts: getReconnectAttempts(id),
    pending_reconnect: hasPendingReconnect(id),
    updated_at: record?.updatedAt ?? null,
  };
}

export async function describeAllSessions(): Promise<SessionHealth[]> {
  const ids = await listSessionIds();
  const out: SessionHealth[] = [];
  for (const id of ids) out.push(await describeSession(id));
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export interface SelfHealReport {
  at: string;
  sessions: number;
  connected: number;
  restarted: string[];
  status_fixed: string[];
  labels_resynced: string[];
  orphans_removed: string[];
  errors: string[];
}

let running = false;
let lastReport: SelfHealReport | null = null;

export function getLastSelfHealReport(): SelfHealReport | null {
  return lastReport;
}

export async function runSelfHeal(trigger = "timer"): Promise<SelfHealReport> {
  if (running) {
    return lastReport ?? {
      at: new Date().toISOString(), sessions: 0, connected: 0,
      restarted: [], status_fixed: [], labels_resynced: [], orphans_removed: [], errors: ["already_running"],
    };
  }
  running = true;
  const report: SelfHealReport = {
    at: new Date().toISOString(),
    sessions: 0,
    connected: 0,
    restarted: [],
    status_fixed: [],
    labels_resynced: [],
    orphans_removed: [],
    errors: [],
  };

  try {
    const ids = await listSessionIds();
    report.sessions = ids.length;
    const now = Date.now();

    for (const id of ids) {
      try {
        const rec = await getSessionRecord(id);
        if (!rec) continue;
        const info = getLiveInfo(id);

        // --- Sessão parada de propósito (ou órfã) ---------------------------
        if (rec.status === "disconnected" && !info) {
          const paired = await isSessionPaired(id);
          const idleMs = now - new Date(rec.updatedAt).getTime();
          if (!paired && idleMs > config.orphanTtlHours * 3600_000) {
            await clearRedisAuthState(id);
            await clearLabelStore(id);
            await redis.del(`wa:meta:${id}`);
            report.orphans_removed.push(id);
          }
          continue;
        }

        // --- Deveria estar de pé e não tem socket ---------------------------
        if (!info) {
          if (hasPendingReconnect(id)) continue; // já tem reconexão agendada
          if (report.restarted.length >= MAX_RESTARTS_PER_RUN) continue;
          await startSession(id, {});
          report.restarted.push(id);
          await sleep(STEP_PAUSE_MS);
          continue;
        }

        // --- Tem socket, mas não abriu --------------------------------------
        if (!info.wsOpen || !info.openedAt) {
          const paired = rec.paired ?? (await isSessionPaired(id));
          const stuckMs = now - info.startedAt;
          if (paired && stuckMs > STUCK_CONNECTING_MS && report.restarted.length < MAX_RESTARTS_PER_RUN) {
            await restartSession(id, {});
            report.restarted.push(id);
            await sleep(STEP_PAUSE_MS);
          }
          continue;
        }

        // --- Conectada ------------------------------------------------------
        report.connected++;

        if (rec.status !== "connected") {
          // O socket está aberto mas o status gravado ficou para trás.
          const sock = getLiveSocket(id);
          const phone = sock?.user?.id?.split(":")[0]?.split("@")[0] ?? rec.phoneNumber;
          await redis.set(
            `wa:meta:${id}`,
            JSON.stringify({ ...rec, status: "connected", qr: null, phoneNumber: phone, paired: true, updatedAt: new Date().toISOString() })
          );
          await sendWebhookEvent(id, "session.status", {
            status: "connected",
            phone_number: phone,
            push_name: sock?.user?.name ?? rec.pushName,
          });
          report.status_fixed.push(id);
        }

        // Lista de etiquetas vazia numa sessão estável há mais de 1 minuto.
        if (now - info.openedAt > 60_000 && now - getLastLabelResync(id) > LABEL_RESYNC_EVERY_MS) {
          const labels = await countLabelsInStore(id);
          if (labels === 0) {
            await resyncLabels(id);
            report.labels_resynced.push(id);
            await sleep(STEP_PAUSE_MS);
          }
        }
      } catch (err) {
        report.errors.push(`${id}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    report.errors.push(`geral: ${(err as Error).message}`);
  } finally {
    running = false;
  }

  lastReport = report;
  const acted =
    report.restarted.length + report.status_fixed.length + report.labels_resynced.length +
    report.orphans_removed.length + report.errors.length;
  // Sempre uma linha por rodada; detalhe só quando fez alguma coisa.
  console.log(
    `[self-heal] (${trigger}) sessões=${report.sessions} conectadas=${report.connected} religadas=${report.restarted.length} status_corrigido=${report.status_fixed.length} etiquetas_relidas=${report.labels_resynced.length} órfãs_apagadas=${report.orphans_removed.length} erros=${report.errors.length}`
  );
  if (acted > 0) console.log(`[self-heal] detalhe: ${JSON.stringify(report)}`);
  return report;
}

export function installSelfHeal(): void {
  // Primeira rodada 90s depois do boot (dá tempo das sessões religarem).
  setTimeout(() => {
    runSelfHeal("boot").catch((err) => console.error("[self-heal] falha", (err as Error).message));
  }, 90_000).unref();
  setInterval(() => {
    runSelfHeal("timer").catch((err) => console.error("[self-heal] falha", (err as Error).message));
  }, config.selfHealIntervalMs).unref();
  console.log(
    `[self-heal] ativa (a cada ${Math.round(config.selfHealIntervalMs / 1000)}s; órfãs apagadas após ${config.orphanTtlHours}h)`
  );
}
