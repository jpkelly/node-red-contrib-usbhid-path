# node-red-contrib-usbhid-path

A fork of node-red-contrib-usbhid that adds path-based device selection support. This enhancement is particularly useful when working with multiple identical devices that share the same VID/PID.

## Credits
This package is based on [node-red-contrib-usbhid](https://github.com/gdziuba/node-red-contrib-usbhid) by [@gdziuba](https://github.com/gdziuba). The original package provided the foundation for USB HID communication in Node-RED, and this fork adds path-based device selection capabilities while maintaining compatibility with the original package.

### Acknowledgments
- Original package by [@gdziuba](https://github.com/gdziuba)
- Uses [node-hid](https://github.com/node-hid/node-hid) for USB HID communication

## Features

- All the features of the original package
- Path-based device selection support
- Non-conflicting node names (uses -p suffix)
- Device picker in configuration node

## Node Types

This package provides three nodes with -p suffix to avoid conflicts with the original package:

1. `hidconfig-p` - Configuration node with path-based device selection
   - Configure by VID/PID or device path
   - Built-in device picker shows available devices
   - Shows device paths for easy identification

2. `gethiddevices-p` - List available HID devices
   - Lists all connected USB HID devices
   - Includes device paths in the output
   - Useful for device discovery

3. `hiddevice-p` - Communicate with HID devices
   - Send and receive data from HID devices
   - Auto-reconnect on device disconnect
   - Three outputs:
     - Output 1: Data received from device
     - Output 2: Error messages
     - Output 3: Connection status updates

## Prerequisites

* [Node.js](https://nodejs.org/) v0.8 - v4.x+
* Mac OS X 10.8, Linux (kernel 2.6+), and Windows XP+
* libudev-dev, libusb-1.0-0-dev (if Linux, see Compile below)
* [git](https://git-scm.com/)

node-hid uses node-pre-gyp to store pre-built binary bundles, so usually no compiler is needed to install.

Platforms we pre-build binaries for:
- Mac OS X x64: v0.10, v0.12, v4.2.x
- Windows x64 & x86: v0.10, v0.12, v4.2.x
- Linux Debian/Ubuntu x64: v4.2.x
- Raspberry Pi arm: v4.2.x

## Installation

### From Source
```bash
cd ~/.node-red/node-modules
git clone https://github.com/jpkelly/node-red-contrib-usbhid-path.git
cd node-red-contrib-usbhid-path
npm install
```

### Linux USB Permissions
For Linux systems, you need to set up proper USB permissions:

1. Install required libraries:
```bash
sudo apt install libusb-1.0-0 libusb-1.0-0-dev libudev-dev
```

2. Create udev rules:
```bash
sudo mkdir -p /etc/udev/rules.d
sudo nano /etc/udev/rules.d/85-pure-data.rules
```

3. Add the following rules (update KERNEL for your device):
```
SUBSYSTEM=="input", GROUP="input", MODE="0777"
SUBSYSTEM=="usb", MODE:="777", GROUP="input"
KERNEL=="hidraw*", MODE="0777", GROUP="input"
```

4. Set up input group:
```bash
sudo groupadd -f input
sudo gpasswd -a $USER input
```

5. Reload rules and reboot:
```bash
sudo udevadm control --reload-rules
sudo reboot
```

## Usage

1. Add a `hidconfig-p` node to configure your device:
   - Enter VID/PID, or
   - Use the device picker to select by path
   - (Optional) Set interface number if needed

2. Use `gethiddevices-p` to list available devices:
   - Connect to an inject node to trigger
   - View device details in debug node

3. Use `hiddevice-p` to communicate:
   - Configure with a `hidconfig-p` node
   - Input: Buffer or Array payload
   - Output 1: Received data
   - Output 2: Errors

### Connection Status Output

The `hiddevice-p` node provides real-time connection status through its third output. The status message format is:

```javascript
{
    topic: "status",
    payload: {
        fill: "green" | "yellow" | "red",  // Status color
        shape: "dot" | "ring",            // Status shape
        text: "connected" | "disconnected" | "reconnecting in Xs"  // Status text
    },
    timestamp: 1234567890  // Timestamp of status change
}
```

Status indicators:
- 🟢 Green: Device connected and ready (includes device details)
- 🟡 Yellow: Attempting to reconnect
- 🟥 Red: Device disconnected

The connection status includes detailed device information in the payload:
```javascript
{
    topic: "status",
    payload: {
        fill: "green",
        shape: "dot",
        text: "connected to Barcode Scanner (/dev/hidraw0)",  // Human-readable status
        device: {
            product: "Barcode Scanner",      // Device name if available
            vendorId: 1234,                  // Vendor ID
            productId: 5678,                 // Product ID
            path: "/dev/hidraw0",           // Device path
            serialNumber: "ABC123",          // Serial number if available
            interface: 0                     // Interface number if applicable
        }
    },
    timestamp: 1234567890
}
```

### Example Flow: Status Display

Here's an example of how to use the connection status output with a UI LED and text display:

```json
[
    {
        "id": "015f81a5e59b3ab8",
        "type": "function",
        "name": "Parse Connection Status",
        "func": "// Log incoming message for debugging\nnode.log(\"Incoming message: \" + JSON.stringify(msg));\n\n// Get the status from the incoming message\nconst status = msg.payload;\n\nif (status && status.fill) {\n    // Create two separate messages\n    const ledMsg = { payload: 3 };  // Default to red\n    const textMsg = { payload: status.text };  // Use the actual status text\n\n    // Set LED color based on status\n    switch(status.fill) {\n        case \"green\":\n            ledMsg.payload = 1;  // Green\n            break;\n        case \"yellow\":\n            ledMsg.payload = 2;  // Yellow\n            break;\n        case \"red\":\n            ledMsg.payload = 3;  // Red\n            break;\n    }\n    \n    node.log(\"Setting LED state to: \" + ledMsg.payload);\n    node.log(\"Setting status text to: \" + textMsg.payload);\n\n    // Return array of messages [LED message, Text message]\n    return [ledMsg, textMsg];\n} else {\n    // Handle invalid status\n    return [{payload: 3}, {payload: \"Unknown status\"}];\n}",
        "outputs": 2,
        "noerr": 0
    }
]
```

To use this example:
1. Connect the third output of your `hiddevice-p` node to the function node
2. Add a FlowFuse Dashboard UI LED widget to the first output of the function
   - Configure LED colors: 1=Green, 2=Yellow, 3=Red
3. Add a FlowFuse Dashboard text widget to the second output
   - This will display the connection status text

### Example Flow
See the included `examples/getStarted.json` for a complete working example flow.

## Important Notes

- When using with input devices (keyboards, mice, etc.), be aware that the node may take exclusive control
- For system input devices, prefer using path-based selection to ensure you connect to the right device
- Multiple identical devices can be distinguished by their paths

For more information about node-hid, visit: https://github.com/node-hid/node-hid
