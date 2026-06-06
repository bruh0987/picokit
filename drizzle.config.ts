import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const url = process.env.TURSO_DATABASE_URL ?? process.env.TURSO_CONNECTION_URL;

if (!url) {
  throw new Error("Missing TURSO_DATABASE_URL or TURSO_CONNECTION_URL.");
}

if (!process.env.TURSO_AUTH_TOKEN) {
  throw new Error("Missing TURSO_AUTH_TOKEN.");
}

export default defineConfig({
  schema: "./example/src/db/schema.ts",
  out: "./example/drizzle",
  dialect: "turso",
  dbCredentials: {
    url,
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
});
