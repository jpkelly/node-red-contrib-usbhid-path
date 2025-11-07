const pkg = require('../package.json');
console.log(`✅ Loaded ${pkg.name} v${pkg.version}`);
module.exports = function(RED) {

  var HID = require('node-hid');

  // Admin endpoint for device enumeration
  RED.httpAdmin.get('/usbhid/devices', function(req, res) {
    try {
      const devs = HID.devices().map(d => ({
        path: d.path,
        vendorId: d.vendorId,
        productId: d.productId,
        interface: d.interface,
        product: d.product,
        manufacturer: d.manufacturer,
        serialNumber: d.serialNumber
      }));
      res.json(devs);
    } catch(e) {
      res.json([]);
    }
  });

  // Helper function to get device details
  function getDeviceDetails(config) {
    if (config.path && String(config.path).trim()) {
      let path = String(config.path).trim();
      // Try direct path first
      let match = HID.devices().find(d => d.path === path);
      if (!match) {
        // If not found, try resolving potential symlink
        try {
          const fs = require('fs');
          const resolvedPath = fs.readlinkSync(path);
          if (resolvedPath) {
            // If it was a symlink, try with the resolved path
            const fullPath = resolvedPath.startsWith('/') ? resolvedPath : `/dev/${resolvedPath}`;
            match = HID.devices().find(d => d.path === fullPath);
          }
        } catch(e) {
          // Ignore errors from readlink
        }
      }
      if (!match) throw new Error('HID device not found (path).');
      return match;
    }
    const vid = parseInt(config.vid);
    const pid = parseInt(config.pid);
    const iface = (config.interface !== "" && config.interface !== undefined)
        ? parseInt(config.interface) : undefined;
    const manufacturer = config.manufacturer ? String(config.manufacturer).trim() : undefined;
    
    const match = HID.devices().find(d =>
      d.vendorId === vid &&
      d.productId === pid &&
      (iface == null || d.interface === iface) &&
      (!manufacturer || (d.manufacturer && d.manufacturer.toLowerCase().includes(manufacturer.toLowerCase())))
    );
    if (!match || !match.path) {
      const errorDetails = manufacturer 
        ? '(VID/PID/interface/manufacturer)' 
        : '(VID/PID/interface)';
      throw new Error('HID device not found ' + errorDetails + '.');
    }
    return match;
  }

  // Helper function to open HID device by path or VID/PID
  function openHid(config) {
    const deviceInfo = getDeviceDetails(config);
    return new HID.HID(deviceInfo.path);
  }

  function HIDConfigNode(n) {
    RED.nodes.createNode(this, n);
    this.vid = n.vid;
    this.pid = n.pid;
    this.interface = n.interface;
    this.path = n.path;
    // console.log(this.vid);
  }

  function usbHIDNode(config) {
    RED.nodes.createNode(this, config);

    this.server = RED.nodes.getNode(config.connection);
    if (!this.server) {
      this.error("No HID configuration found");
      return;
    }

    var node = this;
    var device = null;
    var reconnectTimer = null;
    var backoffDelay = 250; // Start with 250ms
    var maxBackoffDelay = 5000; // Max 5 seconds
    var deviceCheckInterval = null;
    var lastDeviceState = null;

    // Helper function to send status updates
    function sendStatus(status) {
        node.status(status);
        
        const msg = {
            topic: "status",
            payload: status,
            timestamp: new Date().getTime()
        };
        
        // Use setImmediate to ensure the message is sent outside the current execution context
        setImmediate(() => {
            try {
                node.send([null, null, msg]);
                node.log(`Sent status message: ${status.text}`);
            } catch (e) {
                node.error("Error sending status message: " + e.toString());
            }
        });
    }

    // Initialize all outputs
    node.on("input", function(msg, send, done) {
        // Ensure send exists (for backwards compatibility)
        send = send || function() { node.send.apply(node, arguments); };
        // Process message here
        done();
    });

    function connect() {
      try {
        // Get device details before connecting
        const deviceInfo = getDeviceDetails(node.server);
        device = openHid(node.server);
        node.log("HID device opened successfully");
        
        // Reset backoff on successful connection
        backoffDelay = 250;
        
        // After successful setup, send connected status with device info
        const deviceName = deviceInfo.product || `VID:${deviceInfo.vendorId} PID:${deviceInfo.productId}`;
        const devicePath = deviceInfo.path ? ` (${deviceInfo.path})` : '';
        sendStatus({
            fill: "green",
            shape: "dot",
            text: `connected to ${deviceName}${devicePath}`,
            device: {
                product: deviceInfo.product,
                vendorId: deviceInfo.vendorId,
                productId: deviceInfo.productId,
                path: deviceInfo.path,
                serialNumber: deviceInfo.serialNumber,
                interface: deviceInfo.interface
            }
        });
        
        // Set up event handlers after successful connection
        device.on("data", function(data) {
          var message = {
            payload: data
          };
          node.send([message, null, null]);
        });

        // Handle device errors
        device.on("error", function(err) {
          node.error("HID device error: " + err.toString());
          var message = {
            payload: err
          };
          node.send([null, message, null]);
          
          // Attempt reconnect
          scheduleReconnect();
        });

      } catch (err) {
        node.error("Failed to connect to HID device: " + err.toString());
        // Send disconnected status
        sendStatus({
            fill: "red",
            shape: "ring",
            text: "disconnected"
        });
        
        scheduleReconnect();
      }
    }

    function scheduleReconnect() {
      if (device) {
        try {
          device.close();
        } catch (e) {
          // Ignore close errors
        }
        device = null;
      }
      
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      
      // Send reconnecting status
      sendStatus({
          fill: "yellow",
          shape: "ring", 
          text: "reconnecting in " + (backoffDelay/1000).toFixed(1) + "s"
      });
      
      reconnectTimer = setTimeout(function() {
        reconnectTimer = null;
        connect();
      }, backoffDelay);
      
      // Exponential backoff
      backoffDelay = Math.min(backoffDelay * 2, maxBackoffDelay);
    }

    this.on('input', function(msg) {
      if (!device) {
        node.error("HID device not connected");
        return;
      }

      var data;
      if (Buffer.isBuffer(msg.payload)) {
        data = Array.from(msg.payload);
      } else if (Array.isArray(msg.payload)) {
        data = msg.payload;
      } else {
        node.error("msg.payload must be Buffer or Array");
        return;
      }

      try {
        device.write(data);
      } catch (err) {
        node.error("Failed to write to HID device: " + err.toString());
        scheduleReconnect();
      }
    });

    this.on('close', function() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (device) {
        try {
          device.close();
        } catch (e) {
          // Ignore close errors
        }
        device = null;
      }
    });

    // Check for device presence/absence
    function checkDevicePresence() {
      try {
        const currentDevice = getDeviceDetails(node.server);
        const deviceState = JSON.stringify(currentDevice);
        
        if (lastDeviceState === null) {
          // First check, store initial state
          lastDeviceState = deviceState;
        } else if (deviceState !== lastDeviceState) {
          // Device state changed
          if (!device) {
            // If we're not connected, try to connect
            connect();
          } else {
            // If we are connected but device changed, reconnect
            scheduleReconnect();
          }
          lastDeviceState = deviceState;
        }
      } catch (err) {
        // Device not found
        if (lastDeviceState !== null) {
          // Only trigger disconnect if we previously had a device
          if (device) {
            node.error("Device disconnected: " + err.toString());
            scheduleReconnect();
          }
          lastDeviceState = null;
        }
      }
    }

    // Start device monitoring
    deviceCheckInterval = setInterval(checkDevicePresence, 1000);

    // Initial connection attempt
    connect();

    // Clean up interval on node close
    this.on('close', function(done) {
      if (deviceCheckInterval) {
        clearInterval(deviceCheckInterval);
        deviceCheckInterval = null;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (device) {
        try {
          device.close();
        } catch (e) {
          // Ignore close errors
        }
        device = null;
      }
      done();
    });
  }


  function toArray(buffer) {
    var view = [];
    for (var i = 0; i < buffer.length; ++i) {
      view.push(buffer[i]);
    }
    return view;
  }


  function getHIDNode(config) {
    RED.nodes.createNode(this, config);

    var node = this;
    this.on('input', function(msg) {

      var devices = HID.devices();
      msg.payload = devices;
      node.send(msg);

    });
  }


  RED.nodes.registerType("gethiddevices-p", getHIDNode);
  RED.nodes.registerType("hiddevice-p", usbHIDNode);
  RED.nodes.registerType('hidconfig-p', HIDConfigNode);
}