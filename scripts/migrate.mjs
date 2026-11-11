// Applies every SQL file in supabase/migrations using psql.
// Needs SUPABASE_DB_URL in .env.local (the Postgres connection string).
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
try {
  process.loadEnvFile(`${root}.env.local`);
} catch {
  // fall back to the existing environment
}

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error("SUPABASE_DB_URL is not set. Add it to .env.local first.");
  process.exit(1);
}

const dir = `${root}supabase/migrations`;
for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
  console.log(`Applying ${file}`);
  const result = spawnSync(
    "psql",
    [url, "--no-psqlrc", "-v", "ON_ERROR_STOP=1", "-q", "-1", "-f", `${dir}/${file}`],
    { stdio: "inherit" }
  );
  if (result.status !== 0) {
    console.error(`Failed on ${file}`);
    process.exit(result.status ?? 1);
  }
}
// Ask PostgREST to pick up the new tables right away.
spawnSync("psql", [url, "--no-psqlrc", "-q", "-c", "notify pgrst, 'reload schema';"], {
  stdio: "inherit"
});
console.log("Migrations applied.");
