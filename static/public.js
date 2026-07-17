const client = window.createLNbitsExtensionClient({extensionId: 'pingpong'})
const START_COUNTDOWN_SECONDS = 5

const state = {
  tableId: '',
  gameId: '',
  playerToken: '',
  playerSlot: '',
  invoice: null,
  paymentUnsubscribe: null,
  websocket: null,
  qrApp: null,
  game: null,
  keys: new Set(),
  localPaddle: 0.5,
  remotePaddle: 0.5,
  lastSend: 0,
  lastStateSend: 0,
  animation: 0,
  authority: false,
  finishedSubmitted: false,
  engine: null
}

const nodes = {
  loading: document.querySelector('#loading'),
  error: document.querySelector('#error'),
  tableView: document.querySelector('#table-view'),
  gameView: document.querySelector('#game-view'),
  paymentView: document.querySelector('#payment-view'),
  tableName: document.querySelector('#table-name'),
  tableDescription: document.querySelector('#table-description'),
  tableMeta: document.querySelector('#table-meta'),
  createLnurl: document.querySelector('#create-lnurl'),
  createLnurlError: document.querySelector('#create-lnurl-error'),
  createGame: document.querySelector('#create-game'),
  joinPanel: document.querySelector('#join-panel'),
  joinLnurl: document.querySelector('#join-lnurl'),
  joinGame: document.querySelector('#join-game'),
  paymentStatus: document.querySelector('#payment-status'),
  invoiceLink: document.querySelector('#invoice-link'),
  invoiceText: document.querySelector('#invoice-text'),
  copyInvoice: document.querySelector('#copy-invoice'),
  copyGameLink: document.querySelector('#copy-game-link'),
  copyLink: document.querySelector('#copy-link'),
  arena: document.querySelector('#arena'),
  scoreLeft: document.querySelector('#score-left'),
  scoreRight: document.querySelector('#score-right'),
  matchScore: document.querySelector('#match-score'),
  gameStatus: document.querySelector('#game-status'),
  gameNote: document.querySelector('#game-note'),
  gameMeta: document.querySelector('#game-meta')
}

nodes.createGame.addEventListener('click', createGame)
nodes.createLnurl.addEventListener('input', clearCreateLnurlError)
nodes.joinGame.addEventListener('click', joinGame)
nodes.copyInvoice.addEventListener('click', () =>
  copyText(state.invoice?.paymentRequest || '')
)
nodes.copyGameLink.addEventListener('click', () => copyText(gameUrl()))
nodes.copyLink.addEventListener('click', () => copyText(gameUrl()))
window.addEventListener('keydown', event => state.keys.add(event.key))
window.addEventListener('keyup', event => state.keys.delete(event.key))
nodes.arena.addEventListener('pointermove', event => {
  const rect = nodes.arena.getBoundingClientRect()
  state.localPaddle = clamp((event.clientY - rect.top) / rect.height, 0.08, 0.92)
})

init().catch(showError)

async function init() {
  const context = await client.context()
  state.tableId = context.routeParams?.tableId || ''
  state.gameId = context.routeParams?.gameId || ''
  if (state.tableId) {
    const table = await client.getPublicTable(state.tableId)
    showTable(table)
    return
  }
  if (state.gameId) {
    await restorePlayerToken()
    await loadGame()
    return
  }
  throw new Error('Missing table or game route.')
}

function showTable(table) {
  hideAll()
  nodes.tableView.hidden = false
  nodes.tableName.textContent = table.name
  nodes.tableDescription.textContent = table.description || ''
  nodes.tableMeta.textContent =
    `${table.entrySats} sats per player · first to ${table.gamesToWin} games · winner payout ${table.winnerPayoutSats} sats`
  nodes.createGame.disabled = table.status !== 'open'
  if (table.status !== 'open') {
    nodes.tableMeta.textContent += ' · table closed'
  }
}

async function createGame() {
  const lnurl = nodes.createLnurl.value.trim()
  if (!lnurl) {
    showCreateLnurlError('Enter a Lightning Address or LNURL.')
    return
  }
  clearCreateLnurlError()
  nodes.createGame.disabled = true
  try {
    const response = await client.createGame(state.tableId, {lnurl})
    state.gameId = response.gameId
    state.playerToken = response.playerToken
    state.playerSlot = response.playerSlot
    await rememberPlayerToken()
    showInvoice(response.invoice, 'Pay to create your game. Share the link after payment.')
  } catch (error) {
    showError(error)
  } finally {
    nodes.createGame.disabled = false
  }
}

