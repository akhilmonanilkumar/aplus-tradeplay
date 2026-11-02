import { config } from "./config.js";
import { MarketHub } from "./market.js";
import { startServer } from "./server.js";
import { TickStore } from "./store.js";
import { CoinSwitchVenue } from "./venues/coinswitch.js";
import { DeltaVenue } from "./venues/delta.js";
import { FyersVenue } from "./venues/fyers.js";
import { CTraderSync } from "./venues/ctrader.js";

if (!config.secret) {
  console.error("ENGINE_SECRET is not set; refusing to start without request signing.");
  process.exit(1);
}

// A venue outage must never take the host down: log and keep serving.
process.on("unhandledRejection", (e) => console.error("unhandled:", e instanceof Error ? e.message : e));

const hub = new MarketHub(config.memoryMs);
const store = new TickStore(config.databaseUrl);
hub.onTrades((venue, symbol, trades) => store.add(venue, symbol, trades));

const delta = new DeltaVenue(hub);
const coinswitch = new CoinSwitchVenue(hub);
const fyers = new FyersVenue(hub);
const ctrader = new CTraderSync(config.ctrader);

store.start();
delta.start();
coinswitch.start();
void fyers.start();
void ctrader.start();
const server = startServer({ hub, store, delta, coinswitch, fyers, ctrader, startedAt: Date.now() });

const shutdown = async () => {
  console.log("shutting down");
  delta.stop(); coinswitch.stop(); fyers.stop(); ctrader.stop();
  server.close();
  await store.stop();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
