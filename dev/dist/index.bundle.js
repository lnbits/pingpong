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

const storage = {
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

const wallet = {
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

const websocket = {
  publish(itemId, data) {
    return websocketPublish({
      itemId,
      dataJson: JSON.stringify(data || {})
    }).sent
  }
}

const system = {
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


const TABLES = 'tables'
const GAMES = 'games'
const POINTS_TO_WIN = 11

export function createTable(requestJson) {
  return runJson(() => {
    const request = parseObject(requestJson)
    const now = system.now()
    const table = {
      id: system.id('table'),
      name: requiredText(request.name, 'name', 80),
      description: cleanText(request.description, 300),
      wallet_id: requiredText(request.walletId, 'walletId', 128),
      entry_sats: positiveInteger(request.entrySats, 'entrySats'),
      games_to_win: boundedInteger(request.gamesToWin, 'gamesToWin', 1, 9),
      host_percent: boundedInteger(request.hostPercent, 'hostPercent', 0, 50),
      status: 'open',
      created_at: now,
      updated_at: now
    }
    storage.set(TABLES, table)
    return tableSummary(table)
  })
}

export function listTables(_requestJson) {
  return runJson(() => ({
    tables: storage
      .getPaginated(TABLES, {sortBy: 'created_at', descending: true, limit: 100})
      .data.map(table => ({
        ...tableSummary(table),
        activeGames: rows(GAMES, {table_id: table.id}, 1000).filter(game =>
          ['waiting_payment', 'waiting_opponent', 'playing'].includes(game.status)
        ).length
      }))
  }))
}

export function updateTable(requestJson) {
  return runJson(() => {
    const request = parseObject(requestJson)
    const table = getTable(requiredText(request.tableId, 'tableId', 128))
    if ('name' in request) table.name = requiredText(request.name, 'name', 80)
    if ('description' in request) table.description = cleanText(request.description, 300)
    if ('entrySats' in request) {
      table.entry_sats = positiveInteger(request.entrySats, 'entrySats')
    }
    if ('gamesToWin' in request) {
      table.games_to_win = boundedInteger(request.gamesToWin, 'gamesToWin', 1, 9)
    }
    if ('hostPercent' in request) {
      table.host_percent = boundedInteger(request.hostPercent, 'hostPercent', 0, 50)
    }
    if ('status' in request) table.status = validTableStatus(request.status)
    table.updated_at = system.now()
    storage.set(TABLES, table)
    return tableSummary(table)
  })
}

export function deleteTable(requestJson) {
  return runJson(() => {
    const tableId = requiredText(parseObject(requestJson).tableId, 'tableId', 128)
    const table = getTable(tableId)
    if (rows(GAMES, {table_id: table.id}, 1).length) {
      throw new Error('Tables with games cannot be deleted.')
    }
    storage.delete(TABLES, table.id)
    return {id: table.id, deleted: true}
  })
}

export function listWallets(_requestJson) {
  return runJson(() => ({wallets: wallet.listUserWallets()}))
}

export function getPublicTable(requestJson) {
  return runJson(() => {
    const table = getPublicTableRow(requiredText(parseObject(requestJson).tableId, 'tableId', 128))
    return tableSummary(table)
  })
}

export function createGame(requestJson) {
  return runJson(() => {
    const request = parseObject(requestJson)
    const table = getPublicTableRow(requiredText(request.tableId, 'tableId', 128))
    ensureOpenTable(table)
    const playerToken = system.id('player')
    const now = system.now()
    const gameId = system.id('game')
    storage.set(GAMES, {
      id: gameId,
      table_id: table.id,
      status: 'waiting_payment',
      player1_lnurl: normalizeLnurl(request.lnurl),
      player2_lnurl: '',
      player1_token: playerToken,
      player2_token: '',
      player1_paid: false,
      player2_paid: false,
      player1_payment_hash: '',
      player2_payment_hash: '',
      player1_wins: 0,
      player2_wins: 0,
      current_player1_score: 0,
      current_player2_score: 0,
      winner_slot: '',
      payout_status: 'none',
      payout_payment_hash: '',
      payout_error: '',
      created_at: now,
      updated_at: now,
      started_at: 0,
      finished_at: 0
    })
    const invoice = createEntryInvoice(table, {
      gameId,
      playerSlot: 'player1',
      playerToken,
      lnurl: normalizeLnurl(request.lnurl)
    })
    return {
      gameId,
      playerSlot: 'player1',
      playerToken,
      invoice
    }
  })
}

export function getPublicGame(requestJson) {
  return runJson(() => {
    const request = parseObject(requestJson)
    const game = getPublicGameRow(requiredText(request.gameId, 'gameId', 128))
    const table = getPublicTableRow(game.table_id)
    return publicGame(game, table, cleanText(request.playerToken, 128))
  })
}

export function joinGame(requestJson) {
  return runJson(() => {
    const request = parseObject(requestJson)
    const game = getPublicGameRow(requiredText(request.gameId, 'gameId', 128))
    const table = getPublicTableRow(game.table_id)
    ensureOpenTable(table)
    if (!game.player1_paid) throw new Error('The first player has not paid yet.')
    if (game.player2_paid || game.status === 'playing' || game.status === 'paid') {
      throw new Error('This game is full.')
    }
    const playerToken = system.id('player')
    const lnurl = normalizeLnurl(request.lnurl)
    const invoice = createEntryInvoice(table, {
      gameId: game.id,
      playerSlot: 'player2',
      playerToken,
      lnurl
    })
    return {
      gameId: game.id,
      playerSlot: 'player2',
      playerToken,
      invoice
    }
  })
}

export function finishGame(requestJson) {
  return runJson(() => {
    const request = parseObject(requestJson)
    const game = getGame(requiredText(request.gameId, 'gameId', 128))
    const table = getTable(game.table_id)
    const playerToken = requiredText(request.playerToken, 'playerToken', 128)
    const submitterSlot = slotForToken(game, playerToken)
    const winnerSlot = validPlayerSlot(request.winnerSlot)
    if (!submitterSlot) throw new Error('Invalid player token.')
    if (!game.player1_paid || !game.player2_paid) {
      throw new Error('Both players must pay before a game can finish.')
    }
    if (game.status === 'paid') return publicGame(game, table, playerToken)

    const winnerLnurl = winnerSlot === 'player1' ? game.player1_lnurl : game.player2_lnurl
    const winnerAmount = winnerPayoutSats(table)
    const now = system.now()
    game.status = 'payout_pending'
    game.winner_slot = winnerSlot
    game.player1_wins = safeInteger(request.player1Wins, game.player1_wins)
    game.player2_wins = safeInteger(request.player2Wins, game.player2_wins)
    game.current_player1_score = safeInteger(
      request.currentPlayer1Score,
      game.current_player1_score
    )
    game.current_player2_score = safeInteger(
      request.currentPlayer2Score,
      game.current_player2_score
    )
    game.finished_at = now
    game.updated_at = now
    game.payout_status = 'pending'
    storage.set(GAMES, game)

    const payout = wallet.payLnurl({
      walletId: table.wallet_id,
      lnurl: winnerLnurl,
      amount: winnerAmount,
      maxSat: winnerAmount,
      description: `Ping Pong winner payout for ${table.name}`,
      comment: 'Ping Pong winner payout',
      extra: {gameId: game.id, winnerSlot}
    })
    game.payout_status = payout.ok ? 'paid' : 'failed'
    game.payout_payment_hash = payout.paymentHash || ''
    game.payout_error = payout.ok ? '' : payout.error || 'Payout failed.'
    game.status = payout.ok ? 'paid' : 'payout_pending'
    game.updated_at = system.now()
    storage.set(GAMES, game)
    publishGame(game, table, 'finished')
    return publicGame(game, table, playerToken)
  })
}

export function recordPayment(eventJson) {
  return runJson(() => {
    const event = parseObject(eventJson)
    const paymentHash = eventValue(event, 'paymentHash', 'payment_hash')
    const extra = extensionExtra(event)
    const gameId = cleanText(extra.gameId || extra.game_id, 128)
    const playerSlot = cleanText(extra.playerSlot || extra.player_slot, 20)
    const playerToken = cleanText(extra.playerToken || extra.player_token, 128)
    const lnurl = cleanText(extra.lnurl, 2048)
    if (!paymentHash || !gameId || !playerSlot || !playerToken || !lnurl) {
      return {recorded: false}
    }

    const game = getGame(gameId)
    const table = getTable(game.table_id)
    if (game.player1_payment_hash === paymentHash || game.player2_payment_hash === paymentHash) {
      return {recorded: false, duplicate: true}
    }

    const amountSats = eventAmountSats(event)
    if (amountSats < table.entry_sats) {
      refundPayment(table, lnurl, amountSats, game.id, 'underpaid')
      return {recorded: false, refunded: true}
    }

    if (playerSlot === 'player1' && playerToken === game.player1_token && !game.player1_paid) {
      game.player1_paid = true
      game.player1_payment_hash = paymentHash
      game.status = 'waiting_opponent'
      game.updated_at = system.now()
      storage.set(GAMES, game)
      publishGame(game, table, 'player-paid')
      return {recorded: true, slot: 'player1'}
    }

    if (playerSlot === 'player2' && game.player1_paid && !game.player2_paid) {
      game.player2_paid = true
      game.player2_payment_hash = paymentHash
      game.player2_token = playerToken
      game.player2_lnurl = lnurl
      game.status = 'playing'
      game.started_at = system.now()
      game.updated_at = game.started_at
      storage.set(GAMES, game)
      publishGame(game, table, 'player-paid')
      return {recorded: true, slot: 'player2'}
    }

    refundPayment(table, lnurl, amountSats, game.id, 'full')
    return {recorded: false, refunded: true}
  })
}

function createEntryInvoice(table, player) {
  const invoice = wallet.createInvoicePublic({
    sourceId: table.id,
    amount: table.entry_sats,
    currency: 'sat',
    memo: `Ping Pong entry: ${table.name}`,
    extra: player
  })
  return {
    paymentHash: invoice.paymentHash,
    paymentRequest: invoice.paymentRequest,
    checkingId: invoice.checkingId
  }
}

function refundPayment(table, lnurl, amountSats, gameId, reason) {
  if (amountSats <= 0) return null
  return wallet.payLnurl({
    walletId: table.wallet_id,
    lnurl,
    amount: amountSats,
    maxSat: amountSats,
    description: `Ping Pong refund for ${table.name}`,
    comment: 'Ping Pong refund',
    extra: {gameId, reason}
  })
}

function publishGame(game, table, event) {
  try {
    websocket.publish(`game:${game.id}`, {
      type: 'server',
      event,
      game: publicGame(game, table, '')
    })
  } catch (error) {
    system.log(`websocket publish failed: ${errorMessage(error)}`, 'warning')
  }
}

function publicGame(game, table, playerToken) {
  return {
    id: game.id,
    tableId: game.table_id,
    status: game.status,
    playerSlot: slotForToken(game, playerToken),
    player1Paid: game.player1_paid === true,
    player2Paid: game.player2_paid === true,
    player1Wins: Number(game.player1_wins || 0),
    player2Wins: Number(game.player2_wins || 0),
    currentPlayer1Score: Number(game.current_player1_score || 0),
    currentPlayer2Score: Number(game.current_player2_score || 0),
    winnerSlot: game.winner_slot || '',
    payoutStatus: game.payout_status || 'none',
    pointsToWin: POINTS_TO_WIN,
    table: tableSummary(table),
    createdAt: Number(game.created_at || 0),
    updatedAt: Number(game.updated_at || 0),
    startedAt: Number(game.started_at || 0),
    finishedAt: Number(game.finished_at || 0)
  }
}

function tableSummary(table) {
  const pot = Number(table.entry_sats || 0) * 2
  const hostFee = Math.floor((pot * Number(table.host_percent || 0)) / 100)
  return {
    id: table.id,
    name: table.name,
    description: table.description || '',
    entrySats: Number(table.entry_sats || 0),
    gamesToWin: Number(table.games_to_win || 1),
    hostPercent: Number(table.host_percent || 0),
    hostFeeSats: hostFee,
    winnerPayoutSats: Math.max(0, pot - hostFee),
    status: table.status || 'open',
    createdAt: Number(table.created_at || 0),
    updatedAt: Number(table.updated_at || 0)
  }
}

function winnerPayoutSats(table) {
  return tableSummary(table).winnerPayoutSats
}

function rows(table, filters, limit = 1000) {
  return storage.getPaginated(table, {filters, limit}).data
}

function getTable(id) {
  const table = storage.get(TABLES, id)
  if (!table) throw new Error('Table not found.')
  return table
}

function getPublicTableRow(id) {
  const table = storage.getPublic(TABLES, id)
  if (!table) throw new Error('Table not found.')
  return table
}

function getGame(id) {
  const game = storage.get(GAMES, id)
  if (!game) throw new Error('Game not found.')
  return game
}

function getPublicGameRow(id) {
  const game = storage.getPublic(GAMES, id)
  if (!game) throw new Error('Game not found.')
  return game
}

function ensureOpenTable(table) {
  if (table.status !== 'open') throw new Error('This table is closed.')
}

function slotForToken(game, playerToken) {
  if (!playerToken) return ''
  if (playerToken === game.player1_token) return 'player1'
  if (playerToken === game.player2_token) return 'player2'
  return ''
}

function validPlayerSlot(value) {
  if (value === 'player1' || value === 'player2') return value
  throw new Error('Invalid player slot.')
}

function validTableStatus(value) {
  if (value === 'open' || value === 'closed') return value
  throw new Error('Invalid table status.')
}

function normalizeLnurl(value) {
  const text = requiredText(value, 'lnurl', 2048)
  if (!text.includes('@') && !/^lnurl/i.test(text)) {
    throw new Error('Enter a Lightning Address or LNURL.')
  }
  return text
}

function positiveInteger(value, name) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive whole number.`)
  }
  return number
}

function boundedInteger(value, name, min, max) {
  const number = Number(value)
  if (!Number.isSafeInteger(number)) {
    throw new Error(`${name} must be a whole number.`)
  }
  if (number < min || number > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`)
  }
  return number
}

