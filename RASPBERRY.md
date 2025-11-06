# Installing on Raspberry Pi

This guide will help you install and configure the USB HID nodes on a Raspberry Pi running Node-RED.

## Prerequisites

1. A Raspberry Pi running Node-RED (typically installed via Node-RED Pi script)
2. SSH access to your Raspberry Pi or direct terminal access
3. sudo privileges

## Installation Steps

### 1. Install Required Libraries

```bash
# Update package list
sudo apt-get update

# Install USB libraries
sudo apt-get install -y libusb-1.0-0 libusb-1.0-0-dev libudev-dev
```

### 2. Set Up USB Permissions

1. Create or edit the udev rules file:
```bash
sudo nano /etc/udev/rules.d/85-hid.rules
```

2. Add these rules to the file:
```
SUBSYSTEM=="input", GROUP="input", MODE="0777"
SUBSYSTEM=="usb", MODE:="777", GROUP="input"
KERNEL=="hidraw*", MODE="0777", GROUP="input"
```

3. Add your user (typically 'pi') to the input group:
```bash
sudo groupadd -f input
sudo usermod -a -G input $USER
# or specifically for pi user:
sudo usermod -a -G input pi
```

4. Reload udev rules:
```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
```

### 3. Install the Node

1. Navigate to your Node-RED user directory:
```bash
cd ~/.node-red
```

2. Install the package:
```bash
npm install @jpkelly/node-red-usbhid
```

Or install from git:
```bash
cd ~/.node-red
git clone https://github.com/jpkelly/node-red-contrib-usbhid-path.git
cd node-red-contrib-usbhid-path
npm install
cd ..
npm install ./node-red-contrib-usbhid-path
```

### 4. Restart Node-RED

```bash
# If using the Pi service:
sudo systemctl restart nodered

# Or if running standalone:
node-red-stop
node-red-start
```

## Testing the Installation

1. Open Node-RED in your browser (typically `http://[raspberry-pi-ip]:1880`)
2. Check the palette - you should see three new nodes:
   - `hidconfig-p`
   - `gethiddevices-p`
   - `hiddevice-p`

3. Create a test flow:
   - Add an inject node
   - Connect it to a `gethiddevices-p` node
   - Connect to a debug node
   - Deploy and trigger the inject node
   - You should see a list of connected USB HID devices

## Troubleshooting

### Permission Issues
If you see "Permission denied" errors:
1. Verify your udev rules are correctly set:
```bash
ls -l /dev/hidraw*
```
Should show permissions like: `crw-rw-rw-`

2. Check your group membership:
```bash
groups $USER
```
Should include 'input' group

3. Try rebooting if changes don't take effect:
```bash
sudo reboot
```

### Node-RED Can't Find Devices
1. Check if devices are detected by the system:
```bash
ls -l /dev/hidraw*
```

2. Test device access manually:
```bash
sudo apt-get install usb-utils
lsusb
```

3. Check Node-RED logs:
```bash
sudo journalctl -u nodered -f
```

### Module Not Loading
1. Check Node-RED settings:
```bash
cat ~/.node-red/settings.js
```
Ensure no modules are blacklisted

2. Check npm installation:
```bash
cd ~/.node-red
npm list @jpkelly/node-red-usbhid
```

## Support

If you encounter issues:
1. Check the device permissions
2. Verify the udev rules are correct
3. Try rebooting the Raspberry Pi
4. Check Node-RED logs for errors
5. Create an issue on the GitHub repository with:
   - Your Raspberry Pi model
   - Node-RED version
   - Full error message
   - Steps to reproduce the issue