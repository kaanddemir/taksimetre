import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { defineConfig, type Plugin, type ResolvedConfig } from "vite";

const SW_TEMPLATE = new URL("./src/pwa/sw.js", import.meta.url);

/**
 * Writes dist/sw.js after the build: the template plus the list of every emitted file and a version
 * derived from their contents. Same input → same version, so a rebuild without changes is not an update.
 */
function pwaPlugin(): Plugin {
  let config: ResolvedConfig;
  return {
    name: "taksimetre-sw",
    apply: "build",
    configResolved(c) {
      config = c;
    },
    closeBundle() {
      const outDir = config.build.outDir;
      const files = walk(outDir)
        .map((f) => relative(outDir, f).split(sep).join("/"))
        .filter((f) => f !== "sw.js" && f !== "index.html" && !f.endsWith(".map") && !f.split("/").some((p) => p.startsWith(".")))
        .sort();
      const template = readFileSync(SW_TEMPLATE, "utf8");
      const hash = createHash("sha256").update(template);
      for (const f of [...files, "index.html"]) hash.update(f).update(readFileSync(join(outDir, f)));
      const version = hash.digest("hex").slice(0, 12);
      const header = `const VERSION = ${JSON.stringify(version)};\nconst ASSETS = ${JSON.stringify(files)};\n`;
      writeFileSync(join(outDir, "sw.js"), header + template);
    },
  };
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

/** Only the development server needs a style nonce and its own HMR socket. */
function devSecurity(nonce: string): Plugin {
  return {
    name: "taksimetre-dev-csp",
    apply: "serve",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const urls = ctx.server?.resolvedUrls;
        const sockets = [...(urls?.local ?? []), ...(urls?.network ?? [])]
          .map((u) => new URL(u.replace(/^http/, "ws")).origin);
        return html.replace("style-src 'self'", `style-src 'self' 'nonce-${nonce}'`)
          .replace("connect-src 'self'", `connect-src 'self' ${[...new Set(sockets)].join(" ")}`);
      },
    },
  };
}

export default defineConfig(({ command }) => {
  const nonce = randomBytes(18).toString("base64");
  return {
    base: "./", // relative URLs: the build can be hosted at any domain or sub-path (not decided yet)
    server: { host: "localhost", port: 5173 }, // opt in to LAN with npm run dev -- --host 0.0.0.0
    ...(command === "serve" ? { html: { cspNonce: nonce } } : {}),
    plugins: [pwaPlugin(), devSecurity(nonce)],
    test: { include: ["test/**/*.test.ts"] },
  };
});
