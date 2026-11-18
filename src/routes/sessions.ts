import { Router } from "express";
import QRCode from "qrcode";
import { SessionMode } from "../types";
import { describeAllSessions, describeSession, getLastSelfHealReport, runSelfHeal } from "../baileys/selfHeal";
import {
  getSessionRecord,
  listSessionIds,
  purgeAndRenegotiate,
  restartSession,
  startSession,
  stopSession,
} from "../baileys/session";

export const sessionsRouter = Router();

// Cria (ou reaproveita) uma sessão e começa o processo de pareamento.
// Body opcional: { "mode": "labels" | "full" }. Sem body, usa o modo já
// gravado na sessão ou o padrão (DEFAULT_SESSION_MODE, hoje "labels").
function modeFrom(body: unknown): SessionMode | undefined {
  const m = String((body as any)?.mode ?? "").toLowerCase();
  return m === "labels" || m === "full" ? m : undefined;
}

sessionsRouter.post("/sessions/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const record = await startSession(id, { manual: true, mode: modeFrom(req.body) });
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Status atual + QR em base64 (pronto pra exibir direto no front),
// igual ao que o WAHA devolve pro fluxo de "ler QR".
sessionsRouter.get("/sessions/:id", async (req, res) => {
  const { id } = req.params;
  const record = await getSessionRecord(id);
  if (!record) return res.status(404).json({ error: "session_not_found" });

  let qrImage: string | null = null;
  if (record.qr) {
    try {
      qrImage = await QRCode.toDataURL(record.qr);
    } catch {
      /* ignore */
    }
  }
  res.json({ ...record, qr_image: qrImage });
});

sessionsRouter.get("/sessions", async (_req, res) => {
  const ids = await listSessionIds();
  res.json({ sessions: ids });
});

// Painel de saúde: uma linha por sessão (status, modo, pareada, socket
// aberto, quantas etiquetas no cache) + o resultado da última auto-cura.
sessionsRouter.get("/sessions-health", async (_req, res) => {
  try {
    const sessions = await describeAllSessions();
    res.json({
      total: sessions.length,
      connected: sessions.filter((s) => s.ws_open).length,
      not_paired: sessions.filter((s) => !s.paired).map((s) => s.id),
      last_self_heal: getLastSelfHealReport(),
      sessions,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

sessionsRouter.get("/sessions/:id/health", async (req, res) => {
  res.json(await describeSession(req.params.id));
});

// Roda a auto-cura agora (ela também roda sozinha de tempo em tempo).
sessionsRouter.post("/self-heal/run", async (_req, res) => {
  try {
    res.json(await runSelfHeal("manual"));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

sessionsRouter.post("/sessions/:id/restart", async (req, res) => {
  const { id } = req.params;
  try {
    const record = await restartSession(id, { manual: true, mode: modeFrom(req.body) });
    res.json(record);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Auto-cura sob demanda: apaga a sessão Signal corrompida de UM contato
// (body: { jid: "554598261206@s.whatsapp.net" }) e força renegociação com
// chave nova. Pensado pra ser chamado pelo Lovable/CRM quando um contato
// fica preso, sem precisar abrir o console do Redis na mão.
sessionsRouter.post("/sessions/:id/purge-jid", async (req, res) => {
  const { id } = req.params;
  const { jid } = req.body ?? {};
  if (!jid || typeof jid !== "string") {
    return res.status(400).json({ error: "jid é obrigatório no corpo (ex: 554598261206@s.whatsapp.net)" });
  }
  try {
    const result = await purgeAndRenegotiate(id, jid, "purge-jid");
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// wipe=true (default) apaga credenciais — usar quando o usuário desconecta
// de propósito. wipe=false só derruba o socket em memória (ex.: antes de um
// restart controlado).
sessionsRouter.delete("/sessions/:id", async (req, res) => {
  const { id } = req.params;
  const wipe = req.query.wipe !== "false";
  try {
    await stopSession(id, wipe);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});
