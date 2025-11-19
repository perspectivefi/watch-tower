import { DatabaseOptions, Level } from "level";
import { getLogger } from "../utils/logging";
import { RedisDBService, RedisConfig } from "./redis-storage";

const DEFAULT_DB_LOCATION = "./database";

export type DBLevel = Level<string, string>;

export type StorageType = "leveldb" | "redis";

export class DBService {
  protected db: DBLevel | ReturnType<RedisDBService["getDB"]>;
  protected storageType: StorageType;
  protected redisService?: RedisDBService;

  private static _instance: DBService | undefined;

  protected constructor(
    path?: string,
    storageType?: StorageType,
    redisConfig?: RedisConfig
  ) {
    const log = getLogger({ name: "dbService:constructor" });

    // Determine storage type from config or environment variable
    this.storageType =
      storageType || (process.env.STORAGE_TYPE as StorageType) || "leveldb";

    if (this.storageType === "redis") {
      log.info("Using Redis storage");
      const config: RedisConfig = redisConfig || {
        host: process.env.REDIS_HOST || "localhost",
        port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
        password: process.env.REDIS_PASSWORD,
      };
      this.redisService = RedisDBService.getInstance(config);
      this.db = this.redisService.getDB();
    } else {
      log.info(`Using LevelDB storage at ${path || DEFAULT_DB_LOCATION}`);
      const options: DatabaseOptions<string, string> = {
        valueEncoding: "json",
        createIfMissing: true,
        errorIfExists: false,
      };
      this.db = new Level<string, string>(path || DEFAULT_DB_LOCATION, options);
    }
  }

  public static getInstance(
    path?: string,
    storageType?: StorageType,
    redisConfig?: RedisConfig
  ): DBService {
    if (!DBService._instance) {
      DBService._instance = new DBService(path, storageType, redisConfig);
    }
    return DBService._instance;
  }

  public async open() {
    const log = getLogger({ name: "dbService:open" });
    log.info(`Opening ${this.storageType} database...`);

    if (this.storageType === "redis" && this.redisService) {
      await this.redisService.open();
    } else {
      await (this.db as DBLevel).open();
    }
  }

  public async close() {
    const log = getLogger({ name: "dbService:close" });
    log.info(`Closing ${this.storageType} database...`);

    if (this.storageType === "redis" && this.redisService) {
      await this.redisService.close();
    } else {
      await (this.db as DBLevel).close();
    }
  }

  public getDB() {
    return this.db;
  }
}
