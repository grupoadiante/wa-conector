import Redis from "ioredis";
import { config } from "./config";

// Um client só, reaproveitado por toda a aplicação — sessões de auth,
// estado de conexão em memória-persistida.
export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 3,
});

redis.on("error", (err) => {
  console.error("[redis] connection error", err.message);
});