function showCreateLnurlError(message) {
  nodes.createLnurlError.textContent = message
  nodes.createLnurlError.hidden = false
  nodes.createLnurl.setAttribute('aria-invalid', 'true')
}

function clearCreateLnurlError() {
  nodes.createLnurlError.textContent = ''
  nodes.createLnurlError.hidden = true
  nodes.createLnurl.removeAttribute('aria-invalid')
}

async function joinGame() {
  const lnurl = nodes.joinLnurl.value.trim()
  if (!lnurl) return showError(new Error('Enter a Lightning Address or LNURL.'))
  nodes.joinGame.disabled = true
  try {
    const response = await client.joinGame(state.gameId, {lnurl})
    state.playerToken = response.playerToken
    state.playerSlot = response.playerSlot
    await rememberPlayerToken()
    showInvoice(response.invoice, 'Pay to join this game.')
  } catch (error) {
    showError(error)
  } finally {
    nodes.joinGame.disabled = false
  }
}

function showInvoice(invoice, message) {
  state.invoice = invoice
  hideAll()
  nodes.paymentView.hidden = false
  nodes.paymentStatus.textContent = message
  nodes.invoiceLink.href = `lightning:${invoice.paymentRequest}`
  nodes.invoiceText.textContent = invoice.paymentRequest
  renderQr(invoice.paymentRequest)
  state.paymentUnsubscribe?.()
  client
    .subscribePayment(invoice.paymentHash, event => {
      const payment = event.data || {}
      if (
        event.event === 'payment.settled' ||
        payment.pending === false ||
        ['paid', 'settled', 'success'].includes(String(payment.status || ''))
      ) {
        paymentSettled()
      }
    })
    .then(unsubscribe => {
      state.paymentUnsubscribe = unsubscribe
    })
    .catch(showError)
}

async function paymentSettled() {
  state.paymentUnsubscribe?.()
  state.paymentUnsubscribe = null
  await rememberPlayerToken()
  replaceTableRouteWithGameRoute()
  await loadGame()
  client.notify('Payment received.', 'positive').catch(() => {})
}

async function loadGame() {
  const game = await client.getPublicGame(state.gameId, state.playerToken)
  if (
    !state.playerToken &&
    (game.player2Paid || game.status === 'playing' || game.status === 'paid')
  ) {
    throw new Error('This game is full.')
  }
  state.game = game
  if (game.playerSlot) state.playerSlot = game.playerSlot
  showGame(game)
  await ensureRealtime()
}

function showGame(game) {
  hideAll()
  nodes.gameView.hidden = false
  nodes.joinPanel.hidden =
    !!state.playerToken ||
    game.player2Paid ||
    game.status === 'playing' ||
    game.status === 'paid' ||
    !game.player1Paid
  renderGameMeta(game)
  updateScoreboard(game)
  if (!game.player1Paid) {
    nodes.gameNote.textContent = 'Waiting for player 1 payment.'
  } else if (!game.player2Paid) {
    nodes.gameNote.textContent = state.playerToken
      ? 'Share the game link with player 2.'
      : 'Join with your payout address, then pay the entry invoice.'
  } else if (game.status === 'paid') {
    nodes.gameNote.textContent = `${label(game.winnerSlot)} won. Payout status: ${game.payoutStatus}.`
  } else {
    nodes.gameNote.textContent =
      state.playerSlot === 'player1'
        ? 'You control the left paddle.'
        : 'You control the right paddle.'
  }
  setupEngine(game)
}

function renderGameMeta(game) {
  nodes.gameMeta.replaceChildren(
    metaRow('Table', game.table.name),
    metaRow('Entry', `${game.table.entrySats} sats each`),
    metaRow('Match', `First to ${game.table.gamesToWin} games`),
    metaRow('Payout', `${game.table.winnerPayoutSats} sats`),
    metaRow('Link', gameUrl())
  )
}

function metaRow(name, value) {
  const row = document.createElement('div')
  row.className = 'status-row'
  const labelNode = document.createElement('div')
  labelNode.className = 'text-caption text-grey-5'
  labelNode.textContent = name
  const valueNode = document.createElement('div')
  valueNode.textContent = value
  row.append(labelNode, valueNode)
  return row
}