function safeInteger(value, fallback) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : Number(fallback || 0)
}

function requiredText(value, name, max) {
  const text = cleanText(value, max)
  if (!text) throw new Error(`${name} is required.`)
  return text
}

function cleanText(value, max) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text.length > max) throw new Error(`Text must be at most ${max} characters.`)
  return text
}

function parseObject(value) {
  const parsed = value ? JSON.parse(value) : {}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object.')
  }
  return parsed
}

function eventValue(event, camel, snake) {
  return cleanText(
    event[camel] ||
      event[snake] ||
      event.extra?.[camel] ||
      event.extra?.[snake] ||
      event.payment?.[camel] ||
      event.payment?.[snake] ||
      event.payment?.extra?.[camel] ||
      event.payment?.extra?.[snake],
    128
  )
}

function extensionExtra(event) {
  return event.extra?.extra_pingpong || event.payment?.extra?.extra_pingpong || {}
}

function eventAmountSats(event) {
  const amountMsat = Number(event.amount || event.payment?.amount || 0)
  return Number.isFinite(amountMsat) ? Math.abs(Math.trunc(amountMsat / 1000)) : 0
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function runJson(fn) {
  try {
    return JSON.stringify({ok: true, data: fn()})
  } catch (error) {
    const message = errorMessage(error)
    system.log(`pingpong: ${message}`, 'warning')
    return JSON.stringify({ok: false, error: message})
  }
}
