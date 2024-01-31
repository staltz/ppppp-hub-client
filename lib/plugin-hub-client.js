// @ts-ignore
const DuplexPair = require('pull-pair/duplex') // @ts-ignore
const Notify = require('pull-notify')
const debug = require('debug')('ppppp:hub-client')
const makeTunnelPlugin = require('./ms-tunnel')
const { ErrorDuplex } = require('./utils')

const HUBS_SUBDOMAIN = 'hubs'

/**
 * @typedef {`/${string}/${string}/${string}/${string}/${string}/${string}`} HubMultiaddr
 * @typedef {ReturnType<import('ppppp-net').init>} PPPPPNet
 * @typedef {ReturnType<import('ppppp-set').init>} PPPPPSet
 * @typedef {import('ppppp-net').Info} Info
 * @typedef {{
 *   net: PPPPPNet,
 *   set: PPPPPSet,
 *   multiserver: {
 *     transport(transport: any): void
 *   },
 *   shse: {
 *     pubkey: string
 *   }
 * }} Peer
 */

/**
 * @template T
 * @typedef {(...args: [Error] | [null, T]) => void } CB
 */

/**
 * @param {Peer} peer
 * @param {any} config
 */
function initHubClient(peer, config) {
  const hubs = new Map()

  peer.multiserver.transport({
    name: 'tunnel',
    create: makeTunnelPlugin(hubs, peer),
  })

  // Setup discoveredAttendants source pull-stream
  const _notifyDiscoveredAttendant = Notify()
  function discoveredAttendants() {
    return _notifyDiscoveredAttendant.listen()
  }
  // @ts-ignore
  peer.close.hook(function (fn, args) {
    _notifyDiscoveredAttendant?.end()
    // @ts-ignore
    fn.apply(this, args)
  })

  /**
   * @param {HubMultiaddr} multiaddr
   * @param {CB<void>} cb
   */
  function addHub(multiaddr, cb) {
    /**@type {HubMultiaddr}*/
    let multiaddrWithoutToken
    if (/shse\/[^.]+\.[^.]+$/.test(multiaddr)) {
      // @ts-ignore
      multiaddrWithoutToken = multiaddr.replace(/\.[^.]+$/, '')
    } else if (/shse\/[^.]+$/.test(multiaddr)) {
      multiaddrWithoutToken = multiaddr
    } else {
      return cb(new Error('Invalid Hub multiaddr: ' + multiaddr))
    }

    peer.set.add(HUBS_SUBDOMAIN, multiaddrWithoutToken, (err, _) => {
      // prettier-ignore
      if (err) return cb(new Error('Failed to add Hub to my Set feed', {cause: err}))
      peer.net.connect(multiaddr, (err, rpc) => {
        // prettier-ignore
        if (err) return cb(new Error('Failed to connect to Hub after adding it to my Set feed', {cause: err}))
        cb(null, void 0)
      })
    })
  }

  /**
   * @param {number} amount
   * @param {CB<Array<HubMultiaddr>>} cb
   */
  function getHubs(amount, cb) {
    const source = peer.net.peers()
    source(null, (err, peers) => {
      if (err === true || !peers) return cb(null, [])
      if (err) return cb(new Error('Failed to get hubs', { cause: err }))
      const infoMap = new Map(peers)
      const multiaddrs = peer.set.values(HUBS_SUBDOMAIN)
      const hubs = []
      for (const multiaddr of multiaddrs) {
        const stats = infoMap.get(multiaddr)?.stats ?? { failure: 1 }
        hubs.push({ multiaddr, stats })
      }
      hubs.sort((a, b) => (a.stats.failure ?? 1) - (b.stats.failure ?? 1))
      hubs.splice(amount)
      const returnable = hubs.map((h) => h.multiaddr)
      cb(null, returnable)
    })
  }

  /**
   * @param {string} origin
   * @returns {import('pull-stream').Duplex<unknown, unknown>}
   */
  function connect(origin) {
    // @ts-ignore
    const hub = this.shse.pubkey
    debug('received hubClient.connect(%s) via hub %s', origin, hub)
    if (hubs.has(hub) && origin) {
      debug('connect() will resolve because handler exists')
      const handler = hubs.get(hub).handler
      const [ins, outs] = DuplexPair()
      handler(ins, origin)
      return outs
    } else {
      return ErrorDuplex(`Could not connect to ${origin} via ${hub}`)
    }
  }

  // Internal method
  function getHubsMap() {
    return hubs
  }

  return {
    addHub,
    getHubs,
    connect,
    getHubsMap,
    discoveredAttendants,
    // underscore so other modules IN THIS LIBRARY can use it
    _notifyDiscoveredAttendant,
  }
}

exports.name = 'hubClient'
exports.init = initHubClient
exports.needs = ['shse', 'net', 'set']
exports.manifest = {
  connect: 'duplex',
}
exports.permissions = {
  anonymous: {
    allow: ['connect'],
  },
}
