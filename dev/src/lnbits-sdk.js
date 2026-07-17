import {
  createInvoicePublic,
  listUserWallets,
  log,
  now,
  payLnurl,
  randomId,
  storageAppendPublic,
  storageDelete,
  storageGet,
  storageGetPaginated,
  storageGetPublic,
  storageGetPublicPaginated,
  storageSet,
  websocketPublish
} from 'lnbits:extension/host'

export const storage = {
  get(table, id, fallback = null) {
    const {dataJson} = storageGet({table, id})
    return dataJson ? JSON.parse(dataJson) : fallback
  },

  getPublic(table, id, fallback = null) {
    const {dataJson} = storageGetPublic({table, id})
    return dataJson ? JSON.parse(dataJson) : fallback
  },

  set(table, data) {
    storageSet({table, dataJson: JSON.stringify(data || {})})
    return data
  },

  appendPublic(table, sourceId, data) {
    return storageAppendPublic({
      table,
      sourceId,
      dataJson: JSON.stringify(data || {})
    }).id
  },

  getPaginated(table, options = {}) {
    const {rowsJson, total} = storageGetPaginated({
      table,
      filtersJson: JSON.stringify(options.filters || {}),
      search: options.search || '',
      searchFields: options.searchFields || [],
      sortBy: options.sortBy || '',
      descending: options.descending === true,
      limit: options.limit || 25,
      offset: options.offset || 0
    })
    return {data: JSON.parse(rowsJson || '[]'), total: Number(total || 0)}
  },

  getPublicPaginated(table, options = {}) {
    const {rowsJson, total} = storageGetPublicPaginated({
      table,
      filtersJson: JSON.stringify(options.filters || {}),
      search: options.search || '',
      searchFields: options.searchFields || [],
      sortBy: options.sortBy || '',
      descending: options.descending === true,
      limit: options.limit || 25,
      offset: options.offset || 0
    })
    return {data: JSON.parse(rowsJson || '[]'), total: Number(total || 0)}
  },

  delete(table, id) {
    storageDelete({table, id})
  }
}

export const wallet = {
  listUserWallets() {
    return listUserWallets().wallets || []
  },

  createInvoicePublic({sourceId, amount, currency = 'sat', memo = '', extra = {}}) {
    return createInvoicePublic({
      sourceId,
      amount: Number(amount),
      currency,
      memo,
      extra: Object.entries(extra).map(([key, value]) => [key, String(value)])
    })
  },

  payLnurl({
    walletId,
    lnurl,
    amount,
    currency = 'sat',
    comment = '',
    description = '',
    maxSat = 0,
    extra = {}
  }) {
    return payLnurl({
      walletId,
      lnurl,
      amount: Number(amount),
      currency,
      comment: comment || undefined,
      description,
      maxSat: maxSat > 0 ? BigInt(maxSat) : undefined,
      extra: Object.entries(extra).map(([key, value]) => [key, String(value)])
    })
  }
}

export const websocket = {
  publish(itemId, data) {
    return websocketPublish({
      itemId,
      dataJson: JSON.stringify(data || {})
    }).sent
  }
}

export const system = {
  id(prefix) {
    return randomId({prefix}).id
  },

  now() {
    return Number(now().timestamp)
  },

  log(message, level = 'info') {
    log({level, message})
  }
}
