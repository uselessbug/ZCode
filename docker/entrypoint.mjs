import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

if (process.env.ZCODE_SERVER_AUTH_TOKEN_FILE) {
  const token = (await readFile(process.env.ZCODE_SERVER_AUTH_TOKEN_FILE, "utf8")).trim();
  if (!token) throw new Error("The configured server token file is empty");
  process.env.ZCODE_SERVER_AUTH_TOKEN = token;
}

await import(pathToFileURL("/app/zcode/server/entry-http.js").href);
