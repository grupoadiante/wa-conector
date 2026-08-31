import makeWASocket, {
  DisconnectReason,
  WASocket,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import { useRedisAuthState, clearRedisAuthState } from "./authState";
import { redis } from "../redis";
import { sendWebhookEvent } from "../webhook";
import { SessionRecord, SessionStatus } from "../types";
import { upsertLabelInStore } from "./labelStore";
import { downloadMedia, isDownloadableMedia } from "./media";
import { getCachedMessage, msgRetryCounterCache, rememberMessage } from "./msgCache";
import { createDecryptWatchLogger } from "./decryptWatch";
import { acquireLock, releaseLock } from "./lock";

type Managed = {
  sock: WASocket;
  qrRetries: number;
};

// Sessões vivas neste processo. Se o container reiniciar, o Redis ainda tem
// as credenciais — a sessão só precisa ser recriada (não relogar via QR),
// a menos que tenha sido um logout de verdade.
const live = new Map<string, Managed>();

const MAX_QR_RETRIES = 3;
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

export async function getSessionRecord(id: string): Promise<SessionRecord | null> {
  return readRecord(id);
}

export async function listSessionIds(): Promise<string[]> {
  const keys = await redis.keys("wa:meta:*");
  return keys.map((k) => k.replace("wa:meta:", ""));
}

export function getLiveSocket(id: string): WASocket | null {
  return live.get(id)?.sock ?? null;
}

// Ping leve: confirma que o socket ainda responde antes de operações
// arriscadas (labels) e depois delas — é o que detecta a queda a tempo de
// reconectar sozinho em vez de deixar o front achar que ainda está tudo bem.
export async function isSessionHealthy(id: string): Promise<boolean> {
  const managed = live.get(id);
  if (!managed) return false;
  return managed.sock.ws.isOpen;
}

export async function startSession(id: string): Promise<SessionRecord> {
  const existing = live.get(id);
  if (existing) return (await readRecord(id))!;

  // Evita dois processos (container antigo + novo durante um redeploy)
  // segurando a mesma sessão do WhatsApp ao mesmo tempo — isso corrompia
  // as chaves de criptografia por contato (ver lock.ts). Se não conseguir
  // o lock, outro processo já está com essa sessão viva; tenta de novo em
  // breve em vez de brigar por ela.
  const gotLock = await acquireLock(id);
  if (!gotLock) {
    console.warn(`[session:${id}] lock ocupado por outro processo — tentando de novo em 5s`);
    setTimeout(() => {
      startSession(id).catch((err) =>
        console.error(`[session:${id}] falha ao tentar de novo após lock ocupado`, err)
      );
    }, 5000);
    return (await readRecord(id)) ?? {
      id,
      status: "starting",
      qr: null,
      phoneNumber: null,
      pushName: null,
      updatedAt: new Date().toISOString(),
    };
  }

  await writeRecord(id, { status: "starting", qr: null });

  const { state, saveCreds } = await useRedisAuthState(id);
  const { version } = await fetchLatestBaileysVersion();

  // Escuta falhas repetidas de decriptação com o mesmo contato e renegocia
  // a sessão automaticamente (assertSessions com force) — sem isso, um
  // contato preso em "Aguardando mensagem" só destrava com intervenção
  // manual, como identificamos hoje.
  const sessionLogger = createDecryptWatchLogger(id, async (jid) => {
    const managed = live.get(id);
    if (!managed) return;
    try {
      const fetched = await managed.sock.assertSessions([jid], true);
      console.log(`[decrypt-watch:${id}] sessão renegociada com ${jid} (fetched=${fetched})`);
    } catch (err) {
      console.error(`[decrypt-watch:${id}] falha ao renegociar sessão com ${jid}`, (err as Error).message);
    }
  });

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
    // Resolve o "Waiting for this message" — ver comentários em msgCache.ts.
    msgRetryCounterCache,
    getMessage: async (key) => getCachedMessage(key),
  });

  live.set(id, { sock, qrRetries: 0 });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const managed = live.get(id);

    if (qr) {
      const retries = (managed?.qrRetries ?? 0) + 1;
      if (managed) managed.qrRetries = retries;
      if (retries > MAX_QR_RETRIES) {
        await writeRecord(id, { status: "disconnected", qr: null });
        await sendWebhookEvent(id, "session.status", { status: "disconnected", reason: "qr_expired" });
        live.delete(id);
        sock.end(undefined as any);
        return;
      }
      await writeRecord(id, { status: "qr_pending", qr });
      await sendWebhookEvent(id, "session.status", { status: "qr_pending", qr });
    }

    if (connection === "open") {
      const me = sock.user;
      await writeRecord(id, {
        status: "connected",
        qr: null,
        phoneNumber: me?.id?.split(":")[0]?.split("@")[0] ?? null,
        pushName: me?.name ?? null,
      });
      await sendWebhookEvent(id, "session.status", {
        status: "connected",
        phone_number: me?.id?.split(":")[0]?.split("@")[0] ?? null,
        push_name: me?.name ?? null,
      });
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 403;

      live.delete(id);

      if (loggedOut) {
        // Logout de verdade: precisa ler QR de novo. Limpa credenciais.
        await clearRedisAuthState(id);
        await writeRecord(id, { status: "disconnected", qr: null });
        await sendWebhookEvent(id, "session.status", { status: "disconnected", reason: "logged_out" });
        return;
      }

      // Queda recuperável (inclusive a que costuma seguir uma operação de
      // label): reconecta sozinho, sem exigir QR e sem intervenção humana.
      await writeRecord(id, { status: "failed" });
      await sendWebhookEvent(id, "session.status", { status: "failed", reason: "reconnecting" });
      setTimeout(() => {
        startSession(id).catch((err) =>
          console.error(`[session:${id}] falha ao reconectar`, err)
        );
      }, 2000);
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    for (const msg of m.messages) {
      rememberMessage(msg);

      // Mensagens de grupo (@g.us) e de listas de transmissão (@broadcast)
      // não são tratadas como conversa de lead — nunca repassa pro CRM,
      // pra evitar o bot respondendo dentro de um grupo.
      const remoteJid = msg.key?.remoteJid ?? "";
      if (remoteJid.endsWith("@g.us") || remoteJid.endsWith("@broadcast")) {
        continue;
      }

      // Mídia (imagem/vídeo/áudio/documento/figurinha) precisa ser baixada
      // e DECRIPTADA aqui — só o socket com a sessão ativa tem as chaves.
      // O upload pro Storage acontece do lado do custom-webhook, que já tem
      // acesso embutido às credenciais do Supabase.
      let media: { base64: string; mimetype: string | null; filename: string | null } | null = null;
      if (isDownloadableMedia(msg)) {
        media = await downloadMedia(sock, id, msg);
      }
      await sendWebhookEvent(id, "message", { ...msg, media });
    }
  });

  // Mantém o cache de definições de etiqueta atualizado — o Baileys não
  // expõe uma lista pronta, só avisa por evento quando algo muda (inclusive
  // no sync inicial da sessão, quando ele reenvia todas as existentes).
  sock.ev.on("labels.edit", async (label) => {
    try {
      await upsertLabelInStore(id, {
        id: label.id,
        name: label.name,
        color: label.color,
        deleted: !!label.deleted,
      });
    } catch (err) {
      console.error(`[session:${id}] falha ao gravar label no cache`, err);
    }
  });

  return (await readRecord(id))!;
}

