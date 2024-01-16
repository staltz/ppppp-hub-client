const debug = require('debug')('ppppp:hub-client')
const pull = require('pull-stream')
// @ts-ignore
const getSeverity = require('ssb-network-errors')

/**
 * @typedef {ReturnType<import('ppppp-net').init>} PPPPPNet
 * @typedef {{net: PPPPPNet, shse: {pubkey: string}}} Peer
 * @typedef {(pull.Sink<AttendantsEvent> & {abort: () => void})} Drain
 * @typedef {{type: 'state', pubkeys: Array<string>}} AttendantsEventState
 * @typedef {{type: 'joined', pubkey: string}} AttendantsEventJoined
 * @typedef {{type: 'left', pubkey: string}} AttendantsEventLeft
 */

/**
 * @typedef {AttendantsEventState | AttendantsEventJoined | AttendantsEventLeft} AttendantsEvent
 */

module.exports = class HubObserver {
  /**@readonly @type {Peer}*/
  #peer
  /**@type {string}*/
  #hubPubkey
  /**@type {`/${string}`}*/
  #multiaddr
  /**@type {{name: string, admin: string}}*/
  #hubMetadata
  /**@type {Set<string>}*/
  #attendants
  /**@type {Drain | undefined}*/
  #attendantsDrain

  /**
   * @param {Peer} peer
   * @param {string} hubPubkey
   * @param {`/${string}`} multiaddr
   * @param {{name: string, admin: string}} hubMetadata
   * @param {any} rpc
   * @param {any} onConnect
   */
  constructor(peer, hubPubkey, multiaddr, hubMetadata, rpc, onConnect) {
    this.#peer = peer
    this.#hubPubkey = hubPubkey
    this.#multiaddr = multiaddr
    this.#hubMetadata = hubMetadata
    this.#attendants = new Set()

    this.rpc = rpc

    /**
     * @param {any} stream
     * @param {string} peerPubkey
     */
    this.handler = (stream, peerPubkey) => {
      stream.address = `tunnel:${this.#hubPubkey}:${peerPubkey}`
      // prettier-ignore
      debug('Handler will call onConnect for the stream.address: %s', stream.address);
      onConnect(stream)
    }

    // If metadata is a plain object with at least one field
    if (
      typeof this.#hubMetadata === 'object' &&
      this.#hubMetadata &&
      Object.keys(this.#hubMetadata).length >= 1
    ) {
      /** @type {any} */
      const metadata = { type: 'hub' }
      const { name, admin } = this.#hubMetadata
      if (name) metadata.name = name
      if (admin) metadata.admin = admin
      this.#peer.net.updateInfo(this.#multiaddr, metadata)
    }

    debug('Announcing myself to hub %s', this.#hubPubkey)
    pull(
      this.rpc.hub.attendants(),
      (this.#attendantsDrain = /** @type {Drain} */ (
        pull.drain(this.#attendantsUpdated, this.#attendantsEnded)
      ))
    )
  }

  /**
   * @param {AttendantsEvent} event
   */
  #attendantsUpdated = (event) => {
    // debug log
    if (event.type === 'state') {
      // prettier-ignore
      debug('initial attendants in %s: %s', this.#hubPubkey, JSON.stringify(event.pubkeys))
    } else if (event.type === 'joined') {
      debug('attendant joined %s: %s', this.#hubPubkey, event.pubkey)
    } else if (event.type === 'left') {
      debug('attendant left %s: %s', this.#hubPubkey, event.pubkey)
    }

    // Update attendants set
    if (event.type === 'state') {
      this.#attendants.clear()
      for (const pubkey of event.pubkeys) {
        this.#attendants.add(pubkey)
      }
    } else if (event.type === 'joined') {
      this.#attendants.add(event.pubkey)
    } else if (event.type === 'left') {
      this.#attendants.delete(event.pubkey)
    }

    // Update onlineCount metadata for this hub
    const onlineCount = this.#attendants.size
    this.#peer.net.updateInfo(this.#multiaddr, /**@type {any}*/ ({ onlineCount }))

    const hubName = this.#hubMetadata?.name
    if (event.type === 'state') {
      for (const pubkey of event.pubkeys) {
        this.#notifyNewAttendant(pubkey, this.#hubPubkey, hubName)
      }
    } else if (event.type === 'joined') {
      this.#notifyNewAttendant(event.pubkey, this.#hubPubkey, hubName)
    } else if (event.type === 'left') {
      const multiaddr = this.#getMultiaddr(event.pubkey)
      debug('Will disconnect and unstage %s', multiaddr)
      this.#peer.net.disconnect(multiaddr)
    }
  }

  /**
   * @param {Error | boolean | null | undefined} err
   * @returns
   */
  #attendantsEnded = (err) => {
    if (err && err !== true) {
      this.#handleStreamError(err)
    }
  }

  /**
   * Typically, this should stage the new attendant, but it's not up to us to
   * decide that. We just notify other modules (like the net scheduler) and
   * they listen to the notify stream and stage it if they want.
   *
   * @param {string} attendantPubkey
   * @param {string} hubPubkey
   * @param {string} hubName
   */
  #notifyNewAttendant(attendantPubkey, hubPubkey, hubName) {
    if (attendantPubkey === hubPubkey) return
    if (attendantPubkey === this.#peer.shse.pubkey) return
    const multiaddr = this.#getMultiaddr(attendantPubkey)
    // @ts-ignore
    this.#peer.hubClient._notifyDiscoveredAttendant({
      multiaddr,
      attendantPubkey,
      hubPubkey,
      hubName,
    })
  }

  /**
   * @param {Error} err
   */
  #handleStreamError(err) {
    const severity = getSeverity(err)
    if (severity === 1) {
      // pre-emptively destroy the stream, assuming the other
      // end is packet-stream 2.0.0 sending end messages.
      this.close()
    } else if (severity >= 2) {
      // prettier-ignore
      console.error(`error getting updates from hub ${this.#hubPubkey} because ${err.message}`);
    }
  }

  /**
   * @param {string} pubkey
   * @returns {`/${string}`}
   */
  #getMultiaddr(pubkey) {
    return `/tunnel/${this.#hubPubkey}.${pubkey}/shse/${pubkey}`
  }

  /**
   * Similar to close(), but just destroys this "observer", not the
   * underlying connections.
   */
  cancel() {
    this.#attendantsDrain?.abort()
  }

  /**
   * Similar to cancel(), but also closes connection with the hub server.
   */
  close() {
    this.#attendantsDrain?.abort()
    for (const pubkey of this.#attendants) {
      const multiaddr = this.#getMultiaddr(pubkey)
      this.#peer.net.forget(multiaddr)
    }
    this.rpc.close(true, (/** @type {any} */ err) => {
      if (err) debug('error when closing connection with room: %o', err)
    })
    this.#peer.net.disconnect(this.#multiaddr)
  }
}
