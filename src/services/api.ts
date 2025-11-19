import { Server } from "http";
import express, { Request, Response, Router } from "express";
import { Express } from "express-serve-static-core";
import * as client from "prom-client";
import { getLogger } from "../utils/logging";
import { DBService, ChainContext } from "../services";
import { Registry } from "../types";
import { version, name, description } from "../../package.json";

export class ApiService {
  protected port: number;
  protected app: Express;
  protected server: Server | null = null;

  protected chainContexts: ChainContext[] = [];

  private static _instance: ApiService | undefined;

  protected constructor(port?: number) {
    this.port = port || 8080;
    this.app = express();
    this.bootstrap();
  }

  private bootstrap() {
    this.app.use(express.json());

    client.collectDefaultMetrics();
    this.app.use(express.urlencoded({ extended: true }));
    this.app.get("/", (_req: Request, res: Response) => {
      res.send("🐮 Moooo!");
    });
    this.app.use("/metrics", (_req: Request, res: Response) => {
      const { register } = client;
      res.setHeader("Content-Type", register.contentType);
      register.metrics().then((data) => res.status(200).send(data));
    });
    this.app.get("/health", async (_req: Request, res: Response) => {
      const health = ChainContext.health;
      res.status(health.overallHealth ? 200 : 503).send(health);
    });
    this.app.use("/config", (_req: Request, res: Response) => {
      res.setHeader("Content-Type", "application/json");
      res.status(200).send(
        this.chainContexts.map(
          ({
            chainId,
            contract,
            deploymentBlock,
            dryRun,
            filterPolicy,
            pageSize,
            processEveryNumBlocks,
            addresses,
          }) => ({
            chainId,
            contract: contract.address,
            deploymentBlock,
            dryRun,
            filterPolicy: filterPolicy?.toJSON(),
            pageSize,
            processEveryNumBlocks,
            addresses,
          })
        )
      );
    });
    this.app.use("/api", router);
  }

  public static getInstance(port?: number): ApiService {
    if (!ApiService._instance) {
      ApiService._instance = new ApiService(port);
    }
    return ApiService._instance;
  }

  async start(): Promise<Server> {
    return await new Promise((resolve, reject) => {
      try {
        const log = getLogger({ name: "api:start" });
        if (this.server?.listening) {
          throw new Error("Server is already running");
        }
        this.server = this.app.listen(this.port, () => {
          log.info(
            `Rest API server is running on port ${this.port}. See http://localhost:${this.port}/api/version`
          );
        });

        resolve(this.server);
      } catch (err) {
        reject(err);
      }
    });
  }

  async stop(): Promise<void> {
    return await new Promise((resolve, reject) => {
      try {
        if (!this.server) {
          throw new Error("Server is not running");
        }

        const log = getLogger({ name: "api:stop" });
        log.info("Stopping Rest API server...");

        this.server.once("close", resolve);
        this.server.close();
      } catch (err) {
        reject(err);
      }
    });
  }

  setChainContexts(chainContexts: ChainContext[]) {
    this.chainContexts = chainContexts;
  }

  getChainContexts() {
    return this.chainContexts;
  }
}

const dumpRoute = (router: Router) => {
  router.get("/dump/:chainId", async (req: Request, res: Response) => {
    try {
      const dump = await Registry.dump(
        DBService.getInstance(),
        req.params.chainId
      );
      res.setHeader("Content-Type", "application/json");
      res.send(dump);
    } catch (err) {
      res.send(JSON.stringify(err));
    }
  });
};

