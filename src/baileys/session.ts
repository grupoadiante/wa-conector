import makeWASocket, {
  DisconnectReason,
  WASocket,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WAMessageStubType,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { useRedisAuthState, clearRedisAuthState, purgeJidSession } from "./authState";
import { redis } from "../redis";
import { config } from "../config";
import { sendWebhookEvent } from "../webhook";
import { SessionMode, SessionRecord, SessionStatus } from "../types";
import {
  upsertLabelInStore,
  setChatLabelAssociation,
  countLabelsInStore,
  clearLabelStore,
} from "./labelStore";
import { downloadMedia, isDownloadableMedia } from "./media";
import { getCachedMessage, msgRetryCounterCache, rememberMessage } from "./msgCache";
import { createConnectionWatchLogger, createFailureTracker, createZombieSocketWatch } from "./decryptWatch";
import { acquireLock, releaseLock } from "./lock";
import { noteSessionClose } from "./resourceLog";
import { exemptFromQuarantine } from "./libsignalGuard";

type Managed = {
  sock: WASocket;
  mode: SessionMode;
  qrRetries: number;
  startedAt: number;
  openedAt: number | null;
  // true quando NÓS pedimos para parar (stop, QR expirado). O evento de
  // "close" que vem em seguida não pode religar a sessão.
  stopping: boolean;
};

export interface StartOptions {
  mode?: SessionMode;
  // Pedido explícito (API/painel): pode abrir uma sessão ainda não pareada
  // para mostrar o QR. Reconexão automática e religamento no boot NÃO abrem
  // sessão sem pareamento — era isso que deixava sessões órfãs em laço.
  manual?: boolean;
  // Reconexão logo depois de ler o QR (código 515): as credenciais acabaram
  // de ser gravadas, então a sessão é tratada como pareada.
  allowUnpaired?: boolean;
}

// Sessões vivas neste processo.
const live = new Map<string, Managed>();
const reconnectAttempts = new Map<string, number>();
const reconnectTimers = new Map<string, NodeJS.Timeout>();
const lastStatusSent = new Map<string, string>();
const lastLabelResync = new Map<string, number>();

const MAX_QR_RETRIES = 3;
const MAX_BACKOFF_MS = 5 * 60_000;
const recordKey = (id: string) => `wa:meta:${id}`;

async function readRecord(id: string): Promise<SessionRecord | null> {
  const raw = await redis.get(recordKey(id));
  return raw ? (JSON.parse(raw) as SessionRecord) : null;
}

async function writeRecord(id: string, patch: Partial<SessionRecord>): Promise<SessionRecord> {
  const current = (await readRecord(id)) ?? {
    id,
    status: "starting" as SessionStatus,
    qr: null,
    phoneNumber: null,
    pushName: null,
    updatedAt: new Date().toISOString(),
  };
  const next: SessionRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await redis.set(recordKey(id), JSON.stringify(next));
  return next;
}

// Avisa o CRM só quando o status MUDA. Antes, cada QR novo e cada tentativa
// de reconexão gerava um webhook — centenas por minuto com sessões paradas.
async function notifyStatus(
  id: string,
  status: SessionStatus,
  extra: Record<string, unknown> = {}
): Promise<void> {
  const key = `${status}:${String(extra.reason ?? "")}`;
  if (lastStatusSent.get(id) === key) return;
  lastStatusSent.set(id, key);
  await sendWebhookEvent(id, "session.status", { status, ...extra });
}

export async function getSessionRecord(id: string): Promise<SessionRecord | null> {
  return readRecord(id);
}

export async function listSessionIds(): Promise<string[]> {
  const ids: string[] = [];
  const stream = redis.scanStream({ match: "wa:meta:*", count: 200 });
  for await (const keys of stream) {
    for (const k of keys as string[]) ids.push(k.replace("wa:meta:", ""));
  }
  return ids;
}

export function getLiveSocket(id: string): WASocket | null {
  return live.get(id)?.sock ?? null;
}

export interface LiveInfo {
  mode: SessionMode;
  wsOpen: boolean;
  startedAt: number;
  openedAt: number | null;
  qrRetries: number;
}

export function getLiveInfo(id: string): LiveInfo | null {
  const m = live.get(id);
  if (!m) return null;
  return {
    mode: m.mode,
    wsOpen: m.sock.ws.isOpen,
    startedAt: m.startedAt,
    openedAt: m.openedAt,
    qrRetries: m.qrRetries,
  };
}

export function hasPendingReconnect(id: string): boolean {
  return reconnectTimers.has(id);
}

export function getReconnectAttempts(id: string): number {
  return reconnectAttempts.get(id) ?? 0;
}

export async function isSessionHealthy(id: string): Promise<boolean> {
  const managed = live.get(id);
  if (!managed) return false;
  return managed.sock.ws.isOpen;
}

// Apaga a sessão Signal corrompida de UM contato e força o Baileys a montar
// uma limpa do zero. Usado pela auto-cura do modo "full" e pelo endpoint
// POST /sessions/:id/purge-jid.
export async function purgeAndRenegotiate(
  id: string,
  jid: string,
  label: string = "manual"
): Promise<{ purged: number; fetched: boolean }> {
  const managed = live.get(id);
  if (!managed) throw new Error("sessão não está ativa neste processo");
  const purged = await purgeJidSession(id, jid);
  try {
    const fetched = await managed.sock.assertSessions([jid], true);
    console.log(`[${label}:${id}] sessão renegociada com ${jid} (purgado=${purged}, fetched=${fetched})`);
    return { purged, fetched };
  } catch (err) {
    console.error(`[${label}:${id}] falha ao renegociar sessão com ${jid}`, (err as Error).message);
    throw err;
  }
}

// A versão do WhatsApp Web muda raramente — consultar a cada reconexão de
// cada sessão era uma chamada de rede à toa.
let cachedVersion: { version: [number, number, number]; at: number } | null = null;
async function getWaVersion(): Promise<[number, number, number]> {
  if (cachedVersion && Date.now() - cachedVersion.at < 6 * 3600_000) return cachedVersion.version;
  const { version } = await fetchLatestBaileysVersion();
  cachedVersion = { version, at: Date.now() };
  return version;
}

// Modo "labels": quais remetentes o Baileys deve ignorar SEM decifrar.
//
// Uma linha de etiquetas recebe cópia de tudo o que o número envia e recebe.
// Decifrar isso não serve para etiquetar e era a origem de toda a carga
// (falhas de decriptação, renegociações, download de mídia). Então ignoramos
// todo mundo, com três exceções obrigatórias:
//  - o servidor do WhatsApp ("s.whatsapp.net", sem usuário): por ele chegam
//    os avisos de sincronização das etiquetas;
//  - o APARELHO PRINCIPAL da própria conta (sem sufixo ":N", ou ":0"): é ele
//    que envia as chaves de sincronização sem as quais não dá para etiquetar;
//  - TUDO, enquanto a linha ainda não recebeu as chaves de sincronização
//    (pareamento recém-feito). Nessa janela a linha se comporta exatamente
//    como antes do modo "labels", para o pareamento não depender do filtro.
//    O filtro só liga depois que as chaves chegaram.
// Os outros aparelhos da conta (":N" — o WAHA, o WhatsApp Web) são ignorados:
// são eles que mandam as cópias das mensagens do bot.
function makeLabelsOnlyFilter(
  sessionId: string,
  getMe: () => { id?: string; lid?: string } | undefined,
  hasSyncKeys: () => boolean
) {
  // Diagnóstico: registra uma vez cada forma de remetente da própria conta.
  const seenOwn = new Set<string>();
  return (jid: string): boolean => {
    if (!jid) return false;
    const at = jid.indexOf("@");
    if (at <= 0) return false;
    if (!hasSyncKeys()) return false; // janela de pareamento: não filtra nada

    const [user, device] = jid.slice(0, at).split(":");
    const me = getMe();
    const mine = [me?.id, me?.lid]
      .filter((j): j is string => !!j)
      .map((j) => j.split("@")[0].split(":")[0]);
    if (!mine.includes(user)) return true; // lead, grupo, lista: ignora

    const primary = !device || device === "0";
    if (seenOwn.size < 12 && !seenOwn.has(jid)) {
      seenOwn.add(jid);
      console.log(
        `[filter:${sessionId}] remetente da própria conta: ${jid} -> ${primary ? "processa (celular principal)" : "ignora (aparelho vinculado)"}`
      );
    }
    return !primary;
  };
}

function clearReconnectTimer(id: string): void {
  const t = reconnectTimers.get(id);
  if (t) {
    clearTimeout(t);
    reconnectTimers.delete(id);
  }
}

function scheduleReconnect(id: string, delayMs: number, opts: StartOptions): void {
  clearReconnectTimer(id);
  const timer = setTimeout(() => {
    reconnectTimers.delete(id);
    startSession(id, opts).catch((err) =>
      console.error(`[session:${id}] falha ao reconectar`, (err as Error).message)
    );
  }, delayMs);
  reconnectTimers.set(id, timer);
}

// Espera crescente entre reconexões da MESMA sessão: 2s, 4s, 8s... até 5 min.
// Volta a zero quando a conexão fica estável por 1 minuto.
function nextBackoffMs(id: string, baseMs: number): number {
  const attempts = reconnectAttempts.get(id) ?? 0;
  reconnectAttempts.set(id, attempts + 1);
  const exp = Math.min(baseMs * 2 ** Math.min(attempts, 10), MAX_BACKOFF_MS);
  return exp + Math.floor(Math.random() * 3000);
}

export async function startSession(id: string, opts: StartOptions = {}): Promise<SessionRecord> {
  const existing = live.get(id);
  if (existing) return (await readRecord(id))!;

  clearReconnectTimer(id);

  // Evita dois processos (container antigo + novo durante um redeploy)
  // segurando a mesma sessão do WhatsApp ao mesmo tempo.
  const gotLock = await acquireLock(id);
  if (!gotLock) {
    console.warn(`[session:${id}] lock ocupado por outro processo — tentando de novo em 5s`);
    scheduleReconnect(id, 5000, opts);
    return (await readRecord(id)) ?? {
      id,
      status: "starting",
      qr: null,
      phoneNumber: null,
      pushName: null,
      updatedAt: new Date().toISOString(),
    };
  }

  const { state, saveCreds } = await useRedisAuthState(id);
  const paired = !!state.creds.me?.id;
  const previous = await readRecord(id);
  const mode: SessionMode = opts.mode ?? previous?.mode ?? config.defaultSessionMode;

  // Sessão que nunca leu o QR só abre quando alguém pede (painel/API).
  if (!paired && !opts.manual && !opts.allowUnpaired) {
    await releaseLock(id);
    const rec = await writeRecord(id, { status: "disconnected", qr: null, mode, paired: false });
    console.log(`[session:${id}] sem pareamento — não religada automaticamente (aguardando pedido de QR)`);
    return rec;
  }

  await writeRecord(id, { status: "starting", qr: null, mode, paired });

  // A própria conta nunca entra em quarentena (ver libsignalGuard.ts).
  exemptFromQuarantine(state.creds.me?.id);
  exemptFromQuarantine(state.creds.me?.lid);

  const version = await getWaVersion();
  const labelsOnly = mode === "labels";

  // Renegociação automática por contato: só no modo "full", só para falha de
  // mensagem recebida de lead, e com teto por minuto (ver decryptWatch.ts).
  const failureTracker = labelsOnly
    ? null
    : createFailureTracker(id, (jid) => {
        purgeAndRenegotiate(id, jid, "decrypt-watch").catch(() => {
          /* já logado dentro de purgeAndRenegotiate */
        });
      });
  const zombieWatch = createZombieSocketWatch(id, () => {
    restartSession(id).catch((err) =>
      console.error(`[zombie-watch:${id}] falha ao reiniciar sessão`, (err as Error).message)
    );
  });
  const sessionLogger = createConnectionWatchLogger(id, failureTracker, zombieWatch);

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, sessionLogger),
    },
    logger: sessionLogger,
    printQRInTerminal: false,
    browser: ["WA Connector", "Chrome", "1.0.0"],
    syncFullHistory: false,
    msgRetryCounterCache,
    getMessage: async (key) => getCachedMessage(key),
    ...(labelsOnly
      ? {
          // Linha de etiquetas: não aparece "online" (senão o celular para de
          // notificar), não baixa histórico e não decifra mensagens.
          markOnlineOnConnect: false,
          emitOwnEvents: false,
          shouldSyncHistoryMessage: () => false,
          shouldIgnoreJid: makeLabelsOnlyFilter(
            id,
            () => sock?.user ?? state.creds.me,
            () => !!state.creds.myAppStateKeyId
          ),
        }
      : {}),
  });

  const managed: Managed = {
    sock,
    mode,
    qrRetries: 0,
    startedAt: Date.now(),
    openedAt: null,
    stopping: false,
  };
  live.set(id, managed);

  // Avisa no log quando as chaves de sincronização chegam (ou são renovadas)
  // e, se a lista de etiquetas ainda estiver vazia, relê em seguida.
  let knownSyncKey = state.creds.myAppStateKeyId ?? null;
  if (!knownSyncKey) {
    console.log(`[labels:${id}] aguardando chaves de sincronização do celular (linha recém-pareada ou sem chaves)`);
  }
  sock.ev.on("creds.update", (update) => {
    saveCreds().catch((err) => console.error(`[session:${id}] falha ao salvar credenciais`, (err as Error).message));
    const key = (update as any)?.myAppStateKeyId;
    if (key && key !== knownSyncKey) {
      knownSyncKey = key;
      console.log(`[labels:${id}] chaves de sincronização recebidas do celular`);
      setTimeout(async () => {
        try {
          if (live.get(id) !== managed || !sock.ws.isOpen) return;
          if ((await countLabelsInStore(id)) === 0) await resyncLabels(id);
        } catch (err) {
          console.warn(`[labels:${id}] releitura após receber chaves falhou: ${(err as Error).message}`);
        }
      }, 20_000).unref();
    }
  });

  sock.ev.on("connection.update", async (update) => {
    try {
      const { connection, lastDisconnect, qr } = update;
      // Evento de um socket antigo, ou de uma parada que nós pedimos: ignora.
      if (live.get(id) !== managed || managed.stopping) return;

      if (qr) {
        managed.qrRetries += 1;
        if (managed.qrRetries > MAX_QR_RETRIES) {
          // QR expirou sem ninguém ler: para de vez. Só volta com novo pedido.
          managed.stopping = true;
          live.delete(id);
          try {
            sock.end(undefined as any);
          } catch {
            /* já encerrado */
          }
          await releaseLock(id);
          await writeRecord(id, { status: "disconnected", qr: null });
          await notifyStatus(id, "disconnected", { reason: "qr_expired" });
          console.log(`[session:${id}] QR expirou sem leitura — sessão parada (não tenta de novo sozinha)`);
          return;
        }
        await writeRecord(id, { status: "qr_pending", qr });
        await notifyStatus(id, "qr_pending");
      }

      if (connection === "open") {
        managed.openedAt = Date.now();
        const me = sock.user;
        exemptFromQuarantine(me?.id);
        exemptFromQuarantine(me?.lid);
        const phone = me?.id?.split(":")[0]?.split("@")[0] ?? null;
        await writeRecord(id, {
          status: "connected",
          qr: null,
          phoneNumber: phone,
          pushName: me?.name ?? null,
          paired: true,
        });
        await notifyStatus(id, "connected", { phone_number: phone, push_name: me?.name ?? null });
        // Conexão estável por 1 minuto zera a espera crescente.
        setTimeout(() => {
          if (live.get(id) === managed && sock.ws.isOpen) reconnectAttempts.delete(id);
        }, 60_000).unref();
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 403;
        const restartRequired = statusCode === DisconnectReason.restartRequired;

        noteSessionClose(statusCode);
        console.warn(
          `[session:${id}] conexão fechada (código ${statusCode ?? "?"}): ${(lastDisconnect?.error as Error)?.message ?? "sem detalhe"}`
        );

        live.delete(id);

        if (loggedOut) {
          // Logout de verdade: precisa ler QR de novo. Limpa credenciais.
          await clearRedisAuthState(id);
          await releaseLock(id);
          reconnectAttempts.delete(id);
          await writeRecord(id, { status: "disconnected", qr: null, paired: false });
          await notifyStatus(id, "disconnected", { reason: "logged_out" });
          return;
        }

        const pairedNow = !!state.creds.me?.id;
        if (!pairedNow && !restartRequired) {
          // Nunca foi pareada: não fica tentando sozinha.
          await releaseLock(id);
          await writeRecord(id, { status: "disconnected", qr: null, paired: false });
          await notifyStatus(id, "disconnected", { reason: "not_paired" });
          return;
        }

        // Garante que as credenciais recém-recebidas (pareamento) estão no
        // Redis antes de abrir o próximo socket.
        try {
          await saveCreds();
        } catch {
          /* best effort */
        }

        await writeRecord(id, { status: "failed" });
        await notifyStatus(id, "failed", { reason: "reconnecting" });

        // 515 = reinício pedido pelo WhatsApp logo após o pareamento (rápido).
        // 440 = outra conexão assumiu esta sessão: espera mais, sem brigar.
        const delay = restartRequired
          ? 1500
          : nextBackoffMs(id, statusCode === DisconnectReason.connectionReplaced ? 60_000 : 2000);
        scheduleReconnect(id, delay, { allowUnpaired: true });
      }
    } catch (err) {
      console.error(`[session:${id}] erro tratando connection.update`, (err as Error).message);
    }
  });

  // Mensagens só são repassadas no modo "full". No modo "labels" o Baileys
  // nem as decifra (ver makeLabelsOnlyFilter).
  if (!labelsOnly) {
    sock.ev.on("messages.upsert", async (m) => {
      for (const msg of m.messages) {
        try {
          rememberMessage(msg);

          const remoteJid = msg.key?.remoteJid ?? "";
          if (remoteJid.endsWith("@g.us") || remoteJid.endsWith("@broadcast")) continue;

          // Mensagem "stub" vazia de um lead conta como falha de decriptação.
          if (msg.messageStubType === WAMessageStubType.CIPHERTEXT && !msg.key?.fromMe) {
            failureTracker?.noteFailure(remoteJid, "stub_vazio");
          }

          let media: { base64: string; mimetype: string | null; filename: string | null } | null = null;
          if (isDownloadableMedia(msg)) {
            media = await downloadMedia(sock, id, msg);
          }
          await sendWebhookEvent(id, "message", { ...msg, media });
        } catch (err) {
          console.error(`[session:${id}] erro tratando mensagem recebida`, (err as Error).message);
        }
      }
    });
  }

  // Cache das definições de etiqueta — o Baileys só avisa por evento.
  sock.ev.on("labels.edit", async (label) => {
    try {
      await upsertLabelInStore(id, {
        id: label.id,
        name: label.name,
        color: label.color,
        deleted: !!label.deleted,
      });
    } catch (err) {
      console.error(`[session:${id}] falha ao gravar label no cache`, (err as Error).message);
    }
  });

  // Quais etiquetas cada chat tem — também só chega por evento.
  sock.ev.on("labels.association", async ({ association, type }) => {
    if (association.type !== "label_jid") return;
    try {
      await setChatLabelAssociation(id, association.chatId, association.labelId, type === "add");
    } catch (err) {
      console.error(`[session:${id}] falha ao gravar associação de label`, (err as Error).message);
    }
  });

  return (await readRecord(id))!;
}

