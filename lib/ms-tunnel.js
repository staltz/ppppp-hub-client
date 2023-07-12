const bs58 = require('bs58')
const debug = require('debug')('ppppp:hub-client')
const pull = require('pull-stream')
const run = require('promisify-tuple')
const HubObserver = require('./hub-observer')
const { muxrpcMissing } = require('./utils')

/**
 * @typedef {Map<string, HubObserver>} Hubs
 */

/**
 * @param {Hubs} hubs
 * @param {any} sstack
 */
const makeTunnelPlugin = (hubs, sstack) => (/** @type {any}} */ msConfig) => {
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
        sstack.conn.hub().listen(),
        pull.filter(({ type }) => type === 'connected'),
        pull.drain(async ({ address, key, details }) => {
          if (!key) return
          // TODO: once secret-stack is updated, we won't need this anymore:
          const pubkey = bs58.encode(Buffer.from(key, 'base64'))
          if (hubs.has(pubkey)) return
          if (!details?.rpc) return
          if (address.startsWith('tunnel:')) return
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
          const obs = new HubObserver(sstack, pubkey, address, res, rpc, onConnect)
          hubs.set(pubkey, obs)
        })
      )

      // Once a hub disconnects, teardown
      pull(
        sstack.conn.hub().listen(),
        pull.filter(({ type }) => type === 'disconnected'),
        pull.drain(({ key }) => {
          if (!key) return
          // TODO: once secret-stack is updated, we won't need this anymore:
          const pubkey = bs58.encode(Buffer.from(key, 'base64'))
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
      debug(`we wish to connect to %o`, address)
      const opts = self.parse(address)
      if (!opts) {
        cb(new Error(`invalid tunnel address ${address}`))
        return
      }
      const { hub, target } = opts
      const addrStr = `tunnel:${hub}:${target}`

      let hubRPC = hubs.get(hub)?.rpc

      // If no hub found, look up hub in connDB and connect to it
      if (!hubRPC) {
        for (const [msaddr] of sstack.conn.db().entries()) {
          const pubkey = msaddr.split('~shse:')[1]
          if (pubkey === hub) {
            // prettier-ignore
            debug(`to connect to ${addrStr} we first have to connect to ${hub}`)
            const [err, rpc] = await run(sstack.conn.connect)(msaddr)
            if (err) {
              // prettier-ignore
              cb(new Error(`cant connect to ${addrStr} because cant reach the hub ${hub} due to: ` + err.message ?? err))
              return
            }
            hubRPC = rpc
          }
        }
      }

      // If no hub found, find tunnel addr in connDB and connect to its `hub`
      if (!hubRPC) {
        const addrStrPlusShse = `tunnel:${hub}:${target}~shse:${target}`
        const peerData = sstack.conn.db().get(addrStrPlusShse)
        if (peerData?.hub === hub && peerData?.hubAddress) {
          // prettier-ignore
          debug(`to connect to ${addrStr} we first have to connect to ${hub}`)
          const [err, rpc] = await run(sstack.conn.connect)(peerData.hubAddress)
          if (err) {
            // prettier-ignore
            cb(new Error(`cant connect to ${addrStr} because cant reach the hub ${hub} due to: ` + err.message ?? err))
            return
          }
          hubRPC = rpc
        }
      }

      // If still no hub is found, consider it unknown
      if (!hubRPC) {
        // prettier-ignore
        cb(new Error(`cant connect to ${addrStr} because hub ${hub} is offline or unknown`))
        return
      }

      debug(`will call createTunnel with ${target} via hub ${hub}`)
      const duplex = hubRPC.hub.createTunnel(
        target,
        (/** @type {any} */ err) => {
          // prettier-ignore
          if (err) debug('tunnel duplex broken with %o because %s', address, err.message ?? err)
        }
      )
      cb(null, duplex)
    },

    /**
     * @param {any} addr
     */
    parse(addr) {
      if (typeof addr === 'object') return addr

      const [prefix, hub, target] = addr.split(':')
      if (prefix !== 'tunnel') return
      return { prefix, hub, target }
    },

    stringify() {
      return undefined
    },
  }

  return self
}

module.exports = makeTunnelPlugin
