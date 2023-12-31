// @ts-ignore
const DuplexPair = require('pull-pair/duplex') // @ts-ignore
const Notify = require('pull-notify')
const debug = require('debug')('ppppp:hub-client')
const makeTunnelPlugin = require('./ms-tunnel')
const { ErrorDuplex } = require('./utils')

module.exports = {
  name: 'hubClient',
  manifest: {
    connect: 'duplex',
  },
  permissions: {
    anonymous: {
      allow: ['connect'],
    },
  },

  /**
   * @param {any} local
   * @param {any} config
   */
  init(local, config) {
    if (!local.conn?.connect) {
      throw new Error('hub-client is missing the required ssb-conn plugin')
    }

    const hubs = new Map()

    local.multiserver.transport({
      name: 'tunnel',
      create: makeTunnelPlugin(hubs, local),
    })

    // Setup discoveredAttendants source pull-stream
    const _notifyDiscoveredAttendant = Notify()
    function discoveredAttendants() {
      return _notifyDiscoveredAttendant.listen()
    }
    // @ts-ignore
    local.close.hook(function (fn, args) {
      _notifyDiscoveredAttendant?.end()
      // @ts-ignore
      fn.apply(this, args)
    })

    return {
      /**
       * @param {string} origin
       * @returns {import('pull-stream').Duplex<unknown, unknown>}
       */
      connect(origin) {
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
      },

      // Needed due to https://github.com/ssb-ngi-pointer/ssb-room-client/pull/3#issuecomment-808322434
      ping() {
        return Date.now()
      },

      // Internal method, needed for api-plugin.ts
      getHubsMap() {
        return hubs
      },

      discoveredAttendants,

      // underscore so other modules IN THIS LIBRARY can use it
      _notifyDiscoveredAttendant,
    }
  },
}
