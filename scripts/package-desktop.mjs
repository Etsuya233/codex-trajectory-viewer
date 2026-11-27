import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repo = fileURLToPath(new URL('../', import.meta.url));
const browser = join(repo, 'dist', 'panel');
const marketplace = join(repo, 'dist', 'desktop-marketplace');
const catalog = join(marketplace, '.agents', 'plugins');
const plugin = join(marketplace, 'plugins', 'local-trajectory-viewer');
const licenses = join(plugin, 'licenses');
await Promise.all([mkdir(catalog, { recursive: true }), mkdir(licenses, { recursive: true })]);

const shell = await readFile(join(browser, 'desktop-panel.html'), 'utf8');
const scriptTag = shell.match(/<script type="module"[^>]* src="\/(assets\/[^"]+\.js)"[^>]*><\/script>/);
const styleTag = shell.match(/<link rel="stylesheet"[^>]* href="\/(assets\/[^"]+\.css)"[^>]*>/);
if (!scriptTag || !styleTag) throw new Error('Expected exactly one built viewer script and stylesheet.');
const [script, styles] = await Promise.all([scriptTag[1], styleTag[1]].map(asset => readFile(join(browser, asset), 'utf8')));
const html = shell.replace('<head>', '<head><meta name="trajectory-transport" content="mcp">')
  .replace(scriptTag[0], () => `<script type="module">${script.replace(/<\/script/gi, '<\\/script')}</script>`)
  .replace(styleTag[0], () => `<style>${styles.replace(/<\/style/gi, '<\\/style')}</style>`);

const { metafile } = await build({
  absWorkingDir: repo, entryPoints: ['src/server/mcp.ts'], outfile: join(plugin, 'server.mjs'),
  platform: 'node', format: 'esm', target: 'node24', bundle: true, minify: true, metafile: true,
  legalComments: 'eof',
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});

await Promise.all([
  writeFile(join(plugin, 'viewer.html'), html),
  copyFile(join(repo, 'desktop', 'marketplace.json'), join(catalog, 'marketplace.json')),
  copyFile(join(repo, 'desktop', 'plugin.json'), join(plugin, 'plugin.json')),
  copyFile(join(repo, 'desktop', 'mcp.json'), join(plugin, 'mcp.json')),
  copyFile(join(repo, 'src', 'client', 'dsh', 'LICENSE'), join(licenses, 'DeepSeek-Harness.txt')),
  copyFile(join(browser, 'browser-licenses.md'), join(licenses, 'browser.md')),
]);

const dependencyPaths = new Set(Object.keys(metafile.inputs).flatMap(path =>
  path.replaceAll('\\', '/').match(/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+/g)?.map(root => root.replace(/^\//, '')) ?? []));
await Promise.all([...dependencyPaths].map(async path => {
  const packageRoot = join(repo, path);
  const name = path.replace(/^node_modules\//, '').replaceAll('/', '-');
  const notices = (await readdir(packageRoot)).filter(file => /^(?:licen[cs]e|notice|copying)(?:[.-]|$)/i.test(file));
  await Promise.all(notices.map(file => copyFile(join(packageRoot, file), join(licenses, `${name}-${file}`))));
}));

console.log(`Desktop marketplace: ${marketplace}`);