async function ensureRealtime() {
  if (!state.gameId || state.websocket) return
  state.websocket = await client.subscribeWebsocket(`game:${state.gameId}`, event => {
    if (event.event === 'websocket.error') {
      state.websocket = null
      return
    }
    const data = event.data || {}
    if (data.type === 'server') {
      loadGame().catch(showError)
      return
    }
    if (data.type === 'input' && state.authority && data.slot !== state.playerSlot) {
      state.remotePaddle = clamp(Number(data.y || 0.5), 0.08, 0.92)
    }
    if (data.type === 'state' && !state.authority) {
      applyRemoteState(data)
    }
  })
}

function setupEngine(game) {
  window.cancelAnimationFrame(state.animation)
  state.authority = state.playerSlot === 'player1' && game.status === 'playing'
  state.finishedSubmitted = false
  state.engine = {
    player1Y: 0.5,
    player2Y: 0.5,
    ballX: 0.5,
    ballY: 0.5,
    ballVX: 0.48,
    ballVY: 0.22,
    score1: Number(game.currentPlayer1Score || 0),
    score2: Number(game.currentPlayer2Score || 0),
    wins1: Number(game.player1Wins || 0),
    wins2: Number(game.player2Wins || 0),
    matchOver: game.status === 'paid',
    winnerSlot: game.winnerSlot || '',
    countdownEndAt: countdownEndAt(game)
  }
  state.animation = window.requestAnimationFrame(tick)
}

function tick(timestamp) {
  const engine = state.engine
  if (!engine) return
  updateLocalPaddle()
  if (state.playerSlot === 'player1') engine.player1Y = state.localPaddle
  if (state.playerSlot === 'player2') engine.player2Y = state.localPaddle

  const countdownActive = countdownRemaining(engine) > 0

  if (state.authority && !engine.matchOver) {
    engine.player2Y = state.remotePaddle
    if (!countdownActive) {
      stepAuthority(engine, 1 / 60)
    }
    if (!countdownActive && timestamp - state.lastStateSend > 33) {
      state.lastStateSend = timestamp
      sendState(engine)
    }
  } else if (!state.authority && timestamp - state.lastSend > 40) {
    state.lastSend = timestamp
    sendInput()
  }

  draw(engine)
  state.animation = window.requestAnimationFrame(tick)
}

function updateLocalPaddle() {
  const up = state.keys.has('ArrowUp') || state.keys.has('w') || state.keys.has('W')
  const down =
    state.keys.has('ArrowDown') || state.keys.has('s') || state.keys.has('S')
  if (up) state.localPaddle -= 0.025
  if (down) state.localPaddle += 0.025
  state.localPaddle = clamp(state.localPaddle, 0.08, 0.92)
}

function stepAuthority(engine, dt) {
  engine.ballX += engine.ballVX * dt
  engine.ballY += engine.ballVY * dt
  if (engine.ballY < 0.035 || engine.ballY > 0.965) {
    engine.ballY = clamp(engine.ballY, 0.035, 0.965)
    engine.ballVY *= -1
  }
  collidePaddle(engine, 'player1')
  collidePaddle(engine, 'player2')
  if (engine.ballX < -0.05) point(engine, 'player2')
  if (engine.ballX > 1.05) point(engine, 'player1')
}

function collidePaddle(engine, slot) {
  const isLeft = slot === 'player1'
  const paddleX = isLeft ? 0.055 : 0.945
  const paddleY = isLeft ? engine.player1Y : engine.player2Y
  const movingToward = isLeft ? engine.ballVX < 0 : engine.ballVX > 0
  if (!movingToward || Math.abs(engine.ballX - paddleX) > 0.018) return
  if (Math.abs(engine.ballY - paddleY) > 0.105) return
  engine.ballX = paddleX + (isLeft ? 0.02 : -0.02)
  engine.ballVX = Math.abs(engine.ballVX) * (isLeft ? 1 : -1) * 1.035
  engine.ballVY += (engine.ballY - paddleY) * 2.2
}

function point(engine, slot) {
  if (slot === 'player1') engine.score1 += 1
  else engine.score2 += 1
  if (isGameWon(engine.score1, engine.score2)) {
    engine.wins1 += 1
    engine.score1 = 0
    engine.score2 = 0
  }
  if (isGameWon(engine.score2, engine.score1)) {
    engine.wins2 += 1
    engine.score1 = 0
    engine.score2 = 0
  }
  if (engine.wins1 >= state.game.table.gamesToWin) {
    finishMatch(engine, 'player1')
    return
  }
  if (engine.wins2 >= state.game.table.gamesToWin) {
    finishMatch(engine, 'player2')
    return
  }
  resetBall(engine, slot === 'player1' ? 1 : -1)
}

