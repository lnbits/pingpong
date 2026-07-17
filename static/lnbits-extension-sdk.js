;(function () {
  let bridgePortPromise = null
  const bridgeEventHandlers = new Map()
  const LOG_PREFIX = '[pingpong extension]'

  function createLNbitsExtensionClient({extensionId}) {
    const baseUrl = `/api/v1/ext/${extensionId}`

    return {
      context() {
        return bridgeRequest({action: 'context'})
      },

      notify(message, level = 'info') {
        return bridgeRequest({
          action: 'ui.notify',
          level,
          message: errorMessage(message)
        })
      },

      notifyError(message) {
        return bridgeRequest({
          action: 'ui.notify',
          level: 'negative',
          message: errorMessage(message)
        })
      },

      openNewTab(url) {
        return bridgeRequest({
          action: 'navigation.open_new_tab',
          url
        })
      },

      requestBackgroundPaymentPermission(grant) {
        return bridgeRequest({
          action: 'permissions.request_background_payment',
          grant
        })
      },

      createTable(payload) {
        return request(`${baseUrl}/tables`, {method: 'POST', body: payload})
      },

      listTables() {
        return request(`${baseUrl}/tables`)
      },

      updateTable(tableId, payload) {
        return request(`${baseUrl}/tables/${encodeURIComponent(tableId)}`, {
          method: 'PATCH',
          body: payload
        })
      },

      deleteTable(tableId) {
        return request(`${baseUrl}/tables/${encodeURIComponent(tableId)}`, {
          method: 'DELETE'
        })
      },

      listWallets() {
        return request(`${baseUrl}/wallets`)
      },

      getPublicTable(tableId) {
        return request(`${baseUrl}/tables/${encodeURIComponent(tableId)}/public`)
      },

      createGame(tableId, payload) {
        return request(`${baseUrl}/tables/${encodeURIComponent(tableId)}/games`, {
          method: 'POST',
          body: payload
        })
      },

      getPublicGame(gameId, playerToken = '') {
        const query = playerToken
          ? `?playerToken=${encodeURIComponent(playerToken)}`
          : ''
        return request(
          `${baseUrl}/games/${encodeURIComponent(gameId)}/public${query}`
        )
      },

      joinGame(gameId, payload) {
        return request(`${baseUrl}/games/${encodeURIComponent(gameId)}/join`, {
          method: 'POST',
          body: payload
        })
      },

      finishGame(gameId, payload) {
        return request(`${baseUrl}/games/${encodeURIComponent(gameId)}/finish`, {
          method: 'POST',
          body: payload
        })
      },

      subscribePayment(paymentHash, callback) {
        return subscribePayment(paymentHash, callback)
      },

      subscribeWebsocket(itemId, callback) {
        return subscribeWebsocket(itemId, callback)
      }
    }
  }

  function request(path, {method = 'GET', body = null} = {}) {
    return bridgeRequest({
      action: 'api',
      method,
      path,
      body
    }).then(unwrapRuntimeResponse)
  }

  function bridgeRequest(message) {
    if (window.parent === window) {
      return Promise.reject(new Error('LNbits extension bridge is not available.'))
    }
    return getBridgePort().then(port => bridgePortRequest(port, message))
  }

  function getBridgePort() {
    if (!bridgePortPromise) bridgePortPromise = connectBridge()
    return bridgePortPromise
  }

  function connectBridge() {
    const id = requestId()
    const channel = new MessageChannel()
    const parentOrigin = bridgeParentOrigin()

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        channel.port1.removeEventListener('message', onMessage)
        channel.port1.close()
        reject(new Error('LNbits extension bridge timed out.'))
      }, 30000)

      function onMessage(event) {
        if (event.currentTarget !== channel.port1) return
        const response = event.data
        if (
          !response ||
          response.type !== 'lnbits-extension:connected' ||
          response.id !== id
        ) {
          return
        }
        window.clearTimeout(timeout)
        channel.port1.removeEventListener('message', onMessage)
        attachBridgeEvents(channel.port1)
        resolve(channel.port1)
      }

      channel.port1.addEventListener('message', onMessage)
      channel.port1.start()
      window.parent.postMessage(
        {type: 'lnbits-extension:connect', id},
        parentOrigin,
        [channel.port2]
      )
    })
  }

  function bridgePortRequest(port, message) {
    const id = requestId()

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        port.removeEventListener('message', onMessage)
        reject(new Error('LNbits extension bridge timed out.'))
      }, 30000)

      function onMessage(event) {
        if (event.currentTarget !== port) return
        const response = event.data
        if (
          !response ||
          response.type !== 'lnbits-extension:response' ||
          response.id !== id
        ) {
          return
        }
        window.clearTimeout(timeout)
        port.removeEventListener('message', onMessage)
        if (response.ok === false) {
          reject(new Error(response.error || 'Extension call failed.'))
          return
        }
        resolve(response.data)
      }

      port.addEventListener('message', onMessage)
      port.postMessage({
        type: 'lnbits-extension:request',
        id,
        ...message
      })
    })
  }

  function attachBridgeEvents(port) {
    if (port.__lnbitsExtensionEventsAttached) return
    port.__lnbitsExtensionEventsAttached = true
    port.addEventListener('message', event => {
      if (event.currentTarget !== port) return
      const message = event.data
      if (!message || message.type !== 'lnbits-extension:event') return
      const handler = bridgeEventHandlers.get(message.subscriptionId)
      if (handler) handler(message)
    })
  }

  function subscribePayment(paymentHash, callback) {
    if (typeof callback !== 'function') {
      return Promise.reject(new Error('Payment subscription needs a callback.'))
    }
    const subscriptionId = requestId()
    bridgeEventHandlers.set(subscriptionId, callback)

    return bridgeRequest({
      action: 'payment.subscribe',
      subscriptionId,
      paymentHash
    })
      .then(() => {
        let active = true
        return () => {
          if (!active) return
          active = false
          bridgeEventHandlers.delete(subscriptionId)
          bridgeRequest({
            action: 'payment.unsubscribe',
            subscriptionId
          }).catch(error =>
            logFailure('Payment unsubscribe failed.', {subscriptionId, error})
          )
        }
      })
      .catch(error => {
        bridgeEventHandlers.delete(subscriptionId)
        throw error
      })
  }

  function subscribeWebsocket(itemId, callback) {
    if (typeof callback !== 'function') {
      return Promise.reject(new Error('Websocket subscription needs a callback.'))
    }
    const subscriptionId = requestId()
    bridgeEventHandlers.set(subscriptionId, callback)

    return bridgeRequest({
      action: 'websocket.subscribe',
      subscriptionId,
      itemId
    })
      .then(() => {
        let active = true
        return {
          send(data) {
            if (!active) return Promise.resolve()
            return bridgeRequest({
              action: 'websocket.send',
              subscriptionId,
              data
            })
          },
          unsubscribe() {
            if (!active) return
            active = false
            bridgeEventHandlers.delete(subscriptionId)
            bridgeRequest({
              action: 'websocket.unsubscribe',
              subscriptionId
            }).catch(error =>
              logFailure('Websocket unsubscribe failed.', {subscriptionId, error})
            )
          }
        }
      })
      .catch(error => {
        bridgeEventHandlers.delete(subscriptionId)
        throw error
      })
  }

  function requestId() {
    return (
      window.crypto?.randomUUID?.() ||
      `request_${Date.now()}_${Math.random().toString(36).slice(2)}`
    )
  }

  function bridgeParentOrigin() {
    return new URL(window.location.href).origin
  }

  function unwrapRuntimeResponse(value) {
    if (typeof value === 'string') value = JSON.parse(value)
    if (value && value.ok === false) {
      throw new Error(value.error || 'Extension call failed.')
    }
    if (value && value.ok === true && 'data' in value) return value.data
    return value
  }

  function errorMessage(value) {
    return value instanceof Error ? value.message : String(value)
  }

  function logFailure(message, details = {}) {
    if (window.console?.error) window.console.error(LOG_PREFIX, message, details)
  }

  window.createLNbitsExtensionClient = createLNbitsExtensionClient
})()
