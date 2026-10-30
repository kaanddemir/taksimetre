import { defineConfig, devices } from "@playwright/test";

const mobile = { ...devices["Desktop Chrome"], hasTouch: true, colorScheme: "dark" as const }; // the app default; theme.spec covers light
const CI = !!process.env.CI;
/** Stand-in for a GitHub Pages project site (https://<owner>.github.io/<repo>/); the real name is not assumed. */
export const PAGES_SUBPATH = "/example-repo/";

export default defineConfig({
  testDir: "e2e",
  outputDir: "e2e/.results",
  reporter: CI ? [["list"], ["github"]] : "list",
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  projects: [
    { name: "dev", testIgnore: /(prod|pages)\.spec/, use: { ...mobile, baseURL: "http://localhost:5173" } },
    { name: "prod", testMatch: /prod\.spec/, use: { ...mobile, baseURL: "http://localhost:4173" } },
    // The same production build served under a sub-path, as GitHub Pages does for project sites.
    { name: "pages", testMatch: /pages\.spec/, use: { ...mobile, baseURL: `http://localhost:4174${PAGES_SUBPATH}` } },
  ],
  webServer: [
    { command: "npx vite --port 5173 --strictPort", url: "http://localhost:5173", reuseExistingServer: !CI },
    { command: "npx vite build && npx vite preview --port 4173 --strictPort", url: "http://localhost:4173", reuseExistingServer: !CI },
    {
      // Own output directory: the prod project rewrites dist/sw.js during its update test.
      command: `npx vite build --outDir dist-pages --emptyOutDir && npx vite preview --outDir dist-pages --base ${PAGES_SUBPATH} --port 4174 --strictPort`,
      url: `http://localhost:4174${PAGES_SUBPATH}`,
      reuseExistingServer: !CI,
    },
  ],
});