function isGameWon(score, otherScore) {
  return score >= state.game.pointsToWin && score - otherScore >= 2
}

function resetBall(engine, direction = 1) {
  engine.ballX = 0.5
  engine.ballY = 0.5
  engine.ballVX = 0.44 * direction
  engine.ballVY = (Math.random() * 0.32 + 0.12) * (Math.random() > 0.5 ? 1 : -1)
}

function finishMatch(engine, winnerSlot) {
  engine.matchOver = true
  engine.winnerSlot = winnerSlot
  sendState(engine)
  if (winnerSlot === state.playerSlot) submitFinish(engine).catch(showError)
}

async function submitFinish(engine) {
  if (state.finishedSubmitted) return
  state.finishedSubmitted = true
  const game = await client.finishGame(state.gameId, {
    playerToken: state.playerToken,
    winnerSlot: engine.winnerSlot,
    player1Wins: engine.wins1,
    player2Wins: engine.wins2,
    currentPlayer1Score: engine.score1,
    currentPlayer2Score: engine.score2
  })
  state.game = game
  showGame(game)
}

function sendInput() {
  sendRealtime({
    type: 'input',
    slot: state.playerSlot,
    y: state.localPaddle
  })
}

function sendState(engine) {
  sendRealtime({
    type: 'state',
    slot: state.playerSlot,
    player1Y: engine.player1Y,
    player2Y: engine.player2Y,
    ballX: engine.ballX,
    ballY: engine.ballY,
    score1: engine.score1,
    score2: engine.score2,
    wins1: engine.wins1,
    wins2: engine.wins2,
    matchOver: engine.matchOver,
    winnerSlot: engine.winnerSlot
  })
}

function sendRealtime(data) {
  const websocket = state.websocket
  if (!websocket) return
  websocket
    .send(data)
    .catch(error => {
      if (isRealtimeNotOpen(error)) return
      if (state.websocket === websocket) state.websocket = null
      if (window.console?.warn) {
        window.console.warn('[pingpong extension] Realtime send failed.', error)
      }
    })
    .finally(() => {
      if (websocket.active === false && state.websocket === websocket) {
        state.websocket = null
      }
    })
}

function isRealtimeNotOpen(error) {
  return errorMessage(error) === 'Websocket subscription is not open.'
}

function applyRemoteState(data) {
  const engine = state.engine
  if (!engine) return
  engine.player1Y = clamp(Number(data.player1Y || 0.5), 0.08, 0.92)
  engine.player2Y = clamp(Number(data.player2Y || 0.5), 0.08, 0.92)
  engine.ballX = clamp(Number(data.ballX || 0.5), -0.1, 1.1)
  engine.ballY = clamp(Number(data.ballY || 0.5), 0, 1)
  engine.score1 = Number(data.score1 || 0)
  engine.score2 = Number(data.score2 || 0)
  engine.wins1 = Number(data.wins1 || 0)
  engine.wins2 = Number(data.wins2 || 0)
  engine.matchOver = data.matchOver === true
  engine.winnerSlot = data.winnerSlot || ''
  if (engine.matchOver && engine.winnerSlot === state.playerSlot) {
    submitFinish(engine).catch(showError)
  }
}

function draw(engine) {
  const canvas = nodes.arena
  const ctx = canvas.getContext('2d')
  const width = canvas.width
  const height = canvas.height
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = '#0b3d3a'
  ctx.fillRect(0, 0, width, height)
  ctx.strokeStyle = 'rgba(248,250,252,0.75)'
  ctx.lineWidth = 4
  ctx.setLineDash([12, 12])
  ctx.beginPath()
  ctx.moveTo(width / 2, 0)
  ctx.lineTo(width / 2, height)
  ctx.stroke()
  ctx.setLineDash([])
  drawPaddle(ctx, 34, engine.player1Y * height)
  drawPaddle(ctx, width - 46, engine.player2Y * height)
  ctx.fillStyle = '#f8fafc'
  ctx.beginPath()
  ctx.arc(engine.ballX * width, engine.ballY * height, 9, 0, Math.PI * 2)
  ctx.fill()
  drawCountdown(ctx, width, height, countdownRemaining(engine))
  updateScoreboardFromEngine(engine)
}

function drawPaddle(ctx, x, y) {
  ctx.fillStyle = '#f4c542'
  ctx.fillRect(x, y - 48, 12, 96)
}

