import { createServer } from 'node:net';

const probe = createServer();
probe.once('error', error => {
  console.error(`Cannot start ReceiptMatch on 127.0.0.1:4310: ${error.message}`);
  process.exitCode = 1;
});
probe.listen(4310, '127.0.0.1', () => probe.close());
