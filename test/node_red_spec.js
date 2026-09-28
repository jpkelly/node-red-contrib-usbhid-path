const assert = require('assert');
const helper = require('node-red-node-test-helper');
const completeNode = require('@node-red/nodes/core/common/24-complete');
const catchNode = require('@node-red/nodes/core/common/25-catch');
const { info, deferred, device, mockHID, load, flush } = require('./support');

helper.init(require.resolve('node-red'));

function flow(config = {}) {
  return [
    Object.assign({ id: 'config', type: 'hidconfig-p', name: 'Existing keypad',
      vid: '1234', pid: '5678', interface: '0', manufacturer: '', path: '' }, config),
    { id: 'hid', type: 'hiddevice-p', name: 'Mitti keypad', connection: 'config', wires: [['data'], ['errors'], ['status']] },
    { id: 'data', type: 'helper' }, { id: 'errors', type: 'helper' }, { id: 'status', type: 'helper' },
    { id: 'complete', type: 'complete', scope: ['hid'], wires: [['completed']] },
    { id: 'completed', type: 'helper' },
    { id: 'catch-errors', type: 'catch', scope: ['hid'], uncaught: false, wires: [['caught']] },
    { id: 'caught', type: 'helper' }
  ].map(n => n.type === 'hidconfig-p' ? n : Object.assign({ z: 'test-tab', x: 100, y: 100 }, n))
    .concat({ id: 'test-tab', type: 'tab', label: 'Isolated test flow' });
}
function collect(id) {
  const messages = [];
  helper.getNode(id).on('input', msg => messages.push(msg));
  return messages;
}

