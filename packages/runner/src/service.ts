import { loadDotEnv } from "./env.js";
import { startWorker } from "./worker.js";

loadDotEnv();
await startWorker();
console.log("Kiln runner worker is ready.");
