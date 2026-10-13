import { Worker } from "node:worker_threads";
const w = new Worker(new URL("./t10_worker.ts", import.meta.url));
const ROUNDS = 100000;
let n = 0;
const t0 = performance.now();
w.on("message", (m: number) => {
  n++;
  if (n < ROUNDS) w.postMessage(n); else { const dt = performance.now() - t0; console.log(`ping-pong ${ROUNDS} round trips: ${(dt * 1e6 / ROUNDS).toFixed(0)} ns/round trip`); w.terminate(); }
});
w.postMessage(0);