describe('Node-RED runtime integration (mocked hardware)', function() {
  let HID;
  beforeEach(function(done) { HID = mockHID(); helper.startServer(done); });
  afterEach(async function() {
    await helper.unload();
    await new Promise(resolve => helper.stopServer(resolve));
  });
  async function loadFlow(config, extra = []) {
    await helper.load([load(HID), completeNode, catchNode], flow(config).concat(extra));
  }

  it('loads existing config fields unchanged and preserves all three output formats', async function() {
    const opening = deferred(), d = device();
    HID.HIDAsync.open.returns(opening.promise);
    await loadFlow({ manufacturer: 'EXAMPLE', path: '  ' + info.path + '  ' });
    const cfg = helper.getNode('config');
    for (const [key, value] of Object.entries({ vid: '1234', pid: '5678', interface: '0', manufacturer: 'EXAMPLE', path: '  ' + info.path + '  ' })) {
      assert.strictEqual(cfg[key], value);
    }
    const data = collect('data'), errors = collect('errors'), status = collect('status');
    opening.resolve(d);
    await flush();
    assert.strictEqual(status.length, 1);
    assert.strictEqual(status[0].topic, 'status');
    assert.strictEqual(typeof status[0].timestamp, 'number');
    assert.deepStrictEqual(status[0].payload, {
      fill: 'green', shape: 'dot', text: 'connected to Keypad (/dev/hidraw0)',
      device: { product: 'Keypad', vendorId: 1234, productId: 5678, path: info.path, serialNumber: 'ABC123', interface: 0 }
    });
    d.emit('data', Buffer.from([1, 2, 3]));
    await flush();
    assert.strictEqual(data.length, 1);
    assert.deepStrictEqual(data[0].payload, Buffer.from([1, 2, 3]));
    d.emit('error', new Error('disconnected'));
    await flush();
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].payload.message, 'disconnected');
    assert.deepStrictEqual(status.slice(1).map(m => m.payload.text), ['disconnected', 'reconnecting in 0.3s']);
  });

  it('completes each actual runtime input once, only after its write settles', async function() {
    await loadFlow();
    await flush();
    const d = await HID.HIDAsync.open.firstCall.returnValue, writing = deferred();
    d.write.onFirstCall().returns(writing.promise);
    const completed = collect('completed');
    helper.getNode('hid').receive({ payload: Buffer.from([0, 1]), topic: 'first' });
    helper.getNode('hid').receive({ payload: [0, 2], topic: 'second' });
    await flush();
    assert.strictEqual(completed.length, 0);
    assert.strictEqual(d.write.callCount, 1);
    writing.resolve(2);
    await flush();
    assert.deepStrictEqual(d.write.args, [[[0, 1]], [[0, 2]]]);
    assert.deepStrictEqual(completed.map(m => m.topic), ['first', 'second']);
  });


  it('routes a failed write to output two and Catch exactly once', async function() {
    await loadFlow();
    await flush();
    const d = await HID.HIDAsync.open.firstCall.returnValue;
    d.write.rejects(new Error('write failed'));
    const errors = collect('errors'), caught = collect('caught'), completed = collect('completed');
    helper.getNode('hid').receive({ payload: [0], topic: 'failed input' });
    await flush();
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].payload.message, 'write failed');
    assert.strictEqual(caught.length, 1);
    assert.match(caught[0].error.message, /write failed/);
    assert.strictEqual(caught[0].topic, 'failed input');
    assert.strictEqual(completed.length, 0);
  });

  it('awaits an opening handle and its native close before actual unload completes', async function() {
    const opening = deferred(), closing = deferred(), d = device();
    HID.HIDAsync.open.returns(opening.promise);
    d.close.returns(closing.promise);
    await loadFlow();
    await flush();
    let unloaded = false;
    const unloading = helper.unload().then(() => { unloaded = true; });
    await flush();
    assert.strictEqual(unloaded, false);
    opening.resolve(d);
    await flush();
    assert.strictEqual(d.close.callCount, 1);
    assert.strictEqual(unloaded, false);
    closing.resolve();
    await unloading;
  });

  it('awaits writes on actual unload and suppresses late device callbacks', async function() {
    await loadFlow();
    await flush();
    const d = await HID.HIDAsync.open.firstCall.returnValue;
    const data = d.listeners('data')[0], error = d.listeners('error')[0];
    const received = collect('data'), statuses = collect('status');
    const writing = deferred(), closing = deferred();
    d.write.returns(writing.promise);
    d.close.returns(closing.promise);
    helper.getNode('hid').receive({ payload: [0] });
    await flush();
    let unloaded = false;
    const unloading = helper.unload().then(() => { unloaded = true; });
    await flush();
    data(Buffer.from([1])); error(new Error('late callback'));
    assert.strictEqual(d.close.callCount, 0);
    writing.resolve(1);
    await flush();
    assert.strictEqual(d.close.callCount, 1);
    assert.strictEqual(unloaded, false);
    closing.resolve();
    await unloading;
    assert.strictEqual(received.length, 0);
    assert.strictEqual(statuses.length, 0);
  });

  it('can repeatedly load and unload without leaving old handles active', async function() {
    for (let i = 0; i < 5; i++) {
      await loadFlow();
      await flush();
      const d = await HID.HIDAsync.open.getCall(i).returnValue;
      assert.strictEqual(d.listenerCount('data'), 1);
      await helper.unload();
      assert.strictEqual(d.close.callCount, 1);
      assert.strictEqual(d.listenerCount('data'), 0);
      assert.strictEqual(d.listenerCount('error'), 0);
    }
    assert.strictEqual(HID.HIDAsync.open.callCount, 5);
  });

  it('applies manufacturer/interface filters from a loaded configuration node', async function() {
    HID.devicesAsync.resolves([
      Object.assign({}, info, { path: '/wrong-maker', manufacturer: 'Other' }),
      Object.assign({}, info, { path: '/wrong-interface', interface: 1 }), info
    ]);
    await loadFlow({ manufacturer: 'Example' });
    await flush();
    assert.deepStrictEqual(HID.HIDAsync.open.firstCall.args, [info.path]);
  });

  it('keeps gethiddevices-p message fields and the editor enumeration response', async function() {
    await loadFlow({}, [
      { id: 'list', type: 'gethiddevices-p', wires: [['listed']] }, { id: 'listed', type: 'helper' }
    ]);
    const listed = collect('listed');
    helper.getNode('list').receive({ topic: 'discovery', custom: 42 });
    await flush();
    assert.strictEqual(listed.length, 1);
    assert.strictEqual(listed[0].topic, 'discovery');
    assert.strictEqual(listed[0].custom, 42);
    assert.deepStrictEqual(listed[0].payload, [info]);
    const response = await helper.request().get('/usbhid/devices').expect(200);
    assert.deepStrictEqual(response.body, [info]);
    HID.devicesAsync.rejects(new Error('enumeration failed'));
    const failure = await helper.request().get('/usbhid/devices').expect(200);
    assert.deepStrictEqual(failure.body, []);
  });

  it('awaits discovery on unload and does not send its late result', async function() {
    await loadFlow({}, [
      { id: 'list', type: 'gethiddevices-p', wires: [['listed']] }, { id: 'listed', type: 'helper' }
    ]);
    await flush();
    const listing = deferred(), listed = collect('listed');
    HID.devicesAsync.returns(listing.promise);
    helper.getNode('list').receive({ payload: 'list' });
    await flush();
    let unloaded = false;
    const unloading = helper.unload().then(() => { unloaded = true; });
    await flush();
    assert.strictEqual(unloaded, false);
    listing.resolve([info]);
    await unloading;
    assert.strictEqual(listed.length, 0);
  });
});
