// Lists HydraDB databases/collections and runs a sample query, to confirm the setup.
// Usage: pnpm hydra:inspect "Acme discovery call"
import { HydraDBClient } from "@hydradb/sdk";

const hydra = new HydraDBClient({ token: process.env.HYDRA_DB_API_KEY! });
const dbs = await hydra.databases.list();
console.log("databases:", JSON.stringify(dbs.data, null, 2));

const database = process.env.HYDRA_DB_DATABASE;
if (database) {
  const cols = await hydra.databases.collections({ database });
  console.log("collections:", JSON.stringify(cols.data, null, 2));
  const q = process.argv[2] ?? "latest discovery call";
  const res = await hydra.query({ query: q, database, type: "all", maxResults: 5 });
  console.log(typeof res.data === "string" ? res.data : res.data?.llmPrompt);
}
