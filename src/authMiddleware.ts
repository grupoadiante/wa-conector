import { Request, Response, NextFunction } from "express";
import { config } from "./config";

export function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const key = req.header("X-Api-Key");
  if (!key || key !== config.apiKey) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}