function drawCountdown(ctx, width, height, remaining) {
  if (!remaining) return

  ctx.save()
  ctx.fillStyle = 'rgba(4, 17, 29, 0.62)'
  ctx.fillRect(0, 0, width, height)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = 'rgba(248,250,252,0.95)'
  ctx.font = `700 ${Math.round(Math.min(width, height) * 0.07)}px Inter, Roboto, Arial, sans-serif`
  ctx.fillText('GET READY', width / 2, height * 0.32)
  ctx.fillStyle = '#f4c542'
  ctx.strokeStyle = 'rgba(248,250,252,0.9)'
  ctx.lineWidth = Math.max(4, Math.round(width * 0.008))
  ctx.font = `900 ${Math.round(Math.min(width, height) * 0.28)}px Inter, Roboto, Arial, sans-serif`
  ctx.strokeText(String(remaining), width / 2, height * 0.55)
  ctx.fillText(String(remaining), width / 2, height * 0.55)
  ctx.restore()
}

function countdownEndAt(game) {
  if (game.status !== 'playing' || !game.startedAt) return 0
  return Number(game.startedAt) * 1000 + START_COUNTDOWN_SECONDS * 1000
}

function countdownRemaining(engine) {
  if (!engine.countdownEndAt) return 0
  return Math.max(0, Math.ceil((engine.countdownEndAt - Date.now()) / 1000))
}

function updateScoreboard(game) {
  nodes.scoreLeft.textContent = game.currentPlayer1Score
  nodes.scoreRight.textContent = game.currentPlayer2Score
  nodes.matchScore.textContent = `${game.player1Wins} - ${game.player2Wins}`
  nodes.gameStatus.textContent = game.status
}

function updateScoreboardFromEngine(engine) {
  nodes.scoreLeft.textContent = engine.score1
  nodes.scoreRight.textContent = engine.score2
  nodes.matchScore.textContent = `${engine.wins1} - ${engine.wins2}`
  nodes.gameStatus.textContent = engine.matchOver ? `${label(engine.winnerSlot)} won` : 'playing'
}

function renderQr(invoice) {
  if (!window.Vue || !window.QrcodeVue?.default) return
  state.qrApp?.unmount()
  nodes.invoiceLink.replaceChildren()
  state.qrApp = Vue.createApp({
    render: () =>
      Vue.h(QrcodeVue.default, {
        value: `lightning:${invoice.toUpperCase()}`,
        size: 260,
        margin: 3,
        level: 'Q',
        renderAs: 'canvas'
      })
  })
  state.qrApp.mount(nodes.invoiceLink)
}

function hideAll() {
  nodes.loading.hidden = true
  nodes.error.hidden = true
  nodes.tableView.hidden = true
  nodes.paymentView.hidden = true
  nodes.gameView.hidden = true
}

function replaceTableRouteWithGameRoute() {
  if (!state.tableId || !state.gameId) return
  client.replaceRoute(gamePath()).catch(showError)
}

async function rememberPlayerToken() {
  if (!state.gameId || !state.playerToken) return
  try {
    await client.setSessionValue(playerTokenStorageKey(), state.playerToken)
    return
  } catch (_error) {}
  try {
    window.sessionStorage.setItem(playerTokenStorageKey(), state.playerToken)
  } catch (_error) {}
}

async function restorePlayerToken() {
  if (!state.gameId || state.playerToken) return
  try {
    const data = await client.getSessionValue(playerTokenStorageKey())
    state.playerToken = data?.value || ''
    if (state.playerToken) return
  } catch (_error) {}
  try {
    state.playerToken =
      window.sessionStorage.getItem(playerTokenStorageKey()) || ''
  } catch (_error) {}
}

function playerTokenStorageKey() {
  return `lnbits.pingpong.playerToken.${state.gameId}`
}

function gamePath() {
  return `/ext/pingpong/g/${encodeURIComponent(state.gameId)}`
}

function gameUrl() {
  return new URL(gamePath(), window.location.href).href
}

async function copyText(text) {
  await navigator.clipboard.writeText(text)
  client.notify('Copied.', 'positive').catch(() => {})
}

function showError(error) {
  hideAll()
  nodes.error.hidden = false
  nodes.error.textContent = errorMessage(error)
  client.notifyError(nodes.error.textContent).catch(() => {})
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function label(slot) {
  return slot === 'player1' ? 'Player 1' : slot === 'player2' ? 'Player 2' : 'Player'
}
