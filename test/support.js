const { EventEmitter } = require('events');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const info = {
  path: '/dev/hidraw0', vendorId: 1234, productId: 5678,
  interface: 0, manufacturer: 'Example Devices', product: 'Keypad', serialNumber: 'ABC123'
};
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function device() {
  const result = new EventEmitter();
  result.write = sinon.stub().resolves(1);
  result.close = sinon.stub().callsFake(async () => result.removeAllListeners());
  return result;
}
function mockHID() {
  return {
    devicesAsync: sinon.stub().resolves([Object.assign({}, info)]),
    HIDAsync: { open: sinon.stub().callsFake(async () => device()) },
    // Any accidental use of the synchronous API must fail, without loading hardware.
    HID: sinon.stub().throws(new Error('Synchronous HID API used')),
    devices: sinon.stub().throws(new Error('Synchronous enumeration used'))
  };
}
function load(HID, readlink = sinon.stub().rejects(new Error('not a symlink'))) {
  return proxyquire('../usbhid/usbhid', { 'node-hid': HID, fs: { promises: { readlink } } });
}
async function flush() {
  for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
}
function harness(HID, config = { path: info.path }, readlink) {
  const types = {};
  const RED = {
    httpAdmin: { get: sinon.spy() },
    nodes: {
      registerType: (name, type) => { types[name] = type; },
      getNode: () => config,
      createNode: node => {
        const events = new EventEmitter();
        node.on = events.on.bind(events);
        node.emit = events.emit.bind(events);
        node.listenerCount = events.listenerCount.bind(events);
        for (const method of ['send', 'status', 'log', 'error']) node[method] = sinon.spy();
      }
    }
  };
  load(HID, readlink)(RED);
  return { node: new types['hiddevice-p']({ connection: 'config' }), types, RED };
}
function close(node) {
  return new Promise((resolve, reject) => node.emit('close', false, err => err ? reject(err) : resolve()));
}
module.exports = { info, deferred, device, mockHID, load, flush, harness, close };
