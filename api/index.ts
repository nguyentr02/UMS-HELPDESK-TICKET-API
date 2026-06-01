// Vercel serverless entry. The `vercel.json` rewrite directs every request to
// `/api/index`, and `@vercel/node` compiles this TS file with esbuild and
// invokes the default export as a Node HTTP handler. The Express app exported
// from `../src/app` already matches that signature.
import app from '../src/app';

export default app;
