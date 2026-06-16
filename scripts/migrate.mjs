import pg from "pg";
import { loadDotEnv } from "./lib/env.mjs";

const { Pool } = pg;
loadDotEnv();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

let schemaModule;
try {
  schemaModule = await import(new URL("../packages/shared/dist/db/schema.js", import.meta.url).href);
} catch (err) {
  console.error("Could not load packages/shared/dist/db/schema.js. Run `npm run build --workspace=packages/shared` first.");
  if (process.env.KILN_DEBUG === "1") console.error(err);
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  await pool.query(schemaModule.SCHEMA_SQL);
  console.log("Database schema is up to date.");
} finally {
  await pool.end();
}
