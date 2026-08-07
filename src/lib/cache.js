import envPaths from 'env-paths'

export const CACHE_DIR = envPaths('mohdel', { suffix: null }).cache
