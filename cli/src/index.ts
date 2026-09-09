/**
 * The entry point.
 *
 * Usage:
 *   npm run teecash -- deploy
 *   npm run teecash -- deposit 111
 *   npm run teecash -- mint [id]
 *   npm run teecash -- claim [id]
 *   npm run teecash -- spend [id]
 *   npm run teecash -- status
 *   npm run teecash -- demo 111
 *   npm run teecash -- privy-check
 *
 * TEECASH_RPC sets the node. TEECASH_DEPLOYER_KEY sets the funding account.
 *
 * TEECASH_WALLETS picks the wallet provider. It takes `local` or `privy` and `local` is
 * the default. The `privy` provider needs PRIVY_APP_ID and PRIVY_APP_SECRET.
 */

import { claim, deploy, deposit, mint, privyCheck, spend, status } from "./commands.ts";

const [command, argument] = process.argv.slice(2);

/** Run the whole protocol in one call. */
async function demo(amount: string): Promise<void> {
  const steps: [string, () => Promise<void>][] = [
    ["deploy", () => deploy()],
    ["deposit", () => deposit(amount)],
    ["mint", () => mint()],
    ["claim", () => claim()],
    ["spend", () => spend()],
    ["status", () => status()],
  ];
  for (const [name, run] of steps) {
    console.log(`\n=== ${name} ===`);
    await run();
  }
}

const commands: Record<string, () => Promise<void>> = {
  deploy: () => deploy(),
  deposit: () => deposit(argument ?? "111"),
  mint: () => mint(argument),
  claim: () => claim(argument),
  spend: () => spend(argument),
  status: () => status(),
  demo: () => demo(argument ?? "111"),
  "privy-check": () => privyCheck(),
};

const run = commands[command ?? ""];
if (!run) {
  console.error(`unknown command ${command ?? "(none)"}`);
  console.error(`known commands: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
