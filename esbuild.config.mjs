import esbuild from 'esbuild';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const isWatch = process.argv.includes('--watch');
const isDev = process.argv.includes('--dev');
const manifest = JSON.parse(readFileSync(resolve(rootDir, 'plugin.json'), 'utf8'));
const outputDir = isDev
  ? resolve(homedir(), '.kai', 'plugins', manifest.name)
  : resolve(rootDir, 'dist');

const builtins = new Set([
  'assert', 'buffer', 'child_process', 'crypto', 'events', 'fs', 'http', 'https',
  'net', 'os', 'path', 'process', 'stream', 'timers', 'tls', 'url', 'util', 'zlib',
]);

const localNodeModulesPlugin = {
  name: 'local-node-modules',
  setup(build) {
    build.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('node:')) return null;
      const packageName = args.path.startsWith('@')
        ? args.path.split('/').slice(0, 2).join('/')
        : args.path.split('/')[0];
      if (builtins.has(packageName)) return null;
      try {
        return {
          path: require.resolve(args.path, { paths: [resolve(rootDir, 'node_modules')] }),
        };
      } catch {
        return null;
      }
    });
  },
};

const reactGlobalPlugin = {
  name: 'react-global',
  setup(build) {
    build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => ({
      path: args.path,
      namespace: 'react-global',
    }));
    build.onLoad({ filter: /.*/, namespace: 'react-global' }, () => ({
      contents: `
        const R = () => globalThis.React;
        export default new Proxy({}, { get: (_, key) => R()[key] });
        export const useState = (...args) => R().useState(...args);
        export const useEffect = (...args) => R().useEffect(...args);
        export const useCallback = (...args) => R().useCallback(...args);
        export const useMemo = (...args) => R().useMemo(...args);
        export const createElement = (...args) => R().createElement(...args);
        export const Fragment = Symbol.for('react.fragment');
      `,
      loader: 'js',
    }));
  },
};

mkdirSync(outputDir, { recursive: true });
copyFileSync(resolve(rootDir, 'plugin.json'), resolve(outputDir, 'plugin.json'));

const backendOptions = {
  entryPoints: [resolve(rootDir, 'src/backend/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: resolve(outputDir, 'backend.js'),
  sourcemap: true,
  target: 'node18',
  plugins: [localNodeModulesPlugin],
};

const frontendOptions = {
  entryPoints: [resolve(rootDir, 'src/frontend/index.ts')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outfile: resolve(outputDir, 'frontend.js'),
  sourcemap: true,
  target: 'es2020',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  plugins: [reactGlobalPlugin, localNodeModulesPlugin],
};

if (isWatch) {
  const [backend, frontend] = await Promise.all([
    esbuild.context(backendOptions),
    esbuild.context(frontendOptions),
  ]);
  await Promise.all([backend.watch(), frontend.watch()]);
  console.info(`Watching Rally plugin (output: ${outputDir})`);
} else {
  await Promise.all([esbuild.build(backendOptions), esbuild.build(frontendOptions)]);
  console.info(isDev ? `Built to ${outputDir}` : 'Built Rally plugin to dist/');
}
