// Preloaded (node --require) by test/core/production.test.ts: on exit, prints which builds of React
// and React's reconciler the process loaded, and the NODE_ENV the process ended with.
process.on("exit", () => {
  // Only modules that ran (preparsing an ES import of CommonJS puts the others in the cache too).
  const loaded = Object.keys(require.cache)
    .filter((file) => require.cache[file]?.loaded)
    .map((file) => /(react|react-reconciler)[\\/]cjs[\\/][\w-]+\.(production|development)\.js$/.exec(file))
    .filter(Boolean)
    .map((m) => `${m[1]}:${m[2]}`);
  process.stderr.write(`REACT-BUILDS ${JSON.stringify({ loaded: [...new Set(loaded)].sort(), nodeEnv: process.env.NODE_ENV ?? null })}\n`);
});
