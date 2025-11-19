import Redis, { RedisOptions } from "ioredis";
import { getLogger } from "../utils/logging";

export interface RedisConfig {
  host: string;
  port?: number;
  password?: string;
}

export interface RedisBatch {
  put(key: string, value: string): RedisBatch;
  del(key: string): RedisBatch;
  write(): Promise<void>;
}

export interface RedisDB {
  get(key: string): Promise<string>;
  batch(): RedisBatch;
}

/**
 * Redis adapter that mimics the LevelDB interface
 * Implements the same API as LevelDB for seamless replacement
 */
export class RedisDBService {
  protected client: Redis;
  protected isConnected = false;
  protected readonly keyPrefix = "cryptoswap:watch-tower:";

  private static _instance: RedisDBService | undefined;

  protected constructor(config?: RedisConfig) {
    const log = getLogger({ name: "redisDBService:constructor" });

    const redisConfig: RedisConfig = config || {
      host: process.env.REDIS_HOST || "localhost",
      port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
      password: process.env.REDIS_PASSWORD,
    };

    log.info(
      `Connecting to Redis at ${redisConfig.host}:${redisConfig.port || 6379}`
    );

    const options: RedisOptions = {
      host: redisConfig.host,
      lazyConnect: true,
      showFriendlyErrorStack: true,
      enableAutoPipelining: true,
      maxRetriesPerRequest: 0,
      retryStrategy: (times: number) => {
        if (times > 3) {
          throw new Error(`[Redis] Could not connect after ${times} attempts`);
        }
        return Math.min(times * 200, 1000);
      },
    };

    if (redisConfig.port) {
      options.port = redisConfig.port;
    }

    if (redisConfig.password) {
      options.password = redisConfig.password;
    }

    this.client = new Redis(options);

    this.client.on("error", (err: Error) => {
      const errorLog = getLogger({ name: "redisDBService:error" });
      errorLog.error("[Redis] Error connecting", err);
    });

    this.client.on("connect", () => {
      const connectLog = getLogger({ name: "redisDBService:connect" });
      connectLog.info("[Redis] Client connecting...");
    });

    this.client.on("ready", () => {
      const readyLog = getLogger({ name: "redisDBService:ready" });
      readyLog.info("[Redis] Client ready");
      this.isConnected = true;
    });

    this.client.on("close", () => {
      const closeLog = getLogger({ name: "redisDBService:close" });
      closeLog.info("[Redis] Client connection closed");
      this.isConnected = false;
    });
  }

  public static getInstance(config?: RedisConfig): RedisDBService {
    if (!RedisDBService._instance) {
      RedisDBService._instance = new RedisDBService(config);
    }
    return RedisDBService._instance;
  }

  public async open() {
    const log = getLogger({ name: "redisDBService:open" });
    log.info("Opening Redis connection...");

    if (!this.isConnected) {
      await this.client.connect();
    }

    log.info("Redis connection opened");
  }

  public async close() {
    const log = getLogger({ name: "redisDBService:close" });
    log.info("Closing Redis connection...");

    if (this.isConnected) {
      await this.client.quit();
    }

    log.info("Redis connection closed");
  }

  private prefixKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  public getDB(): RedisDB {
    return {
      get: async (key: string): Promise<string> => {
        try {
          const prefixedKey = this.prefixKey(key);
          const value = await this.client.get(prefixedKey);
          if (value === null) {
            throw new Error(`Key not found: ${key}`);
          }
          return value;
        } catch (error: any) {
          if (error.message?.includes("Key not found")) {
            throw error;
          }
          throw new Error(`Redis get error for key ${key}: ${error.message}`);
        }
      },
      batch: (): RedisBatch => {
        const operations: Array<{
          type: "put" | "del";
          key: string;
          value?: string;
        }> = [];
        const batchInstance: RedisBatch = {
          put: (key: string, value: string): RedisBatch => {
            operations.push({ type: "put", key, value });
            return batchInstance;
          },
          del: (key: string): RedisBatch => {
            operations.push({ type: "del", key });
            return batchInstance;
          },
          write: async (): Promise<void> => {
            if (operations.length === 0) {
              return;
            }

            const pipeline = this.client.pipeline();

            for (const op of operations) {
              const prefixedKey = this.prefixKey(op.key);
              if (op.type === "put") {
                pipeline.set(prefixedKey, op.value!);
              } else if (op.type === "del") {
                pipeline.del(prefixedKey);
              }
            }

            await pipeline.exec();
            operations.length = 0;
          },
        };
        return batchInstance;
      },
    };
  }
}
