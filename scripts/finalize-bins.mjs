#!/usr/bin/env node
// After tsc emit: prepend `#!/usr/bin/env node` and chmod +x every dist/bin/*.js.
import { readdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const binDir = join(here, "..", "dist", "bin");
const shebang = "#!/usr/bin/env node\n";

for (const name of readdirSync(binDir)) {
  if (!name.endsWith(".js")) continue;
  const path = join(binDir, name);
  const body = readFileSync(path, "utf8");
  if (!body.startsWith("#!")) writeFileSync(path, shebang + body);
  chmodSync(path, 0o755);
}
