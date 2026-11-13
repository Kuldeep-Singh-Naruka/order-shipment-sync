// Runs the mock courier and the API + worker together. Ctrl+C stops both.
// A plain child_process script instead of a package like `concurrently`, to keep dependencies at three.
const { spawn } = require('node:child_process');

const children = ['mock-courier.js', 'src/server.js'].map((file) =>
  spawn(process.execPath, [file], { stdio: 'inherit' }),
);

// If one exits (e.g. the server has no WEBHOOK_SECRET), stop the other so nothing is left half-running.
for (const child of children) {
  child.on('exit', (code) => {
    for (const other of children) other.kill();
    process.exitCode = code ?? 1;
  });
}
