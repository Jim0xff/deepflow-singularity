import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const helpersDir = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.resolve(helpersDir, "..");
const projectRoot = path.resolve(testDir, "..");

dotenv.config({ path: path.join(testDir, "env.test") });
dotenv.config({ path: path.join(projectRoot, ".env") });
