const assert = require('assert');
const sinon = require('sinon');
const { info, deferred, device, mockHID, flush, harness, close } = require('./support');

describe('HID lifecycle (mocked hardware)', function() {
  let clock, HID, node;
  beforeEach(function() {
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    HID = mockHID();
  });
  afterEach(async function() {
    if (node) await close(node).catch(() => {});
    clock.restore();
    node = null;
  });
  async function start(config, readlink) {
    node = harness(HID, config, readlink).node;
    await flush();
    return HID.HIDAsync.open.firstCall && await HID.HIDAsync.open.firstCall.returnValue;
  }
  async function tick(ms) { await clock.tickAsync(ms); await flush(); }
  function input(payload) {
    const done = sinon.spy();
    node.emit('input', { payload }, undefined, done);
    return done;
  }
  function statuses() { return node.send.args.map(([m]) => m[2]).filter(Boolean); }

  for (const nativeString of [true, false]) {
    it('reports native disconnects as Error objects ' + (nativeString ? 'from strings' : 'without replacing existing errors'), async function() {
      const d = await start();
      const message = 'could not read from HID device';
      const failure = nativeString ? message : Object.assign(new Error(message), { code: 'EIO' });
      const oldError = d.listeners('error')[0];
      d.emit('error', failure);
      oldError(failure); // A duplicate callback must not publish another error.
      await flush();
      const errors = node.send.args.map(([m]) => m[1]).filter(Boolean);
      assert.strictEqual(errors.length, 1);
      assert(errors[0].payload instanceof Error);
      assert.strictEqual(errors[0].payload.message, message);
      if (!nativeString) {
        assert.strictEqual(errors[0].payload, failure);
        assert.strictEqual(errors[0].payload.code, 'EIO');
      }
      assert.strictEqual(d.close.callCount, 1);
      await tick(250);
      assert.strictEqual(HID.HIDAsync.open.callCount, 2);
      const sends = node.send.callCount;
      oldError(failure);
      assert.strictEqual(node.send.callCount, sends);
    });
  }

  it('has one input/close handler, preserves Buffer/Array writes and completes each once', async function() {
    const d = await start();
    assert.strictEqual(node.listenerCount('input'), 1);
    assert.strictEqual(node.listenerCount('close'), 1);
    const a = input(Buffer.from([0, 1]));
    const b = input([0, 2]);
    await flush();
    assert.deepStrictEqual(d.write.args, [[[0, 1]], [[0, 2]]]);
    for (const done of [a, b]) { assert.strictEqual(done.callCount, 1); assert.deepStrictEqual(done.firstCall.args, []); }
    node.emit('input', { payload: [0, 3] }); // Older calling convention has no done.
    await flush();
    assert.strictEqual(d.write.callCount, 3);
  });

  it('retries missing devices with bounded backoff and resets after success', async function() {
    HID.devicesAsync.resolves([]);
    await start();
    assert.strictEqual(HID.HIDAsync.open.callCount, 0);
    assert.strictEqual(statuses()[0].payload.text, 'disconnected');
    for (const delay of [250, 500, 1000, 2000, 4000, 5000, 5000]) await tick(delay);
    const attempts = HID.devicesAsync.callCount;
    assert.strictEqual(attempts, 8);
    HID.devicesAsync.resolves([info]);
    await tick(5000);
    assert.strictEqual(HID.HIDAsync.open.callCount, 1);
    const d = await HID.HIDAsync.open.firstCall.returnValue;
    d.emit('error', new Error('unplugged'));
    await flush();
    assert.strictEqual(statuses().slice(-1)[0].payload.text, 'reconnecting in 0.3s');
  });

  it('reports failed opens and reconnects without leaking a handle', async function() {
    HID.HIDAsync.open.onFirstCall().rejects(new Error('open failed'));
    node = harness(HID).node;
    await flush();
    assert(node.send.args.some(([m]) => m[1] && m[1].payload.message === 'open failed'));
    await tick(250);
    assert.strictEqual(HID.HIDAsync.open.callCount, 2);
    await close(node);
    const d = await HID.HIDAsync.open.secondCall.returnValue;
    assert.strictEqual(d.close.callCount, 1);
  });

  it('serializes writes and waits for an in-flight write before closing', async function() {
    const d = await start();
    const writing = deferred(), closing = deferred();
    d.write.onFirstCall().returns(writing.promise);
    d.close.returns(closing.promise);
    const first = input([1]), second = input([2]);
    await flush();
    assert.strictEqual(d.write.callCount, 1);
    let closed = false;
    const shutdown = close(node).then(() => { closed = true; });
    await flush();
    assert.strictEqual(d.close.callCount, 0);
    writing.resolve(1);
    await flush();
    assert.strictEqual(first.callCount, 1);
    assert.strictEqual(second.callCount, 1);
    assert.match(second.firstCall.args[0].message, /closing/);
    assert.strictEqual(d.write.callCount, 1);
    assert.strictEqual(d.close.callCount, 1);
    assert.strictEqual(closed, false);
    closing.resolve();
    await shutdown;
    assert.strictEqual(clock.countTimers(), 0);
  });

  it('completes failed writes once, emits errors, and closes before retrying', async function() {
    const d = await start();
    const error = new Error('write failed'), closing = deferred();
    d.write.rejects(error);
    d.close.returns(closing.promise);
    const done = input([0]);
    await flush();
    assert.strictEqual(done.callCount, 1);
    assert.strictEqual(done.firstCall.args[0], error);
    assert(node.send.args.some(([m]) => m[1] && m[1].payload === error));
    await tick(5000);
    assert.strictEqual(HID.HIDAsync.open.callCount, 1);
    closing.resolve();
    await flush();
    await tick(250);
    assert.strictEqual(HID.HIDAsync.open.callCount, 2);
  });

  it('coalesces read errors and a concurrent presence check, ignoring stale callbacks', async function() {
    const d = await start(), enumeration = deferred(), closing = deferred();
    const oldData = d.listeners('data')[0], oldError = d.listeners('error')[0];
    HID.devicesAsync.returns(enumeration.promise);
    await tick(1000);
    d.close.returns(closing.promise);
    d.emit('error', new Error('read failed'));
    oldError(new Error('duplicate error'));
    enumeration.reject(new Error('device missing'));
    await flush();
    assert.strictEqual(d.close.callCount, 1);
    const sends = node.send.callCount;
    oldData(Buffer.from([9]));
    oldError(new Error('late error'));
    assert.strictEqual(node.send.callCount, sends);
    closing.resolve();
    HID.devicesAsync.resolves([info]);
    await flush();
    await tick(250);
    assert.strictEqual(HID.HIDAsync.open.callCount, 2);
    const newSends = node.send.callCount;
    oldData(Buffer.from([9]));
    oldError(new Error('old generation'));
    assert.strictEqual(node.send.callCount, newSends);
  });

  it('invalidates callbacks immediately and awaits native reader cleanup on shutdown', async function() {
    const d = await start(), readerStopped = deferred();
    const data = d.listeners('data')[0], error = d.listeners('error')[0];
    d.close.returns(readerStopped.promise);
    let closed = false;
    const shutdown = close(node).then(() => { closed = true; });
    const sends = node.send.callCount;
    data(Buffer.from([1])); error(new Error('late read'));
    await flush();
    assert.strictEqual(closed, false);
    assert.strictEqual(node.send.callCount, sends);
    readerStopped.resolve();
    await shutdown;
    await tick(10000);
    data(Buffer.from([2])); error(new Error('after close'));
    assert.strictEqual(node.send.callCount, sends);
    assert.strictEqual(HID.HIDAsync.open.callCount, 1);
    assert.strictEqual(clock.countTimers(), 0);
  });

  it('closes a late open result before completing shutdown, without publishing it', async function() {
    const opening = deferred(), closing = deferred(), d = device();
    HID.HIDAsync.open.returns(opening.promise);
    d.close.returns(closing.promise);
    node = harness(HID).node;
    await flush();
    let closed = false;
    const shutdown = close(node).then(() => { closed = true; });
    opening.resolve(d);
    await flush();
    assert.strictEqual(d.close.callCount, 1);
    assert.strictEqual(d.listenerCount('data'), 0);
    assert.strictEqual(node.send.callCount, 0);
    assert.strictEqual(closed, false);
    closing.resolve();
    await shutdown;
    assert.strictEqual(clock.countTimers(), 0);
  });

  it('does not open after enumeration finishes during shutdown', async function() {
    const enumeration = deferred();
    HID.devicesAsync.returns(enumeration.promise);
    node = harness(HID).node;
    await flush();
    const shutdown = close(node);
    enumeration.resolve([info]);
    await shutdown;
    assert.strictEqual(HID.HIDAsync.open.callCount, 0);
    assert.strictEqual(node.send.callCount, 0);
  });

  it('handles an open rejection after shutdown with no retry or late output', async function() {
    const opening = deferred();
    HID.HIDAsync.open.returns(opening.promise);
    node = harness(HID).node;
    await flush();
    const shutdown = close(node);
    opening.reject(new Error('open failed after shutdown'));
    await shutdown;
    assert.strictEqual(node.send.callCount, 0);
    assert.strictEqual(clock.countTimers(), 0);
  });

  it('handles a write rejection during shutdown without reconnecting', async function() {
    const d = await start(), writing = deferred();
    d.write.returns(writing.promise);
    const done = input([0]);
    await flush();
    const sends = node.send.callCount, shutdown = close(node);
    writing.reject(new Error('write failed during shutdown'));
    await shutdown;
    assert.strictEqual(done.callCount, 1);
    assert.match(done.firstCall.args[0].message, /write failed/);
    assert.strictEqual(node.send.callCount, sends);
    assert.strictEqual(d.close.callCount, 1);
    assert.strictEqual(clock.countTimers(), 0);
  });

  it('cancels a pending reconnect and supports repeated/legacy shutdown callbacks', async function() {
    const d = await start();
    d.emit('error', new Error('unplugged'));
    await flush();
    const done = sinon.spy();
    node.emit('close', done);
    await close(node);
    await tick(10000);
    assert.strictEqual(done.callCount, 1);
    assert.strictEqual(d.close.callCount, 1);
    assert.strictEqual(HID.HIDAsync.open.callCount, 1);
    assert.strictEqual(clock.countTimers(), 0);
  });

  it('detects removal and changed device identity through presence polling', async function() {
    const first = await start();
    HID.devicesAsync.resolves([]);
    await tick(1000);
    assert.strictEqual(first.close.callCount, 1);
    HID.devicesAsync.resolves([info]);
    await tick(250);
    const second = await HID.HIDAsync.open.secondCall.returnValue;
    HID.devicesAsync.resolves([Object.assign({}, info, { serialNumber: 'replacement' })]);
    await tick(750);
    assert.strictEqual(second.close.callCount, 1);
    await tick(250);
    assert.strictEqual(HID.HIDAsync.open.callCount, 3);
  });

  it('does not accumulate presence checks while enumeration is slow', async function() {
    await start();
    const enumeration = deferred();
    HID.devicesAsync.returns(enumeration.promise);
    await tick(10000);
    assert.strictEqual(HID.devicesAsync.callCount, 2);
    const shutdown = close(node);
    enumeration.resolve([info]);
    await shutdown;
    assert.strictEqual(clock.countTimers(), 0);
  });

  it('surfaces close failures and prevents unsafe reopening', async function() {
    const d = await start(), error = new Error('close failed');
    d.close.rejects(error);
    d.emit('error', new Error('read failed'));
    await flush();
    await tick(10000);
    assert.strictEqual(HID.HIDAsync.open.callCount, 1);
    await assert.rejects(close(node), /close failed/);
    assert.strictEqual(d.close.callCount, 1);
    assert.strictEqual(clock.countTimers(), 0);
  });

  it('rejects invalid payloads and disconnected writes once', async function() {
    const d = await start();
    const invalid = input('bad');
    await flush();
    assert.strictEqual(invalid.callCount, 1);
    assert.match(invalid.firstCall.args[0].message, /Buffer or Array/);
    d.emit('error', new Error('unplugged'));
    const disconnected = input([0]);
    await flush();
    assert.strictEqual(disconnected.callCount, 1);
    assert.match(disconnected.firstCall.args[0].message, /not connected/);
    assert.strictEqual(d.write.callCount, 0);
  });

  it('handles a missing configuration without starting timers or opening', async function() {
    await start(null);
    assert.strictEqual(HID.HIDAsync.open.callCount, 0);
    assert.strictEqual(clock.countTimers(), 0);
    await close(node);
  });

  it('preserves path precedence and whitespace handling', async function() {
    await start({ path: '  ' + info.path + '  ', vid: '9', pid: '9', interface: '9', manufacturer: 'wrong' });
    assert.deepStrictEqual(HID.HIDAsync.open.firstCall.args, [info.path]);
  });

  for (const target of ['/dev/hidraw0', 'hidraw0', '../hidraw0']) {
    it('resolves symlink target ' + target, async function() {
      const link = target.startsWith('..') ? '/dev/by-id/keypad' : '/dev/keypad';
      await start({ path: link }, sinon.stub().resolves(target));
      assert.deepStrictEqual(HID.HIDAsync.open.firstCall.args, [info.path]);
    });
  }

  it('keeps VID/PID, interface zero and case-insensitive manufacturer filters', async function() {
    HID.devicesAsync.resolves([
      Object.assign({}, info, { path: '/wrong-interface', interface: 1 }),
      Object.assign({}, info, { path: '/wrong-maker', manufacturer: 'Other' }), info
    ]);
    await start({ vid: '0x04d2', pid: '5678', interface: '0', manufacturer: '  eXample  ' });
    assert.deepStrictEqual(HID.HIDAsync.open.firstCall.args, [info.path]);
  });

  it('retains first matching device selection when optional filters are absent', async function() {
    HID.devicesAsync.resolves([Object.assign({}, info, { interface: 3 }), info]);
    await start({ vid: '1234', pid: '5678', interface: '' });
    assert.strictEqual(statuses()[0].payload.device.interface, 3);
  });
});
