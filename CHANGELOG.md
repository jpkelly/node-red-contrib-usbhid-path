# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2025-11-06

### Added
- Manufacturer filtering capability
  - New manufacturer field in device configuration
  - Filter devices by manufacturer name (case-insensitive)
  - Auto-population of manufacturer field when selecting a device
- Hot-plug detection
  - Automatic detection of device connection/disconnection
  - Periodic device presence checking (every 1 second)
  - Automatic reconnection when device becomes available
  - Enhanced status messages for connection state changes
- Enhanced device selection UI
  - Auto-population of all fields when selecting a device
  - Improved device information display in dropdown

### Changed
- Enhanced error messages to include more specific details
- Improved device reconnection logic with state tracking

## [1.2.0] - 2025
- Added detailed device information to status messages
- Added connection status LED indicator support

## [1.1.0] - 2025
- Enhanced USB HID node with path-based device selection

## [1.0.0] - 2025
- Initial release
- Basic USB HID functionality for Node-RED