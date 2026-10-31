// 逐个构建仓库内的插件。
// 插件的市场快照来自根索引（dist/index.json），所以先 `npm run build` 生成索引。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pluginsDir = join(root, "plugins");
for (const name of readdirSync(pluginsDir).sort()) {
  const dir = join(pluginsDir, name);
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (!pkg.scripts?.build) continue;
  console.log("building " + name);
  const result = spawnSync("npm", ["run", "build"], { cwd: dir, stdio: "inherit" });
  if (result.status !== 0) {
    console.error("plugin build failed: " + name);
    process.exit(result.status ?? 1);
  }
}
