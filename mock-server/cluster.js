const cluster = require('cluster');
const os = require('os');
const process = require('process');

const numCPUs = os.cpus().length;

if (cluster.isPrimary) {
  console.log(`Primary ${process.pid} is running`);
  console.log(`Starting ${numCPUs} workers...`);

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died (${signal || code}). Restarting...`);
    cluster.fork();
  });

  cluster.on('listening', (worker, address) => {
    console.log(`Worker ${worker.process.pid} listening on ${address.address}:${address.port}`);
  });
} else {
  require('./server.js');
}