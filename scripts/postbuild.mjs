// Makes the built CLI executable (tsc keeps the shebang but not the file mode).
import { chmodSync, existsSync } from "node:fs";

const cli = new URL("../dist/cli.js", import.meta.url);
if (existsSync(cli)) chmodSync(cli, 0o755);
