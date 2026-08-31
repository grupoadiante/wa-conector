export type SessionStatus =
  | "starting"
  | "qr_pending"
  | "connected"
  | "disconnected"
  | "failed";

export interface SessionRecord {
  id: string;
  status: SessionStatus;
  qr: string | null;
  phoneNumber: string | null;
  pushName: string | null;
  updatedAt: string;
}
