import { createApp } from "./app";

const app = createApp();
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

Bun.serve({
  port,
  fetch: app.fetch
});

console.log(`Server running at http://localhost:${port}`);
