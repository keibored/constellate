// The real entry point, with a test-only IPC signal bridge for Windows.
// Never included in the server build or used by the deployment command.
process.on('message', message => {
  if (message === 'test:SIGTERM') {
    process.disconnect();
    process.emit('SIGTERM');
  }
});
await import('../../dist/index.js');
