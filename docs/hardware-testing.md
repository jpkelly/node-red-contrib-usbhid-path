# Isolated HID lifecycle hardware checks

These checks have **not been performed** as part of the automated tests. Mocked tests cannot demonstrate that native crashes are eliminated on a Raspberry Pi 5.

## Preconditions and isolation

- Obtain explicit authorization before accessing the physical keypad, disconnecting it, or stopping any production service. This procedure itself grants no authorization. Prefer a spare Pi/keypad on a separate test host.
- The test runtime must have exclusive access to the device. A second Node-RED user directory/port isolates flows but does **not** isolate the HID handle. Do not run against a keypad still owned by production Node-RED, Mitti, another HID node, or another process. If exclusive access needs a production shutdown, arrange that as a separately approved maintenance step; there are no production stop commands here.
- Use Node.js 18.20.4, Node-RED 4.1.0 and node-hid 3.1.0 for the first Pi 5 run. Record architecture, OS/kernel, backend (normally hidraw), VID/PID, interface, manufacturer, serial number, physical path and symlink target. Do not change production permissions or configuration.
- Use an unused local port (1889 below). Never import production flows, credentials or dashboards. All three outputs must connect only to Debug nodes; no OSC, MIDI, MQTT, HTTP, dashboard or show-control destinations.

## Prepare a disposable runtime

Perform these commands only on the authorized test host, in a checkout of the PR branch. They install solely into a new temporary directory. They do not install into the production user directory or global modules.

```sh
HID_REPO=$(pwd)
HID_TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/hid-lifecycle.XXXXXX")
# Package the checkout without publishing anything.
npm pack --ignore-scripts --pack-destination "$HID_TEST_DIR"
cd "$HID_TEST_DIR"
npm init -y
npm install --save-exact node-red@4.1.0 node-hid@3.1.0 ./node-red-contrib-usbhid-path-*.tgz
node --version
npm ls node-red node-hid node-red-contrib-usbhid-path
mkdir user
cat > user/settings.js <<'SETTINGS'
module.exports = {
  uiHost: '127.0.0.1',
  uiPort: 1889,
  flowFile: 'diagnostic-flows.json',
  logging: { console: { level: 'debug', metrics: false, audit: false } }
};
SETTINGS
node ./node_modules/node-red/red.js --userDir "$HID_TEST_DIR/user" \
  --settings "$HID_TEST_DIR/user/settings.js" --port 1889 \
  > "$HID_TEST_DIR/runtime.log" 2>&1 &
HID_TEST_PID=$!
printf 'Test directory: %s\nTest process: %s\n' "$HID_TEST_DIR" "$HID_TEST_PID"
```

Use the test host's loopback editor at `http://127.0.0.1:1889` (or an explicitly chosen SSH tunnel). Verify the editor port and user directory before editing. Create one diagnostic flow: one `hidconfig-p`, one `hiddevice-p`, and three Debug nodes showing complete messages, one per output. Record the repository commit (`git -C "$HID_REPO" rev-parse HEAD`) with the log.

For write tests, add a **manual** Inject node with a device-documented, harmless output report. Include the correct report ID as byte zero. A Function node can convert that same known-safe array to `Buffer.from(msg.payload)` for the Buffer case. Do not invent report bytes, send commands with unknown effects, or auto-repeat writes without a bounded test plan.

## Test cases and acceptance criteria

1. **Selection and output compatibility:** test the existing path, its symlink, and VID/PID with optional interface/manufacturer fields. Path must override the other selectors; manufacturer filtering must be case-insensitive. Confirm one data message per device report (a key can legitimately produce separate press/release reports). Confirm error output `{payload: Error}` and status `{topic: 'status', payload: {fill, shape, text, device?}, timestamp}`. Check all connected-device fields against enumeration.
2. **Idle reader and redeploy:** with no keys pressed, perform at least 100 stop/start or full-deploy cycles in the disposable editor, including quick successive cycles. Repeat while generating continuous reports. Each stopped node must release its handle; startup must establish one reader. Look for duplicate data, messages from retired nodes, hanging shutdowns, growing resource use, invalid-pointer errors and SIGSEGV.
3. **Opening/shutdown:** repeat starting the test runtime and quickly sending SIGINT to its recorded PID, including when the device is missing and when present. Confirm no reconnect appears after shutdown begins and the process exits cleanly. Never use process-name-wide kill commands.
4. **Writes/shutdown:** use only the approved harmless report in both Array and Buffer form. Trigger writes while redeploying/stopping the test flow. Verify no duplicate reports, unhandled rejections or close-over-write failures. Connect a Complete node and a Catch node to diagnostic Debug outputs if needed to check one completion per input.
5. **Missing device/open failure:** use an intentionally nonexistent path first; observe bounded retries (250 ms through 5 seconds). Test an unavailable device or an open permission failure only in this disposable environment. Restore a valid selection and verify recovery.
6. **Disconnect/reconnect:** unplug/replug only the authorized test device while idle, receiving data, and writing the approved report. Repeat at least 50 times, including unplug immediately before deploy and replug during the backoff window. Verify at most one active reader, a disconnected/reconnecting status sequence, eventual recovery, and no retry after stopping the node.
7. **Longer soak:** run diagnostic-only reading for at least 30 minutes with periodic authorized redeploys and hot-plugs. Capture elapsed time, report counts, process memory/file-descriptor trends and all errors. On Linux, `lsof -p "$HID_TEST_PID"` or `/proc/$HID_TEST_PID/fd` can help check handle growth; do not treat a successful mock test as evidence of native handle cleanup.

Stop only the disposable process using its recorded PID, wait for clean exit, and retain the log and diagnostic flow as test evidence:

```sh
kill -INT "$HID_TEST_PID"
wait "$HID_TEST_PID"
```

A hung native operation or a Node-RED shutdown-timeout warning is a failure, even if the process eventually exits. If a native crash recurs, preserve the core/backtrace and runtime versions, and record whether it occurred during open, idle read, write, disconnect, redeploy or process exit. The earlier trace in synchronous `hid_read_timeout` identifies a failing area, not proof that all crashes share one cause.

Record each test as passed/failed/not run, cycle counts, native crash evidence, and whether exclusive access was verified. Hardware success does not authorize merging, publishing, deploying or modifying production; those remain separate steps.
