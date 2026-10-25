// Stand-in for "react-devtools-core" in the standalone binaries (scripts/build-binaries.ts).
// Ink imports it for its optional DEV=true devtools connection; the real package is not a
// dependency, so Bun's bundler resolves the import here instead. Both calls do nothing.
const devtools = {
  initialize() {},
  connectToDevTools() {},
};

export default devtools;
export const initialize = devtools.initialize;
export const connectToDevTools = devtools.connectToDevTools;
