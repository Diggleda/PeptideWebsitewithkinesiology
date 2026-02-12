const http = require('http');
const net = require('net');
const { env } = require('./config/env');
const { logger } = require('./config/logger');
const { bootstrap } = require('./bootstrap');

process.on('uncaughtException', (err) => {
  // Ensure we see boot/runtime crashes even if logger transport is misconfigured under Passenger.
  // eslint-disable-next-line no-console
  console.error('[boot] uncaughtException', err);
  logger.fatal({ err }, 'Uncaught exception');
});

process.on('unhandledRejection', (reason) => {
  // eslint-disable-next-line no-console
  console.error('[boot] unhandledRejection', reason);
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
});

const assertSecureRuntimeConfig = () => {
  if (env.nodeEnv !== 'production') {
    return;
  }
  if (!process.env.JWT_SECRET || env.jwtSecret === 'your-secret-key-change-in-production') {
    throw new Error('JWT_SECRET must be set to a strong value in production');
  }
};

const probeListen = (port, host) => new Promise((resolve) => {
  const tester = net.createServer();
  let settled = false;

  const finish = (available, code = null) => {
    if (settled) return;
    settled = true;
    resolve({ available, code });
  };

  tester.once('error', (err) => {
    const code = err && typeof err.code === 'string' ? err.code : null;
    try {
      tester.close(() => finish(false, code));
    } catch {
      finish(false, code);
    }
  });

  tester.once('listening', () => {
    try {
      tester.close(() => finish(true, null));
    } catch {
      finish(true, null);
    }
  });

  try {
    tester.listen({ port, host });
  } catch (err) {
    const code = err && typeof err.code === 'string' ? err.code : null;
    try {
      tester.close(() => finish(false, code));
    } catch {
      finish(false, code);
    }
  }
});

const probePortAvailability = async (port) => {
  // Match `server.listen(port)` behavior which prefers IPv6 dual-stack (`::`) when available.
  const ipv6 = await probeListen(port, '::');
  if (ipv6.available) {
    return ipv6;
  }
  const retryIpv4 =
    ipv6.code === 'EAFNOSUPPORT'
    || ipv6.code === 'EADDRNOTAVAIL'
    || ipv6.code === 'EPERM'
    || ipv6.code === 'EACCES';
  if (!retryIpv4) {
    return ipv6;
  }
  return probeListen(port, '0.0.0.0');
};

const findAvailablePort = async (startPort, attempts = 5) => {
  const failureCodes = [];
  for (let i = 0; i < attempts; i += 1) {
    const candidate = startPort + i;
    // eslint-disable-next-line no-await-in-loop
    const probe = await probePortAvailability(candidate);
    if (probe.available) {
      if (i > 0) {
        logger.warn({ tried: startPort, selected: candidate }, 'Port in use, using fallback');
      }
      return candidate;
    }
    failureCodes.push(probe.code);
  }
  const distinctCodes = Array.from(new Set(failureCodes.filter(Boolean)));
  if (distinctCodes.length === 1 && (distinctCodes[0] === 'EPERM' || distinctCodes[0] === 'EACCES')) {
    throw new Error(
      `Unable to bind to ports starting at ${startPort} (${distinctCodes[0]}). `
      + 'This environment may block listening sockets; choose a different PORT or update hosting configuration.',
    );
  }
  throw new Error(`No available port found starting at ${startPort}`);
};

const start = async () => {
  try {
    // eslint-disable-next-line no-console
    console.log('[boot] start', new Date().toISOString(), {
      nodeEnv: env.nodeEnv,
      portEnv: process.env.PORT || null,
      resolvedPort: env.port,
      allowPortFallback: env.allowPortFallback,
    });
    assertSecureRuntimeConfig();
    await bootstrap();

    let port = env.port;
    if (env.allowPortFallback) {
      port = await findAvailablePort(env.port, 6);
    } else {
      const probe = await probePortAvailability(env.port);
      if (!probe.available) {
        if (probe.code === 'EPERM' || probe.code === 'EACCES') {
          throw new Error(
            `Unable to bind to port ${env.port} (${probe.code}). `
            + 'Choose a different PORT or update host permissions.',
          );
        }
        throw new Error(
          `Port ${env.port} is already in use. Stop the existing process or set PORT, or set ALLOW_PORT_FALLBACK=true.`,
        );
      }
    }

    const createApp = require('./app');
    const app = createApp();
    const server = http.createServer(app);

    server.listen(port, () => {
      logger.info(
        {
          service: 'peppro-backend',
          port,
          nodeEnv: env.nodeEnv,
        },
        'Backend server is ready',
      );
      try {
        const { startOrderSyncJob } = require('./services/orderService');
        startOrderSyncJob();
      } catch (error) {
        logger.error({ err: error }, 'Failed to start background order sync job');
      }
      try {
        const { startShipStationStatusSyncJob } = require('./services/shipStationSyncService');
        startShipStationStatusSyncJob();
      } catch (error) {
        logger.error({ err: error }, 'Failed to start ShipStation status sync job');
      }
    });

    server.on('error', (error) => {
      logger.error({ err: error }, 'HTTP server error');
      process.exitCode = 1;
    });

    return server;
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[boot] failed to start', error);
    logger.fatal({ err: error }, 'Failed to start backend server');
    process.exit(1);
  }
};

if (require.main === module) {
  start();
}

module.exports = { start };
