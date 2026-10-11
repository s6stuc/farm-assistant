import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { ask } from './rag.js';

const port = Number(process.env.API_PORT ?? 3000);

export const app = new Hono();

app.use('*', cors({ origin: '*' }));

app.get('/health', (context) => context.json({ status: 'ok' }));

app.post('/api/ask', async (context) => {
  let body: { question?: unknown; limit?: unknown };

  try {
    body = await context.req.json<{ question?: unknown; limit?: unknown }>();
  } catch {
    return context.json({ error: 'Request body must be valid JSON' }, 400);
  }

  if (typeof body.question !== 'string' || body.question.trim().length === 0) {
    return context.json({ error: 'question must be a non-empty string' }, 400);
  }

  try {
    const result = await ask(
      body.question.trim(),
      typeof body.limit === 'number' ? body.limit : undefined,
    );
    return context.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Request failed';
    const statusCode = message.startsWith('limit ') ? 400 : 503;
    return context.json({ error: message }, statusCode);
  }
});

app.notFound((context) => context.json({ error: 'Not found' }, 404));

app.onError((error, context) => {
  console.error(error);
  return context.json({ error: 'Internal server error' }, 500);
});

const server = serve(
  {
    fetch: app.fetch,
    port,
  },
  (info) => {
    console.log(`API listening on http://localhost:${info.port}`);
  },
);

const shutdown = (): void => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
