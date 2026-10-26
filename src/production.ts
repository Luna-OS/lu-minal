// Imported first by cli.tsx, before React loads. React (and Ink's reconciler) pick their build from
// NODE_ENV when they are first imported, and without NODE_ENV that is the development build, which
// costs about 1.5 times the CPU for every frame (checks and warnings no user sees). The binaries
// have "production" built in; this gives `node dist/cli.js` (npm installs) the same. An explicit
// NODE_ENV wins (NODE_ENV=development lu-minal for React's development build).
//
// Once React has loaded, cli.tsx takes NODE_ENV out again: the programs lu-minal starts (Claude
// Code, the agents' commands, an `npm install` among them) must see the environment as it was.

/**
 * Sets NODE_ENV to "production" in `env` unless it is set; the function returned takes it out
 * again (and does nothing when NODE_ENV was set before).
 */
export function productionForReact(env: NodeJS.ProcessEnv = process.env): () => void {
  // A computed key: the binaries' build replaces `process.env.NODE_ENV` with a string, which would
  // make an assignment to it invalid code.
  const key = "NODE_ENV";
  if (env[key]) return () => undefined;
  env[key] = "production";
  return () => {
    if (env[key] === "production") delete env[key];
  };
}

/** Puts process.env.NODE_ENV back as it was before lu-minal started. */
export const restoreNodeEnv = productionForReact();
