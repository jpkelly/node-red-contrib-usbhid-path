console.log("✅ Loaded @jpkelly/node-red-usbhid (local dev mode)");
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
        serialNumber: d.serialNumber
      }));
      res.json(devs);
    } catch(e) {
      res.json([]);
    }
  });

  // Helper function to open HID device by path or VID/PID
  function openHid(config) {
    if (config.path && String(config.path).trim()) {
      return new HID.HID(String(config.path).trim());
    }
    const vid = parseInt(config.vid);
    const pid = parseInt(config.pid);
    const iface = (config.interface !== "" && config.interface !== undefined)
        ? parseInt(config.interface) : undefined;
    const match = HID.devices().find(d =>
      d.vendorId === vid &&
      d.productId === pid &&
      (iface == null || d.interface === iface)
    );
    if (!match || !match.path) throw new Error('HID device not found (VID/PID/interface).');
    return new HID.HID(match.path);
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

    function connect() {
      try {
        device = openHid(node.server);
        node.log("HID device opened successfully");
        
        // Reset backoff on successful connection
        backoffDelay = 250;
        
        // Set up event handlers first
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
        
        // After successful setup, send connected status
        const status = {
          fill: "green",
          shape: "dot",
          text: "connected"
        };
        
        // Update node status
        node.status(status);
        node.log("Setting connected status");
        
        // Send status message on third output
        const msg = { payload: status };
        node.send([null, null, msg]);
        node.log("Sent connected status message");
        
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
        // Create status update
        const status = {
          fill: "red",
          shape: "ring",
          text: "disconnected"
        };
        
        // Update node status
        node.status(status);
        
        // Send status message on third output
        const msg = { payload: status };
        node.send([null, null, msg]);
        
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
      
      // Create status update
      const status = {
        fill: "yellow",
        shape: "ring", 
        text: "reconnecting in " + (backoffDelay/1000).toFixed(1) + "s"
      };
      
      // Update node status
      node.status(status);
      
      // Send status message on third output
      const msg = { payload: status };
      node.send([null, null, msg]);
      
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

    // Initial connection attempt
    connect();
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