const ordersRoute = (router: Router) => {
  /**
   * Get conditional orders filtered by handler address
   * GET /api/orders/:chainId?handler=0x...
   */
  router.get(
    "/orders/:chainId",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const { chainId } = req.params;
        const { handler } = req.query;

        // Load the registry for the chain
        const chainContext = ApiService.getInstance()
          .getChainContexts()
          .find((ctx) => ctx.chainId.toString() === chainId);

        if (!chainContext) {
          res.status(404).json({
            error: `Chain ${chainId} not found`,
          });
          return;
        }

        const registry = chainContext.registry;
        const ownerOrders = registry.ownerOrders;

        // Debug: Collect all unique handlers found and filter orders
        const allHandlers = new Set<string>();
        let totalOrdersInRegistry = 0;
        const filteredOrders: Array<{
          owner: string;
          conditionalOrder: {
            id: string;
            tx: string;
            params: {
              handler: string;
              salt: string;
              staticInput: string;
            };
            proof: any;
            composableCow: string;
            orders: Array<{ orderUid: string; status: string }>;
            pollResult?: {
              lastExecutionTimestamp: number;
              blockNumber: number;
              result: any;
            };
          };
        }> = [];

        const handlerFilter = handler
          ? (handler as string).toLowerCase()
          : null;

        for (const [owner, conditionalOrders] of ownerOrders.entries()) {
          totalOrdersInRegistry += conditionalOrders.size;
          for (const conditionalOrder of conditionalOrders) {
            const orderHandler = conditionalOrder.params.handler.toLowerCase();
            allHandlers.add(orderHandler);

            // Filter by handler if provided
            if (handlerFilter && orderHandler !== handlerFilter) {
              continue;
            }

            // Convert Map to Array for JSON serialization
            const ordersArray = Array.from(
              conditionalOrder.orders.entries()
            ).map(([orderUid, status]) => ({
              orderUid:
                typeof orderUid === "string" ? orderUid : orderUid.toString(),
              status:
                status === 1
                  ? "SUBMITTED"
                  : status === 2
                  ? "FILLED"
                  : "UNKNOWN",
            }));

            filteredOrders.push({
              owner,
              conditionalOrder: {
                id: conditionalOrder.id,
                tx: conditionalOrder.tx,
                params: conditionalOrder.params,
                proof: conditionalOrder.proof,
                composableCow: conditionalOrder.composableCow,
                orders: ordersArray,
                pollResult: conditionalOrder.pollResult,
              },
            });
          }
        }

        res.setHeader("Content-Type", "application/json");
        res.json({
          chainId,
          totalOrders: filteredOrders.length,
          totalOrdersInRegistry,
          allHandlersFound: Array.from(allHandlers),
          requestedHandler: handler ? (handler as string).toLowerCase() : null,
          lastProcessedBlock: registry.lastProcessedBlock,
          orders: filteredOrders,
        });
        return;
      } catch (err: any) {
        res.status(500).json({
          error: err.message || "Internal server error",
        });
        return;
      }
    }
  );

  /**
   * Get a specific conditional order by ID
   * GET /api/orders/:chainId/:orderId
   */
  router.get(
    "/orders/:chainId/:orderId",
    async (req: Request, res: Response): Promise<void> => {
      try {
        const { chainId, orderId } = req.params;

        const chainContext = ApiService.getInstance()
          .getChainContexts()
          .find((ctx) => ctx.chainId.toString() === chainId);

        if (!chainContext) {
          res.status(404).json({
            error: `Chain ${chainId} not found`,
          });
          return;
        }

        const registry = chainContext.registry;
        const ownerOrders = registry.ownerOrders;

        // Find the order by ID
        for (const [owner, conditionalOrders] of ownerOrders.entries()) {
          for (const conditionalOrder of conditionalOrders) {
            if (conditionalOrder.id.toLowerCase() === orderId.toLowerCase()) {
              const ordersArray = Array.from(
                conditionalOrder.orders.entries()
              ).map(([orderUid, status]) => ({
                orderUid:
                  typeof orderUid === "string" ? orderUid : orderUid.toString(),
                status:
                  status === 1
                    ? "SUBMITTED"
                    : status === 2
                    ? "FILLED"
                    : "UNKNOWN",
              }));

              res.json({
                chainId,
                owner,
                conditionalOrder: {
                  id: conditionalOrder.id,
                  tx: conditionalOrder.tx,
                  params: conditionalOrder.params,
                  proof: conditionalOrder.proof,
                  composableCow: conditionalOrder.composableCow,
                  orders: ordersArray,
                  pollResult: conditionalOrder.pollResult,
                },
              });
              return;
            }
          }
        }

        res.status(404).json({
          error: `Conditional order ${orderId} not found`,
        });
        return;
      } catch (err: any) {
        res.status(500).json({
          error: err.message || "Internal server error",
        });
        return;
      }
    }
  );
};

const aboutRoute = (router: Router) => {
  router.get("/version", async (req: Request, res: Response) => {
    res.setHeader("Content-Type", "application/json");
    res.send({
      version,
      name,
      description,
      dockerImageTag: process.env.DOCKER_IMAGE_TAG, // Optional: convenient way to inform about the used docker image tag in docker environments
    });
  });
};

export type RouterInitializer = (router: Router) => void;
const routeInitializers: RouterInitializer[] = [
  aboutRoute,
  dumpRoute,
  ordersRoute,
];

const router = Router();
for (const routeInitialize of routeInitializers) {
  routeInitialize(router);
}
