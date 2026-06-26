import { createBot } from "./bot.js";

const bot = createBot({ enableSchedules: true });

async function main(): Promise<void> {
  await bot.launch();
  console.log("ARM PDD bot started");
}

main().catch((error) => {
  console.error("Failed to start bot:", error);
  process.exit(1);
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
