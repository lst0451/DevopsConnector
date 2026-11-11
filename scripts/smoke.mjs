import { spawn, execFile } from 'node:child_process';
import { mkdir, mkdtemp, access } from 'node:fs/promises';
import path from 'node:path';

const executable = process.argv[2];
if (!executable) { throw new Error('Pass an installed VS Code executable path.'); }
await access(executable);
const root = process.cwd();
await mkdir('work', { recursive: true });
const directory = await mkdtemp(path.join(root, 'work', 'host-smoke-'));
await mkdir(path.join(directory, 'workspace'));
console.log('Isolated smoke profile: ' + directory);
const child = spawn(executable, [
  '--user-data-dir=' + path.join(directory, 'user-data'),
  '--extensions-dir=' + path.join(directory, 'extensions'),
  '--extensionDevelopmentPath=' + root,
  '--extensionTestsPath=' + path.join(root, 'out', 'test', 'host', 'index.js'),
  '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
  path.join(directory, 'workspace'),
], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let passed = false;
let stoppedAfterPass = false;
let shutdown;
let output = '';
const stopIsolatedHost = () => {
  if (child.exitCode !== null || child.signalCode !== null) { return; }
  if (process.platform === 'win32') {
    // Only the child launched above and its isolated descendants; never all Code processes.
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else { child.kill('SIGTERM'); }
};
const consume = (chunk) => {
  output = (output + chunk.toString()).slice(-64 * 1024);
  if (!passed && output.includes('HOST SMOKE PASSED:')) {
    passed = true;
    console.log('HOST SMOKE PASSED: activation, 11 commands, snapshot provider, configuration.');
    // Some desktop builds leave the UI process alive after the test extension host exits.
    shutdown = setTimeout(() => {
      stoppedAfterPass = true;
      console.log('Closing the isolated desktop after successful assertions.');
      stopIsolatedHost();
    }, 5000);
  }
};
child.stdout.on('data', consume);
child.stderr.on('data', consume);
const timeout = setTimeout(() => {
  console.error('Smoke test timed out; stopping only its isolated process tree.');
  stopIsolatedHost();
}, 60_000);
const result = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => resolve(code));
}).finally(() => { clearTimeout(timeout); clearTimeout(shutdown); });
if (!passed || (result !== 0 && !stoppedAfterPass)) {
  console.error(output);
  throw new Error('VS Code smoke test failed: ' + result);
}
