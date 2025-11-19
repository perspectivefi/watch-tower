import fs from "fs";
import path from "path";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

interface NetworkConfig {
  name: string;
  rpc: string;
  deploymentBlock: number;
  processEveryNumBlocks?: number;
  keepExpiredOrders?: boolean;
  pollingIntervalSeconds?: number;
  filterPolicy: {
    defaultAction: "ACCEPT" | "DROP" | "SKIP";
    handlers?: {
      [key: string]: "ACCEPT" | "DROP" | "SKIP";
    };
  };
}

interface StorageConfig {
  type: "leveldb" | "redis";
  redis?: {
    host: string;
    port?: number;
    password?: string;
  };
}

interface Config {
  storage?: StorageConfig;
  networks: NetworkConfig[];
}

function validateEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}. Please check your .env file.`
    );
  }
  return value;
}

function validateAddress(address: string, name: string): string {
  if (!address.startsWith("0x") || address.length !== 42) {
    throw new Error(
      `Invalid ${name} address format. Expected 0x-prefixed 42 character address, got: ${address}`
    );
  }
  return address.toLowerCase();
}

function parsePositiveIntegerEnv(
  name: string,
  defaultValue?: number
): number {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (defaultValue === undefined) {
      throw new Error(
        `Missing required environment variable: ${name}. Please check your .env file.`
      );
    }
    return defaultValue;
  }

  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error(
      `${name} must be a positive integer, got: ${value}`
    );
  }
  return parsed;
}

function parseNetworkConfig(networkName: string): NetworkConfig {
  const normalizedName = networkName.toLowerCase().trim();
  const prefix = normalizedName.toUpperCase();

  // Required fields
  const rpc = validateEnvVar(`${prefix}_RPC_URL`);
  const deploymentBlock = parsePositiveIntegerEnv(`${prefix}_DEPLOYMENT_BLOCK`);
  const handlerAddress = validateAddress(
    validateEnvVar(`${prefix}_HANDLER_ADDRESS`),
    `${prefix}_HANDLER_ADDRESS`
  );

  // Optional fields with defaults
  const processEveryNumBlocks = parsePositiveIntegerEnv(
    `${prefix}_BLOCK_POLLING_RATE`,
    1
  );
  
  const keepExpiredOrdersEnv = process.env[`${prefix}_KEEP_EXPIRED_ORDERS`];
  const keepExpiredOrders = keepExpiredOrdersEnv === undefined 
    ? true // Default to true when filtering by handler
    : keepExpiredOrdersEnv.toLowerCase() === "true";

  // Polling interval (optional, defaults to block-by-block if not set)
  const pollingIntervalSecondsEnv = process.env[`${prefix}_POLLING_INTERVAL_SECONDS`];
  const pollingIntervalSeconds = pollingIntervalSecondsEnv
    ? parsePositiveIntegerEnv(`${prefix}_POLLING_INTERVAL_SECONDS`)
    : undefined;

  const config: NetworkConfig = {
    name: normalizedName,
    rpc,
    deploymentBlock,
    processEveryNumBlocks,
    keepExpiredOrders,
    filterPolicy: {
      defaultAction: "DROP", // Only accept orders from our handler
      handlers: {
        [handlerAddress]: "ACCEPT",
      },
    },
  };

  // Only add pollingIntervalSeconds if it's set
  if (pollingIntervalSeconds !== undefined) {
    config.pollingIntervalSeconds = pollingIntervalSeconds;
  }

  return config;
}

function generateConfig(): Config {
  // Get list of networks from environment
  const networksEnv = process.env.NETWORKS || "base";
  const networkNames = networksEnv
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);

  if (networkNames.length === 0) {
    throw new Error(
      "NETWORKS environment variable is empty or invalid. Expected comma-separated list (e.g., 'base,mainnet')"
    );
  }

  // Parse each network configuration
  const networks = networkNames.map((networkName) => {
    try {
      return parseNetworkConfig(networkName);
    } catch (error: any) {
      throw new Error(
        `Failed to parse configuration for network '${networkName}': ${error.message}`
      );
    }
  });

  // Storage configuration (optional, defaults to leveldb)
  const storageType = (process.env.STORAGE_TYPE as "leveldb" | "redis") || "leveldb";
  const storageConfig: StorageConfig | undefined = 
    storageType === "redis"
      ? {
          type: "redis",
          redis: {
            host: process.env.REDIS_HOST || "localhost",
            port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
            password: process.env.REDIS_PASSWORD || undefined,
          },
        }
      : undefined;

  // Clean up storage config - remove password if empty
  if (storageConfig && storageConfig.redis && !storageConfig.redis.password) {
    delete storageConfig.redis.password;
  }

  const config: Config = {
    ...(storageConfig && { storage: storageConfig }),
    networks,
  };

  return config;
}

function main() {
  try {
    const config = generateConfig();
    const configPath = path.join(process.cwd(), "config.json");
    const configJson = JSON.stringify(config, null, 2);

    fs.writeFileSync(configPath, configJson, "utf8");
    console.log("✅ Successfully generated config.json");
    console.log(`📝 Config written to: ${configPath}`);
    
    if (config.storage) {
      console.log(`💾 Storage: ${config.storage.type}${config.storage.type === "redis" ? ` (${config.storage.redis?.host}:${config.storage.redis?.port || 6379})` : ""}`);
    }
    
    console.log(`\n📡 Configured ${config.networks.length} network(s):`);
    config.networks.forEach((network, index) => {
      console.log(`\n  ${index + 1}. ${network.name.toUpperCase()}:`);
      console.log(`     🔗 RPC: ${network.rpc}`);
      console.log(`     📦 Deployment Block: ${network.deploymentBlock}`);
      console.log(`     🎯 Handler Address: ${Object.keys(network.filterPolicy.handlers || {})[0]}`);
      if (network.pollingIntervalSeconds) {
        console.log(`     ⏱️  Time-based polling: every ${network.pollingIntervalSeconds} seconds`);
      } else if (network.processEveryNumBlocks) {
        console.log(`     ⏱️  Block polling rate: every ${network.processEveryNumBlocks} blocks`);
      }
      console.log(`     📊 Keep expired orders: ${network.keepExpiredOrders}`);
    });
  } catch (error: any) {
    console.error("❌ Error generating config.json:", error.message);
    process.exit(1);
  }
}

main();

