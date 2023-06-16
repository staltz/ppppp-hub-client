/**
 * @param {Error | string | null | undefined} err
 */
function muxrpcMissing(err) {
  if (!err) return false
  const errString =
    typeof err === 'string'
      ? err
      : typeof err.message === 'string'
      ? err.message
      : ''
  return errString.endsWith('not in list of allowed methods')
}

/**
 * @param {string} message
 * @returns {import('pull-stream').Duplex<unknown, unknown>}
 */
function ErrorDuplex(message) {
  const err = new Error(message)
  return {
    source(_abort, cb) {
      cb(err)
    },
    sink(read) {
      read(err, () => {})
    },
  }
}

module.exports = {
  muxrpcMissing,
  ErrorDuplex,
}
