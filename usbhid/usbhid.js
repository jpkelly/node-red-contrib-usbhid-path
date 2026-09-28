const fs = require('fs').promises;
const path = require('path');

module.exports = function(RED) {
  const HID = require('node-hid');

  // Keep enumeration off the event loop as well as device I/O.
  RED.httpAdmin.get('/usbhid/devices', async function(req, res) {
    try {
      const devs = (await HID.devicesAsync()).map(d => ({
        path: d.path,
        vendorId: d.vendorId,
        productId: d.productId,
        interface: d.interface,
        product: d.product,
        manufacturer: d.manufacturer,
        serialNumber: d.serialNumber
      }));
      res.json(devs);
    } catch (err) {
      res.json([]);
    }
  });

  async function getDeviceDetails(config) {
    const devices = await HID.devicesAsync();
    if (config.path && String(config.path).trim()) {
      const devicePath = String(config.path).trim();
      let match = devices.find(d => d.path === devicePath);
      if (!match) {
        try {
          const target = await fs.readlink(devicePath);
          const resolvedPath = path.resolve(path.dirname(devicePath), target);
          match = devices.find(d => d.path === resolvedPath);
        } catch (err) {
          // A missing/non-symlink path is reported below.
        }
      }
      if (!match) throw new Error('HID device not found (path).');
      return match;
    }
    const vid = parseInt(config.vid);
    const pid = parseInt(config.pid);
    const iface = (config.interface !== '' && config.interface !== undefined)
      ? parseInt(config.interface) : undefined;
    const manufacturer = config.manufacturer ? String(config.manufacturer).trim() : undefined;
    const match = devices.find(d =>
      d.vendorId === vid && d.productId === pid &&
      (iface == null || d.interface === iface) &&
      (!manufacturer || (d.manufacturer && d.manufacturer.toLowerCase().includes(manufacturer.toLowerCase())))
    );
    if (!match || !match.path) {
      const details = manufacturer ? '(VID/PID/interface/manufacturer)' : '(VID/PID/interface)';
      throw new Error('HID device not found ' + details + '.');
    }
    return match;
  }

  function HIDConfigNode(config) {
    RED.nodes.createNode(this, config);
    for (const field of ['vid', 'pid', 'interface', 'path', 'manufacturer']) {
      this[field] = config[field];
    }
  }

  function usbHIDNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    node.server = RED.nodes.getNode(config.connection);
    let stopping = false;
    let connection = null;
    let queue = Promise.resolve();
    let shutdown;
    let closeError;
    let reconnectTimer = null;
    let presenceTimer = null;
    let backoffDelay = 250;

    // Every open, write, presence check and close is ordered through this queue.
    // Event callbacks may invalidate a connection immediately, but never close it.
    function enqueue(operation) {
      const result = queue.then(operation);
      queue = result.catch(() => {});
      return result;
    }

    function usable(current) {
      return !stopping && current === connection && current && current.valid;
    }

    function sendStatus(status) {
      if (stopping) return;
      node.status(status);
      node.send([null, null, { topic: 'status', payload: status, timestamp: Date.now() }]);
    }

    function reportError(err, prefix, logError = true) {
      if (stopping) return;
      if (logError) node.error(prefix + err.toString());
      node.send([null, { payload: err }, null]);
    }

    async function closeConnection() {
      const current = connection;
      if (!current) return;
      current.valid = false;
      connection = null;
      try {
        // HIDAsync.close() stops/joins its native reader before freeing the handle.
        // Do not separately pause/remove data listeners: let close own that cleanup.
        await current.device.close();
      } catch (err) {
        // An uncertain close must never be followed by another open of the device.
        closeError = err;
        throw err;
      }
    }

    function scheduleReconnect() {
      if (stopping || closeError || reconnectTimer) return;
      sendStatus({ fill: 'yellow', shape: 'ring', text: 'reconnecting in ' + (backoffDelay / 1000).toFixed(1) + 's' });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        enqueue(connect).catch(err => reportError(err, 'HID reconnect error: '));
      }, backoffDelay);
      backoffDelay = Math.min(backoffDelay * 2, 5000);
    }

    function disconnect(current, err, prefix, logError = true) {
      if (!usable(current)) return;
      // Coalesce read errors, write failures and polling results for this handle.
      current.valid = false;
      reportError(err, prefix, logError);
      sendStatus({ fill: 'red', shape: 'ring', text: 'disconnected' });
      enqueue(async () => {
        await closeConnection();
        scheduleReconnect();
      }).catch(error => reportError(error, 'Failed to close HID device: '));
    }

    async function connect() {
      if (stopping || closeError || connection) return;
      try {
        const info = await getDeviceDetails(node.server);
        if (stopping) return;
        const device = await HID.HIDAsync.open(info.path);
        const current = { device, info, valid: true };
        connection = current;
        if (stopping) {
          await closeConnection();
          return;
        }
        device.on('error', err => disconnect(current, err, 'HID device error: '));
        device.on('data', data => {
          if (usable(current)) node.send([{ payload: data }, null, null]);
        });
        backoffDelay = 250;
        const name = info.product || `VID:${info.vendorId} PID:${info.productId}`;
        sendStatus({
          fill: 'green', shape: 'dot', text: `connected to ${name} (${info.path})`,
          device: {
            product: info.product,
            vendorId: info.vendorId,
            productId: info.productId,
            path: info.path,
            serialNumber: info.serialNumber,
            interface: info.interface
          }
        });
      } catch (err) {
        reportError(err, 'Failed to connect to HID device: ');
        sendStatus({ fill: 'red', shape: 'ring', text: 'disconnected' });
        await closeConnection();
        scheduleReconnect();
      }
    }

    // A chained timeout prevents slow enumeration from building up queued checks.
    function monitorPresence() {
      if (stopping || closeError) return;
      presenceTimer = setTimeout(() => {
        presenceTimer = null;
        enqueue(async () => {
          const current = connection;
          if (!usable(current)) return;
          try {
            const info = await getDeviceDetails(node.server);
            if (JSON.stringify(info) !== JSON.stringify(current.info)) {
              disconnect(current, new Error('HID device changed'), 'Device disconnected: ');
            }
          } catch (err) {
            disconnect(current, err, 'Device disconnected: ');
          }
        }).catch(err => reportError(err, 'HID presence check error: ')).then(monitorPresence);
      }, 1000);
    }

    node.on('input', function(msg, send, done) {
      const complete = typeof done === 'function' ? done : err => {
        if (err) node.error(err, msg);
      };
      const data = Buffer.isBuffer(msg.payload) || Array.isArray(msg.payload)
        ? Array.from(msg.payload) : null;
      enqueue(async () => {
        if (stopping) throw new Error('HID node is closing');
        if (!data) throw new Error('msg.payload must be Buffer or Array');
        const current = connection;
        if (!usable(current)) throw new Error('HID device not connected');
        try {
          await current.device.write(data);
        } catch (err) {
          // done(err) reports this input failure to Node-RED exactly once.
          disconnect(current, err, 'Failed to write to HID device: ', false);
          throw err;
        }
      }).then(() => complete(), err => complete(err));
    });

    node.on('close', function(removed, done) {
      // Also accept the older close(done) calling convention.
      if (typeof removed === 'function') done = removed;
      if (!shutdown) {
        stopping = true;
        if (connection) connection.valid = false;
        clearTimeout(reconnectTimer);
        clearTimeout(presenceTimer);
        reconnectTimer = presenceTimer = null;
        shutdown = enqueue(async () => {
          await closeConnection();
          if (closeError) throw closeError;
        });
      }
      shutdown.then(() => { if (done) done(); }, err => {
        node.error('Failed to close HID device: ' + err.toString());
        if (done) done(err);
      });
    });

    if (!node.server) {
      node.error('No HID configuration found');
      return;
    }
    enqueue(connect).catch(err => reportError(err, 'HID connection error: '));
    monitorPresence();
  }

  function getHIDNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    let stopping = false;
    let pending = Promise.resolve();
    node.on('input', function(msg, send, done) {
      const complete = typeof done === 'function' ? done : err => {
        if (err) node.error(err, msg);
      };
      const operation = pending.then(async () => {
        if (stopping) return;
        msg.payload = await HID.devicesAsync();
        if (!stopping) (send || node.send.bind(node))(msg);
      });
      pending = operation.catch(() => {});
      operation.then(() => complete(), err => complete(err));
    });
    node.on('close', function(removed, done) {
      if (typeof removed === 'function') done = removed;
      stopping = true;
      pending.then(() => { if (done) done(); });
    });
  }

  RED.nodes.registerType('gethiddevices-p', getHIDNode);
  RED.nodes.registerType('hiddevice-p', usbHIDNode);
  RED.nodes.registerType('hidconfig-p', HIDConfigNode);
};
