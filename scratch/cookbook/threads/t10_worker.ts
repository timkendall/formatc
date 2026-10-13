import { parentPort } from "node:worker_threads";
parentPort!.on("message", (m: number) => { parentPort!.postMessage(m + 1); });
