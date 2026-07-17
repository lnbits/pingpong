const client = window.createLNbitsExtensionClient({extensionId: 'pingpong'})

const app = Vue.createApp({
  data() {
    return {
      tables: [],
      wallets: [],
      dialog: false,
      saving: false,
      editingId: '',
      form: this.emptyForm()
    }
  },

  async mounted() {
    await Promise.all([this.fetchWallets(), this.fetchTables()])
  },

  computed: {
    canSave() {
      return (
        this.form.name.trim().length > 0 &&
        this.form.walletId &&
        Number.isSafeInteger(Number(this.form.entrySats)) &&
        Number(this.form.entrySats) > 0 &&
        Number.isSafeInteger(Number(this.form.gamesToWin)) &&
        Number(this.form.gamesToWin) >= 1 &&
        Number(this.form.gamesToWin) <= 9 &&
        Number.isSafeInteger(Number(this.form.hostPercent)) &&
        Number(this.form.hostPercent) >= 0 &&
        Number(this.form.hostPercent) <= 50
      )
    }
  },

  methods: {
    emptyForm() {
      return {
        name: '',
        description: '',
        walletId: '',
        entrySats: 100,
        gamesToWin: 3,
        hostPercent: 10
      }
    },

    async fetchWallets() {
      try {
        const response = await client.listWallets()
        this.wallets = response.wallets || []
        if (!this.form.walletId && this.wallets.length) {
          this.form.walletId = this.wallets[0].id
        }
      } catch (error) {
        this.showError(error)
      }
    },

    async fetchTables() {
      try {
        const response = await client.listTables()
        this.tables = response.tables || []
      } catch (error) {
        this.showError(error)
      }
    },

    openCreate() {
      this.editingId = ''
      this.form = this.emptyForm()
      this.form.walletId = this.wallets[0]?.id || ''
      this.dialog = true
    },

    openEdit(table) {
      this.editingId = table.id
      this.form = {
        name: table.name,
        description: table.description || '',
        walletId: this.wallets[0]?.id || '',
        entrySats: table.entrySats,
        gamesToWin: table.gamesToWin,
        hostPercent: table.hostPercent
      }
      this.dialog = true
    },

    closeDialog() {
      this.dialog = false
      this.editingId = ''
      this.form = this.emptyForm()
    },

    async saveTable() {
      if (!this.canSave || this.saving) return
      this.saving = true
      try {
        if (!this.editingId) {
          await this.ensureBackgroundPaymentGrant()
          await client.createTable(this.tablePayload())
          client.notify('Table created.', 'positive').catch(() => {})
        } else {
          await client.updateTable(this.editingId, this.tablePayload())
          client.notify('Table updated.', 'positive').catch(() => {})
        }
        this.closeDialog()
        await this.fetchTables()
      } catch (error) {
        this.showError(error)
      } finally {
        this.saving = false
      }
    },

    tablePayload() {
      return {
        name: this.form.name,
        description: this.form.description,
        walletId: this.form.walletId,
        entrySats: Number(this.form.entrySats),
        gamesToWin: Number(this.form.gamesToWin),
        hostPercent: Number(this.form.hostPercent)
      }
    },

    async ensureBackgroundPaymentGrant() {
      const entrySats = Number(this.form.entrySats)
      await client.requestBackgroundPaymentPermission({
        walletId: this.form.walletId,
        maxAmount: entrySats * 2,
        destinationPolicy: 'external_allowed'
      })
    },

    async toggleTable(table) {
      try {
        await client.updateTable(table.id, {
          status: table.status === 'open' ? 'closed' : 'open'
        })
        await this.fetchTables()
      } catch (error) {
        this.showError(error)
      }
    },

    deleteTable(table) {
      Quasar.Dialog.create({
        title: 'Delete table',
        message: `Delete "${table.name}"?`,
        cancel: true
      }).onOk(async () => {
        try {
          await client.deleteTable(table.id)
          await this.fetchTables()
        } catch (error) {
          this.showError(error)
        }
      })
    },

    publicUrl(tableId) {
      return new URL(`/ext/pingpong/t/${encodeURIComponent(tableId)}`, window.location.href)
        .href
    },

    openPublic(tableId) {
      window.open(this.publicUrl(tableId), '_blank', 'noopener')
    },

    async copyPublic(tableId) {
      try {
        await navigator.clipboard.writeText(this.publicUrl(tableId))
        client.notify('Public link copied.', 'positive').catch(() => {})
      } catch (error) {
        this.showError(error)
      }
    },

    showError(error) {
      const message = error instanceof Error ? error.message : String(error)
      client.notifyError(message).catch(() => {
        Quasar.Notify.create({type: 'negative', message})
      })
    }
  },

  render() {
    const h = Vue.h
    const component = name => Vue.resolveComponent(name)
    const QBadge = component('q-badge')
    const QBtn = component('q-btn')
    const QCard = component('q-card')
    const QDialog = component('q-dialog')
    const QForm = component('q-form')
    const QInput = component('q-input')
    const QSelect = component('q-select')

    const iconButton = props => h(QBtn, {flat: true, round: true, ...props})
    const formInput = (field, props = {}) =>
      h(QInput, {
        modelValue: this.form[field],
        'onUpdate:modelValue': value => {
          this.form[field] = value
        },
        dark: true,
        filled: true,
        dense: true,
        ...props
      })

    const rows = this.tables.length
      ? this.tables.map(table =>
          h(
            'article',
            {key: table.id, class: 'table-row row items-center q-col-gutter-md'},
            [
              h('div', {class: 'col-12 col-md'}, [
                h('div', {class: 'text-weight-medium'}, table.name),
                h('div', {class: 'text-caption text-grey-5'}, [
                  `${table.entrySats} sats entry`,
                  ` · first to ${table.gamesToWin} games`,
                  ` · host ${table.hostPercent}%`
                ])
              ]),
              h('div', {class: 'col-auto'}, [
                h(QBadge, {
                  color: table.status === 'open' ? 'positive' : 'grey-7',
                  label: table.status
                })
              ]),
              h('div', {class: 'col-auto'}, `${table.winnerPayoutSats} sats payout`),
              h('div', {class: 'col-auto row q-gutter-xs'}, [
                iconButton({
                  icon: 'sports_esports',
                  'aria-label': 'Open table',
                  onClick: () => this.openPublic(table.id)
                }),
                iconButton({
                  icon: 'content_copy',
                  'aria-label': 'Copy public link',
                  onClick: () => this.copyPublic(table.id)
                }),
                iconButton({
                  icon: 'edit',
                  'aria-label': 'Edit table',
                  onClick: () => this.openEdit(table)
                }),
                iconButton({
                  icon: table.status === 'open' ? 'lock' : 'lock_open',
                  'aria-label': table.status === 'open' ? 'Close table' : 'Open table',
                  onClick: () => this.toggleTable(table)
                }),
                iconButton({
                  icon: 'delete',
                  color: 'negative',
                  disable: table.activeGames > 0,
                  'aria-label': 'Delete table',
                  onClick: () => this.deleteTable(table)
                })
              ])
            ]
          )
        )
      : [h('div', {class: 'text-grey-5'}, 'No tables yet.')]

    return h('main', {class: 'shell q-pa-md'}, [
      h('header', {class: 'row items-center justify-between q-mb-lg q-gutter-md'}, [
        h('div', {class: 'row items-center q-gutter-sm'}, [
          h('img', {
            class: 'app-icon',
            src: '/ext-assets/pingpong/assets/icon.svg',
            alt: ''
          }),
          h('div', [
            h('h1', {class: 'text-h5 text-weight-bold q-my-none'}, 'Ping Pong'),
            h('div', {class: 'text-caption text-grey-5'}, 'Lightning Pong tables')
          ])
        ]),
        h(QBtn, {
          color: 'primary',
          icon: 'add',
          label: 'Create table',
          onClick: this.openCreate
        })
      ]),

      h(QCard, {dark: true, class: 'panel q-pa-md'}, {default: () => rows}),

      h(
        QDialog,
        {
          modelValue: this.dialog,
          'onUpdate:modelValue': value => {
            this.dialog = value
          },
          persistent: true
        },
        {
          default: () =>
            h(
              QCard,
              {dark: true, class: 'modal-card'},
              {
                default: () =>
                  h(
                    QForm,
                    {class: 'q-pa-lg q-gutter-md'},
                    {
                      default: () => [
                        h('div', {class: 'row items-center justify-between'}, [
                          h(
                            'h2',
                            {class: 'text-h6 q-my-none'},
                            this.editingId ? 'Edit table' : 'Create table'
                          ),
                          iconButton({
                            icon: 'close',
                            type: 'button',
                            'aria-label': 'Close',
                            onClick: this.closeDialog
                          })
                        ]),
                        formInput('name', {
                          label: 'Name',
                          maxlength: 80,
                          rules: [value => !!String(value || '').trim() || 'Name is required.']
                        }),
                        formInput('description', {
                          label: 'Description',
                          type: 'textarea',
                          maxlength: 300
                        }),
                        this.editingId
                          ? null
                          : h(QSelect, {
                              modelValue: this.form.walletId,
                              'onUpdate:modelValue': value => {
                                this.form.walletId = value
                              },
                              dark: true,
                              filled: true,
                              dense: true,
                              emitValue: true,
                              mapOptions: true,
                              label: 'Escrow wallet',
                              options: this.wallets.map(wallet => ({
                                label: wallet.name,
                                value: wallet.id
                              })),
                              disable: !this.wallets.length,
                              rules: [value => !!value || 'Wallet is required.']
                            }),
                        formInput('entrySats', {
                          label: 'Entry price per player',
                          type: 'number',
                          min: 1,
                          step: 1
                        }),
                        formInput('gamesToWin', {
                          label: 'Games to win match',
                          type: 'number',
                          min: 1,
                          max: 9,
                          step: 1
                        }),
                        formInput('hostPercent', {
                          label: 'Host percentage',
                          type: 'number',
                          min: 0,
                          max: 50,
                          step: 1
                        }),
                        h('div', {class: 'row justify-end q-gutter-sm'}, [
                          h(QBtn, {
                            flat: true,
                            label: 'Cancel',
                            type: 'button',
                            onClick: this.closeDialog
                          }),
                          h(QBtn, {
                            color: 'primary',
                            label: 'Save',
                            type: 'button',
                            loading: this.saving,
                            disable: !this.canSave,
                            onClick: this.saveTable
                          })
                        ])
                      ]
                    }
                  )
              }
            )
        }
      )
    ])
  }
})

app.use(Quasar)
app.mount('#pingpong-admin-app')
