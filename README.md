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
   - Two outputs: data and errors

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

### Example Flow
See the included `examples/getStarted.json` for a working example flow.

## Important Notes

- When using with input devices (keyboards, mice, etc.), be aware that the node may take exclusive control
- For system input devices, prefer using path-based selection to ensure you connect to the right device
- Multiple identical devices can be distinguished by their paths

For more information about node-hid, visit: https://github.com/node-hid/node-hid
