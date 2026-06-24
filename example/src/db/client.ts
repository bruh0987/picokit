import "dotenv/config";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

// Use Turso when it's configured; otherwise fall back to a local SQLite file so the
// example runs out of the box with no external database or credentials.
const url =
  process.env.TURSO_DATABASE_URL ??
  process.env.TURSO_CONNECTION_URL ??
  "file:example/local.db";
const authToken = process.env.TURSO_AUTH_TOKEN;
const isLocalFile = url.startsWith("file:");

if (!isLocalFile && !authToken) {
  throw new Error("Missing TURSO_AUTH_TOKEN.");
}

const client = createClient({ url, authToken });

// A local file DB starts empty, so create the schema on boot to keep the demo
// zero-setup. Against Turso, run `bun run db:migrate` to apply migrations instead.
if (isLocalFile) {
  await client.execute(`CREATE TABLE IF NOT EXISTS todos (
    id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
    title text NOT NULL,
    completed integer DEFAULT false NOT NULL
  );`);
}

export const db = drizzle(client, { schema });
