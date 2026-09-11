import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { run, webAppArguments, tuiArguments, transcodeArguments } from "../src/workflows.ts";

const installed = fsSync.existsSync("/usr/share/omarchy/bin/omarchy-webapp-install");

test("original Omarchy installers and transcode complete without opening a legacy picker", { skip: !installed }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "super-space-original-workflow-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const bin = path.join(home, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "omarchy-notification-send"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await fs.writeFile(path.join(bin, "wl-copy"), '#!/bin/sh\ncat > "$HOME/clipboard.uri"\n', { mode: 0o755 });
  for (const picker of ["gum", "omarchy-menu-select", "omarchy-menu-file", "omarchy-file-select"]) {
    await fs.writeFile(path.join(bin, picker), '#!/bin/sh\nprintf legacy-picker-invoked >&2\nexit 99\n', { mode: 0o755 });
  }
  const env = { ...process.env, HOME: home, PATH: `${bin}:/usr/share/omarchy/bin:${process.env.PATH}` };
  await run("/usr/share/omarchy/bin/omarchy-webapp-install", webAppArguments({ name: "Fixture Web", url: "https://example.com/a?q=%20", icon: "internet-web-browser" }), { env });
  const web = await fs.readFile(path.join(home, ".local/share/applications/Fixture Web.desktop"), "utf8");
  assert.match(web, /^Name=Fixture Web$/m);
  assert.match(web, /^Exec=omarchy-launch-webapp "https:\/\/example.com\/a\?q=%%20"$/m);
  await run("/usr/share/omarchy/bin/omarchy-tui-install", tuiArguments({ name: "Fixture TUI", command: "btop", style: "float", icon: "utilities-terminal" }), { env });
  const tui = await fs.readFile(path.join(home, ".local/share/applications/Fixture TUI.desktop"), "utf8");
  assert.match(tui, /^Exec=xdg-terminal-exec --app-id=TUI.float -e btop$/m);
  const input = path.join(home, "fixture.ppm");
  await fs.writeFile(input, "P3\n2 2\n255\n255 0 0 0 255 0 0 0 255 255 255 255\n");
  const conversion = await transcodeArguments({ files: [input], format: "jpg", resolution: "low" });
  await run("/usr/share/omarchy/bin/omarchy-transcode", conversion.args, { env });
  assert.equal((await fs.readFile(conversion.output)).subarray(0, 2).toString("hex"), "ffd8");
  assert.equal((await fs.readFile(path.join(home, "clipboard.uri"), "utf8")).trim(), `file://${conversion.output}`);
});
