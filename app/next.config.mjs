/**
 * The Next.js configuration.
 *
 * This file is JavaScript and not TypeScript on purpose. The repository uses TypeScript 7,
 * which is the native port. Next.js 15 cannot load a TypeScript configuration with it and
 * it fails with a `fileExists` error. A JavaScript configuration avoids that loader.
 *
 * `@teecash/lib-blind` exports TypeScript source and has no build step. Next.js must
 * therefore compile it with the application. Its own dependencies are `@noble/curves` and
 * `@noble/hashes`. Both run in a browser without a polyfill.
 *
 * @type {import("next").NextConfig}
 */
/**
 * The optional peer dependencies of Privy.
 *
 * Privy marks each one optional and teecash installs none of them. They serve the Solana
 * screens, the Farcaster mini application, Abstract and smart accounts. This application
 * opens none of them.
 *
 * A bundler still resolves every import it finds, so an absent optional peer stops the
 * build. The webpack alias `false` maps each one to an empty module.
 *
 * This is why `package.json` runs webpack and not Turbopack. Turbopack also checks that
 * each named import exists in the target, so an empty module gives 272 errors instead of
 * one. The alternative is to install the whole Solana stack for an application that only
 * uses Ethereum.
 */
const OPTIONAL_PEERS = [
  "@solana/kit",
  "@solana-program/memo",
  "@solana-program/system",
  "@solana-program/token",
  "@farcaster/mini-app-solana",
  "@abstract-foundation/agw-client",
  "permissionless",
];

const config = {
  transpilePackages: ["@teecash/lib-blind"],
  // Next.js starts one worker for each core minus one. This machine is a laptop and the
  // developer uses it while the build runs. Two workers keep the build off every core.
  // The count applies to page generation, to the webpack build worker and to the minify
  // pass.
  experimental: { cpus: 2 },
  // Next.js writes its own AGENTS.md and CLAUDE.md into this directory. The repository
  // holds its conventions in the CLAUDE.md at the root, and a second file here competes
  // with it.
  agentRules: false,
  // The repository holds more than one lockfile. Name the root, or Next.js infers one
  // outside the repository and warns.
  outputFileTracingRoot: new URL("..", import.meta.url).pathname,
  webpack(webpackConfig) {
    for (const name of OPTIONAL_PEERS) webpackConfig.resolve.alias[name] = false;
    // `experimental.cpus` bounds the worker count. It does not bound the work inside one
    // worker. This bounds how many modules webpack compiles at the same time. The default
    // is 100. Keep this value generous. A small value makes the build much slower and it
    // does not reduce the peak load more.
    webpackConfig.parallelism = 16;
    return webpackConfig;
  },
};

export default config;
