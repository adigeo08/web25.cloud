// @ts-check

export const CHANNELS_EXT_NAME = 'web25_channels_v1'

/**
 * Factory that returns a BEP10 wire-extension constructor for the channels
 * protocol, compatible with `wire.use()` from WebTorrent.
 *
 * Returning a constructor (instead of an instance) is the critical BEP10 fix:
 * WebTorrent calls it with `new` for every wire and declares the extension
 * name inside the `m: {}` field of the BEP10 extended handshake, so the
 * remote peer knows which ID to use when responding.
 *
 * @param {object} service - ChannelsService instance
 * @returns {function} Extension constructor
 */
export function createChannelsExtension(service) {
  /**
   * @this {object}
   * @param {object} wire - WebTorrent wire instance
   */
  function ChannelsBep10Extension(wire) {
    this.name = CHANNELS_EXT_NAME
    this._wire = wire
    wire.web25ChannelsExtension = this
  }

  ChannelsBep10Extension.prototype.onExtendedHandshake = function (remoteHandshake) {
    if (remoteHandshake?.m?.[CHANNELS_EXT_NAME] === undefined) return
    service.onPeerConnected(this._wire)
  }

  ChannelsBep10Extension.prototype.onMessage = function (buf) {
    try {
      const payload = JSON.parse(new TextDecoder().decode(buf))
      service.handleInbound(payload, false)
    } catch (_) {}
  }

  ChannelsBep10Extension.prototype.send = function (payload) {
    try {
      const raw = new TextEncoder().encode(JSON.stringify(payload))
      this._wire.extended(CHANNELS_EXT_NAME, raw)
    } catch (_) {}
  }

  return ChannelsBep10Extension
}
