import assertModule from 'assert'
import {promises as fs} from 'fs'

const assert = assertModule.strict

const tests = []

function test(name, fn) {
  tests.push({name, fn})
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

async function moduleWithHost() {
  const tables = {tables: [], games: []}
  const invoiceRequests = []
  const lnurlPayments = []
  const websocketMessages = []
  const logs = []
  const appendPublicCalls = []
  const config = JSON.parse(
    await fs.readFile(new URL('../../config.json', import.meta.url), 'utf8')
  )
  const publicPolicies = new Map(
    config.permissions
      .find(permission => permission.id === 'ext.storage.read_public')
      .policies.map(policy => [policy.table_name, policy.public_fields])
  )

  let nextId = 0
  let nextGameId = 0
  let now = 1_700_000_000

  const storage = {
    set(table, row) {
      const index = tables[table].findIndex(item => item.id === row.id)
      if (index < 0) tables[table].push(clone(row))
      else tables[table][index] = clone(row)
    },

    appendPublic(table, sourceId, row) {
      nextGameId += 1
      appendPublicCalls.push({table, sourceId, row})
      throw new Error(`Unexpected public append for ${table}:${sourceId}:${row}`)
    },

    get(table, id) {
      const row = tables[table].find(item => item.id === id)
      return row ? clone(row) : null
    },

    getPublic(table, id) {
      const row = this.get(table, id)
      if (!row) return null
      const fields = publicPolicies.get(table) || []
      return Object.fromEntries(fields.map(field => [field, row[field]]))
    },

    getPaginated(table, {filters = {}, limit = 1000} = {}) {
      const rows = tables[table].filter(row =>
        Object.entries(filters).every(([key, value]) => row[key] === value)
      )
      return {data: rows.slice(0, limit).map(row => clone(row)), total: rows.length}
    },

    delete(table, id) {
      tables[table] = tables[table].filter(row => row.id !== id)
    }
  }

  const system = {
    id(prefix) {
      return `${prefix}_${++nextId}`
    },

    now() {
      return now++
    },

    log(message, level = 'info') {
      logs.push({level, message})
    }
  }

  const wallet = {
    listUserWallets() {
      return [{id: 'wallet_1', name: 'Main wallet'}]
    },

    createInvoicePublic(request) {
      const index = invoiceRequests.length + 1
      invoiceRequests.push(clone(request))
      return {
        paymentHash: `hash_${index}`,
        paymentRequest: `bolt11_${index}`,
        checkingId: `check_${index}`
      }
    },

    payLnurl(request) {
      const index = lnurlPayments.length + 1
      lnurlPayments.push(clone(request))
      return {ok: true, paymentHash: `payout_${index}`}
    }
  }

  const websocket = {
    publish(itemId, data) {
      websocketMessages.push({itemId, data: clone(data)})
      return 1
    }
  }

  let source = await fs.readFile(new URL('../src/index.js', import.meta.url), 'utf8')
  source = source
    .replace(/^import .*\n\n/, '')
    .replace(/export function /g, 'function ')
  const names = [
    'createTable',
    'listTables',
    'updateTable',
    'deleteTable',
    'listWallets',
    'getPublicTable',
    'createGame',
    'getPublicGame',
    'joinGame',
    'finishGame',
    'recordPayment'
  ]
  const api = Function(
    'storage',
    'system',
    'wallet',
    'websocket',
    `${source}; return {${names.join(',')}}`
  )(storage, system, wallet, websocket)

  return {
    api,
    tables,
    invoiceRequests,
    lnurlPayments,
    websocketMessages,
    logs,
    appendPublicCalls
  }
}

function unwrap(value) {
  return JSON.parse(value)
}

function ok(value) {
  const response = unwrap(value)
  assert.equal(response.ok, true, response.error)
  return response.data
}

function paymentEvent(invoiceRequest, paymentHash, amountSats, extra = {}) {
  return {
    paymentHash,
    amount: amountSats * 1000,
    extra: {extra_pingpong: {...(invoiceRequest?.extra || {}), ...extra}}
  }
}

function createTable(api, overrides = {}) {
  return ok(
    api.createTable(
      JSON.stringify({
        name: 'Fast table',
        description: 'Friendly match',
        walletId: 'wallet_1',
        entrySats: 100,
        gamesToWin: 3,
        hostPercent: 10,
        ...overrides
      })
    )
  )
}

test('creates a public game without using public append policy', async () => {
  const {api, tables, invoiceRequests, appendPublicCalls} = await moduleWithHost()
  const table = createTable(api)
  const game = ok(
    api.createGame(JSON.stringify({tableId: table.id, lnurl: 'alice@example.com'}))
  )

  assert.deepEqual(appendPublicCalls, [])
  assert.equal(game.playerSlot, 'player1')
  assert.equal(game.invoice.paymentRequest, 'bolt11_1')
  assert.equal(invoiceRequests[0].sourceId, table.id)
  assert.deepEqual(invoiceRequests[0].extra, {
    gameId: game.gameId,
    playerSlot: 'player1',
    playerToken: game.playerToken,
    lnurl: 'alice@example.com'
  })

  const row = tables.games[0]
  assert.equal(row.id, game.gameId)
  assert.equal(row.table_id, table.id)
  assert.equal(row.status, 'waiting_payment')
  assert.equal(row.player2_lnurl, '')
  assert.equal(row.player2_token, '')
  assert.equal(row.player1_payment_hash, '')
  assert.equal(row.player2_payment_hash, '')
  assert.equal(row.winner_slot, '')
  assert.equal(row.payout_payment_hash, '')
  assert.equal(row.payout_error, '')
  assert.equal(row.started_at, 0)
  assert.equal(row.finished_at, 0)
})

test('config gives public game creation an owner context', async () => {
  const config = JSON.parse(
    await fs.readFile(new URL('../../config.json', import.meta.url), 'utf8')
  )
  const route = config.api_routes.find(route => route.export === 'create-game')

  assert.deepEqual(route.ownerContext, {table: 'tables', idParam: 'tableId'})
})

test('covers create, player payments, join, and winner payout', async () => {
  const {api, tables, invoiceRequests, lnurlPayments, websocketMessages} =
    await moduleWithHost()
  const table = createTable(api)
  const created = ok(
    api.createGame(JSON.stringify({tableId: table.id, lnurl: 'alice@example.com'}))
  )
  const player1Payment = ok(
    api.recordPayment(
      JSON.stringify(paymentEvent(invoiceRequests[0], created.invoice.paymentHash, 100))
    )
  )
  assert.deepEqual(player1Payment, {recorded: true, slot: 'player1'})
  assert.equal(tables.games[0].status, 'waiting_opponent')

  const joined = ok(
    api.joinGame(JSON.stringify({gameId: created.gameId, lnurl: 'bob@example.com'}))
  )
  const player2Payment = ok(
    api.recordPayment(
      JSON.stringify(paymentEvent(invoiceRequests[1], joined.invoice.paymentHash, 100))
    )
  )
  assert.deepEqual(player2Payment, {recorded: true, slot: 'player2'})
  assert.equal(tables.games[0].status, 'playing')
  assert.equal(tables.games[0].player2_lnurl, 'bob@example.com')
  assert.equal(tables.games[0].player2_token, joined.playerToken)

  const finished = ok(
    api.finishGame(
      JSON.stringify({
        gameId: created.gameId,
        playerToken: created.playerToken,
        winnerSlot: 'player2',
        player1Wins: 1,
        player2Wins: 3,
        currentPlayer1Score: 9,
        currentPlayer2Score: 11
      })
    )
  )

  assert.equal(finished.status, 'paid')
  assert.equal(finished.winnerSlot, 'player2')
  assert.equal(finished.payoutStatus, 'paid')
  assert.equal(finished.table.winnerPayoutSats, 180)
  assert.deepEqual(lnurlPayments, [
    {
      walletId: 'wallet_1',
      lnurl: 'bob@example.com',
      amount: 180,
      maxSat: 180,
      description: 'Ping Pong winner payout for Fast table',
      comment: 'Ping Pong winner payout',
      extra: {gameId: created.gameId, winnerSlot: 'player2'}
    }
  ])
  assert.equal(JSON.stringify(finished).includes(created.playerToken), false)
  assert.equal(JSON.stringify(finished).includes(joined.playerToken), false)
  assert.ok(websocketMessages.some(message => message.data.event === 'finished'))
})

test('rejects joining before player one pays and refunds a late second player', async () => {
  const {api, invoiceRequests, lnurlPayments} = await moduleWithHost()
  const table = createTable(api)
  const created = ok(
    api.createGame(JSON.stringify({tableId: table.id, lnurl: 'alice@example.com'}))
  )

  assert.equal(
    unwrap(
      api.joinGame(JSON.stringify({gameId: created.gameId, lnurl: 'bob@example.com'}))
    ).ok,
    false
  )

  ok(
    api.recordPayment(
      JSON.stringify(paymentEvent(invoiceRequests[0], created.invoice.paymentHash, 100))
    )
  )
  const joined = ok(
    api.joinGame(JSON.stringify({gameId: created.gameId, lnurl: 'bob@example.com'}))
  )
  ok(
    api.recordPayment(
      JSON.stringify(paymentEvent(invoiceRequests[1], joined.invoice.paymentHash, 100))
    )
  )

  const race = ok(
    api.recordPayment(
      JSON.stringify(
        paymentEvent(null, 'late_hash', 100, {
          gameId: created.gameId,
          playerSlot: 'player2',
          playerToken: 'late_token',
          lnurl: 'late@example.com'
        })
      )
    )
  )
  assert.deepEqual(race, {recorded: false, refunded: true})
  assert.deepEqual(lnurlPayments, [
    {
      walletId: 'wallet_1',
      lnurl: 'late@example.com',
      amount: 100,
      maxSat: 100,
      description: 'Ping Pong refund for Fast table',
      comment: 'Ping Pong refund',
      extra: {gameId: created.gameId, reason: 'full'}
    }
  ])
})

test('refunds underpaid entries and ignores duplicate payment events', async () => {
  const {api, tables, invoiceRequests, lnurlPayments} = await moduleWithHost()
  const table = createTable(api)
  const created = ok(
    api.createGame(JSON.stringify({tableId: table.id, lnurl: 'alice@example.com'}))
  )

  const underpaid = ok(
    api.recordPayment(
      JSON.stringify(paymentEvent(invoiceRequests[0], created.invoice.paymentHash, 99))
    )
  )
  assert.deepEqual(underpaid, {recorded: false, refunded: true})
  assert.equal(tables.games[0].player1_paid, false)
  assert.equal(lnurlPayments[0].amount, 99)
  assert.equal(lnurlPayments[0].extra.reason, 'underpaid')

  const paid = ok(
    api.recordPayment(
      JSON.stringify(paymentEvent(invoiceRequests[0], created.invoice.paymentHash, 100))
    )
  )
  assert.deepEqual(paid, {recorded: true, slot: 'player1'})
  const duplicate = ok(
    api.recordPayment(
      JSON.stringify(paymentEvent(invoiceRequests[0], created.invoice.paymentHash, 100))
    )
  )
  assert.deepEqual(duplicate, {recorded: false, duplicate: true})
})

test('covers table listing, updates, public reads, and guarded deletes', async () => {
  const {api} = await moduleWithHost()
  const table = createTable(api)
  const updated = ok(
    api.updateTable(
      JSON.stringify({
        tableId: table.id,
        name: 'Slow table',
        description: 'Practice',
        entrySats: 50,
        gamesToWin: 1,
        hostPercent: 0,
        status: 'closed'
      })
    )
  )
  assert.equal(updated.name, 'Slow table')
  assert.equal(updated.entrySats, 50)
  assert.equal(updated.status, 'closed')

  const listed = ok(api.listTables('{}'))
  assert.equal(listed.tables.length, 1)
  assert.equal(listed.tables[0].activeGames, 0)
  const publicTable = ok(api.getPublicTable(JSON.stringify({tableId: table.id})))
  assert.equal(publicTable.name, 'Slow table')

  assert.equal(
    unwrap(
      api.createGame(JSON.stringify({tableId: table.id, lnurl: 'alice@example.com'}))
    ).ok,
    false
  )
  assert.deepEqual(ok(api.deleteTable(JSON.stringify({tableId: table.id}))), {
    id: table.id,
    deleted: true
  })
})

let failures = 0
for (const {name, fn} of tests) {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    failures += 1
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}
if (failures) process.exitCode = 1