// Relê as etiquetas direto do WhatsApp. O cache local só é preenchido por
// evento; se o evento se perde (ex.: sessão criada num momento ruim), a lista
// fica vazia para sempre e nada é etiquetado. Aqui a versão local do estado é
// zerada para o WhatsApp reenviar tudo, o que dispara os eventos de novo.
export async function resyncLabels(id: string): Promise<{ before: number; after: number }> {
  const managed = live.get(id);
  if (!managed || !managed.sock.ws.isOpen) throw new Error("session_not_connected");
  lastLabelResync.set(id, Date.now());

  const before = await countLabelsInStore(id);
  const run = async (
    collections: ("critical_unblock_low" | "regular_high" | "regular_low" | "critical_block" | "regular")[]
  ) => {
    const reset: Record<string, null> = {};
    for (const c of collections) reset[c] = null;
    await managed.sock.authState.keys.set({ "app-state-sync-version": reset } as any);
    await managed.sock.resyncAppState(collections, true);
    await new Promise((r) => setTimeout(r, 2000)); // eventos gravam no Redis
  };

  await run(["regular"]);
  let after = await countLabelsInStore(id);
  if (after === 0) {
    await run(["regular_high", "regular_low", "critical_block", "critical_unblock_low"]);
    after = await countLabelsInStore(id);
  }
  console.log(`[labels:${id}] etiquetas relidas do WhatsApp (antes=${before}, depois=${after})`);
  return { before, after };
}

