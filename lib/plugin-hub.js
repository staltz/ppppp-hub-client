const pull = require('pull-stream')
const { ErrorDuplex } = require('./utils')

module.exports = {
  name: 'hub',
  version: '1.0.0',
  manifest: {
    ping: 'sync',
    metadata: 'async',
    attendants: 'source',
    createTunnel: 'duplex',
    createToken: 'async',
  },
  permissions: {
    anonymous: {
      allow: ['createTunnel', 'ping', 'attendants', 'createToken', 'metadata'],
    },
  },

  /**
   * @param {any} sstack
   */
  init(sstack) {
    return {
      attendants() {
        return pull.error(new Error('Not implemented on the client'))
      },

      /**
       * @param {string} origin
       * @returns {pull.Duplex<unknown, unknown>}
       */
      connect(origin) {
        return ErrorDuplex('Not implemented on the client')
      },

      ping() {
        throw new Error('Not implemented on the client')
      },

      /**
       * @param {CallableFunction} cb
       */
      createToken(cb) {
        cb(new Error('Not implemented on the client'))
      },

      /**
       * @param {CallableFunction} cb
       */
      metadata(cb) {
        cb(new Error('Not implemented on the client'))
      },
    }
  },
}
