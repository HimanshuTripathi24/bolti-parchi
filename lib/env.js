// Loads .env for local runs. Must be the first import so other modules see the variables.
import fs from "node:fs";

if (fs.existsSync(".env")) process.loadEnvFile(".env");
