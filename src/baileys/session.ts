import makeWASocket, {
  DisconnectReason,
  WASocket,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import P from "pino";
import { useRedisAuthState, clearRedisAuthState } from "./authState";
import { redis } from "../redis";
import { sendWebhookEvent } from "../webhook";
import { SessionRecord, SessionStatus } from "../types";
import { upsertLabelInStore } from "./labelStore";

const logger = P({ level: "error" });

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

  await writeRecord(id, { status: "starting", qr: null });

  const { state, saveCreds } = await useRedisAuthState(id);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: false,
    browser: ["WA Connector", "Chrome", "1.0.0"],
    syncFullHistory: false,
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
      await sendWebhookEvent(id, "message", msg);
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
