const debug = require('debug')('ppppp:hub-client')
const pull = require('pull-stream')
const run = require('promisify-tuple')
const HubObserver = require('./hub-observer')
const { muxrpcMissing } = require('./utils')

/**
 * @typedef {ReturnType<import('ppppp-net').init>} PPPPPNet
 * @typedef {Map<string, HubObserver>} Hubs
 */

/**
 * @param {Hubs} hubs
 * @param {{net: PPPPPNet, shse: {pubkey: string}}} peer
 */
const makeTunnelPlugin = (hubs, peer) => (/** @type {any}} */ msConfig) => {
  const self = {
    name: 'tunnel',

    scope() {
      return msConfig.scope
    },

    /**
     * @param {CallableFunction} onConnect
     * @param {CallableFunction} startedCB
     */
    server(onConnect, startedCB) {
      // Once a peer connects, detect hubs, and setup observers
      pull(
        peer.net.listen(),
        pull.filter(({ type }) => type === 'connected'),
        pull.drain(async ({ multiaddr, pubkey, details }) => {
          if (!pubkey) return
          if (hubs.has(pubkey)) return
          if (!details?.rpc) return
          if (multiaddr.startsWith('/tunnel/')) return
          const rpc = details.rpc
          const [err, res] = await run(rpc.hub.metadata)()
          if (muxrpcMissing(err)) return
          if (err) {
            debug('failure when calling hub.metadata: %s', err.message ?? err)
            return
          }
          debug('connected to hub %s', pubkey)
          if (hubs.has(pubkey)) {
            hubs.get(pubkey)?.cancel()
            hubs.delete(pubkey)
          }
          const obs = new HubObserver(
            peer,
            pubkey,
            multiaddr,
            res,
            rpc,
            onConnect
          )
          hubs.set(pubkey, obs)
        })
      )

      // Once a hub disconnects, teardown
      pull(
        peer.net.listen(),
        pull.filter(({ type }) => type === 'disconnected'),
        pull.drain(({ pubkey }) => {
          if (!pubkey) return
          if (!hubs.has(pubkey)) return
          hubs.get(pubkey)?.close()
          hubs.delete(pubkey)
        })
      )

      startedCB()

      // close this ms plugin
      return () => {
        for (const hubObserver of hubs.values()) {
          hubObserver.close()
        }
        hubs.clear()
      }
    },

    /**
     * @param {string} address
     * @param {CallableFunction} cb
     */
    async client(address, cb) {
      debug(`We wish to connect to %o`, address)
      const opts = self.parse(address)
      if (!opts) {
        cb(new Error(`invalid tunnel address ${address}`))
        return
      }
      const { hub, target } = opts
      const addrStr = `tunnel:${hub}:${target}`

      let hubRPC = hubs.get(hub)?.rpc

      // If no hub found, wait a second and try again
      if (!hubRPC) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        hubRPC = hubs.get(hub)?.rpc
      }

      // If still no hub is found, consider it unknown
      if (!hubRPC) {
        // prettier-ignore
        cb(new Error(`cant connect to ${addrStr} because hub ${hub} is offline or unknown`))
        return
      }

      debug(`Will call createTunnel with ${target} via hub ${hub}`)
      const duplex = hubRPC.hub.createTunnel(
        target,
        (/** @type {any} */ err) => {
          // prettier-ignore
          if (err) debug('Tunnel duplex broken with %o because %s', address, err.message ?? err)
        }
      )
      cb(null, duplex)
    },

    /**
     * @param {any} addr
     */
    parse(addr) {
      if (typeof addr === 'object' && addr.name === 'tunnel') return addr
      const [name, hub, target] = addr.split(':')
      if (name !== 'tunnel') return
      return { name, hub, target }
    },

    stringify() {
      return undefined
    },
  }

  return self
}

module.exports = makeTunnelPlugin