export function getLastLabelResync(id: string): number {
  return lastLabelResync.get(id) ?? 0;
}

export async function stopSession(id: string, wipe: boolean): Promise<void> {
  clearReconnectTimer(id);
  const managed = live.get(id);
  if (managed) {
    managed.stopping = true;
    live.delete(id);
    try {
      if (wipe) {
        // Desvincula de verdade no WhatsApp, não só derruba a conexão local.
        await managed.sock.logout();
      } else {
        managed.sock.end(undefined as any);
      }
    } catch (err) {
      console.error(`[session:${id}] falha ao ${wipe ? "deslogar" : "encerrar"} socket`, (err as Error).message);
    }
  }
  await releaseLock(id);
  reconnectAttempts.delete(id);
  if (wipe) {
    await clearRedisAuthState(id);
    await redis.del(recordKey(id));
    await clearLabelStore(id);
    lastStatusSent.delete(id);
    lastLabelResync.delete(id);
  } else {
    await writeRecord(id, { status: "disconnected" });
  }
}

export async function restartSession(id: string, opts: StartOptions = {}): Promise<SessionRecord> {
  await stopSession(id, false);
  return startSession(id, opts);
}

// Chamado uma vez na inicialização do processo: religa as sessões que
// estavam ativas. Sessão "disconnected" ou sem pareamento não é religada.
const MAX_RESUME_STAGGER_MS = 20_000;

export async function resumeAllSessions(): Promise<void> {
  const ids = await listSessionIds();
  let scheduled = 0;
  for (const id of ids) {
    const record = await readRecord(id);
    if (!record || record.status === "disconnected") continue;
    const delay = Math.floor(Math.random() * MAX_RESUME_STAGGER_MS);
    scheduled++;
    scheduleReconnect(id, delay, {});
  }
  console.log(`[resume] ${scheduled} de ${ids.length} sessões agendadas para religar`);
}

// Chamado no desligamento (SIGTERM) — libera os locks das sessões vivas.
export async function releaseAllLocksForShutdown(): Promise<void> {
  const ids = [...live.keys()];
  await Promise.all(ids.map((id) => releaseLock(id)));
}

export function countLiveSessions(): { live: number; open: number } {
  let open = 0;
  for (const m of live.values()) if (m.sock.ws.isOpen) open++;
  return { live: live.size, open };
}
