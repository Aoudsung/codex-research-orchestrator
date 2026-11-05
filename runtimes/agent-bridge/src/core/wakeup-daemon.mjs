import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { BridgeDatabase, resolveBridgeDbPath } from "./bridge-db.mjs";
import {
  ensureResidentSuperagentDaemon,
  getDaemonStateFilePath,
  getDaemonStopMarkerPath,
  getMaxSourceMtimeMs,
  readDaemonState,
  runSuperagentDaemonLoop,
  stopResidentSuperagentDaemon,
} from "../runtime/superagent-daemon.mjs";

const __filename = fileURLToPath(import.meta.url);

export {
  getMaxSourceMtimeMs,
  getDaemonStateFilePath,
  getDaemonStopMarkerPath,
  readDaemonState,
};

export function stopResidentWakeupDaemon(
  dbPath = resolveBridgeDbPath(),
  options = {}
) {
  return stopResidentSuperagentDaemon(dbPath, options);
}

export function ensureResidentWakeupDaemon(
  dbPath = resolveBridgeDbPath(),
  options = {}
) {
  return ensureResidentSuperagentDaemon(dbPath, options);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(__filename)
) {
  if (process.argv[2] === "--deliver-task") {
    const [, , , taskId, dbPath, delayMsStr, driverArg, toAgent] = process.argv;
    const db = new BridgeDatabase(dbPath);
    const failAndExit = (err) => {
      try {
        db.recordWakeupFailure(taskId, [], err?.message || String(err), toAgent || null);
      } catch {
        // ignore
      }
      process.exit(1);
    };
    process.on("uncaughtException", failAndExit);
    process.on("unhandledRejection", failAndExit);
    (async () => {
      try {
        const delayMs = Number(delayMsStr);
        if (Number.isFinite(delayMs) && delayMs > 0) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        await db.executeWakeupDelivery(taskId, {
          toAgent: toAgent || null,
          driverOverride: driverArg || null,
          workerPid: process.pid,
          includeDispatched: false,
        });
        process.exit(0);
      } catch (err) {
        failAndExit(err);
      }
    })();
  } else {
    const targetDb = process.argv[2] || resolveBridgeDbPath();
    runSuperagentDaemonLoop(targetDb);
  }
}
