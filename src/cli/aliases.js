// Short commands → noun + verb. Shared by dispatch and by completion, which
// must resolve the same chain the router would.
export const ALIASES = {
  models: { noun: 'model', inject: ['list'] },
  providers: { noun: 'provider', inject: ['list'] },
  creators: { noun: 'creator', inject: ['list'] },
  tags: { noun: 'tag', inject: ['list'] },
  ls: { noun: 'model', inject: ['list'] },
  show: { noun: 'model', inject: ['show'] },
  search: { noun: 'model', inject: ['search'] },
  stats: { noun: 'model', inject: ['stats'] },
  check: { noun: 'model', inject: ['check'] },
  setup: { noun: 'provider', inject: ['setup'] },
  rank: { noun: 'model', inject: ['rank'] },
  bench: { noun: 'model', inject: ['bench'] },
  curate: { noun: 'model', inject: ['curate'] },
  apply: { noun: 'model', inject: ['apply'] },
  instructions: { noun: 'model', inject: ['instructions'] },
  rl: { noun: 'ratelimit', inject: [] }
}