export async function stopSession(id: string, wipe: boolean): Promise<void> {
  const managed = live.get(id);
  if (managed) {
    managed.sock.ev.removeAllListeners("connection.update");
    try {
      managed.sock.end(undefined as any);
    } catch {
      /* ignore */
    }
    live.delete(id);
  }
  await releaseLock(id);
  if (wipe) {
    await clearRedisAuthState(id);
    await redis.del(recordKey(id));
  } else {
    await writeRecord(id, { status: "disconnected" });
  }
}

export async function restartSession(id: string): Promise<SessionRecord> {
  await stopSession(id, false);
  return startSession(id);
}

// Chamado uma vez na inicialização do processo. O container pode reiniciar
// (redeploy, crash, restart manual) sem que ninguém chame /sessions/:id de
// novo — sem isso, a sessão fica com credenciais salvas no Redis mas nenhum
// socket vivo, e todo envio falha com 409 até alguém notar. Aqui a gente
// religa sozinho qualquer sessão que não estava explicitamente desconectada.
export async function resumeAllSessions(): Promise<void> {
  const ids = await listSessionIds();
  for (const id of ids) {
    const record = await readRecord(id);
    if (!record || record.status === "disconnected") continue;
    console.log(`[resume] religando sessão ${id} (status salvo: ${record.status})`);
    startSession(id).catch((err) =>
      console.error(`[resume] falha ao religar sessão ${id}`, err)
    );
  }
}

// Chamado no desligamento (SIGTERM) — libera os locks das sessões vivas
// neste processo, sem tentar fechar os sockets com calma (o processo está
// morrendo de qualquer forma). O container novo assume mais rápido.
export async function releaseAllLocksForShutdown(): Promise<void> {
  const ids = [...live.keys()];
  await Promise.all(ids.map((id) => releaseLock(id)));
}
