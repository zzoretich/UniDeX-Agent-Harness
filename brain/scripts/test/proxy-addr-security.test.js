const { test } = require('node:test');
const assert = require('node:assert/strict');
const proxyaddr = require('proxy-addr');

// Isolated upstream-library contract; UniDeX does not enable this trust-proxy setup.
test('proxy-addr rejects short mapped trust subnets while retaining valid forwarding boundaries', () => {
  const forwarded = '203.0.113.55';
  function selected(peer, ranges) {
    return proxyaddr({ socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': forwarded } }, ranges);
  }
  for (const range of ['::ffff:10.0.0.0/8', '::/1']) {
    for (const ranges of [[range], [range, '192.0.2.0/24']]) {
      assert.equal(selected('198.51.100.77', ranges), '198.51.100.77', `untrusted IPv4 peer: ${ranges}`);
      assert.equal(selected('::ffff:198.51.100.77', ranges), '::ffff:198.51.100.77', `untrusted mapped peer: ${ranges}`);
    }
  }
  for (const ranges of [['::ffff:10.0.0.0/104'], ['::ffff:10.0.0.0/104', '192.0.2.0/24']]) {
    assert.equal(selected('10.2.3.4', ranges), forwarded);
    assert.equal(selected('::ffff:10.2.3.4', ranges), forwarded);
    assert.equal(selected('198.51.100.77', ranges), '198.51.100.77');
  }
  assert.equal(selected('2001:db8:2::3', ['2001:db8::/32']), forwarded);
  assert.equal(selected('2001:db9::3', ['2001:db8::/32']), '2001:db9::3');
});
