export type SessionStatus =
  | "starting"
  | "qr_pending"
  | "connected"
  | "disconnected"
  | "failed";

// "labels": linha usada SÓ para etiquetar. Não decifra, não baixa mídia e
// não repassa mensagens — só mantém a conexão e o estado das etiquetas.
// "full": linha de atendimento completa (recebe e envia mensagens).
export type SessionMode = "labels" | "full";

export interface SessionRecord {
  id: string;
  status: SessionStatus;
  qr: string | null;
  phoneNumber: string | null;
  pushName: string | null;
  updatedAt: string;
  mode?: SessionMode;
  // true depois que o QR foi lido pelo menos uma vez (existem credenciais).
  paired?: boolean;
}
