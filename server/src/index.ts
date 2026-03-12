import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { webhookRoutes } from "./routes/webhooks.js";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));
app.route("/webhooks", webhookRoutes);

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Server listening on port ${port}`);
});
